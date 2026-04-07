//======ESP-1 Control and read data=======//

#include <ArduinoJson.h>
#include <HardwareSerial.h>
#include <TinyGPS++.h>
#include <BluetoothSerial.h>

// --- KONFIGURASI PIN ---
#define RELAY_STARTER 12
#define RELAY_FUEL 13
#define GPS_RX 19
#define GPS_TX 18
#define ESP2_RX 16
#define ESP2_TX 17
#define PIN_PELAMPUNG 34


// --- INSTANSIASI OBJEK ---
HardwareSerial gpsSerial(1); 
TinyGPSPlus gps;
BluetoothSerial SerialBT;

// Variabel Data
float rpm = 0, speed = 0, temp = 0;
float engineLoad = 0, throttle = 0, intakeTemp = 0, voltage = 0;
double lat = 0.0, lng = 0.0;
int gpsSatellites = 0;

// Timing variables
unsigned long lastSendTime = 0;
unsigned long elmTimeout = 0;
unsigned long elmInterval = 0;
unsigned long lastGpsPrint = 0;
int elmState = 1;
int initStep = 0;
bool elmReady = false;
bool isWaitingELM = false;

// ELM Command buffer
String elmResponse = "";

// Deteksi Mesin Mati: Jika ELM tidak merespons berulang kali = mesin mati / kontak off
int consecutiveTimeouts = 0;       // Counter timeout berturut-turut
bool engineSignal = false;         // true = mesin menyala (ELM aktif merespons)
const int ENGINE_OFF_THRESHOLD = 5; // Berapa kali timeout berturut-turut = mesin mati

// Buffer for serial reading
const int MAX_SERIAL_BUFFER = 128;
char serial2Buffer[MAX_SERIAL_BUFFER];
int serial2Index = 0;

void setup() {
  Serial.begin(115200);
  
  // Komunikasi ke ESP 2
  Serial2.begin(115200, SERIAL_8N1, ESP2_RX, ESP2_TX);
  Serial2.setRxBufferSize(256);
  
  // Komunikasi ke GPS
  gpsSerial.begin(9600, SERIAL_8N1, GPS_RX, GPS_TX);
  gpsSerial.setRxBufferSize(256);

  pinMode(RELAY_STARTER, OUTPUT);
  pinMode(RELAY_FUEL, OUTPUT);
  digitalWrite(RELAY_STARTER, LOW);
  digitalWrite(RELAY_FUEL, LOW);    
  pinMode(PIN_PELAMPUNG, INPUT);

  Serial.println("\n=================================");
  Serial.println(" ESP1 MEMULAI... ");
  Serial.println("=================================");
  Serial.println("[BT] Menghubungkan ke ELM327...");
  
  SerialBT.begin("ESP32_Tracker", true); 
  SerialBT.setPin("1234"); 
  
  if (!SerialBT.connect("OBDII")) { 
    Serial.println("⚠️ [BT] Gagal terhubung ke nama OBDII, mencoba MAC...");
    uint8_t elmAddress[6] = {0xAA, 0xBB, 0xCC, 0x11, 0x22, 0x33}; 
    if(!SerialBT.connect(elmAddress)) {
      Serial.println("❌ [BT] Gagal terhubung ke ELM327!");
    } else {
      Serial.println("✅ [BT] ELM327 Terhubung (Via MAC).");
    }
  } else {
    Serial.println("✅ [BT] ELM327 Terhubung (Via Nama).");
  }
}

void parseELMData(String res) {
  res.replace(" ", ""); // Bersihkan spasi
  res.replace("\r", "");
  res.replace("\n", "");
  res.replace(">", "");
  
  if (res.length() < 2) return;
  Serial.print("[ELM] Balasan: "); Serial.println(res);

  if (res.indexOf("41") != -1) {
    int idx = res.indexOf("41");
    String pid = res.substring(idx + 2, idx + 4);
    String hexData = res.substring(idx + 4);

    if (pid == "0C" && hexData.length() >= 4) { // RPM
      long A = strtol(hexData.substring(0, 2).c_str(), NULL, 16);
      long B = strtol(hexData.substring(2, 4).c_str(), NULL, 16);
      rpm = ((A * 256.0) + B) / 4.0;
      Serial.printf("  => RPM: %.0f rpm\n", rpm);
      // Data RPM valid diterima = mesin menyala
      consecutiveTimeouts = 0;
      engineSignal = true;
    } 
    else if (pid == "0D" && hexData.length() >= 2) { // Speed
      speed = strtol(hexData.substring(0, 2).c_str(), NULL, 16);
      Serial.printf("  => Speed: %.0f km/h\n", speed);
    } 
    else if (pid == "05" && hexData.length() >= 2) { // Temp
      temp = strtol(hexData.substring(0, 2).c_str(), NULL, 16) - 40;
      Serial.printf("  => Temp: %.0f C\n", temp);
    } 
    else if (pid == "04" && hexData.length() >= 2) { // Load
      engineLoad = strtol(hexData.substring(0, 2).c_str(), NULL, 16) * 100.0 / 255.0;
      Serial.printf("  => Load: %.0f %%\n", engineLoad);
    } 
    else if (pid == "11" && hexData.length() >= 2) { // Throttle
      throttle = strtol(hexData.substring(0, 2).c_str(), NULL, 16) * 100.0 / 255.0;
      Serial.printf("  => Throttle: %.0f %%\n", throttle);
    } 
    else if (pid == "0F" && hexData.length() >= 2) { // IAT
      intakeTemp = strtol(hexData.substring(0, 2).c_str(), NULL, 16) - 40;
      Serial.printf("  => IAT: %.0f C\n", intakeTemp);
    }
  } else if (res.indexOf("V") != -1 && res.indexOf("AT") == -1) { 
    // Tegangan biasanya membalas misal "13.8V" 
    float v = res.toFloat();
    if (v > 0) {
      voltage = v;
      Serial.printf("  => Voltage: %.1f V\n", voltage);
    }
  }
}

void processELMResponse() {
  while (SerialBT.available()) {
    char c = SerialBT.read();
    if (c == '>') {
      isWaitingELM = false;
      elmInterval = millis() + 50; 
      parseELMData(elmResponse);
      elmResponse = "";
      
      if (!elmReady) {
        initStep++;
        if (initStep > 3) {
           elmReady = true;
           elmState = 1;
           Serial.println("\n✅ INISIALISASI SELESAI. MULAI MEMBACA SENSOR!\n");
           delay(1000); // beri jeda sebentar sebelum pooling PID
        }
      } else {
        elmState++;
        if (elmState > 7) elmState = 1;
      }
      return;
    } else { 
      // masukkan ke buffer selain '>'
      elmResponse += c;
    }
  }
}

void loop() {
  // 1. BACA DATA GPS TANPA BLOCKING
  while (gpsSerial.available() > 0) {
    if (gps.encode(gpsSerial.read())) {
      gpsSatellites = gps.satellites.value();
      if (gps.location.isValid()) {
        lat = gps.location.lat();
        lng = gps.location.lng();
      }
    }
  }

  // Tampilkan status GPS tiap 5 detik
  if (millis() - lastGpsPrint > 5000) {
    lastGpsPrint = millis();
    Serial.printf("[GPS] Satelit didapat: %d | Lokasi GPS Valid: %s\n", 
      gpsSatellites, (gps.location.isValid() ? "YA" : "TIDAK (Mencari Sinyal...)"));
  }

  // 2. BACA DATA ELM327 NON-BLOCKING STATE MACHINE
  if (SerialBT.connected()) {
    processELMResponse();
    
    // Timeout handler: if ELM stuck without sending >
    if (isWaitingELM && millis() > elmTimeout) {
      consecutiveTimeouts++;
      Serial.printf("⚠️ [ELM] Timeout! (ke-%d)\n", consecutiveTimeouts);
      
      // Jika terlalu banyak timeout berturut-turut, anggap mesin mati
      if (consecutiveTimeouts >= ENGINE_OFF_THRESHOLD) {
        if (engineSignal) {
          Serial.println("🔴 [ENGINE] Timeout berulang! Mesin dianggap MATI.");
        }
        engineSignal = false;
        rpm = 0; // Reset RPM ke 0 agar ESP2 tahu mesin mati
      }
      
      isWaitingELM = false;
      elmResponse = "";
      elmInterval = millis() + 500;
      
      if (!elmReady) {
        initStep++;
        if(initStep > 4) { initStep = 0; Serial.println("⚠️ [ELM] Gagal inisialisasi, reset urutan!"); } 
      } else {
        elmState++;
        if (elmState > 7) elmState = 1;
      }
    }

    if (!isWaitingELM && millis() > elmInterval) {
      isWaitingELM = true;
      if (!elmReady) {
          if (initStep == 0) { Serial.println("Mengirim: ATZ"); SerialBT.print("ATZ\r"); elmTimeout = millis() + 3000; }
          else if (initStep == 1) { Serial.println("Mengirim: ATE0"); SerialBT.print("ATE0\r"); elmTimeout = millis() + 2000; }
          else if (initStep == 2) { Serial.println("Mengirim: ATL0"); SerialBT.print("ATL0\r"); elmTimeout = millis() + 2000; }
          else if (initStep == 3) { Serial.println("Mengirim: ATSP0"); SerialBT.print("ATSP0\r"); elmTimeout = millis() + 4000; } // beri waktu agak lama
      } else {
          // PID READ
          if (elmState == 1)      { SerialBT.print("010C\r"); elmTimeout = millis() + 1500; } // RPM
          else if (elmState == 2) { SerialBT.print("010D\r"); elmTimeout = millis() + 1500; } // Speed
          else if (elmState == 3) { SerialBT.print("0105\r"); elmTimeout = millis() + 1500; } // Temp
          else if (elmState == 4) { SerialBT.print("0104\r"); elmTimeout = millis() + 1500; } // Load
          else if (elmState == 5) { SerialBT.print("0111\r"); elmTimeout = millis() + 1500; } // Throttle
          else if (elmState == 6) { SerialBT.print("010F\r"); elmTimeout = millis() + 1500; } // IAT
          else if (elmState == 7) { SerialBT.print("ATRV\r"); elmTimeout = millis() + 1500; } // Battery
      }
    }
  }

  // 3. TERIMA PERINTAH DARI ESP 2 (Kontrol Relay) NON-BLOCKING
  while (Serial2.available() > 0) {
    char c = Serial2.read();
    if (c == '\n') {
      serial2Buffer[serial2Index] = '\0'; // Null-terminate
      StaticJsonDocument<128> docIn;
      if (!deserializeJson(docIn, serial2Buffer)) {
        if (docIn.containsKey("cut_engine")) {
          bool cutEngine = docIn["cut_engine"];
          if (cutEngine) {
            digitalWrite(RELAY_STARTER, HIGH);
            digitalWrite(RELAY_FUEL, HIGH);
            Serial.println("PERINTAH DITERIMA: MESIN DIMATIKAN!");
          } else {
            digitalWrite(RELAY_STARTER, LOW);
            digitalWrite(RELAY_FUEL, LOW);
            Serial.println("PERINTAH DITERIMA: MESIN DIHIDUPKAN!");
          }
        }
      }
      serial2Index = 0; 
    } else if (c != '\r' && serial2Index < MAX_SERIAL_BUFFER - 1) {
      serial2Buffer[serial2Index++] = c;
    }
  }

  // 4. KIRIM DATA KE ESP 2 SETIAP 2 DETIK
  if (millis() - lastSendTime > 2000) {
    StaticJsonDocument<256> docOut;
    docOut["rpm"] = (int)rpm;
    docOut["spd"] = (int)speed;
    docOut["tmp"] = (int)temp;
    docOut["lod"] = (int)engineLoad;
    docOut["thr"] = (int)throttle;
    docOut["iat"] = (int)intakeTemp;
    docOut["vol"] = voltage;
    docOut["lat"] = lat;
    docOut["lng"] = lng;
    docOut["fuel"] = 100; 
    docOut["fuelADC"] = analogRead(PIN_PELAMPUNG);
    // Sinyal engine: 1=mesin menyala (ELM aktif merespons), 0=mesin mati/timeout
    docOut["engsig"] = engineSignal ? 1 : 0;

    serializeJson(docOut, Serial2);
    Serial2.println(); 
    
    lastSendTime = millis();
  }
}
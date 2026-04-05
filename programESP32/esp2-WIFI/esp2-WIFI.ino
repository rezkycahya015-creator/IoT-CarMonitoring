//======ESP 2 WIFI AND HENDEL IN OUT WEB (OPTIMIZED WITH EDGE COMPUTING) =====//

#include <WiFi.h>
#include <Firebase_ESP_Client.h>
#include <ArduinoJson.h>
#include <time.h>

// Berikan token info dari Firebase_ESP_Client
#include "addons/TokenHelper.h"
#include "addons/RTDBHelper.h"

// --- KONFIGURASI WIFI & FIREBASE ---
#define WIFI_SSID "wifi-iot"
#define WIFI_PASSWORD "password-iot"

// Data diekstrak dari app.js Anda
#define API_KEY "AIzaSyBTZoF-X_FY6EYfWnrkJ4SghVDS-2hnHro" 
#define DATABASE_URL "carmonitoring-iot-default-rtdb.asia-southeast1.firebasedatabase.app"

// --- PIN SERIAL 2 ---
#define ESP1_RX 16
#define ESP1_TX 17

// Objek Firebase
FirebaseData fbdo;
FirebaseAuth auth;
FirebaseConfig config;
bool signupOK = false;

String deviceID = "ESP32-"; 

unsigned long sendDataPrevMillis = 0;
unsigned long timeCheckPrevMillis = 0;

// --- EDGE COMPUTING VARIABLES (TRIP & OPTIMISASI) ---
unsigned long g_lastDataSent = 0;
unsigned long g_diagnosticUntil = 0; // Batas akhir mode diag (Epoch seconds)
int g_updateIntervalNormal = 30000;  // 30 detik
int g_updateIntervalDiagnostic = 1000; // 1 detik

bool g_tripActive = false;
unsigned long g_tripStartEpoch = 0;
float g_tripDistance = 0.0;
float g_tripFuelUsed = 0.0;
int g_maxSpeedInTrip = 0;
unsigned long g_lastCalcMillis = 0;

unsigned long g_lastGpsPush = 0; 
String g_currentTripID = "";

// Buffer for serial reading
const int MAX_SERIAL_BUFFER = 256;
char serial2Buffer[MAX_SERIAL_BUFFER];
int serial2Index = 0;

unsigned long getEpochTime() {
  time_t now;
  struct tm timeinfo;
  if (!getLocalTime(&timeinfo)) {
    return 0; // return 0 jika belum dpt jam
  }
  time(&now);
  return now;
}

void setupNTP() {
  configTime(7 * 3600, 0, "pool.ntp.org", "time.nist.gov"); // GMT+7 WIB
  Serial.print("Menghubungkan ke Server NTP (Sinkronisasi Jam)");
  time_t now = time(nullptr);
  int retry = 0;
  while (now < 8 * 3600 * 2 && retry < 15) { 
    Serial.print(".");
    delay(500);
    now = time(nullptr);
    retry++;
  }
  Serial.println("\n[INFO] Waktu sudah sinkron!");
}

void setup() {
  Serial.begin(115200);
  Serial2.begin(115200, SERIAL_8N1, ESP1_RX, ESP1_TX);
  Serial2.setRxBufferSize(512);

  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  Serial.print("Menghubungkan ke Wi-Fi");
  while (WiFi.status() != WL_CONNECTED) {
    Serial.print(".");
    delay(300);
  }
  Serial.println("\nWi-Fi Terhubung!");
  
  setupNTP();

  deviceID += WiFi.macAddress();
  deviceID.replace(":", ""); 
  Serial.println("\n=============================================");
  Serial.print("👉 DEVICE ID ANDA: ");
  Serial.println(deviceID);
  Serial.println("=============================================\n");

  config.api_key = API_KEY;
  config.database_url = DATABASE_URL;

  if (Firebase.signUp(&config, &auth, "", "")) {
    Serial.println("Firebase Berhasil Terhubung (Anonim)");
    signupOK = true;
  } else {
    Serial.printf("Error Auth: %s\n", config.signer.signupError.message.c_str());
    signupOK = true; // Paksa terus bila aturan rtdb publik
  }
  
  fbdo.setBSSLBufferSize(1024, 512);
  Firebase.begin(&config, &auth);
  Firebase.reconnectWiFi(true);
}

void endOfTripPush() {
    if(!g_tripActive) return;
    
    unsigned long endEpoch = getEpochTime();
    
    float avgSpeed = 0;
    float diffHours = (endEpoch - g_tripStartEpoch) / 3600.0;
    if(diffHours > 0) avgSpeed = g_tripDistance / diffHours;

    float avgKonsumsi = 0;
    if (g_tripFuelUsed > 0 && g_tripDistance > 0) {
       avgKonsumsi = g_tripDistance / g_tripFuelUsed; // Format km/L (Sesuai STD Indonesia)
    }

    FirebaseJson tripData;
    tripData.set("startTs", (uint32_t)(g_tripStartEpoch * 1000ULL));
    tripData.set("endTs", (uint32_t)(endEpoch * 1000ULL));
    tripData.set("distance", g_tripDistance);
    tripData.set("fuelUsed", g_tripFuelUsed);
    tripData.set("maxSpeed", g_maxSpeedInTrip);
    tripData.set("avgSpeed", avgSpeed);
    tripData.set("avgFuelCons_kml", avgKonsumsi);
    tripData.set("routeId", g_currentTripID); // Link to route data khusus mapping trip ini

    String tripPath = "Devices/" + deviceID + "/Trips";
    if (Firebase.RTDB.pushJSON(&fbdo, tripPath.c_str(), &tripData)) {
      Serial.println("✔️ Laporan Trip Akhir Berhasil Diposting!");
    } else {
      Serial.println("❌ Perjalanan gagal disimpan: " + fbdo.errorReason());
    }

    g_tripActive = false;
    g_tripDistance = 0;
    g_tripFuelUsed = 0;
    g_maxSpeedInTrip = 0;
    g_tripStartEpoch = 0;
}

void loop() {
  unsigned long currentMillis = millis();
  unsigned long currentEpoch = getEpochTime();

  // 1. CEK CONFIGURASI SYSTEM & CUT OFF BERKALA (Setiap 3 Detik)
  if (Firebase.ready() && signupOK && (currentMillis - timeCheckPrevMillis > 3000 || timeCheckPrevMillis == 0)) {
    timeCheckPrevMillis = currentMillis;

    // Cek batas interval Diagnostic Mode override 
    String diagPath = "Devices/" + deviceID + "/Config/UpdateOverrideUntil";
    if (Firebase.RTDB.getInt(&fbdo, diagPath.c_str())) {
        unsigned long netEpochOverride = (unsigned long)(fbdo.intData() / 1000); 
        g_diagnosticUntil = netEpochOverride;
    }

    // Cek Perintah Cut Off
    String cutOffPath = "Devices/" + deviceID + "/Status/CutOff";
    if (Firebase.RTDB.getBool(&fbdo, cutOffPath.c_str())) {
      bool cutStatus = fbdo.boolData();
      StaticJsonDocument<128> cmdDoc;
      cmdDoc["cut_engine"] = cutStatus;
      serializeJson(cmdDoc, Serial2);
      Serial2.println(); 
    }
  }

  // Menentukan kecepatan pengiriman (Diagnostic 1s vs Normal 30s)
  int activeInterval = g_updateIntervalNormal;
  if (g_diagnosticUntil > 0 && currentEpoch < g_diagnosticUntil) {
      activeInterval = g_updateIntervalDiagnostic; // Ngebut! User sedang pencet diagnostik
  }

  // 2. BACA DARI ELM327 / ESP1 NON-BLOCKING
  while (Serial2.available() > 0) {
    char c = Serial2.read();
    if (c == '\n') {
      serial2Buffer[serial2Index] = '\0'; 
      
      StaticJsonDocument<256> doc;
      DeserializationError error = deserializeJson(doc, serial2Buffer);

      if (!error && signupOK) {
        int rpm = doc["rpm"] | 0;
        int speed = doc["spd"] | 0;
        int temp = doc["tmp"] | 0;
        int load = doc["lod"] | 0;
        int thr = doc["thr"] | 0;
        int iat = doc["iat"] | 0;
        float vol = doc["vol"] | 0.0;
        float lat = doc["lat"] | 0.0;
        float lng = doc["lng"] | 0.0;
        int fuel = doc["fuel"] | 0;
        int fuelADC = doc["fuelADC"] | 0;
        
        bool engineOn = (rpm > 0);

        // --- EDGE COMPUTING: VIRTUAL ODOMETER & FUEL ---
        if (g_lastCalcMillis == 0) g_lastCalcMillis = currentMillis;
        float dtHours = (currentMillis - g_lastCalcMillis) / 3600000.0;
        g_lastCalcMillis = currentMillis;

        // Trip State Logic
        if (engineOn && !g_tripActive) {
           g_tripActive = true;
           g_tripStartEpoch = currentEpoch;
           g_tripDistance = 0;
           g_tripFuelUsed = 0;
           g_maxSpeedInTrip = 0;
           g_currentTripID = String(currentEpoch); 
           Serial.println("[TRIP] Mesin Nyala, Memulai Perekaman Riwayat Perjalanan...");
        } else if (!engineOn && g_tripActive) {
           Serial.println("[TRIP] Mesin Mati, Mem-push Rangkuman Perjalanan ke Basis Data...");
           endOfTripPush();
        }

        float instFuelRate = 0;
        if (g_tripActive) {
            g_tripDistance += (speed * dtHours);
            if (speed > g_maxSpeedInTrip) g_maxSpeedInTrip = speed;

            // Hitung L/h
            if (engineOn) {
                instFuelRate = (rpm * ((load>0)?load:25) * 1.5) / 50000.0;
                if (instFuelRate < 0.5) instFuelRate = 0.5;
            }
            if (speed > 0 && rpm > 0) {
                instFuelRate = (rpm * load * 2.0) / 45000.0;
            }
            g_tripFuelUsed += (instFuelRate * dtHours);
        }

        // --- MENGIRIM DATA ESP KE FIREBASE (Sesuai Algoritma Hemat Kuota) ---
        if (currentMillis - g_lastDataSent >= activeInterval || g_lastDataSent == 0) {
            g_lastDataSent = currentMillis;

            FirebaseJson liveJson;
            liveJson.set("RPM", rpm);
            liveJson.set("Speed", speed);
            liveJson.set("EngineTemp", temp);
            liveJson.set("EngineLoad", load);
            liveJson.set("ThrottlePos", thr);
            liveJson.set("IntakeTemp", iat);
            liveJson.set("BatteryVoltage", vol);
            liveJson.set("FuelLevel", fuel);
            liveJson.set("FuelADC", fuelADC);
            liveJson.set("EngineOn", engineOn);
            liveJson.set("Timestamp", (uint32_t)(currentEpoch * 1000ULL));
            
            liveJson.set("DistanceTravelled", g_tripDistance);
            liveJson.set("FuelUsed", g_tripFuelUsed);
            liveJson.set("InstFuelRate", instFuelRate);
            
            float kml = 0;
            if(g_tripFuelUsed > 0) kml = g_tripDistance / g_tripFuelUsed;
            liveJson.set("AvgKML", kml); // Khusus indonesia standard km/L

            String liveDataPath = "Devices/" + deviceID + "/Live_Data";
            Firebase.RTDB.updateNode(&fbdo, liveDataPath.c_str(), &liveJson);

            FirebaseJson gpsJson;
            gpsJson.set("lat", lat);
            gpsJson.set("lng", lng);
            gpsJson.set("speed", speed);
            
            String gpsPath = "Devices/" + deviceID + "/GPS";
            Firebase.RTDB.updateNode(&fbdo, gpsPath.c_str(), &gpsJson);
        }

        // --- PUSH ROUTE TRACKING TIAP 15 DETIK KETIKA MOBIL JALAN ---
        // (Ini sangat menghemat Storage dibanding Push GPS tiap 1 detik!)
        if (g_tripActive && speed > 5) {
            if (currentMillis - g_lastGpsPush > 15000) {
                g_lastGpsPush = currentMillis;
                FirebaseJson routeJson;
                routeJson.set("lat", lat);
                routeJson.set("lng", lng);
                routeJson.set("ts", (uint32_t)currentEpoch);

                String routePath = "Devices/" + deviceID + "/TripPaths/" + g_currentTripID;
                Firebase.RTDB.pushJSON(&fbdo, routePath.c_str(), &routeJson);
            }
        }

      }
      serial2Index = 0; 
    } else if (c != '\r' && serial2Index < MAX_SERIAL_BUFFER - 1) {
      serial2Buffer[serial2Index++] = c;
    }
  }
}
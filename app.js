/**
 * ============================================================================
 * IoT Car Monitoring - app.js
 * Shared Application Logic: Auth, Firebase RTDB, Utilities, Navigation
 * ============================================================================
 */

'use strict';

// ============================================================================
// CONFIGURATION
// ============================================================================

const APP_CONFIG = {
    name: 'CarMonitor IoT',
    version: '1.0.0',
    defaultMapCenter: [-6.2088, 106.8456], // Jakarta, Indonesia
    defaultMapZoom: 14,
    firebase: {
        apiKey: "AIzaSyBTZoF-X_FY6EYfWnrkJ4SghVDS-2hnHro",
        authDomain: "carmonitoring-iot.firebaseapp.com",
        databaseURL: "https://carmonitoring-iot-default-rtdb.asia-southeast1.firebasedatabase.app",
        projectId: "carmonitoring-iot",
        storageBucket: "carmonitoring-iot.firebasestorage.app",
        messagingSenderId: "791923251754",
        appId: "1:791923251754:web:8cc2273c070d6c0c42c153",
        measurementId: "G-YPVEV9EJ1P"
    }
};

// Initialize Firebase
if (!firebase.apps.length) {
    firebase.initializeApp(APP_CONFIG.firebase);
}
const auth = firebase.auth();
const db = firebase.database();

// ============================================================================
// APPLICATION STATE
// ============================================================================

const AppState = {
    currentUser: null,
    currentVehicle: null,
    userVehicles: [],
    isOnline: true,
    liveListeners: [],
    geofenceEnabled: false,
    theme: 'light',
};

// Auto-sync auth state
auth.onAuthStateChanged(user => {
    if (user) {
        // Find if admin
        const isAdmin = user.email && user.email.includes('admin');
        AppState.currentUser = {
            uid: user.uid,
            email: user.email,
            displayName: user.displayName || user.email.split('@')[0],
            role: isAdmin ? 'admin' : 'user',
            photoURL: user.photoURL
        };
        // Persist session 
        localStorage.setItem('car_monitor_user', JSON.stringify(AppState.currentUser));
    } else {
        AppState.currentUser = null;
        localStorage.removeItem('car_monitor_user');
    }
});


// ============================================================================
// FIREBASE DATABASE FUNCTIONS
// ============================================================================

function fetchLiveSensorData(deviceId, callback) {
    // Clear previous Firebase listeners if any
    AppState.liveListeners.forEach(ref => ref.off());
    AppState.liveListeners = [];

    const ref = db.ref(`Devices/${deviceId}/Live_Data`);

    // Default zero state before data arrives
    callback({
        speed: 0, rpm: 0, engineTemp: 0, fuelLevel: 0, engineLoad: 0,
        engineOn: false, timestamp: Date.now(),
        intakeTemp: 0, throttlePos: 0, batteryVoltage: 0, maf: 0,
        distanceTravelled: 0, fuelUsed: 0, avgFuelUse: 0, instFuelRate: 0
    });

    ref.on('value', (snapshot) => {
        const val = snapshot.val();
        if (val) {
            callback({
                speed: val.Speed || 0,
                rpm: val.RPM || 0,
                engineTemp: val.EngineTemp || 0,
                fuelLevel: val.FuelLevel || 0,
                engineLoad: val.EngineLoad || 0,
                engineOn: val.EngineOn !== undefined ? val.EngineOn : (val.RPM > 0),
                timestamp: val.Timestamp || Date.now(),
                throttlePos: val.ThrottlePos || val.Throttle || 0,
                batteryVoltage: val.BatteryVoltage || val.Voltage || 0,
                maf: val.MAF || 0,
                intakeTemp: val.IntakeTemp || 0,
                distanceTravelled: val.DistanceTravelled || 0,
                fuelUsed: val.FuelUsed || 0,
                avgFuelUse: val.AvgFuelUse || 0,
                avgKml: val.AvgKML || 0,
                instFuelRate: val.InstFuelRate || 0
            });
        }
    });

    AppState.liveListeners.push(ref);
    return ref; // Replacing the interval ID with db ref
}

function updateMapLocation(deviceId, callback) {
    const ref = db.ref(`Devices/${deviceId}/GPS`);

    // Provide a default map location initially
    callback({
        lat: APP_CONFIG.defaultMapCenter[0],
        lng: APP_CONFIG.defaultMapCenter[1],
        speed: 0, heading: 0, accuracy: 10, timestamp: Date.now()
    });

    ref.on('value', (snapshot) => {
        const val = snapshot.val();
        if (val && val.lat && val.lng) {
            callback({
                lat: val.lat,
                lng: val.lng,
                speed: val.speed || 0,
                heading: val.heading || 0,
                accuracy: val.accuracy || 10,
                timestamp: val.timestamp || Date.now()
            });
        }
    });
    AppState.liveListeners.push(ref);
    return ref;
}

function fetchDTCCodes(deviceId, callback) {
    const ref = db.ref(`Devices/${deviceId}/DTC`);
    ref.on('value', (snapshot) => {
        const val = snapshot.val();
        const codes = [];
        if (val) {
            Object.keys(val).forEach(key => {
                codes.push({
                    id: key,
                    code: val[key].code,
                    description: val[key].description || 'Kode Kerusakan Terdeteksi OBD2',
                    system: val[key].system || 'Engine',
                    severity: val[key].severity || 'warning',
                    timestamp: val[key].timestamp || val[key].ts || Date.now()
                });
            });
        }
        callback(codes);
    });
    AppState.liveListeners.push(ref);
}

async function sendCommandToDevice(deviceId, cmd, params = {}) {
    console.log(`[CMD] Sending command to ${deviceId}: ${cmd}`, params);
    try {
        await db.ref(`Devices/${deviceId}/Commands`).push({
            cmd: cmd,
            params: params,
            timestamp: firebase.database.ServerValue.TIMESTAMP
        });
        return { success: true, cmd, deviceId, timestamp: Date.now() };
    } catch (e) {
        console.error(e);
        return { success: false, error: e.message };
    }
}

async function sendClearDTCCommand(deviceId) {
    return sendCommandToDevice(deviceId, 'CLEAR_DTC', {});
}

async function sendCutoffCommand(deviceId, enable) {
    // Also save directly to Status node so it persists
    try {
        await db.ref(`Devices/${deviceId}/Status/CutOff`).set(enable);
        return sendCommandToDevice(deviceId, 'CUT_OFF', { enable });
    } catch (e) {
        return { success: false, error: e.message };
    }
}

function fetchAllVehicles(callback) {
    // For admin dashboard, read all devices statuses
    db.ref('Devices').once('value').then(snapshot => {
        const devices = snapshot.val();
        const fleet = [];
        if (devices) {
            Object.keys(devices).forEach(devId => {
                const live = devices[devId].Live_Data || {};
                const gps = devices[devId].GPS || {};
                const stat = devices[devId].Status || {};

                const lastSeen = stat.lastSeen || live.Timestamp || Date.now();
                const isOnline = (Date.now() - lastSeen) < 60000; // 1 min timeout

                fleet.push({
                    id: devId,
                    deviceId: devId,
                    ownerName: 'Pengguna ' + devId.slice(-3),
                    vehicleName: 'Kendaraan ' + devId,
                    plateNumber: 'B XXXX XYZ',
                    status: isOnline ? (live.Speed > 0 ? 'moving' : 'idle') : 'offline',
                    lat: gps.lat || APP_CONFIG.defaultMapCenter[0],
                    lng: gps.lng || APP_CONFIG.defaultMapCenter[1],
                    speed: live.Speed || 0,
                    lastSeen: lastSeen,
                    fuelLevel: live.FuelLevel || 0,
                    rpm: live.RPM || 0,
                    engineTemp: live.EngineTemp || 0,
                    engineLoad: live.EngineLoad || 0,
                    throttlePos: live.ThrottlePos || 0,
                    intakeTemp: live.IntakeTemp || 0,
                    batteryVoltage: live.BatteryVoltage || 0
                });
            });
        }
        callback(fleet);
    }).catch(() => {
        callback([]);
    });
}

async function revokeDeviceAccess(deviceId) {
    return new Promise(resolve => setTimeout(() => resolve({ success: true }), 800));
}

async function setGeofenceStatus(deviceId, enabled) {
    return sendCommandToDevice(deviceId, enabled ? 'GEOFENCE_ON' : 'GEOFENCE_OFF', { enabled });
}

// ============================================================================
// FIREBASE AUTHENTICATION
// ============================================================================

async function loginWithEmail(email, password) {
    try {
        const userCredential = await auth.signInWithEmailAndPassword(email, password);
        const user = userCredential.user;

        // Fetch user data from DB to get the role
        let role = 'user'; // default
        try {
            const userSnap = await db.ref(`Users/${user.uid}/Profile`).once('value');
            if (userSnap.exists() && userSnap.val().role) {
                role = userSnap.val().role;
            } else if (email.includes('admin')) {
                role = 'admin'; // fallback for mock admins
            }
        } catch(e) { console.error("Could not fetch user profile", e); }

        const userData = {
            uid: user.uid,
            email: user.email,
            displayName: user.displayName || user.email.split('@')[0],
            role: role,
            photoURL: user.photoURL
        };
        return { user: userData, error: null };
    } catch (error) {
        console.error("Login Error:", error);
        let msg = 'Login gagal: ' + error.message;
        if (error.code === 'auth/user-not-found') msg = 'Akun tidak ditemukan.';
        if (error.code === 'auth/wrong-password') msg = 'Kata sandi salah.';
        return { user: null, error: msg };
    }
}

async function registerWithEmail(email, password, displayName, role) {
    try {
        const userCredential = await auth.createUserWithEmailAndPassword(email, password);
        const user = userCredential.user;
        await user.updateProfile({ displayName: displayName });

        // Save role and profile info to RTDB
        await db.ref(`Users/${user.uid}/Profile`).set({
            email: email,
            displayName: displayName,
            role: role || 'personal',
            createdAt: firebase.database.ServerValue.TIMESTAMP
        });

        const userData = {
            uid: user.uid,
            email: user.email,
            displayName: displayName,
            role: role || 'personal',
            photoURL: null
        };
        return { user: userData, error: null };
    } catch (error) {
        console.error("Register Error:", error);
        let msg = 'Registrasi gagal: ' + error.message;
        if (error.code === 'auth/email-already-in-use') msg = 'Email sudah terdaftar.';
        if (error.code === 'auth/weak-password') msg = 'Kata sandi terlalu lemah.';
        return { user: null, error: msg };
    }
}

async function logout() {
    try {
        await auth.signOut();
    } catch (e) { console.error(e); }

    AppState.currentUser = null;
    AppState.currentVehicle = null;
    AppState.liveListeners.forEach(ref => ref.off());
    AppState.liveListeners = [];

    localStorage.removeItem('car_monitor_user');
    localStorage.removeItem('car_monitor_vehicle');
    localStorage.removeItem('car_monitor_vehicles');
    window.location.href = 'index.html';
}

function handleSocialLogin(provider) {
    if (provider === 'google') {
        const googleProvider = new firebase.auth.GoogleAuthProvider();
        auth.signInWithPopup(googleProvider).then((result) => {
            const user = result.user;
            saveSession({
                uid: user.uid, email: user.email, displayName: user.displayName, role: 'user', photoURL: user.photoURL
            });
            window.location.href = 'dashboard.html';
        }).catch((error) => {
            showToast('Login Google gagal: ' + error.message, 'error');
        });
    } else {
        showToast(`Login dengan ${capitalize(provider)} akan segera tersedia.`, 'info');
    }
}

// ============================================================================
// AUTH STATE MANAGEMENT
// ============================================================================

function saveSession(user, vehicle = null, vehicles = null) {
    localStorage.setItem('car_monitor_user', JSON.stringify(user));
    if (vehicle) localStorage.setItem('car_monitor_vehicle', JSON.stringify(vehicle));
    if (vehicles) localStorage.setItem('car_monitor_vehicles', JSON.stringify(vehicles));
    AppState.currentUser = user;
    if (vehicle) AppState.currentVehicle = vehicle;
    if (vehicles) AppState.userVehicles = vehicles;
}

function loadSession() {
    try {
        const user = JSON.parse(localStorage.getItem('car_monitor_user'));
        const vehicle = JSON.parse(localStorage.getItem('car_monitor_vehicle'));
        const vehicles = JSON.parse(localStorage.getItem('car_monitor_vehicles'));
        if (user) {
            AppState.currentUser = user;
            if (vehicle) AppState.currentVehicle = vehicle;
            if (vehicles) AppState.userVehicles = vehicles;
        }
        return user;
    } catch {
        return null;
    }
}

function requireAuth(allowedRoles = ['user', 'admin', 'personal', 'driver', 'owner', 'company_manager']) {
    const user = loadSession();
    if (!user) {
        window.location.href = 'index.html';
        return false;
    }
    
    // We treat 'admin' or 'company_manager' as having more expansive rights, but generally let them in.
    // If a specific strict role check is needed, we enforce it.
    if (!allowedRoles.includes(user.role) && !allowedRoles.includes('user')) {
        showToast('Anda tidak memiliki akses ke halaman ini.', 'error');
        window.location.href = 'dashboard.html';
        return false;
    }
    return user;
}

// ============================================================================
// UI UTILITIES & THEME
// ============================================================================

function toggleTheme() {
    const current = document.documentElement.getAttribute('data-theme') || 'light';
    const newTheme = current === 'dark' ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', newTheme);
    localStorage.setItem('carmonitor_theme', newTheme);
    
    const icon = document.getElementById('theme-icon');
    if(icon) {
        icon.className = newTheme === 'dark' ? 'fa-solid fa-sun' : 'fa-solid fa-moon';
    }
    document.dispatchEvent(new CustomEvent('themeChanged', { detail: newTheme }));
}

(function loadTheme() {
    const savedTheme = localStorage.getItem('carmonitor_theme') || 'light';
    document.documentElement.setAttribute('data-theme', savedTheme);
    document.addEventListener('DOMContentLoaded', () => {
        const icon = document.getElementById('theme-icon');
        if(icon) {
            icon.className = savedTheme === 'dark' ? 'fa-solid fa-sun' : 'fa-solid fa-moon';
        }
        document.dispatchEvent(new CustomEvent('themeChanged', { detail: savedTheme }));
    });
})();

function showToast(message, type = 'info', duration = 4000) {
    let container = document.getElementById('toast-container');
    if (!container) {
        container = document.createElement('div');
        container.id = 'toast-container';
        document.body.appendChild(container);
    }

    const icons = {
        success: '<i class="fa-solid fa-circle-check" style="color:#10B981"></i>',
        warning: '<i class="fa-solid fa-triangle-exclamation" style="color:#F59E0B"></i>',
        error: '<i class="fa-solid fa-circle-xmark" style="color:#EF4444"></i>',
        info: '<i class="fa-solid fa-circle-info" style="color:#06B6D4"></i>',
    };

    const toast = document.createElement('div');
    toast.className = `toast toast-${type}`;
    toast.innerHTML = `
        ${icons[type] || icons.info}
        <span style="flex:1">${message}</span>
        <button onclick="this.closest('.toast').remove()" style="background:none;border:none;cursor:pointer;color:#94A3B8;padding:0;font-size:14px">
            <i class="fa-solid fa-xmark"></i>
        </button>
    `;
    container.appendChild(toast);

    setTimeout(() => {
        toast.style.opacity = '0';
        toast.style.transform = 'translateX(30px)';
        toast.style.transition = 'all 0.3s ease';
        setTimeout(() => toast.remove(), 300);
    }, duration);
}

function setButtonLoading(btn, loading, originalHtml = '') {
    if (loading) {
        btn._originalHtml = btn.innerHTML;
        btn.disabled = true;
        btn.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i>&nbsp;Mohon Tunggu...`;
    } else {
        btn.disabled = false;
        btn.innerHTML = originalHtml || btn._originalHtml || 'Submit';
    }
}

function openModal(modalId) {
    const modal = document.getElementById(modalId);
    if (modal) {
        modal.style.display = 'flex';
        document.body.style.overflow = 'hidden';
    }
}

function closeModal(modalId) {
    const modal = document.getElementById(modalId);
    if (modal) {
        modal.style.display = 'none';
        document.body.style.overflow = '';
    }
}

function formatDateTime(ts) {
    return new Date(ts).toLocaleString('id-ID', {
        day: '2-digit', month: 'short', year: 'numeric',
        hour: '2-digit', minute: '2-digit',
    });
}

function timeAgo(ts) {
    const diff = (Date.now() - ts) / 1000;
    if (diff < 60) return 'Baru saja';
    if (diff < 3600) return `${Math.floor(diff / 60)} menit lalu`;
    if (diff < 86400) return `${Math.floor(diff / 3600)} jam lalu`;
    return `${Math.floor(diff / 86400)} hari lalu`;
}

function capitalize(str) {
    return str ? str.charAt(0).toUpperCase() + str.slice(1) : '';
}

function getInitials(name) {
    if (!name) return '?';
    const parts = name.split(' ');
    return parts.length > 1
        ? (parts[0][0] + parts[parts.length - 1][0]).toUpperCase()
        : name.slice(0, 2).toUpperCase();
}

function initSidebar() {
    const hamburger = document.getElementById('hamburger-btn');
    const sidebar = document.getElementById('sidebar');
    const overlay = document.getElementById('sidebar-overlay');

    if (!hamburger || !sidebar) return;

    hamburger.addEventListener('click', () => {
        sidebar.classList.toggle('open');
        overlay?.classList.toggle('open');
    });

    overlay?.addEventListener('click', () => {
        sidebar.classList.remove('open');
        overlay.classList.remove('open');
    });

    // Mobile sidebar overlay close works by clicking outside
    // No explicit "X" button needed per user request


    // Conditional Fleet Management Visibility
    const fleetMenu = document.querySelector('a[href="admin.html"]');
    if (fleetMenu) {
        const label = fleetMenu.previousElementSibling;
        const vehiclesCount = AppState.userVehicles?.length || 0;
        const isFleetManager = AppState.currentUser?.role === 'admin' || vehiclesCount > 1;
        
        if (!isFleetManager) {
            fleetMenu.style.display = 'none';
            if (label && label.classList.contains('sidebar-section-label')) {
                label.style.display = 'none';
            }
        }
    }
}

function setActiveNavItem() {
    const currentPage = window.location.pathname.split('/').pop().replace('.html', '');
    const navItems = document.querySelectorAll('.nav-item[data-page]');
    navItems.forEach(item => {
        if (item.dataset.page === currentPage) {
            item.classList.add('active');
        } else {
            item.classList.remove('active');
        }
    });
}

function populateUserUI() {
    const user = AppState.currentUser;
    if (!user) return;

    const nameEls = document.querySelectorAll('[data-user-name]');
    const emailEls = document.querySelectorAll('[data-user-email]');
    const avatarEls = document.querySelectorAll('[data-user-avatar]');
    const initials = getInitials(user.displayName);

    nameEls.forEach(el => el.textContent = user.displayName || user.email);
    emailEls.forEach(el => el.textContent = user.email);
    avatarEls.forEach(el => el.textContent = initials);
}

// ============================================================================
// ECO-DRIVING SCORE CALCULATION
// ============================================================================

function calculateEcoGrade(speedHistory = []) {
    if (!speedHistory.length) return { grade: 'B', score: 75, advice: 'Data tidak tersedia' };

    const avg = speedHistory.reduce((a, b) => a + b, 0) / speedHistory.length;
    const max = Math.max(...speedHistory);
    const variance = speedHistory.reduce((acc, v) => acc + Math.pow(v - avg, 2), 0) / speedHistory.length;

    let score = 100;
    if (avg > 80) score -= 20;
    else if (avg > 60) score -= 10;
    if (max > 120) score -= 25;
    else if (max > 100) score -= 15;
    if (variance > 400) score -= 15;
    else if (variance > 200) score -= 8;

    score = Math.max(0, Math.min(100, score));

    let grade, advice;
    if (score >= 90) { grade = 'A'; advice = 'Berkendara sangat hemat & aman!'; }
    else if (score >= 75) { grade = 'B'; advice = 'Berkendara cukup baik, pertahankan.'; }
    else if (score >= 60) { grade = 'C'; advice = 'Kurangi kecepatan berlebih.'; }
    else { grade = 'D'; advice = 'Gaya berkendara perlu diperbaiki!'; }

    return { grade, score, advice };
}

// ============================================================================
// CHART.JS HELPERS
// ============================================================================

function createGaugeChart(canvasId, value, max, colors = ['#06B6D4', '#E2E8F0']) {
    const ctx = document.getElementById(canvasId)?.getContext('2d');
    if (!ctx) return null;

    const pct = Math.min(value / max, 1);
    const remaining = 1 - pct;

    return new Chart(ctx, {
        type: 'doughnut',
        data: {
            datasets: [{
                data: [pct, remaining],
                backgroundColor: colors,
                borderWidth: 0,
                cutout: '78%',
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: true,
            rotation: -90,
            circumference: 180,
            plugins: {
                legend: { display: false },
                tooltip: { enabled: false },
            },
            animation: {
                animateRotate: true,
                duration: 600,
            }
        }
    });
}

function updateGaugeChart(chart, value, max) {
    if (!chart) return;
    const pct = Math.min(value / max, 1);
    chart.data.datasets[0].data = [pct, 1 - pct];
    chart.update('none');
}

function getStatusColor(pct, mode = 'normal') {
    if (mode === 'reverse') pct = 1 - pct;
    if (pct > 0.75) return '#10B981';
    if (pct > 0.4) return '#F59E0B';
    return '#EF4444';
}

function createSparklineChart(canvasId, data, color = '#06B6D4') {
    const ctx = document.getElementById(canvasId)?.getContext('2d');
    if (!ctx) return null;

    const gradient = ctx.createLinearGradient(0, 0, 0, 80);
    gradient.addColorStop(0, color + '40');
    gradient.addColorStop(1, color + '00');

    return new Chart(ctx, {
        type: 'line',
        data: {
            labels: data.map((_, i) => i),
            datasets: [{
                data,
                borderColor: color,
                backgroundColor: gradient,
                borderWidth: 2,
                fill: true,
                tension: 0.4,
                pointRadius: 0,
                pointHoverRadius: 4,
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
                legend: { display: false },
                tooltip: {
                    callbacks: {
                        label: ctx => `${ctx.raw} km/h`
                    }
                }
            },
            scales: {
                x: { display: false },
                y: {
                    display: false,
                    min: 0,
                    max: 140,
                }
            },
            animation: { duration: 400 }
        }
    });
}

// ============================================================================
// DATA STUBS FOR History, Reports, Settings
// ============================================================================

function fetchTripHistory(deviceId, callback) {
    db.ref(`Devices/${deviceId}/Trips`).orderByChild('startTs').limitToLast(30).once('value').then(snapshot => {
        const val = snapshot.val();
        if (val) {
            const trips = Object.keys(val).map(key => {
                let t = val[key];
                // Calculate Eco Score or use default for history grading
                let kml = t.avgFuelCons_kml || 0;
                let eco = 'C';
                if (kml > 15) eco = 'A';
                else if (kml > 10) eco = 'B';
                else if (kml < 5) eco = 'D';

                return { id: key, ...t, ecoGrade: eco };
            });
            trips.sort((a, b) => b.startTs - a.startTs);
            callback(trips);
        } else {
            callback([]);
        }
    });
}

function fetchTripRoute(deviceId, routeId, callback) {
    if (!routeId) {
        callback([]);
        return;
    }
    db.ref(`Devices/${deviceId}/TripPaths/${routeId}`).once('value').then(snapshot => {
        const val = snapshot.val();
        if (val) {
            const points = Object.keys(val).map(k => val[k]);
            points.sort((a, b) => a.ts - b.ts);
            callback(points);
        } else {
            callback([]);
        }
    });
}

function fetchReports(deviceId, period, callback) {
    db.ref(`Devices/${deviceId}/Reports/${period}`).once('value').then(snapshot => {
        const val = snapshot.val();
        if (val) {
            callback(val);
        } else {
            callback({
                period, labels: [], dailyDistance: [],
                totalDistance: 0,
                totalFuelUsed: 0,
                avgEcoScore: 0,
                topSpeed: 0,
                tripCount: 0,
                avgDailyDistance: 0,
                fuelBreakdown: { city: 0, highway: 0, idle: 0 },
            });
        }
    });
}

function fetchSettings(userId, callback) {
    db.ref(`Users/${userId}/Settings`).once('value').then(snapshot => {
        const val = snapshot.val();
        if (val) {
            callback(val);
        } else {
            const defaults = {
                overspeedLimit: 100, lowFuelAlert: 20, geofenceRadius: 500,
                alerts: { overspeed: true, lowFuel: true, engineTemp: true, geofence: false, dtc: true },
                maintenance: {
                    lastServiceOdo: 0,
                    serviceInterval: 10000 // 10,000 km by default
                },
                vehicle: {
                    vehicleName: AppState.currentVehicle?.vehicleName || 'Kendaraan Baru',
                    plateNumber: AppState.currentVehicle?.plateNumber || '-',
                    deviceId: AppState.currentVehicle?.deviceId || '',
                    fuelCapacity: 45,
                    adcEmpty: 0,
                    adcFull: 4095,
                }
            };
            const saved = JSON.parse(localStorage.getItem('carmonitor_settings') || 'null');
            callback(saved || defaults);
        }
    });
}

async function saveSettings(userId, data) {
    try {
        await db.ref(`Users/${userId}/Settings`).set(data);

        // Also sync the critical config down to the ESP32 device node
        if (data.vehicle && data.vehicle.deviceId) {
            await db.ref(`Devices/${data.vehicle.deviceId}/Config`).set({
                SpeedLimit: data.overspeedLimit || 100,
                FuelCapacity: data.vehicle.fuelCapacity || 45,
                ADCEmpty: data.vehicle.adcEmpty || 0,
                ADCFull: data.vehicle.adcFull || 4095
            });
        }

        localStorage.setItem('carmonitor_settings', JSON.stringify(data));
        return { success: true };
    } catch (e) {
        return { success: false, error: e.message };
    }
}

// ============================================================================
// EXPORT / MODULE PATTERN
// ============================================================================

window.AppState = AppState;
window.APP_CONFIG = APP_CONFIG;
window.fetchLiveSensorData = fetchLiveSensorData;
window.updateMapLocation = updateMapLocation;
window.fetchDTCCodes = fetchDTCCodes;
window.sendClearDTCCommand = sendClearDTCCommand;
window.sendCutoffCommand = sendCutoffCommand;
window.sendCommandToDevice = sendCommandToDevice;
window.fetchAllVehicles = fetchAllVehicles;
window.revokeDeviceAccess = revokeDeviceAccess;
window.setGeofenceStatus = setGeofenceStatus;
window.fetchTripHistory = fetchTripHistory;
window.fetchTripRoute = fetchTripRoute;
window.fetchReports = fetchReports;
window.fetchSettings = fetchSettings;
window.saveSettings = saveSettings;
window.loginWithEmail = loginWithEmail;
window.registerWithEmail = registerWithEmail;
window.logout = logout;
window.saveSession = saveSession;
window.loadSession = loadSession;
window.requireAuth = requireAuth;
window.showToast = showToast;
window.setButtonLoading = setButtonLoading;
window.openModal = openModal;
window.closeModal = closeModal;
window.formatDateTime = formatDateTime;
window.timeAgo = timeAgo;
window.getInitials = getInitials;
window.calculateEcoGrade = calculateEcoGrade;
window.createGaugeChart = createGaugeChart;
window.updateGaugeChart = updateGaugeChart;
window.getStatusColor = getStatusColor;
window.createSparklineChart = createSparklineChart;
window.initSidebar = initSidebar;
window.setActiveNavItem = setActiveNavItem;
window.populateUserUI = populateUserUI;
window.capitalize = capitalize;
window.handleSocialLogin = handleSocialLogin;
window.toggleTheme = toggleTheme;

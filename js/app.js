/**
 * ============================================================================
 * CONTROLLER DASHBOARD 6 HALAMAN — POWER HOUSE IOT MONITORING & CONTROL
 * Mendukung 3 Mode Sumber Data:
 * 1. Supabase Cloud (PostgreSQL + Auth + Realtime + History) — Rekomendasi
 * 2. Firebase Legacy RTDB (Audit & Bridge ke Firmware Lama)
 * 3. Simulasi Interaktif (Pengujian UI & Logika Otomatisasi Tanpa Hardware)
 * ============================================================================
 */

const STORAGE_KEY = "powerhouse_dashboard_settings_v1";
const MAX_REALTIME_POINTS = 25;

// ----------------------------------------------------------------------------
// STATE APLIKASI TERPUSAT
// ----------------------------------------------------------------------------
const defaultSettings = {
  mode: window.APP_CONFIG?.mode || "simulator",
  supabaseUrl: window.APP_CONFIG?.supabase?.url || "",
  supabaseAnonKey: window.APP_CONFIG?.supabase?.anonKey || "",
  deviceId: window.APP_CONFIG?.supabase?.deviceId || "panel-utama-01",
  firebaseDbUrl:
    window.APP_CONFIG?.firebase?.databaseURL ||
    "https://kendali-akuisisi-data-default-rtdb.firebaseio.com/",
  firebaseApiKey:
    window.APP_CONFIG?.firebase?.apiKey ||
    "AIzaSyDVroHlxiu8K5kjnQDZKtffHLshoFBuaUo"
};

const appState = {
  settings: loadSettings(),
  activePage: "overview",
  user: null,
  role: "admin", // Pada mode simulator default admin; pada Supabase mengikuti user_roles
  telemetry: {
    voltage: 221.4,
    current: 4.82,
    power: 1012,
    energy: 148.62,
    frequency: 50.0,
    power_factor: 0.94,
    temp_air: 29.4,
    temp_panel: 30.8,
    humidity: 62.5,
    actual_mode: "AUTO",
    actual_fan: false,
    actual_ac: false,
    actual_buzzer: false,
    actual_lamp: false,
    uptime_seconds: 0,
    wifi_connected: true,
    last_seen_at: new Date().toISOString()
  },
  config: {
    target_mode: "AUTO",
    target_fan: false,
    target_ac: false,
    target_buzzer: false,
    target_lamp: false,
    temp_threshold_fan: 32.0,
    temp_threshold_ac: 35.0,
    temp_threshold_alarm: 45.0,
    log_interval_seconds: 60
  },
  realtimeSeries: [],
  historyLogs: [],
  activityLogs: [],
  simTargetTempOffset: 0
};

let supabaseClient = null;
let supabaseChannels = [];
let simIntervalId = null;
let heartbeatTimerId = null;
let charts = {};

// ----------------------------------------------------------------------------
// HELPER UTILITAS
// ----------------------------------------------------------------------------
function loadSettings() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? { ...defaultSettings, ...JSON.parse(raw) } : { ...defaultSettings };
  } catch {
    return { ...defaultSettings };
  }
}

function saveSettingsToStorage(nextSettings) {
  appState.settings = { ...appState.settings, ...nextSettings };
  localStorage.setItem(STORAGE_KEY, JSON.stringify(appState.settings));
}

function formatNum(val, decimals = 1) {
  const num = Number(val);
  return Number.isFinite(num) ? num.toFixed(decimals) : "--";
}

function formatUptime(totalSec) {
  const sec = Math.max(0, Math.floor(Number(totalSec) || 0));
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  return `${h}j ${m}m ${s}d`;
}

function formatTime(isoStr) {
  if (!isoStr) return "--";
  const d = new Date(isoStr);
  return Number.isNaN(d.getTime()) ? "--" : d.toLocaleTimeString("id-ID");
}

function formatDateTime(isoStr) {
  if (!isoStr) return "--";
  const d = new Date(isoStr);
  return Number.isNaN(d.getTime()) ? "--" : d.toLocaleString("id-ID");
}

function setText(id, value) {
  const el = document.getElementById(id);
  if (el) el.textContent = value;
}

function setStateBadge(id, isOn) {
  const el = document.getElementById(id);
  if (!el) return;
  el.textContent = isOn ? "ON" : "OFF";
  el.className = "state-badge " + (isOn ? "on" : "off");
}

function setQualityTag(id, label, level) {
  const el = document.getElementById(id);
  if (!el) return;
  el.textContent = label;
  el.className = "quality-tag " + level;
}

function canUserControl() {
  if (appState.settings.mode === "simulator") return true;
  if (appState.settings.mode === "firebase") return true;
  return Boolean(appState.user) && ["admin", "operator"].includes(appState.role);
}

// ----------------------------------------------------------------------------
// NAVIGASI 6 HALAMAN & UI RESPONSIVE
// ----------------------------------------------------------------------------
const PAGE_META = {
  overview: {
    title: "Overview Sistem",
    subtitle: "Ringkasan kondisi kelistrikan, termal panel, koneksi ESP32, dan status aktuator"
  },
  electrical: {
    title: "Electrical Monitoring",
    subtitle: "Parameter detail tegangan, arus, daya aktif, energi, frekuensi, dan faktor daya"
  },
  environment: {
    title: "Environment Monitoring",
    subtitle: "Pemantauan suhu internal panel (DS18B20), suhu udara (DHT22), dan kelembapan"
  },
  control: {
    title: "Device Control",
    subtitle: "Pengaturan mode AUTO/MANUAL dan kendali jarak jauh Kipas, AC, Buzzer, dan Lampu"
  },
  history: {
    title: "History & Analytics",
    subtitle: "Analisis tren historis, kalkulasi energi periode, audit aktivitas, dan export CSV"
  },
  settings: {
    title: "Settings & Konfigurasi",
    subtitle: "Konfigurasi backend, ambang batas suhu, autentikasi pengguna, dan uji simulasi"
  }
};

function navigateTo(pageKey) {
  if (!PAGE_META[pageKey]) return;
  appState.activePage = pageKey;

  document.querySelectorAll(".page").forEach((el) => el.classList.remove("active"));
  document.getElementById(`page-${pageKey}`)?.classList.add("active");

  document.querySelectorAll(".nav-item").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.page === pageKey);
  });

  setText("pageTitle", PAGE_META[pageKey].title);
  setText("pageSubtitle", PAGE_META[pageKey].subtitle);

  // Tutup sidebar mobile setelah memilih halaman
  document.getElementById("sidebar")?.classList.remove("open");
  document.getElementById("sidebarBackdrop")?.classList.remove("show");

  if (pageKey === "history") {
    loadHistoryData();
  }
}

// ----------------------------------------------------------------------------
// INISIALISASI GRAFIK CHART.JS
// ----------------------------------------------------------------------------
function createLineChart(canvasId, datasets, yAxes = {}) {
  const ctx = document.getElementById(canvasId);
  if (!ctx || typeof window.Chart === "undefined") return null;

  return new window.Chart(ctx, {
    type: "line",
    data: { labels: [], datasets },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: { duration: 200 },
      interaction: { mode: "index", intersect: false },
      plugins: {
        legend: { labels: { color: "#cbd5e1", boxWidth: 12 } }
      },
      scales: {
        x: {
          ticks: { color: "#94a3b8", maxTicksLimit: 8 },
          grid: { color: "rgba(148,163,184,0.1)" }
        },
        ...yAxes
      }
    }
  });
}

function initCharts() {
  if (typeof window.Chart === "undefined") return;

  charts.elPower = createLineChart(
    "electricalPowerChart",
    [
      { label: "Daya (W)", data: [], borderColor: "#10b981", backgroundColor: "rgba(16,185,129,0.15)", tension: 0.3, yAxisID: "y" },
      { label: "Arus (A)", data: [], borderColor: "#06b6d4", tension: 0.3, yAxisID: "y1" }
    ],
    {
      y: { position: "left", ticks: { color: "#10b981" }, grid: { color: "rgba(148,163,184,0.1)" } },
      y1: { position: "right", ticks: { color: "#06b6d4" }, grid: { drawOnChartArea: false } }
    }
  );

  charts.elVoltage = createLineChart(
    "electricalVoltageChart",
    [
      { label: "Tegangan (V)", data: [], borderColor: "#3b82f6", tension: 0.3, yAxisID: "y" },
      { label: "Power Factor", data: [], borderColor: "#f59e0b", tension: 0.3, yAxisID: "y1" }
    ],
    {
      y: { position: "left", ticks: { color: "#3b82f6" }, grid: { color: "rgba(148,163,184,0.1)" } },
      y1: { position: "right", min: 0, max: 1.05, ticks: { color: "#f59e0b" }, grid: { drawOnChartArea: false } }
    }
  );

  charts.env = createLineChart(
    "environmentChart",
    [
      { label: "Suhu Panel (°C)", data: [], borderColor: "#ef4444", tension: 0.3, yAxisID: "y" },
      { label: "Suhu Udara (°C)", data: [], borderColor: "#f59e0b", tension: 0.3, yAxisID: "y" },
      { label: "Kelembapan (%)", data: [], borderColor: "#38bdf8", tension: 0.3, yAxisID: "y1" }
    ],
    {
      y: { position: "left", ticks: { color: "#fca5a5" }, grid: { color: "rgba(148,163,184,0.1)" } },
      y1: { position: "right", min: 0, max: 100, ticks: { color: "#38bdf8" }, grid: { drawOnChartArea: false } }
    }
  );

  charts.histPower = createLineChart(
    "historyPowerChart",
    [
      { label: "Daya (W)", data: [], borderColor: "#10b981", tension: 0.25, yAxisID: "y" },
      { label: "Arus (A)", data: [], borderColor: "#06b6d4", tension: 0.25, yAxisID: "y1" }
    ],
    {
      y: { position: "left", ticks: { color: "#10b981" }, grid: { color: "rgba(148,163,184,0.1)" } },
      y1: { position: "right", ticks: { color: "#06b6d4" }, grid: { drawOnChartArea: false } }
    }
  );

  charts.histTemp = createLineChart(
    "historyTempChart",
    [
      { label: "Suhu Panel (°C)", data: [], borderColor: "#ef4444", tension: 0.25, yAxisID: "y" },
      { label: "Suhu Udara (°C)", data: [], borderColor: "#f59e0b", tension: 0.25, yAxisID: "y" }
    ],
    {
      y: { position: "left", ticks: { color: "#fca5a5" }, grid: { color: "rgba(148,163,184,0.1)" } }
    }
  );
}

function pushRealtimePoint(t) {
  appState.realtimeSeries.push({
    label: formatTime(t.last_seen_at || new Date().toISOString()),
    power: Number(t.power) || 0,
    current: Number(t.current) || 0,
    voltage: Number(t.voltage) || 0,
    pf: Number(t.power_factor) || 0,
    tempPanel: Number(t.temp_panel) || 0,
    tempAir: Number(t.temp_air) || 0,
    humidity: Number(t.humidity) || 0
  });

  if (appState.realtimeSeries.length > MAX_REALTIME_POINTS) {
    appState.realtimeSeries.shift();
  }

  const labels = appState.realtimeSeries.map((p) => p.label);

  if (charts.elPower) {
    charts.elPower.data.labels = labels;
    charts.elPower.data.datasets[0].data = appState.realtimeSeries.map((p) => p.power);
    charts.elPower.data.datasets[1].data = appState.realtimeSeries.map((p) => p.current);
    charts.elPower.update("none");
  }

  if (charts.elVoltage) {
    charts.elVoltage.data.labels = labels;
    charts.elVoltage.data.datasets[0].data = appState.realtimeSeries.map((p) => p.voltage);
    charts.elVoltage.data.datasets[1].data = appState.realtimeSeries.map((p) => p.pf);
    charts.elVoltage.update("none");
  }

  if (charts.env) {
    charts.env.data.labels = labels;
    charts.env.data.datasets[0].data = appState.realtimeSeries.map((p) => p.tempPanel);
    charts.env.data.datasets[1].data = appState.realtimeSeries.map((p) => p.tempAir);
    charts.env.data.datasets[2].data = appState.realtimeSeries.map((p) => p.humidity);
    charts.env.update("none");
  }
}

// ----------------------------------------------------------------------------
// RENDER SELURUH UI DARI STATE
// ----------------------------------------------------------------------------
function renderAll() {
  const t = appState.telemetry;
  const c = appState.config;

  setText("sidebarDeviceId", appState.settings.deviceId);
  renderTopbarBadges();

  // --- HALAMAN 1: OVERVIEW ---
  setText("ovWifiStatus", t.wifi_connected ? "TERHUBUNG" : "TERPUTUS");
  setText("ovLastSeen", "Update: " + formatTime(t.last_seen_at));
  setText("ovMode", t.actual_mode);
  setText("ovModeHint", t.actual_mode === "AUTO" ? "Kendali otomatis suhu" : "Kendali manual operator");
  setText("ovUptime", formatUptime(t.uptime_seconds));

  const deltaT = (Number(t.temp_panel) || 0) - (Number(t.temp_air) || 0);
  setText("ovThermalDelta", `ΔT Panel-Udara: ${deltaT >= 0 ? "+" : ""}${deltaT.toFixed(1)} °C`);
  const thermalHealth =
    t.temp_panel >= c.temp_threshold_alarm
      ? "KRITIS (OVERHEAT)"
      : t.temp_panel >= c.temp_threshold_ac
        ? "HANGAT"
        : "AMAN";
  setText("ovThermalHealth", thermalHealth);

  setText("ovVoltage", formatNum(t.voltage, 1));
  setText("ovCurrent", formatNum(t.current, 2));
  setText("ovPower", formatNum(t.power, 0));
  setText("ovEnergy", formatNum(t.energy, 3));
  setText("ovFrequency", formatNum(t.frequency, 1));
  setText("ovPf", formatNum(t.power_factor, 2));

  setText("ovTempPanel", `${formatNum(t.temp_panel, 1)} °C`);
  setText("ovTempAir", `${formatNum(t.temp_air, 1)} °C`);
  setText("ovHumidity", `${formatNum(t.humidity, 1)} %`);

  setStateBadge("ovFanBadge", t.actual_fan);
  setStateBadge("ovAcBadge", t.actual_ac);
  setStateBadge("ovBuzzerBadge", t.actual_buzzer);
  setStateBadge("ovLampBadge", t.actual_lamp);

  // --- HALAMAN 2: ELECTRICAL ---
  const v = Number(t.voltage) || 0;
  const i = Number(t.current) || 0;
  const pf = Number(t.power_factor) || 0;
  const freq = Number(t.frequency) || 0;
  const kwh = Number(t.energy) || 0;

  setText("elVoltage", formatNum(v, 1));
  setText("elCurrent", formatNum(i, 2));
  setText("elApparentPower", formatNum(v * i, 0));
  setText("elPower", formatNum(t.power, 0));
  setText("elEnergy", formatNum(kwh, 3));
  setText("elFrequency", formatNum(freq, 1));
  setText("elPf", formatNum(pf, 2));
  setText("elEstCost", "Rp " + Math.round(kwh * 1445).toLocaleString("id-ID"));

  if (v === 0) setQualityTag("elVoltageQuality", "0 V / Padam", "warn");
  else if (v >= 207 && v <= 242) setQualityTag("elVoltageQuality", "Normal", "good");
  else setQualityTag("elVoltageQuality", "Tegangan Abnormal", "bad");

  if (freq === 0) setQualityTag("elFreqQuality", "Tidak Terbaca", "warn");
  else if (freq >= 49.5 && freq <= 50.5) setQualityTag("elFreqQuality", "Stabil", "good");
  else setQualityTag("elFreqQuality", "Deviasi", "warn");

  if (pf >= 0.85) setQualityTag("elPfQuality", "Efisien", "good");
  else if (pf > 0) setQualityTag("elPfQuality", "PF Rendah", "warn");
  else setQualityTag("elPfQuality", "--", "neutral");

  // --- HALAMAN 3: ENVIRONMENT ---
  const tp = Number(t.temp_panel) || 0;
  const hum = Number(t.humidity) || 0;
  setText("envTempPanel", formatNum(tp, 1));
  setText("envTempAir", formatNum(t.temp_air, 1));
  setText("envHumidity", formatNum(hum, 1));
  setText("envDeltaTemp", `${deltaT >= 0 ? "+" : ""}${deltaT.toFixed(1)}`);
  setText("envThFan", formatNum(c.temp_threshold_fan, 1));
  setText("envThAc", formatNum(c.temp_threshold_ac, 1));
  setText("envThAlarm", formatNum(c.temp_threshold_alarm, 1));

  if (tp >= c.temp_threshold_alarm) setQualityTag("envPanelZone", "KRITIS", "bad");
  else if (tp >= c.temp_threshold_fan) setQualityTag("envPanelZone", "Waspada", "warn");
  else setQualityTag("envPanelZone", "Normal", "good");

  if (hum > 75) setQualityTag("envHumidityZone", "Terlalu Lembap", "warn");
  else if (hum < 30 && hum > 0) setQualityTag("envHumidityZone", "Kering", "warn");
  else setQualityTag("envHumidityZone", "Ideal", "good");

  // --- HALAMAN 4: CONTROL ---
  renderControlPage();

  // --- ACTIVITY FEED & ALERTS ---
  renderActivityFeed();
  evaluateAlerts();
}

function renderTopbarBadges() {
  const modeMap = {
    simulator: "Mode: Simulasi Interaktif",
    supabase: "Mode: Supabase Cloud",
    firebase: "Mode: Firebase Legacy"
  };
  setText("backendBadge", modeMap[appState.settings.mode] || "Mode: Unknown");

  if (appState.settings.mode === "simulator") {
    setText("userRoleLabel", "Demo Admin");
  } else if (appState.settings.mode === "firebase") {
    setText("userRoleLabel", "Firebase Anon");
  } else if (appState.user) {
    setText("userRoleLabel", `${appState.user.email} (${appState.role.toUpperCase()})`);
  } else {
    setText("userRoleLabel", "Belum Login");
  }

  updateHeartbeatBadge();
}

function updateHeartbeatBadge() {
  const badge = document.getElementById("heartbeatBadge");
  if (!badge) return;

  const lastMs = new Date(appState.telemetry.last_seen_at).getTime();
  const ageSec = Number.isFinite(lastMs) ? Math.max(0, Math.floor((Date.now() - lastMs) / 1000)) : 9999;

  if (ageSec <= 15 && appState.telemetry.wifi_connected) {
    badge.className = "pill pill-online";
    badge.textContent = `● ESP32: ONLINE (${ageSec}d lalu)`;
  } else {
    badge.className = "pill pill-offline";
    badge.textContent = ageSec > 3600 ? "● ESP32: OFFLINE" : `● ESP32: OFFLINE (${ageSec}d lalu)`;
  }
}

function evaluateAlerts() {
  const banner = document.getElementById("alertBanner");
  const iconEl = document.getElementById("alertBannerIcon");
  const textEl = document.getElementById("alertBannerText");
  if (!banner || !iconEl || !textEl) return;

  const tp = Number(appState.telemetry.temp_panel) || 0;
  const alarmTh = Number(appState.config.temp_threshold_alarm) || 45;
  const lastMs = new Date(appState.telemetry.last_seen_at).getTime();
  const offline = !Number.isFinite(lastMs) || Date.now() - lastMs > 15000;

  if (tp >= alarmTh) {
    banner.className = "alert-banner";
    iconEl.textContent = "🔥";
    textEl.textContent = `PERINGATAN OVERHEAT: Suhu panel mencapai ${tp.toFixed(1)}°C (Batas darurat ${alarmTh}°C). Sistem fail-safe aktif!`;
  } else if (offline && appState.settings.mode !== "simulator") {
    banner.className = "alert-banner warning";
    iconEl.textContent = "📡";
    textEl.textContent = "Koneksi ESP32 tidak mengirim heartbeat lebih dari 15 detik. Periksa catu daya atau jaringan WiFi panel.";
  } else {
    banner.className = "alert-banner hidden";
  }
}

function renderControlPage() {
  const c = appState.config;
  const t = appState.telemetry;
  const allowed = canUserControl();
  const isManual = c.target_mode === "MANUAL";

  document.getElementById("controlGuardBanner")?.classList.toggle("hidden", allowed);

  const btnAuto = document.getElementById("btnModeAuto");
  const btnManual = document.getElementById("btnModeManual");
  if (btnAuto && btnManual) {
    btnAuto.classList.toggle("active", !isManual);
    btnManual.classList.toggle("active", isManual);
    btnAuto.disabled = !allowed;
    btnManual.disabled = !allowed;
  }

  const bindings = [
    { input: "ctrlFan", targetText: "targetFanText", actualText: "actualFanText", targetVal: c.target_fan, actualVal: t.actual_fan, autoLocked: true },
    { input: "ctrlAc", targetText: "targetAcText", actualText: "actualAcText", targetVal: c.target_ac, actualVal: t.actual_ac, autoLocked: true },
    { input: "ctrlBuzzer", targetText: "targetBuzzerText", actualText: "actualBuzzerText", targetVal: c.target_buzzer, actualVal: t.actual_buzzer, autoLocked: true },
    { input: "ctrlLamp", targetText: "targetLampText", actualText: "actualLampText", targetVal: c.target_lamp, actualVal: t.actual_lamp, autoLocked: false }
  ];

  bindings.forEach((b) => {
    const inp = document.getElementById(b.input);
    if (inp) {
      inp.checked = Boolean(b.targetVal);
      inp.disabled = !allowed || (b.autoLocked && !isManual);
    }
    setText(b.targetText, b.targetVal ? "ON" : "OFF");
    setText(b.actualText, b.actualVal ? "ON" : "OFF");
  });

  const inSync =
    c.target_mode === t.actual_mode &&
    (!isManual ||
      (c.target_fan === t.actual_fan &&
        c.target_ac === t.actual_ac &&
        c.target_buzzer === t.actual_buzzer)) &&
    c.target_lamp === t.actual_lamp;

  setText(
    "syncStatusNote",
    inSync
      ? "Status sinkronisasi perintah: Tersinkronisasi dengan ESP32"
      : "Status sinkronisasi perintah: Menunggu konfirmasi dari ESP32..."
  );
}

function renderActivityFeed() {
  const feedEl = document.getElementById("overviewActivityList");
  const tableBody = document.getElementById("historyActivityBody");
  const logs = appState.activityLogs || [];

  if (feedEl) {
    feedEl.replaceChildren();
    if (logs.length === 0) {
      const li = document.createElement("li");
      li.className = "empty-note";
      li.textContent = "Belum ada catatan aktivitas sistem.";
      feedEl.appendChild(li);
    } else {
      logs.slice(0, 6).forEach((item) => {
        const li = document.createElement("li");
        const meta = document.createElement("div");
        meta.className = "activity-meta";
        const actor = document.createElement("span");
        actor.textContent = `${item.actor_type} • ${item.actor_name}`;
        const time = document.createElement("span");
        time.textContent = formatTime(item.created_at);
        meta.append(actor, time);

        const desc = document.createElement("div");
        desc.textContent = item.description;
        li.append(meta, desc);
        feedEl.appendChild(li);
      });
    }
  }

  if (tableBody) {
    tableBody.replaceChildren();
    if (logs.length === 0) {
      const tr = document.createElement("tr");
      const td = document.createElement("td");
      td.colSpan = 5;
      td.className = "empty-note";
      td.textContent = "Belum ada catatan aktivitas.";
      tr.appendChild(td);
      tableBody.appendChild(tr);
    } else {
      logs.slice(0, 40).forEach((item) => {
        const tr = document.createElement("tr");
        [
          formatDateTime(item.created_at),
          item.actor_type,
          item.actor_name,
          item.event_type,
          item.description
        ].forEach((val) => {
          const td = document.createElement("td");
          td.textContent = val || "--";
          tr.appendChild(td);
        });
        tableBody.appendChild(tr);
      });
    }
  }
}

// ----------------------------------------------------------------------------
// PENGIRIMAN PERINTAH KONTROL & THRESHOLD KE BACKEND AKTIF
// ----------------------------------------------------------------------------
async function updateControlConfig(patch, descriptionText) {
  if (!canUserControl()) {
    alert("Anda tidak memiliki hak akses kontrol. Silakan login sebagai Admin atau Operator.");
    return;
  }

  appState.config = { ...appState.config, ...patch };
  renderControlPage();

  const mode = appState.settings.mode;

  if (mode === "simulator") {
    addLocalActivity("USER", "Demo Admin", "CONTROL_COMMAND", descriptionText);
    evaluateSimulatorPhysics(1);
    renderAll();
    return;
  }

  if (mode === "supabase" && supabaseClient) {
    const { error } = await supabaseClient
      .from("panel_config")
      .update(patch)
      .eq("device_id", appState.settings.deviceId);

    if (error) {
      alert("Gagal mengirim perintah ke Supabase: " + error.message);
      await fetchSupabaseInitialState();
    }
    return;
  }

  if (mode === "firebase" && window.__firebaseBridge) {
    try {
      await window.__firebaseBridge.writeControl(patch);
      addLocalActivity("USER", "Firebase Anon", "CONTROL_COMMAND", descriptionText);
      renderActivityFeed();
    } catch (err) {
      alert("Gagal mengirim perintah ke Firebase RTDB (periksa Firebase Rules): " + err.message);
    }
  }
}

function addLocalActivity(actorType, actorName, eventType, description) {
  appState.activityLogs.unshift({
    actor_type: actorType,
    actor_name: actorName,
    event_type: eventType,
    description,
    created_at: new Date().toISOString()
  });
  if (appState.activityLogs.length > 100) appState.activityLogs.pop();
}

// ----------------------------------------------------------------------------
// MODE 1: SIMULATOR FISIKA PANEL LISTRIK (INTERAKTIF TANPA HARDWARE)
// ----------------------------------------------------------------------------
function seedSimulatorHistory() {
  const now = Date.now();
  const points = [];
  let energyAcc = 142.0;

  for (let i = 47; i >= 0; i--) {
    const ts = new Date(now - i * 30 * 60 * 1000);
    const hour = ts.getHours();
    const peakLoad = hour >= 8 && hour <= 17 ? 1.0 : 0.45;
    const voltage = 220 + Math.sin(i * 0.4) * 2.1;
    const current = Number((3.2 * peakLoad + Math.random() * 1.6).toFixed(2));
    const pf = Number((0.91 + Math.random() * 0.05).toFixed(2));
    const power = Math.round(voltage * current * pf);
    energyAcc += (power / 1000) * 0.5;
    const tempAir = Number((27.5 + peakLoad * 2.5 + Math.sin(i * 0.3)).toFixed(1));
    const tempPanel = Number((tempAir + 2.2 + current * 0.45).toFixed(1));

    points.push({
      recorded_at: ts.toISOString(),
      voltage: Number(voltage.toFixed(1)),
      current,
      power,
      energy: Number(energyAcc.toFixed(3)),
      frequency: 50.0,
      power_factor: pf,
      temp_air: tempAir,
      temp_panel: tempPanel,
      humidity: Number((65 - peakLoad * 6).toFixed(1)),
      mode: "AUTO",
      fan: tempPanel >= 32,
      ac: tempPanel >= 35,
      buzzer: false,
      lamp: hour >= 18 || hour <= 5
    });
  }

  appState.historyLogs = points;
  appState.telemetry.energy = energyAcc;
  appState.activityLogs = [
    {
      actor_type: "SYSTEM",
      actor_name: "Simulator",
      event_type: "BOOT",
      description: "Simulator panel listrik aktif (data uji 24 jam dimuat).",
      created_at: new Date().toISOString()
    }
  ];
}

function evaluateSimulatorPhysics(dtSec) {
  const t = appState.telemetry;
  const c = appState.config;

  t.uptime_seconds += dtSec;
  t.wifi_connected = true;
  t.last_seen_at = new Date().toISOString();

  // Simulasi suhu berdasarkan beban dan pendingin aktif
  const ambientTarget = 29.0 + appState.simTargetTempOffset;
  const coolingEffect = (t.actual_fan ? 2.8 : 0) + (t.actual_ac ? 5.2 : 0);
  const targetPanelTemp = ambientTarget + 2.5 - coolingEffect + (Math.random() - 0.5) * 0.4;

  t.temp_air = Number((t.temp_air + (ambientTarget - t.temp_air) * 0.2).toFixed(1));
  t.temp_panel = Number((t.temp_panel + (targetPanelTemp - t.temp_panel) * 0.25).toFixed(1));
  t.humidity = Number(Math.min(95, Math.max(35, 64 - (t.temp_air - 28) * 1.2)).toFixed(1));

  // Logika kontrol identik dengan firmware ESP32
  const prevFan = t.actual_fan;
  const prevAc = t.actual_ac;
  const prevBuzzer = t.actual_buzzer;

  if (c.target_mode === "AUTO") {
    t.actual_mode = "AUTO";
    if (t.temp_panel >= c.temp_threshold_fan) t.actual_fan = true;
    else if (t.temp_panel <= c.temp_threshold_fan - 1.5) t.actual_fan = false;

    if (t.temp_panel >= c.temp_threshold_ac) t.actual_ac = true;
    else if (t.temp_panel <= c.temp_threshold_ac - 1.5) t.actual_ac = false;

    t.actual_buzzer = t.temp_panel >= c.temp_threshold_alarm;
    t.actual_lamp = c.target_lamp;
  } else {
    t.actual_mode = "MANUAL";
    t.actual_fan = c.target_fan;
    t.actual_ac = c.target_ac;
    t.actual_buzzer = c.target_buzzer;
    t.actual_lamp = c.target_lamp;

    // Fail-safe overheat override di mode manual
    if (t.temp_panel >= c.temp_threshold_alarm) {
      t.actual_fan = true;
      t.actual_ac = true;
      t.actual_buzzer = true;
    }
  }

  if (prevFan !== t.actual_fan || prevAc !== t.actual_ac || prevBuzzer !== t.actual_buzzer) {
    addLocalActivity(
      "ESP32",
      appState.settings.deviceId,
      t.actual_buzzer ? "ALARM_TRIGGERED" : "STATE_SYNC",
      `Status aktual [${t.actual_mode}] -> Kipas:${t.actual_fan ? "ON" : "OFF"}, AC:${t.actual_ac ? "ON" : "OFF"}, Buzzer:${t.actual_buzzer ? "ON" : "OFF"} (${t.temp_panel}°C)`
    );
  }

  // Simulasi beban kelistrikan (bertambah saat AC/Kipas/Lampu menyala)
  const baseCurrent = 2.6 + (Math.sin(t.uptime_seconds / 10) * 0.35);
  const actuatorCurrent =
    (t.actual_fan ? 0.45 : 0) +
    (t.actual_ac ? 3.8 : 0) +
    (t.actual_lamp ? 0.25 : 0);

  t.voltage = Number((221.0 + (Math.random() - 0.5) * 2.0).toFixed(1));
  t.current = Number((baseCurrent + actuatorCurrent).toFixed(2));
  t.power_factor = Number((0.92 + (t.actual_ac ? 0.03 : 0) + (Math.random() - 0.5) * 0.02).toFixed(2));
  t.power = Math.round(t.voltage * t.current * t.power_factor);
  t.frequency = Number((50.0 + (Math.random() - 0.5) * 0.1).toFixed(1));
  t.energy = Number((t.energy + (t.power / 1000) * (dtSec / 3600)).toFixed(4));
}

function startSimulatorMode() {
  stopActiveConnections();
  appState.role = "admin";
  if (appState.historyLogs.length === 0) seedSimulatorHistory();

  evaluateSimulatorPhysics(2);
  pushRealtimePoint(appState.telemetry);
  renderAll();
  if (appState.activePage === "history") loadHistoryData();

  simIntervalId = setInterval(() => {
    evaluateSimulatorPhysics(2);
    pushRealtimePoint(appState.telemetry);
    renderAll();
  }, 2000);
}

// ----------------------------------------------------------------------------
// MODE 2: SUPABASE CLOUD (POSTGRESQL + AUTH + REALTIME)
// ----------------------------------------------------------------------------
async function startSupabaseMode() {
  stopActiveConnections();
  const { supabaseUrl, supabaseAnonKey } = appState.settings;

  if (!supabaseUrl || !supabaseAnonKey || supabaseUrl.includes("PROJECT_ID_ANDA")) {
    alert("URL atau Anon Key Supabase belum diisi. Silakan lengkapi di Halaman Settings.");
    navigateTo("settings");
    renderAll();
    return;
  }

  try {
    const { createClient } = await import("https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm");
    supabaseClient = createClient(supabaseUrl, supabaseAnonKey);

    const { data: sessionData } = await supabaseClient.auth.getSession();
    if (sessionData?.session?.user) {
      await handleSupabaseUser(sessionData.session.user);
    } else {
      appState.user = null;
      appState.role = "viewer";
      renderAll();
      openLoginModal();
    }

    supabaseClient.auth.onAuthStateChange(async (_event, session) => {
      if (session?.user) {
        await handleSupabaseUser(session.user);
      } else {
        appState.user = null;
        appState.role = "viewer";
        unsubscribeSupabaseRealtime();
        renderAll();
      }
    });
  } catch (err) {
    console.error("Gagal memuat SDK Supabase:", err);
    alert("Gagal menghubungkan ke Supabase: " + err.message);
  }
}

async function handleSupabaseUser(user) {
  appState.user = user;
  const { data: roleRow } = await supabaseClient
    .from("user_roles")
    .select("role")
    .eq("user_id", user.id)
    .maybeSingle();

  appState.role = roleRow?.role || "viewer";
  await fetchSupabaseInitialState();
  subscribeSupabaseRealtime();
  renderAll();
  updateAuthUI();
}

async function fetchSupabaseInitialState() {
  if (!supabaseClient) return;
  const deviceId = appState.settings.deviceId;

  const [stateRes, cfgRes, actRes] = await Promise.all([
    supabaseClient.from("panel_state").select("*").eq("device_id", deviceId).maybeSingle(),
    supabaseClient.from("panel_config").select("*").eq("device_id", deviceId).maybeSingle(),
    supabaseClient
      .from("activity_logs")
      .select("*")
      .eq("device_id", deviceId)
      .order("created_at", { ascending: false })
      .limit(30)
  ]);

  if (stateRes.data) {
    appState.telemetry = stateRes.data;
    pushRealtimePoint(stateRes.data);
  }
  if (cfgRes.data) {
    appState.config = cfgRes.data;
    syncThresholdInputs();
  }
  if (actRes.data) {
    appState.activityLogs = actRes.data;
  }
  renderAll();
}

function subscribeSupabaseRealtime() {
  unsubscribeSupabaseRealtime();
  if (!supabaseClient) return;
  const deviceId = appState.settings.deviceId;

  const ch = supabaseClient
    .channel(`panel-${deviceId}`)
    .on(
      "postgres_changes",
      { event: "*", schema: "public", table: "panel_state", filter: `device_id=eq.${deviceId}` },
      (payload) => {
        if (payload.new) {
          appState.telemetry = payload.new;
          pushRealtimePoint(payload.new);
          renderAll();
        }
      }
    )
    .on(
      "postgres_changes",
      { event: "*", schema: "public", table: "panel_config", filter: `device_id=eq.${deviceId}` },
      (payload) => {
        if (payload.new) {
          appState.config = payload.new;
          syncThresholdInputs();
          renderAll();
        }
      }
    )
    .on(
      "postgres_changes",
      { event: "INSERT", schema: "public", table: "activity_logs", filter: `device_id=eq.${deviceId}` },
      (payload) => {
        if (payload.new) {
          appState.activityLogs.unshift(payload.new);
          renderActivityFeed();
        }
      }
    )
    .subscribe();

  supabaseChannels.push(ch);
}

function unsubscribeSupabaseRealtime() {
  if (supabaseClient && supabaseChannels.length > 0) {
    supabaseChannels.forEach((ch) => supabaseClient.removeChannel(ch));
  }
  supabaseChannels = [];
}

// ----------------------------------------------------------------------------
// MODE 3: FIREBASE LEGACY RTDB BRIDGE (SDK v10.14.1)
// ----------------------------------------------------------------------------
async function startFirebaseMode() {
  stopActiveConnections();
  appState.role = "admin";
  const { firebaseDbUrl, firebaseApiKey } = appState.settings;

  try {
    const [{ initializeApp, getApps }, { getDatabase, ref, onValue, update }, { getAuth, signInAnonymously }] =
      await Promise.all([
        import("https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js"),
        import("https://www.gstatic.com/firebasejs/10.14.1/firebase-database.js"),
        import("https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js")
      ]);

    const appName = "legacy-bridge";
    const existing = getApps().find((a) => a.name === appName);
    const fbApp =
      existing ||
      initializeApp(
        {
          apiKey: firebaseApiKey,
          databaseURL: firebaseDbUrl
        },
        appName
      );

    const db = getDatabase(fbApp);
    const auth = getAuth(fbApp);

    await signInAnonymously(auth);
    const telemetryRef = ref(db, "panel/telemetry");

    const unsub = onValue(telemetryRef, (snapshot) => {
      const d = snapshot.val();
      if (!d) return;

      const elec = d.electrical || {};
      const out = d.output || {};
      const mapped = {
        voltage: Number(elec.voltage ?? 0),
        current: Number(elec.current ?? 0),
        power: Number(elec.power ?? 0),
        energy: Number(elec.energy ?? 0),
        frequency: Number(elec.frequency ?? 0),
        power_factor: Number(elec.powerFactor ?? 0),
        temp_air: Number(d.temperature?.air ?? 0),
        temp_panel: Number(d.temperature?.panel ?? 0),
        humidity: Number(d.humidity ?? 0),
        actual_mode: d.mode || "AUTO",
        actual_fan: Boolean(out.fan),
        actual_ac: Boolean(out.ac),
        actual_buzzer: Boolean(out.buzzer),
        actual_lamp: Boolean(out.lamp),
        uptime_seconds: Number(d.uptimeSeconds ?? 0),
        wifi_connected: Boolean(d.wifiConnected),
        last_seen_at: new Date().toISOString()
      };

      appState.telemetry = mapped;
      appState.config.target_mode = mapped.actual_mode;
      appState.config.target_fan = mapped.actual_fan;
      appState.config.target_ac = mapped.actual_ac;
      appState.config.target_buzzer = mapped.actual_buzzer;
      appState.config.target_lamp = mapped.actual_lamp;

      appState.historyLogs.push({ ...mapped, recorded_at: mapped.last_seen_at, mode: mapped.actual_mode, fan: mapped.actual_fan, ac: mapped.actual_ac, buzzer: mapped.actual_buzzer, lamp: mapped.actual_lamp });
      if (appState.historyLogs.length > 500) appState.historyLogs.shift();

      pushRealtimePoint(mapped);
      renderAll();
    });

    window.__firebaseBridge = {
      unsubscribe: unsub,
      writeControl: async (patch) => {
        const fbPatch = {};
        if (patch.target_mode !== undefined) fbPatch["mode"] = patch.target_mode;
        if (patch.target_fan !== undefined) fbPatch["output/fan"] = patch.target_fan;
        if (patch.target_ac !== undefined) fbPatch["output/ac"] = patch.target_ac;
        if (patch.target_buzzer !== undefined) fbPatch["output/buzzer"] = patch.target_buzzer;
        if (patch.target_lamp !== undefined) fbPatch["output/lamp"] = patch.target_lamp;
        await update(telemetryRef, fbPatch);
      }
    };
  } catch (err) {
    console.error("Firebase Legacy Bridge error:", err);
    alert("Gagal terhubung ke Firebase RTDB: " + err.message);
  }
}

function stopActiveConnections() {
  if (simIntervalId) {
    clearInterval(simIntervalId);
    simIntervalId = null;
  }
  unsubscribeSupabaseRealtime();
  if (window.__firebaseBridge?.unsubscribe) {
    window.__firebaseBridge.unsubscribe();
    window.__firebaseBridge = null;
  }
}

// ----------------------------------------------------------------------------
// HALAMAN 5: HISTORI, ANALITIK & EXPORT CSV
// ----------------------------------------------------------------------------
async function loadHistoryData() {
  const range = document.getElementById("historyRangeSelect")?.value || "24h";
  const now = new Date();
  let start = new Date(now.getTime() - 24 * 3600 * 1000);
  let end = now;

  if (range === "1h") start = new Date(now.getTime() - 1 * 3600 * 1000);
  else if (range === "7d") start = new Date(now.getTime() - 7 * 24 * 3600 * 1000);
  else if (range === "30d") start = new Date(now.getTime() - 30 * 24 * 3600 * 1000);
  else if (range === "custom") {
    const sVal = document.getElementById("historyStartDate")?.value;
    const eVal = document.getElementById("historyEndDate")?.value;
    if (sVal) start = new Date(sVal + "T00:00:00");
    if (eVal) end = new Date(eVal + "T23:59:59");
  }

  let rows = [];
  if (appState.settings.mode === "supabase" && supabaseClient && appState.user) {
    const { data, error } = await supabaseClient
      .from("telemetry_logs")
      .select("*")
      .eq("device_id", appState.settings.deviceId)
      .gte("recorded_at", start.toISOString())
      .lte("recorded_at", end.toISOString())
      .order("recorded_at", { ascending: true })
      .limit(1000);

    if (!error && data) rows = data;
  } else {
    rows = appState.historyLogs.filter((r) => {
      const ts = new Date(r.recorded_at).getTime();
      return ts >= start.getTime() && ts <= end.getTime();
    });
  }

  appState.filteredHistory = rows;
  renderHistoryAnalytics(rows);
}

function renderHistoryAnalytics(rows) {
  if (!rows || rows.length === 0) {
    setText("histPeakPower", "0");
    setText("histAvgTemp", "--");
    setText("histDeltaEnergy", "0.000");
    setText("histAvgPf", "--");
  } else {
    const peakPower = Math.max(...rows.map((r) => Number(r.power) || 0));
    const avgTemp = rows.reduce((sum, r) => sum + (Number(r.temp_panel) || 0), 0) / rows.length;
    const avgPf = rows.reduce((sum, r) => sum + (Number(r.power_factor) || 0), 0) / rows.length;
    const firstE = Number(rows[0].energy) || 0;
    const lastE = Number(rows[rows.length - 1].energy) || 0;
    const deltaE = Math.max(0, lastE - firstE);

    setText("histPeakPower", peakPower.toFixed(0));
    setText("histAvgTemp", avgTemp.toFixed(1));
    setText("histDeltaEnergy", deltaE.toFixed(3));
    setText("histAvgPf", avgPf.toFixed(2));
  }

  const labels = rows.map((r) => formatDateTime(r.recorded_at));
  if (charts.histPower) {
    charts.histPower.data.labels = labels;
    charts.histPower.data.datasets[0].data = rows.map((r) => r.power);
    charts.histPower.data.datasets[1].data = rows.map((r) => r.current);
    charts.histPower.update();
  }
  if (charts.histTemp) {
    charts.histTemp.data.labels = labels;
    charts.histTemp.data.datasets[0].data = rows.map((r) => r.temp_panel);
    charts.histTemp.data.datasets[1].data = rows.map((r) => r.temp_air);
    charts.histTemp.update();
  }
}

function exportHistoryCsv() {
  const rows = appState.filteredHistory || appState.historyLogs || [];
  if (rows.length === 0) {
    alert("Tidak ada data histori untuk diexport.");
    return;
  }

  const headers = [
    "recorded_at", "voltage_V", "current_A", "power_W", "energy_kWh",
    "frequency_Hz", "power_factor", "temp_air_C", "temp_panel_C",
    "humidity_pct", "mode", "fan", "ac", "buzzer", "lamp"
  ];

  const lines = [
    headers.join(","),
    ...rows.map((r) =>
      [
        r.recorded_at, r.voltage, r.current, r.power, r.energy,
        r.frequency, r.power_factor, r.temp_air, r.temp_panel,
        r.humidity, r.mode || r.actual_mode, r.fan, r.ac, r.buzzer, r.lamp
      ].join(",")
    )
  ];

  const blob = new Blob([lines.join("\n")], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `telemetry_${appState.settings.deviceId}_${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

// ----------------------------------------------------------------------------
// SETTINGS, AUTH MODAL & EVENT BINDING
// ----------------------------------------------------------------------------
function syncSettingsForm() {
  const s = appState.settings;
  document.getElementById("cfgBackendMode").value = s.mode;
  document.getElementById("cfgSupabaseUrl").value = s.supabaseUrl;
  document.getElementById("cfgSupabaseKey").value = s.supabaseAnonKey;
  document.getElementById("cfgDeviceId").value = s.deviceId;
  document.getElementById("cfgFirebaseDbUrl").value = s.firebaseDbUrl;
  document.getElementById("cfgFirebaseApiKey").value = s.firebaseApiKey;

  toggleBackendFields(s.mode);
  syncThresholdInputs();
  updateAuthUI();
}

function syncThresholdInputs() {
  const c = appState.config;
  document.getElementById("cfgThFan").value = c.temp_threshold_fan;
  document.getElementById("cfgThAc").value = c.temp_threshold_ac;
  document.getElementById("cfgThAlarm").value = c.temp_threshold_alarm;
  document.getElementById("cfgLogInterval").value = c.log_interval_seconds;
}

function toggleBackendFields(mode) {
  document.getElementById("supabaseFields")?.classList.toggle("hidden", mode !== "supabase");
  document.getElementById("firebaseFields")?.classList.toggle("hidden", mode !== "firebase");
  document.getElementById("simulatorLabBox")?.classList.toggle("hidden", mode !== "simulator");
}

function updateAuthUI() {
  const isSupa = appState.settings.mode === "supabase";
  const loggedIn = Boolean(appState.user);
  document.getElementById("btnOpenLoginModal")?.classList.toggle("hidden", !isSupa || loggedIn);
  document.getElementById("btnLogoutSupabase")?.classList.toggle("hidden", !isSupa || !loggedIn);

  if (!isSupa) {
    setText("settingsAuthSummary", "Autentikasi Supabase hanya aktif ketika Mode Sumber Data disetel ke Supabase Cloud.");
  } else if (loggedIn) {
    setText("settingsAuthSummary", `Login sebagai ${appState.user.email} | Role: ${appState.role.toUpperCase()}`);
  } else {
    setText("settingsAuthSummary", "Belum login ke Supabase. Silakan login untuk membaca telemetry dan mengontrol perangkat.");
  }
}

function openLoginModal() {
  document.getElementById("loginErrorMsg")?.classList.add("hidden");
  document.getElementById("loginModal")?.classList.remove("hidden");
}

function closeLoginModal() {
  document.getElementById("loginModal")?.classList.add("hidden");
}

function startActiveBackend() {
  const mode = appState.settings.mode;
  syncSettingsForm();
  if (mode === "supabase") startSupabaseMode();
  else if (mode === "firebase") startFirebaseMode();
  else startSimulatorMode();
}

function bindEvents() {
  // Navigasi Sidebar & Shortcut
  document.querySelectorAll(".nav-item").forEach((btn) => {
    btn.addEventListener("click", () => navigateTo(btn.dataset.page));
  });
  document.querySelectorAll("[data-goto]").forEach((btn) => {
    btn.addEventListener("click", () => navigateTo(btn.dataset.goto));
  });

  // Mobile Menu Drawer
  document.getElementById("menuToggleBtn")?.addEventListener("click", () => {
    document.getElementById("sidebar")?.classList.toggle("open");
    document.getElementById("sidebarBackdrop")?.classList.toggle("show");
  });
  document.getElementById("sidebarBackdrop")?.addEventListener("click", () => {
    document.getElementById("sidebar")?.classList.remove("open");
    document.getElementById("sidebarBackdrop")?.classList.remove("show");
  });

  // Kontrol Mode & Aktuator (Halaman 4)
  document.getElementById("btnModeAuto")?.addEventListener("click", () => {
    updateControlConfig({ target_mode: "AUTO" }, "Mode diubah ke AUTO");
  });
  document.getElementById("btnModeManual")?.addEventListener("click", () => {
    updateControlConfig({ target_mode: "MANUAL" }, "Mode diubah ke MANUAL");
  });

  document.getElementById("ctrlFan")?.addEventListener("change", (e) => {
    updateControlConfig({ target_fan: e.target.checked }, `Kipas disetel ${e.target.checked ? "ON" : "OFF"}`);
  });
  document.getElementById("ctrlAc")?.addEventListener("change", (e) => {
    updateControlConfig({ target_ac: e.target.checked }, `AC Split disetel ${e.target.checked ? "ON" : "OFF"}`);
  });
  document.getElementById("ctrlBuzzer")?.addEventListener("change", (e) => {
    updateControlConfig({ target_buzzer: e.target.checked }, `Buzzer disetel ${e.target.checked ? "ON" : "OFF"}`);
  });
  document.getElementById("ctrlLamp")?.addEventListener("change", (e) => {
    updateControlConfig({ target_lamp: e.target.checked }, `Lampu disetel ${e.target.checked ? "ON" : "OFF"}`);
  });

  // Halaman 5: Filter Histori & Export
  document.getElementById("historyRangeSelect")?.addEventListener("change", (e) => {
    document.getElementById("customDateWrap")?.classList.toggle("hidden", e.target.value !== "custom");
  });
  document.getElementById("btnLoadHistory")?.addEventListener("click", loadHistoryData);
  document.getElementById("btnExportCsv")?.addEventListener("click", exportHistoryCsv);

  // Halaman 6: Settings Backend
  document.getElementById("cfgBackendMode")?.addEventListener("change", (e) => {
    toggleBackendFields(e.target.value);
  });

  document.getElementById("backendConfigForm")?.addEventListener("submit", (e) => {
    e.preventDefault();
    saveSettingsToStorage({
      mode: document.getElementById("cfgBackendMode").value,
      supabaseUrl: document.getElementById("cfgSupabaseUrl").value.trim().replace(/\/$/, ""),
      supabaseAnonKey: document.getElementById("cfgSupabaseKey").value.trim(),
      deviceId: document.getElementById("cfgDeviceId").value.trim() || "panel-utama-01",
      firebaseDbUrl: document.getElementById("cfgFirebaseDbUrl").value.trim(),
      firebaseApiKey: document.getElementById("cfgFirebaseApiKey").value.trim()
    });
    appState.realtimeSeries = [];
    appState.historyLogs = [];
    appState.filteredHistory = [];
    appState.activityLogs = [];
    startActiveBackend();
    alert("Konfigurasi sumber data berhasil diterapkan.");
  });

  // Halaman 6: Simpan Threshold
  document.getElementById("thresholdForm")?.addEventListener("submit", async (e) => {
    e.preventDefault();
    const fan = Number(document.getElementById("cfgThFan").value);
    const ac = Number(document.getElementById("cfgThAc").value);
    const alarm = Number(document.getElementById("cfgThAlarm").value);
    const interval = Number(document.getElementById("cfgLogInterval").value);

    if (fan >= alarm || ac > alarm) {
      alert("Ambang batas Kipas/AC harus lebih rendah daripada Ambang Alarm Overheat.");
      return;
    }

    await updateControlConfig(
      {
        temp_threshold_fan: fan,
        temp_threshold_ac: ac,
        temp_threshold_alarm: alarm,
        log_interval_seconds: interval
      },
      `Threshold diperbarui [Fan:${fan}°C, AC:${ac}°C, Alarm:${alarm}°C]`
    );
    alert("Ambang batas suhu berhasil disimpan.");
  });

  // Tombol Uji Simulasi
  document.getElementById("btnSimNormal")?.addEventListener("click", () => {
    appState.simTargetTempOffset = 0;
  });
  document.getElementById("btnSimWarm")?.addEventListener("click", () => {
    appState.simTargetTempOffset = 10;
  });
  document.getElementById("btnSimOverheat")?.addEventListener("click", () => {
    appState.simTargetTempOffset = 22;
  });

  // Auth Modal
  document.getElementById("authActionBtn")?.addEventListener("click", () => {
    if (appState.settings.mode === "supabase" && !appState.user) openLoginModal();
    else navigateTo("settings");
  });
  document.getElementById("btnOpenLoginModal")?.addEventListener("click", openLoginModal);
  document.getElementById("closeLoginModalBtn")?.addEventListener("click", closeLoginModal);

  document.getElementById("supabaseLoginForm")?.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (!supabaseClient) return;
    const email = document.getElementById("loginEmail").value.trim();
    const password = document.getElementById("loginPassword").value;
    const errEl = document.getElementById("loginErrorMsg");

    const { error } = await supabaseClient.auth.signInWithPassword({ email, password });
    if (error) {
      errEl.textContent = "Login gagal: " + error.message;
      errEl.classList.remove("hidden");
    } else {
      closeLoginModal();
    }
  });

  document.getElementById("btnLogoutSupabase")?.addEventListener("click", async () => {
    if (supabaseClient) await supabaseClient.auth.signOut();
  });
}

// ----------------------------------------------------------------------------
// INISIALISASI SAAT HALAMAN SIAP
// ----------------------------------------------------------------------------
document.addEventListener("DOMContentLoaded", () => {
  initCharts();
  bindEvents();
  startActiveBackend();

  // Perbarui indikator umur heartbeat setiap 1 detik
  heartbeatTimerId = setInterval(() => {
    updateHeartbeatBadge();
    evaluateAlerts();
  }, 1000);
});

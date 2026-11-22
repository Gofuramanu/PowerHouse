/**
 * ============================================================================
 * FIRMWARE ESP32 (SUPABASE EDITION) — DISESUAIKAN DENGAN KENDALI_AKUISISI.INO
 * ============================================================================
 * Spesifikasi Hardware & Logika (100% cocok dengan rangkaian teman Anda):
 * - Sensor: DHT22 (GPIO 4), DS18B20 (GPIO 5), PZEM-004T v3.0 (UART2 RX:16, TX:17)
 * - Layar Lokal: LCD 16x2 I2C (0x27, SDA: GPIO 21, SCL: GPIO 22)
 * - Output Relay (Active-LOW): Kipas (GPIO 25), AC Split (GPIO 26)
 * - Output Driver (Active-HIGH): Buzzer BC547 (GPIO 27), Lampu Indikator (GPIO 14)
 * - Proteksi Kompresor AC: AC_RESTART_DELAY 180 detik (3 menit)
 * - Batas Suhu Default: Kipas (ON 30C / OFF 28C), AC (ON 35C / OFF 32C), Alarm (40C)
 * - Lampu Indikator menyala otomatis saat beban (Kipas atau AC) aktif, atau saat
 *   dinyalakan manual dari dashboard.
 * ============================================================================
 */

#include <WiFi.h>
#include <HTTPClient.h>
#include <WiFiClientSecure.h>
#include <ArduinoJson.h>
#include <DHT.h>
#include <OneWire.h>
#include <DallasTemperature.h>
#include <PZEM004Tv30.h>
#include <Wire.h>
#include <LiquidCrystal_I2C.h>
#include <esp_task_wdt.h>

// Salin config.example.h menjadi config.h lalu isi kredensial WiFi & Supabase
#include "config.h"

// ----------------------------------------------------------------------------
// OBJEK SENSOR DAN MODUL
// ----------------------------------------------------------------------------
DHT dht(DHT_PIN, DHT_TYPE);
OneWire oneWire(ONE_WIRE_PIN);
DallasTemperature ds18b20(&oneWire);
PZEM004Tv30 pzem(Serial2, PZEM_RX_PIN, PZEM_TX_PIN);
LiquidCrystal_I2C lcd(LCD_ADDRESS, 16, 2);

// ----------------------------------------------------------------------------
// VARIABEL SISTEM
// ----------------------------------------------------------------------------
float airTemperature = NAN;
float panelTemperature = NAN;
float humidity = NAN;

float voltage = NAN;
float current = NAN;
float power = NAN;
float energy = NAN;
float frequency = NAN;
float powerFactor = NAN;

bool fanState = false;
bool acState = false;
bool buzzerState = false;
bool lampState = false;

String controlMode = "AUTO";
bool manualFanCommand = false;
bool manualACCommand = false;
bool manualLampCommand = false;

float thresholdFanOn = DEFAULT_FAN_ON_TEMP;
float thresholdAcOn = DEFAULT_AC_ON_TEMP;
float thresholdAlarm = DEFAULT_ALARM_TEMP;

unsigned long lastSensorRead = 0;
unsigned long lastSyncAttempt = 0;
unsigned long lastSuccessfulSync = 0;
unsigned long lastLCDUpdate = 0;
unsigned long lastWifiReconnect = 0;
unsigned long acLastOffMillis = 0;
bool hasSyncedOnce = false;

// ----------------------------------------------------------------------------
// FUNGSI RELAY & OUTPUT (PERSIS KENDALI_AKUISISI.INO)
// ----------------------------------------------------------------------------
void writeRelay(uint8_t pin, bool state) {
  if (RELAY_ACTIVE_LOW) {
    digitalWrite(pin, state ? LOW : HIGH);
  } else {
    digitalWrite(pin, state ? HIGH : LOW);
  }
}

void setFan(bool state) {
  fanState = state;
  writeRelay(RELAY_FAN_PIN, state);
}

void setAC(bool state) {
  // Perintah OFF selalu dapat dilakukan seketika
  if (!state) {
    if (acState) {
      acState = false;
      writeRelay(RELAY_AC_PIN, false);
      acLastOffMillis = millis();
    }
    return;
  }

  // Proteksi kompresor: jangan menyalakan kembali sebelum jeda 180 detik selesai
  if (!acState && (millis() - acLastOffMillis >= AC_RESTART_DELAY_MS)) {
    acState = true;
    writeRelay(RELAY_AC_PIN, true);
  }
}

void updateAlarmAndLamp() {
  // Alarm aktif jika temperatur panel mencapai batas alarm (default 40.0 C)
  buzzerState = (!isnan(panelTemperature) && panelTemperature >= thresholdAlarm);

  // Lampu indikator menyala jika salah satu beban (Kipas / AC) aktif atau diaktifkan dari web
  lampState = fanState || acState || manualLampCommand;

  // Buzzer 5V dikendalikan melalui transistor BC547 (Active-HIGH)
  digitalWrite(BUZZER_PIN, buzzerState ? HIGH : LOW);

  // GPIO 14 mengendalikan driver lampu indikator (Active-HIGH)
  digitalWrite(LAMP_PIN, lampState ? HIGH : LOW);
}

// ----------------------------------------------------------------------------
// PEMBACAAN SENSOR
// ----------------------------------------------------------------------------
void readSensors() {
  float h = dht.readHumidity();
  float t = dht.readTemperature();
  if (!isnan(h)) humidity = h;
  if (!isnan(t)) airTemperature = t;

  ds18b20.requestTemperatures();
  float panelT = ds18b20.getTempCByIndex(0);
  if (panelT != DEVICE_DISCONNECTED_C && panelT > -55.0f && panelT < 125.0f) {
    panelTemperature = panelT;
  }

  voltage = pzem.voltage();
  current = pzem.current();
  power = pzem.power();
  energy = pzem.energy();
  frequency = pzem.frequency();
  powerFactor = pzem.pf();
}

// ----------------------------------------------------------------------------
// KENDALI OTOMATIS & MANUAL + FAIL-SAFE
// ----------------------------------------------------------------------------
void automaticControl() {
  if (isnan(panelTemperature)) {
    setFan(false);
    setAC(false);
    updateAlarmAndLamp();
    return;
  }

  float fanOffTemp = thresholdFanOn - HYSTERESIS_FAN_C;
  float acOffTemp = thresholdAcOn - HYSTERESIS_AC_C;

  // Kendali kipas dengan hysteresis (Default: ON >= 30C, OFF <= 28C)
  if (panelTemperature >= thresholdFanOn) {
    setFan(true);
  } else if (panelTemperature <= fanOffTemp) {
    setFan(false);
  }

  // Kendali AC dengan hysteresis (Default: ON >= 35C, OFF <= 32C)
  if (panelTemperature >= thresholdAcOn) {
    setAC(true);
  } else if (panelTemperature <= acOffTemp) {
    setAC(false);
  }

  updateAlarmAndLamp();
}

void manualControl() {
  setFan(manualFanCommand);
  setAC(manualACCommand);

  // Fail-Safe Overheat: jika di mode MANUAL suhu panel menembus batas alarm, paksa pendingin ON
  if (!isnan(panelTemperature) && panelTemperature >= thresholdAlarm) {
    setFan(true);
    setAC(true);
  }

  updateAlarmAndLamp();
}

void evaluateControl() {
  bool wifiConnected = (WiFi.status() == WL_CONNECTED);
  bool cloudOffline = (!hasSyncedOnce) || ((millis() - lastSuccessfulSync) > OFFLINE_FAILSAFE_MS);

  // Jika koneksi terputus > 15 detik, jalankan kendali otomatis lokal demi keamanan panel
  if (controlMode == "AUTO" || !wifiConnected || cloudOffline) {
    automaticControl();
  } else {
    manualControl();
  }
}

// ----------------------------------------------------------------------------
// TAMPILAN LCD 16x2 I2C (PERSIS KENDALI_AKUISISI.INO)
// ----------------------------------------------------------------------------
void updateLCD() {
  lcd.clear();

  lcd.setCursor(0, 0);
  lcd.print("Panel:");
  if (isnan(panelTemperature)) {
    lcd.print("--.-");
  } else {
    lcd.print(panelTemperature, 1);
  }
  lcd.print((char)223);
  lcd.print("C");

  lcd.setCursor(0, 1);
  lcd.print("V:");
  if (isnan(voltage)) {
    lcd.print("---");
  } else {
    lcd.print(voltage, 0);
  }

  lcd.print(" I:");
  if (isnan(current)) {
    lcd.print("--.-");
  } else {
    lcd.print(current, 1);
  }
  lcd.print("A");
}

// ----------------------------------------------------------------------------
// SINKRONISASI 2-ARAH KE SUPABASE RPC
// ----------------------------------------------------------------------------
void syncWithSupabase() {
  if (WiFi.status() != WL_CONNECTED) return;

  WiFiClientSecure client;
  client.setInsecure();

  HTTPClient http;
  String endpoint = String(SUPABASE_URL) + "/rest/v1/rpc/sync_esp32_telemetry";
  if (!http.begin(client, endpoint)) return;

  http.setTimeout(5000);
  http.addHeader("Content-Type", "application/json");
  http.addHeader("apikey", SUPABASE_ANON_KEY);
  http.addHeader("Authorization", String("Bearer ") + SUPABASE_ANON_KEY);

  JsonDocument payload;
  payload["p_device_id"] = DEVICE_ID;
  if (strlen(DEVICE_SECRET_KEY) > 0) {
    payload["p_device_key"] = DEVICE_SECRET_KEY;
  }

  if (isnan(voltage)) payload["p_voltage"] = nullptr;
  else payload["p_voltage"] = roundf(voltage * 100.0f) / 100.0f;

  payload["p_current"] = isnan(current) ? 0.0f : roundf(current * 1000.0f) / 1000.0f;
  payload["p_power"] = isnan(power) ? 0.0f : roundf(power * 100.0f) / 100.0f;
  payload["p_energy"] = isnan(energy) ? 0.0f : roundf(energy * 1000.0f) / 1000.0f;
  payload["p_frequency"] = isnan(frequency) ? 0.0f : roundf(frequency * 10.0f) / 10.0f;
  payload["p_power_factor"] = isnan(powerFactor) ? 0.0f : roundf(powerFactor * 100.0f) / 100.0f;
  payload["p_temp_air"] = isnan(airTemperature) ? 0.0f : roundf(airTemperature * 10.0f) / 10.0f;
  payload["p_temp_panel"] = isnan(panelTemperature) ? 0.0f : roundf(panelTemperature * 10.0f) / 10.0f;
  payload["p_humidity"] = isnan(humidity) ? 0.0f : roundf(humidity * 10.0f) / 10.0f;
  payload["p_actual_mode"] = controlMode;
  payload["p_actual_fan"] = fanState;
  payload["p_actual_ac"] = acState;
  payload["p_actual_buzzer"] = buzzerState;
  payload["p_actual_lamp"] = lampState;
  payload["p_uptime_seconds"] = (unsigned long)(millis() / 1000UL);
  payload["p_wifi_connected"] = true;
  payload["p_wifi_rssi"] = WiFi.RSSI();

  String body;
  serializeJson(payload, body);

  int httpCode = http.POST(body);
  if (httpCode >= 200 && httpCode < 300) {
    JsonDocument resDoc;
    if (!deserializeJson(resDoc, http.getString())) {
      String modeFromServer = resDoc["target_mode"] | "AUTO";
      modeFromServer.toUpperCase();
      if (modeFromServer == "AUTO" || modeFromServer == "MANUAL") {
        controlMode = modeFromServer;
      }
      manualFanCommand = resDoc["target_fan"] | false;
      manualACCommand = resDoc["target_ac"] | false;
      manualLampCommand = resDoc["target_lamp"] | false;
      thresholdFanOn = resDoc["temp_threshold_fan"] | DEFAULT_FAN_ON_TEMP;
      thresholdAcOn = resDoc["temp_threshold_ac"] | DEFAULT_AC_ON_TEMP;
      thresholdAlarm = resDoc["temp_threshold_alarm"] | DEFAULT_ALARM_TEMP;

      hasSyncedOnce = true;
      lastSuccessfulSync = millis();
      Serial.printf("[SYNC OK] Mode: %s | Panel: %.1f C | Fan:%d AC:%d\n",
                    controlMode.c_str(), panelTemperature, fanState, acState);
    }
  } else {
    Serial.printf("[HTTP ERR] %d: %s\n", httpCode, http.getString().c_str());
  }
  http.end();
}

// ----------------------------------------------------------------------------
// KONEKSI WIFI NON-BLOCKING
// ----------------------------------------------------------------------------
void maintainWiFi() {
  if (WiFi.status() == WL_CONNECTED) return;
  unsigned long now = millis();
  if (now - lastWifiReconnect >= 10000UL) {
    lastWifiReconnect = now;
    Serial.println("Menghubungkan ulang WiFi...");
    WiFi.disconnect(false);
    WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  }
}

// ----------------------------------------------------------------------------
// SETUP & LOOP
// ----------------------------------------------------------------------------
void setup() {
  Serial.begin(115200);

  pinMode(RELAY_FAN_PIN, OUTPUT);
  pinMode(RELAY_AC_PIN, OUTPUT);
  pinMode(BUZZER_PIN, OUTPUT);
  pinMode(LAMP_PIN, OUTPUT);

  writeRelay(RELAY_FAN_PIN, false);
  writeRelay(RELAY_AC_PIN, false);
  digitalWrite(BUZZER_PIN, LOW);
  digitalWrite(LAMP_PIN, LOW);

  acLastOffMillis = millis();

  dht.begin();
  ds18b20.begin();

  Wire.begin(LCD_SDA, LCD_SCL);
  lcd.init();
  lcd.backlight();
  lcd.setCursor(0, 0);
  lcd.print("Sistem Panel");
  lcd.setCursor(0, 1);
  lcd.print("Memulai...");

  WiFi.mode(WIFI_STA);
  WiFi.setAutoReconnect(true);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);

#if defined(ESP_ARDUINO_VERSION_MAJOR) && ESP_ARDUINO_VERSION_MAJOR >= 3
  esp_task_wdt_config_t wdt_config = {
    .timeout_ms = 20000,
    .idle_core_mask = (1 << portNUM_PROCESSORS) - 1,
    .trigger_panic = true
  };
  esp_task_wdt_init(&wdt_config);
#else
  esp_task_wdt_init(20, true);
#endif
  esp_task_wdt_add(NULL);

  readSensors();
  evaluateControl();
  updateLCD();
}

void loop() {
  esp_task_wdt_reset();
  unsigned long now = millis();

  maintainWiFi();

  if (now - lastSensorRead >= SENSOR_INTERVAL_MS) {
    lastSensorRead = now;
    readSensors();
    evaluateControl();
  }

  if (now - lastSyncAttempt >= SYNC_INTERVAL_MS) {
    lastSyncAttempt = now;
    syncWithSupabase();
    evaluateControl();
  }

  if (now - lastLCDUpdate >= LCD_INTERVAL_MS) {
    lastLCDUpdate = now;
    updateLCD();
  }
}

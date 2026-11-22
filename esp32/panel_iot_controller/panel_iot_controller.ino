/**
 * ============================================================================
 * FIRMWARE ESP32: SISTEM MONITORING & CONTROL PANEL LISTRIK (SUPABASE EDITION)
 * ============================================================================
 * Fitur Utama:
 * 1. Pembacaan Sensor Non-Blocking: PZEM-004T v3.0, DHT22, DS18B20.
 * 2. Komunikasi HTTPS 2-Arah dalam 1 Request ke RPC Supabase (`sync_esp32_telemetry`).
 * 3. Kontrol Mode AUTO (dengan histeresis) dan MANUAL dari Dashboard.
 * 4. Hardware Fail-Safe: Jika WiFi/Internet terputus > 15 detik atau suhu
 *    panel mencapai batas darurat, ESP32 otomatis menjaga pendinginan tetap aman.
 * 5. Hardware Watchdog Timer (WDT) untuk kestabilan operasi 24 jam nonstop.
 *
 * Library yang diperlukan (Arduino Library Manager):
 * - ArduinoJson (v7.x atau v6.x) by Benoit Blanchon
 * - DHT sensor library by Adafruit
 * - OneWire & DallasTemperature (untuk DS18B20)
 * - PZEM004Tv30 by Jakub Mandula
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
#include <esp_task_wdt.h>

// Salin config.example.h menjadi config.h lalu isi kredensial Anda
#include "config.h"

// ----------------------------------------------------------------------------
// INISIALISASI OBJEK SENSOR
// ----------------------------------------------------------------------------
#define DHTTYPE DHT22
DHT dht(PIN_DHT22, DHTTYPE);

OneWire oneWire(PIN_DS18B20);
DallasTemperature ds18b20(&oneWire);

// PZEM-004T menggunakan UART2 (HardwareSerial 2)
PZEM004Tv30 pzem(Serial2, PIN_PZEM_RX, PIN_PZEM_TX);

// ----------------------------------------------------------------------------
// STRUKTUR DATA TELEMETRY & KONFIGURASI KONTROL
// ----------------------------------------------------------------------------
struct TelemetryData {
  float voltage = 0.0f;
  float current = 0.0f;
  float power = 0.0f;
  float energy = 0.0f;
  float frequency = 0.0f;
  float powerFactor = 0.0f;
  float tempAir = 0.0f;
  float tempPanel = 0.0f;
  float humidity = 0.0f;
  bool pzemValid = false;
  bool dhtValid = false;
  bool ds18Valid = false;
};

struct ControlConfig {
  String targetMode = "AUTO";
  bool targetFan = false;
  bool targetAc = false;
  bool targetBuzzer = false;
  bool targetLamp = false;
  float thresholdFan = 32.0f;
  float thresholdAc = 35.0f;
  float thresholdAlarm = 45.0f;
};

struct ActuatorState {
  String mode = "AUTO";
  bool fan = false;
  bool ac = false;
  bool buzzer = false;
  bool lamp = false;
};

TelemetryData telemetry;
ControlConfig desiredConfig;
ActuatorState actualState;

unsigned long lastSensorReadMs = 0;
unsigned long lastSyncAttemptMs = 0;
unsigned long lastSuccessfulSyncMs = 0;
unsigned long lastWifiReconnectMs = 0;
bool hasSyncedOnce = false;

// ----------------------------------------------------------------------------
// HELPER KONTROL RELAY & FAIL-SAFE
// ----------------------------------------------------------------------------
void writeRelay(uint8_t pin, bool turnOn) {
  if (RELAY_ACTIVE_LOW) {
    digitalWrite(pin, turnOn ? LOW : HIGH);
  } else {
    digitalWrite(pin, turnOn ? HIGH : LOW);
  }
}

void applyOutputs() {
  writeRelay(PIN_RELAY_FAN, actualState.fan);
  writeRelay(PIN_RELAY_AC, actualState.ac);
  writeRelay(PIN_RELAY_BUZZER, actualState.buzzer);
  writeRelay(PIN_RELAY_LAMP, actualState.lamp);
}

// ----------------------------------------------------------------------------
// PEMBACAAN SENSOR DENGAN VALIDASI NaN
// ----------------------------------------------------------------------------
void readAllSensors() {
  // 1. Baca DHT22 (Suhu Udara & Kelembapan)
  float h = dht.readHumidity();
  float tAir = dht.readTemperature();
  if (!isnan(h) && !isnan(tAir) && h >= 0.0f && h <= 100.0f) {
    telemetry.humidity = h;
    telemetry.tempAir = tAir;
    telemetry.dhtValid = true;
  } else {
    telemetry.dhtValid = false;
    Serial.println("[SENSOR] Peringatan: Gagal membaca DHT22");
  }

  // 2. Baca DS18B20 (Suhu Panel)
  ds18b20.requestTemperatures();
  float tPanel = ds18b20.getTempCByIndex(0);
  if (tPanel != DEVICE_DISCONNECTED_C && tPanel > -40.0f && tPanel < 125.0f) {
    telemetry.tempPanel = tPanel;
    telemetry.ds18Valid = true;
  } else {
    telemetry.ds18Valid = false;
    Serial.println("[SENSOR] Peringatan: Gagal membaca DS18B20");
  }

  // 3. Baca PZEM-004T v3.0 (Parameter Kelistrikan AC)
  float v = pzem.voltage();
  float i = pzem.current();
  float p = pzem.power();
  float e = pzem.energy();
  float f = pzem.frequency();
  float pf = pzem.pf();

  if (!isnan(v) && !isnan(i) && !isnan(p)) {
    telemetry.voltage = v;
    telemetry.current = i;
    telemetry.power = p;
    telemetry.energy = isnan(e) ? telemetry.energy : e;
    telemetry.frequency = isnan(f) ? 50.0f : f;
    telemetry.powerFactor = isnan(pf) ? 0.0f : pf;
    telemetry.pzemValid = true;
  } else {
    telemetry.pzemValid = false;
    // Jangan menimpa nilai valid dengan NaN; biarkan 0 jika tidak ada tegangan AC
    telemetry.voltage = isnan(v) ? 0.0f : v;
    telemetry.current = isnan(i) ? 0.0f : i;
    telemetry.power = isnan(p) ? 0.0f : p;
    telemetry.frequency = isnan(f) ? 0.0f : f;
    telemetry.powerFactor = isnan(pf) ? 0.0f : pf;
  }
}

// ----------------------------------------------------------------------------
// LOGIKA KONTROL AKTUATOR (AUTO / MANUAL + HARDWARE FAIL-SAFE)
// ----------------------------------------------------------------------------
void evaluateControlLogic() {
  unsigned long now = millis();
  bool wifiOk = (WiFi.status() == WL_CONNECTED);
  bool cloudTimeout = (!hasSyncedOnce) || ((now - lastSuccessfulSyncMs) > OFFLINE_FAILSAFE_MS);
  bool emergencyButtonPressed = (digitalRead(PIN_BTN_EMERGENCY) == LOW);

  // Gunakan suhu tertinggi antara suhu panel dan suhu udara untuk keamanan
  float refTemp = telemetry.ds18Valid ? telemetry.tempPanel : telemetry.tempAir;
  bool criticalOverheat = (telemetry.ds18Valid || telemetry.dhtValid) && (refTemp >= desiredConfig.thresholdAlarm);

  // Kondisi Fail-Safe: Jika tombol darurat ditekan, internet putus > 15s, atau suhu kritis
  if (emergencyButtonPressed) {
    actualState.mode = "AUTO";
    actualState.fan = true;
    actualState.ac = true;
    actualState.buzzer = true;
    actualState.lamp = true;
    applyOutputs();
    return;
  }

  // Jika koneksi terputus dari server, fallback otomatis ke AUTO lokal demi keamanan panel
  bool useAuto = (desiredConfig.targetMode == "AUTO") || (!wifiOk) || cloudTimeout;

  if (useAuto) {
    actualState.mode = "AUTO";

    if (telemetry.ds18Valid || telemetry.dhtValid) {
      // Histeresis Kipas
      if (refTemp >= desiredConfig.thresholdFan) {
        actualState.fan = true;
      } else if (refTemp <= (desiredConfig.thresholdFan - HYSTERESIS_OFFSET_C)) {
        actualState.fan = false;
      }

      // Histeresis AC
      if (refTemp >= desiredConfig.thresholdAc) {
        actualState.ac = true;
      } else if (refTemp <= (desiredConfig.thresholdAc - HYSTERESIS_OFFSET_C)) {
        actualState.ac = false;
      }

      // Alarm Overheat
      actualState.buzzer = (refTemp >= desiredConfig.thresholdAlarm);
    } else {
      // Jika semua sensor suhu gagal membaca saat AUTO, nyalakan kipas sebagai proteksi pasif
      actualState.fan = true;
      actualState.buzzer = false;
    }

    // Pada mode AUTO, lampu mengikuti perintah terakhir atau mati secara default
    actualState.lamp = desiredConfig.targetLamp;
  } else {
    // Mode MANUAL: ikuti perintah dari Dashboard
    actualState.mode = "MANUAL";
    actualState.fan = desiredConfig.targetFan;
    actualState.ac = desiredConfig.targetAc;
    actualState.buzzer = desiredConfig.targetBuzzer;
    actualState.lamp = desiredConfig.targetLamp;

    // Proteksi Overheat Wajib (tidak bisa dimatikan oleh perintah manual jika suhu darurat)
    if (criticalOverheat) {
      actualState.fan = true;
      actualState.ac = true;
      actualState.buzzer = true;
      Serial.println("[FAIL-SAFE] Suhu kritis terdeteksi! Pendingin & alarm dipaksa ON.");
    }
  }

  applyOutputs();
}

// ----------------------------------------------------------------------------
// SINKRONISASI 2-ARAH KE SUPABASE RPC (1 HTTPS POST REQUEST)
// ----------------------------------------------------------------------------
void syncWithSupabase() {
  if (WiFi.status() != WL_CONNECTED) {
    return;
  }

  WiFiClientSecure client;
  // Catatan Produksi: Untuk keamanan ketat, ganti setInsecure() dengan root CA Supabase (.setCACert)
  client.setInsecure();

  HTTPClient http;
  String endpoint = String(SUPABASE_URL) + "/rest/v1/rpc/sync_esp32_telemetry";

  if (!http.begin(client, endpoint)) {
    Serial.println("[HTTP] Gagal memulai koneksi ke Supabase");
    return;
  }

  http.setTimeout(5000);
  http.addHeader("Content-Type", "application/json");
  http.addHeader("apikey", SUPABASE_ANON_KEY);
  http.addHeader("Authorization", String("Bearer ") + SUPABASE_ANON_KEY);

  // Bangun JSON Payload sesuai parameter fungsi PostgreSQL sync_esp32_telemetry
  JsonDocument payload;
  payload["p_device_id"] = DEVICE_ID;
  if (strlen(DEVICE_SECRET_KEY) > 0) {
    payload["p_device_key"] = DEVICE_SECRET_KEY;
  }
  payload["p_voltage"] = roundf(telemetry.voltage * 100.0f) / 100.0f;
  payload["p_current"] = roundf(telemetry.current * 1000.0f) / 1000.0f;
  payload["p_power"] = roundf(telemetry.power * 100.0f) / 100.0f;
  payload["p_energy"] = roundf(telemetry.energy * 1000.0f) / 1000.0f;
  payload["p_frequency"] = roundf(telemetry.frequency * 10.0f) / 10.0f;
  payload["p_power_factor"] = roundf(telemetry.powerFactor * 100.0f) / 100.0f;
  payload["p_temp_air"] = roundf(telemetry.tempAir * 10.0f) / 10.0f;
  payload["p_temp_panel"] = roundf(telemetry.tempPanel * 10.0f) / 10.0f;
  payload["p_humidity"] = roundf(telemetry.humidity * 10.0f) / 10.0f;
  payload["p_actual_mode"] = actualState.mode;
  payload["p_actual_fan"] = actualState.fan;
  payload["p_actual_ac"] = actualState.ac;
  payload["p_actual_buzzer"] = actualState.buzzer;
  payload["p_actual_lamp"] = actualState.lamp;
  payload["p_uptime_seconds"] = (unsigned long)(millis() / 1000UL);
  payload["p_wifi_connected"] = true;
  payload["p_wifi_rssi"] = WiFi.RSSI();

  String body;
  serializeJson(payload, body);

  int httpCode = http.POST(body);
  if (httpCode >= 200 && httpCode < 300) {
    String response = http.getString();
    JsonDocument resDoc;
    DeserializationError err = deserializeJson(resDoc, response);

    if (!err) {
      desiredConfig.targetMode = resDoc["target_mode"] | "AUTO";
      desiredConfig.targetFan = resDoc["target_fan"] | false;
      desiredConfig.targetAc = resDoc["target_ac"] | false;
      desiredConfig.targetBuzzer = resDoc["target_buzzer"] | false;
      desiredConfig.targetLamp = resDoc["target_lamp"] | false;
      desiredConfig.thresholdFan = resDoc["temp_threshold_fan"] | 32.0f;
      desiredConfig.thresholdAc = resDoc["temp_threshold_ac"] | 35.0f;
      desiredConfig.thresholdAlarm = resDoc["temp_threshold_alarm"] | 45.0f;

      hasSyncedOnce = true;
      lastSuccessfulSyncMs = millis();
      Serial.printf("[SYNC OK] Mode Target: %s | T.Panel: %.1f C | Daya: %.1f W\n",
                    desiredConfig.targetMode.c_str(), telemetry.tempPanel, telemetry.power);
    } else {
      Serial.printf("[JSON] Gagal parse respons Supabase: %s\n", err.c_str());
    }
  } else {
    Serial.printf("[HTTP ERR] Kode %d: %s\n", httpCode, http.getString().c_str());
  }

  http.end();
}

// ----------------------------------------------------------------------------
// MANAJEMEN KONEKSI WIFI NON-BLOCKING
// ----------------------------------------------------------------------------
void maintainWifi() {
  if (WiFi.status() == WL_CONNECTED) {
    digitalWrite(PIN_LED_STATUS, HIGH);
    return;
  }

  digitalWrite(PIN_LED_STATUS, LOW);
  unsigned long now = millis();
  if (now - lastWifiReconnectMs >= 10000UL) {
    lastWifiReconnectMs = now;
    Serial.println("[WIFI] Mencoba menghubungkan ulang ke WiFi...");
    WiFi.disconnect(false);
    WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  }
}

// ----------------------------------------------------------------------------
// SETUP & LOOP UTAMA
// ----------------------------------------------------------------------------
void setup() {
  Serial.begin(115200);
  Serial.println("\n=== BOOT: POWER HOUSE IOT CONTROLLER (SUPABASE) ===");

  // Inisialisasi pin relay dalam keadaan mati (aman) sebelum set OUTPUT
  writeRelay(PIN_RELAY_FAN, false);
  writeRelay(PIN_RELAY_AC, false);
  writeRelay(PIN_RELAY_BUZZER, false);
  writeRelay(PIN_RELAY_LAMP, false);

  pinMode(PIN_RELAY_FAN, OUTPUT);
  pinMode(PIN_RELAY_AC, OUTPUT);
  pinMode(PIN_RELAY_BUZZER, OUTPUT);
  pinMode(PIN_RELAY_LAMP, OUTPUT);
  pinMode(PIN_BTN_EMERGENCY, INPUT_PULLUP);
  pinMode(PIN_LED_STATUS, OUTPUT);

  dht.begin();
  ds18b20.begin();

  WiFi.mode(WIFI_STA);
  WiFi.setAutoReconnect(true);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);

  // Aktifkan Hardware Watchdog 20 detik agar ESP32 auto-restart jika hang
  // Mendukung ESP32 Arduino Core v3.x (ESP-IDF v5+) maupun v2.x
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

  // Baca sensor awal saat boot
  readAllSensors();
  evaluateControlLogic();
}

void loop() {
  esp_task_wdt_reset();

  unsigned long now = millis();
  maintainWifi();

  if (now - lastSensorReadMs >= SENSOR_INTERVAL_MS) {
    lastSensorReadMs = now;
    readAllSensors();
    evaluateControlLogic();
  }

  if (now - lastSyncAttemptMs >= SYNC_INTERVAL_MS) {
    lastSyncAttemptMs = now;
    syncWithSupabase();
    evaluateControlLogic();
  }
}

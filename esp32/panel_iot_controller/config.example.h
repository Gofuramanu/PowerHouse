#ifndef CONFIG_H
#define CONFIG_H

// ============================================================================
// KONFIGURASI FIRMWARE ESP32 — SALIN FILE INI MENJADI "config.h"
// Jangan commit file config.h yang berisi kredensial asli ke Git!
// ============================================================================

// 1. Kredensial WiFi
#define WIFI_SSID           "NAMA_WIFI_ANDA"
#define WIFI_PASSWORD       "PASSWORD_WIFI_ANDA"

// 2. Kredensial Supabase Backend
// Contoh URL: "https://abcdefghijklm.supabase.co" (tanpa garis miring di akhir)
#define SUPABASE_URL        "https://PROJECT_ID_ANDA.supabase.co"
// Gunakan ANON PUBLIC KEY (JANGAN pernah menanamkan service_role key di ESP32!)
#define SUPABASE_ANON_KEY   "SUPABASE_ANON_PUBLIC_KEY_ANDA"

// 3. Identitas Perangkat (DEVICE_SECRET_KEY opsional, biarkan "" jika tanpa kunci rahasia)
#define DEVICE_ID           "panel-utama-01"
#define DEVICE_SECRET_KEY   ""

// 4. Definisi Pinout GPIO ESP32 (Sesuaikan dengan wiring aktual panel)
#define PIN_DHT22           4     // Sensor Suhu Udara & Kelembapan (DHT22)
#define PIN_DS18B20         5     // Sensor Suhu Panel (DS18B20 1-Wire, pasang resistor pull-up 4.7k)

// Serial Hardware 2 (UART2) untuk Sensor Kelistrikan PZEM-004T v3.0
#define PIN_PZEM_RX         16    // Hubungkan ke TX PZEM-004T
#define PIN_PZEM_TX         17    // Hubungkan ke RX PZEM-004T

// Pin Output Relay Aktuator (Gunakan Active-LOW / Active-HIGH sesuai modul relay)
#define RELAY_ACTIVE_LOW    true  // Ubah ke false jika modul relay aktif pada logika HIGH
#define PIN_RELAY_FAN       25    // Kipas Pendingin Panel
#define PIN_RELAY_AC        26    // AC Split Ruangan / Panel
#define PIN_RELAY_BUZZER    27    // Buzzer Alarm Overheat / Trip
#define PIN_RELAY_LAMP      33    // Lampu Indikator / Penerangan Panel

// Tombol Manual Override Lokal & LED Status WiFi
#define PIN_BTN_EMERGENCY   14    // Tombol fisik darurat / override lokal (Active LOW)
#define PIN_LED_STATUS      2     // LED built-in ESP32

// 5. Pengaturan Interval & Fail-Safe
#define SENSOR_INTERVAL_MS        1000UL   // Baca sensor setiap 1 detik
#define SYNC_INTERVAL_MS          3000UL   // Kirim telemetry & ambil perintah tiap 3 detik
#define OFFLINE_FAILSAFE_MS       15000UL  // Masuk mode AUTO aman jika koneksi putus > 15 detik
#define HYSTERESIS_OFFSET_C       1.5f     // Histeresis suhu agar relay tidak cepat cetak-cetek

#endif

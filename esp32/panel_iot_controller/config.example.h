#ifndef CONFIG_H
#define CONFIG_H

// ============================================================================
// KONFIGURASI FIRMWARE ESP32 (DISESUAIKAN 100% DENGAN KENDALI_AKUISISI.INO)
// Salin file ini menjadi "config.h" dan isi kredensial WiFi & Supabase Anda.
// ============================================================================

// 1. Kredensial WiFi
#define WIFI_SSID           "NAMA_WIFI_ANDA"
#define WIFI_PASSWORD       "PASSWORD_WIFI_ANDA"

// 2. Kredensial Supabase Backend
#define SUPABASE_URL        "https://PROJECT_ID_ANDA.supabase.co"
#define SUPABASE_ANON_KEY   "SUPABASE_ANON_PUBLIC_KEY_ANDA"

// 3. Identitas Perangkat (DEVICE_SECRET_KEY opsional, biarkan "" jika tanpa kunci)
#define DEVICE_ID           "panel-utama-01"
#define DEVICE_SECRET_KEY   ""

// 4. Definisi Pinout GPIO ESP32 (Sesuai Hardware Asli Kendali_akuisisi.ino)
#define DHT_PIN             4     // Sensor Suhu Udara & Kelembapan (DHT22)
#define DHT_TYPE            DHT22
#define ONE_WIRE_PIN        5     // Sensor Suhu Panel (DS18B20 1-Wire)

// Serial Hardware 2 (UART2) untuk Sensor Kelistrikan PZEM-004T v3.0
#define PZEM_RX_PIN         16    // RX ESP32 (Hubungkan ke TX PZEM-004T)
#define PZEM_TX_PIN         17    // TX ESP32 (Hubungkan ke RX PZEM-004T)

// LCD I2C 16x2
#define LCD_SDA             21
#define LCD_SCL             22
#define LCD_ADDRESS         0x27  // Umum: 0x27 atau 0x3F

// Pin Output Relay & Indikator (Sesuai Hardware Asli)
#define RELAY_ACTIVE_LOW    true  // Relay Kipas & AC menggunakan logika Active-LOW
#define RELAY_FAN_PIN       25    // Relay Kipas Pendingin Panel
#define RELAY_AC_PIN        26    // Relay AC Split

// Buzzer (Transistor BC547) & Lampu Indikator menggunakan logika Active-HIGH
#define BUZZER_PIN          27    // Buzzer 5V via transistor BC547 (HIGH = ON)
#define LAMP_PIN            14    // Driver lampu indikator beban (HIGH = ON)

// 5. Batas Temperatur Default & Proteksi Kompresor AC (Sesuai Kendali_akuisisi.ino)
#define DEFAULT_FAN_ON_TEMP   30.0f
#define DEFAULT_FAN_OFF_TEMP  28.0f
#define DEFAULT_AC_ON_TEMP    35.0f
#define DEFAULT_AC_OFF_TEMP   32.0f
#define DEFAULT_ALARM_TEMP    40.0f
#define HYSTERESIS_FAN_C      2.0f   // Selisih ON (30C) dan OFF (28C)
#define HYSTERESIS_AC_C       3.0f   // Selisih ON (35C) dan OFF (32C)

// Jeda minimum 180 detik (3 menit) sebelum AC boleh dinyalakan kembali
#define AC_RESTART_DELAY_MS   180000UL

// 6. Interval Pembacaan & Sinkronisasi
#define SENSOR_INTERVAL_MS    2000UL   // Baca sensor setiap 2 detik
#define SYNC_INTERVAL_MS      3000UL   // Sinkronisasi Supabase setiap 3 detik
#define LCD_INTERVAL_MS       2000UL   // Update LCD 16x2 setiap 2 detik
#define OFFLINE_FAILSAFE_MS   15000UL  // Fallback ke AUTO jika internet putus > 15 detik

#endif

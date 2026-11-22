-- Skema database SQL untuk proyek monitoring panel listrik ESP32
-- Kompatibel dengan MySQL 8+ / MariaDB.
-- Catatan: Firebase Realtime Database yang digunakan sebelumnya adalah NoSQL,
-- jadi file ini merupakan skema SQL alternatif agar teman Anda dapat membuat
-- database relasional yang setara.

CREATE DATABASE IF NOT EXISTS panel_monitoring
  CHARACTER SET utf8mb4
  COLLATE utf8mb4_unicode_ci;

USE panel_monitoring;

-- Satu baris menyimpan satu rekaman telemetry dari ESP32.
CREATE TABLE IF NOT EXISTS panel_telemetry (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    device_id VARCHAR(100) NOT NULL DEFAULT 'panel',
    recorded_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,

    -- Sensor lingkungan
    temperature_air_c DECIMAL(6,2) NULL,
    temperature_panel_c DECIMAL(6,2) NULL,
    humidity_percent DECIMAL(6,2) NULL,

    -- Pengukuran listrik (misalnya dari PZEM)
    voltage_v DECIMAL(10,2) NULL,
    current_a DECIMAL(10,3) NULL,
    power_w DECIMAL(10,2) NULL,
    energy_kwh DECIMAL(12,3) NULL,
    frequency_hz DECIMAL(6,2) NULL,
    power_factor DECIMAL(5,3) NULL,

    -- Status kendali dan perangkat
    mode VARCHAR(20) NOT NULL DEFAULT 'AUTO',
    output_ac TINYINT(1) NOT NULL DEFAULT 0,
    output_buzzer TINYINT(1) NOT NULL DEFAULT 0,
    output_fan TINYINT(1) NOT NULL DEFAULT 0,
    output_lamp TINYINT(1) NOT NULL DEFAULT 0,

    -- Status koneksi dan waktu aktif ESP32
    uptime_seconds BIGINT UNSIGNED NULL,
    wifi_connected TINYINT(1) NOT NULL DEFAULT 0,

    PRIMARY KEY (id),
    INDEX idx_device_recorded (device_id, recorded_at),
    INDEX idx_recorded_at (recorded_at)
) ENGINE=InnoDB;

-- Contoh data berdasarkan struktur telemetry yang pernah tampil di Firebase.
-- Angka tegangan belum tersedia pada contoh tersebut, sehingga diisi NULL,
-- bukan 0 atau NaN.
INSERT INTO panel_telemetry (
    device_id,
    temperature_air_c,
    temperature_panel_c,
    humidity_percent,
    voltage_v,
    current_a,
    power_w,
    energy_kwh,
    frequency_hz,
    power_factor,
    mode,
    output_ac,
    output_buzzer,
    output_fan,
    output_lamp,
    uptime_seconds,
    wifi_connected
) VALUES (
    'panel',
    31.50,
    28.00,
    81.20,
    NULL,
    0.000,
    0.00,
    0.000,
    0.00,
    0.000,
    'AUTO',
    0,
    0,
    0,
    0,
    175,
    1
);

-- Contoh melihat 20 data terbaru:
-- SELECT * FROM panel_telemetry
-- WHERE device_id = 'panel'
-- ORDER BY recorded_at DESC
-- LIMIT 20;

-- Contoh mengambil data suhu, kelembapan, dan listrik:
-- SELECT recorded_at, temperature_air_c, temperature_panel_c,
--        humidity_percent, voltage_v, current_a, power_w
-- FROM panel_telemetry
-- WHERE device_id = 'panel'
-- ORDER BY recorded_at DESC;

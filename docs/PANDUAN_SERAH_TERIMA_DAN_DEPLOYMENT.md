# Panduan Teknis, Serah Terima, Migrasi & Deployment
## Sistem IoT Monitoring dan Control Panel Listrik Berbasis ESP32

Dokumen ini disusun sebagai panduan operasional lengkap agar proyek dapat dipindahkan ke perangkat maupun pengembang baru tanpa ketergantungan pada komputer pengembang sebelumnya.

---

## 1. Daftar Komponen Hardware & Sensor (Bill of Materials)

| No | Komponen | Tipe / Spesifikasi | Fungsi |
|---|---|---|---|
| 1 | Mikrokontroler | ESP32 DevKit V1 (30/38 pin, WiFi 2.4 GHz) | Pusat akuisisi data, logika fail-safe, & komunikasi HTTPS |
| 2 | Sensor Kelistrikan AC | PZEM-004T v3.0 + CT Coil (100A) | Mengukur Tegangan (V), Arus (A), Daya (W), Energi (kWh), Hz, PF |
| 3 | Sensor Suhu & Kelembapan Udara | DHT22 (AM2302) | Mengukur suhu udara ruangan & kelembapan relatif (%) |
| 4 | Sensor Suhu Internal Panel | DS18B20 (Probe Waterproof) + Resistor 4.7 kΩ | Mengukur suhu di dalam panel listrik / dekat busbar/MCB |
| 5 | Modul Relay Aktuator | Relay 4-Channel 5V (dengan Optocoupler) | Mengendalikan kontaktor Kipas, AC Split, Buzzer, & Lampu |
| 6 | Kontaktor / SSR (Beban Besar) | Kontaktor AC 220V sesuai daya beban | Memisahkan relay 5V dari arus tinggi Kipas/AC Split |
| 7 | Tombol Darurat Lokal | Push Button NO/NC | Override manual lokal di panel saat kondisi darurat |
| 8 | Catu Daya & Proteksi | PSU 5V DC 2A terisolasi + MCB 2A/6A + Fuse | Menjaga ESP32 stabil 24 jam & proteksi arus pendek |

> [!WARNING]
> **Keselamatan Kelistrikan:** Relay board 5V **tidak boleh** langsung memutus beban induktif besar (seperti kompresor AC Split) tanpa perantara **Kontaktor Magnetik** dan proteksi MCB/sekering yang sesuai kapasitas arus. Pastikan jalur AC 220V terisolasi secara fisik dari jalur DC 3.3V/5V ESP32.

---

## 2. Tabel Pinout & Wiring ESP32

Pinout berikut sesuai dengan template [`esp32/panel_iot_controller/config.example.h`](../esp32/panel_iot_controller/config.example.h):

| Pin GPIO ESP32 | Terhubung Ke | Keterangan Teknis (Sesuai `Kendali_akuisisi.ino`) |
|---|---|---|
| **GPIO 4** | Data DHT22 | Sensor suhu udara & kelembapan (`DHT_PIN = 4`) |
| **GPIO 5** | Data DS18B20 | Sensor suhu panel 1-Wire (`ONE_WIRE_PIN = 5`, pull-up 4.7 kΩ) |
| **GPIO 16 (RX2)** | TX PZEM-004T v3.0 | Komunikasi serial UART2 (`PZEM_RX_PIN = 16`) |
| **GPIO 17 (TX2)** | RX PZEM-004T v3.0 | Komunikasi serial UART2 (`PZEM_TX_PIN = 17`) |
| **GPIO 21 (SDA)** | SDA LCD 16x2 I2C | Layar LCD I2C 16x2 (`LCD_ADDRESS = 0x27`) |
| **GPIO 22 (SCL)** | SCL LCD 16x2 I2C | Clock I2C LCD 16x2 |
| **GPIO 25** | Relay Kipas Pendingin | `RELAY_ACTIVE_LOW = true` (`ON >= 30°C`, `OFF <= 28°C`) |
| **GPIO 26** | Relay AC Split | `RELAY_ACTIVE_LOW = true` (`ON >= 35°C`, `OFF <= 32°C`, jeda restart 180 detik) |
| **GPIO 27** | Buzzer 5V (BC547) | **Active-HIGH** via transistor BC547 (menyala saat suhu panel `>= 40°C`) |
| **GPIO 14** | Lampu Indikator | **Active-HIGH** driver lampu indikator (menyala saat Kipas atau AC aktif) |

---

## 3. Tahapan Migrasi Database ke Supabase (Backend Baru)

Pastikan seluruh akun dibuat menggunakan **email resmi pemilik proyek** (bukan akun pribadi pengembang lama).

### Langkah 3.1: Membuat Project Supabase
1. Buka [supabase.com](https://supabase.com) &rarr; buat Organization dan Project baru (pilih region terdekat, misalnya **Singapore `ap-southeast-1`**).
2. Catat **Project URL** dan **`anon` public key** dari menu **Project Settings &rarr; API**.
   - **Penting:** Jangan menyalin `service_role` key ke kode dashboard maupun ke kode ESP32.

### Langkah 3.2: Menjalankan Skema Database
1. Buka menu **SQL Editor** di Supabase Dashboard.
2. Salin seluruh isi file [`database/supabase_schema.sql`](../database/supabase_schema.sql) dan klik **Run**.
3. Pastikan tidak ada error. Script tersebut otomatis membuat:
   - Tabel `user_roles`, `devices`, `panel_state`, `panel_config`, `telemetry_logs`, dan `activity_logs`.
   - Fungsi RPC `sync_esp32_telemetry(...)` untuk komunikasi 2-arah ESP32.
   - Aturan keamanan **Row Level Security (RLS)** dan **Supabase Realtime**.

### Langkah 3.3: Mengubah Kunci Rahasia Perangkat ESP32
Pada bagian paling bawah `supabase_schema.sql`, perangkat `panel-utama-01` didaftarkan dengan kunci placeholder. Segera ganti dengan kunci rahasia acak Anda melalui SQL Editor:
```sql
UPDATE public.devices
SET device_secret_hash = encode(digest('KUNCI_RAHASIA_BARU_YANG_KUAT', 'sha256'), 'hex')
WHERE device_id = 'panel-utama-01';
```
*(Gunakan string acak minimal 24 karakter dan simpan string aslinya di `config.h` pada ESP32).*

### Langkah 3.4: Membuat Akun Pengguna & Menetapkan Role Admin
1. Masuk ke menu **Authentication &rarr; Users &rarr; Add User**, buat akun operator/admin (misal `admin@perusahaan.com`).
2. Secara default, trigger database memberi role `viewer` (hanya baca). Naikkan hak akses akun utama menjadi `admin` lewat SQL Editor:
```sql
UPDATE public.user_roles
SET role = 'admin'
WHERE email = 'admin@mail.com';
```
*(Role yang tersedia: `admin` = penuh, `operator` = monitoring + kontrol, `viewer` = hanya monitoring).*

---

## 4. Konfigurasi & Flashing Firmware ESP32

1. Install **Arduino IDE** (atau VS Code + PlatformIO).
2. Install Board Package **ESP32 by Espressif Systems** melalui Boards Manager.
3. Install library berikut melalui Library Manager:
   - `ArduinoJson` (by Benoit Blanchon)
   - `DHT sensor library` (by Adafruit) + `Adafruit Unified Sensor`
   - `OneWire` & `DallasTemperature`
   - `PZEM004Tv30` (by Jakub Mandula)
4. Masuk ke folder `esp32/panel_iot_controller/`, salin file `config.example.h` menjadi `config.h`.
5. Isi `WIFI_SSID`, `WIFI_PASSWORD`, `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `DEVICE_ID`, dan `DEVICE_SECRET_KEY` di dalam `config.h`.
6. Pilih board **ESP32 Dev Module**, pilih COM Port, lalu klik **Upload**.
7. Buka **Serial Monitor (115200 baud)** dan pastikan muncul log:
   `[SYNC OK] Mode Target: AUTO | T.Panel: ... C | Daya: ... W`

---

## 5. Cara Menjalankan Dashboard Web & Menghubungkan ke Supabase

1. Jalankan folder proyek melalui web server statis (misal **Live Server** di VS Code atau `npx serve .`).
2. Buka dashboard utama (`index.html`).
3. Masuk ke halaman **6. Settings**, ubah **Mode Sumber Data** menjadi **Supabase Cloud (PostgreSQL + Realtime)**, masukkan **Supabase Project URL**, **Anon Public Key**, dan **Device ID** (`panel-utama-01`), lalu klik **Simpan & Terapkan Koneksi**.
4. Login menggunakan email & password yang dibuat pada Langkah 3.4.
5. *(Opsional untuk Deployment Publik)*: Agar pengguna lain tidak perlu mengisi URL & Anon Key secara manual di Settings, Anda dapat mengisi nilai default di `defaultSettings` pada [`js/app.js`](../js/app.js) (hanya URL dan `anon` public key yang memang bersifat publik oleh arsitektur Supabase RLS).

---

## 6. Deployment Online (Vercel / Cloudflare Pages) & Git Serah Terima

### Langkah 6.1: Menyiapkan Repository Git
Jalankan perintah berikut di folder proyek (`d:\UNY\ambon\Kendali Akuisisi Data`) untuk menyimpan proyek ke GitHub milik pemilik proyek:
```bash
git init
git add .
git status   # Pastikan config.h dan .env TIDAK ikut masuk karena sudah di-.gitignore!
git commit -m "Initial release: IoT Panel Listrik ESP32 + Supabase + Dashboard 6 Halaman"
git branch -M main
git remote add origin https://github.com/ORGANISASI_PEMILIK/iot-panel-listrik.git
git push -u origin main
```

### Langkah 6.2: Deploy ke Vercel (Gratis & HTTPS Otomatis)
1. Masuk ke [vercel.com](https://vercel.com) menggunakan akun GitHub pemilik proyek.
2. Klik **Add New... &rarr; Project** &rarr; pilih repository `iot-panel-listrik`.
3. Biarkan **Framework Preset** pada `Other` (Static Site) dan **Output Directory** kosong (root `/`).
4. Klik **Deploy**. Dalam < 30 detik dashboard online dengan HTTPS aktif akan tersedia (contoh: `https://iot-panel-listrik.vercel.app`).
5. Setiap ada perubahan kode yang di-`git push` ke branch `main`, Vercel otomatis melakukan update deployment.

*(Alternatif Cloudflare Pages: hubungkan repo GitHub yang sama di dashboard Cloudflare Pages dengan build command kosong dan root directory `/`).*

---

## 7. Prosedur Backup & Restore Database Supabase

### A. Backup Rutin (Manual / Mingguan)
1. **Via Supabase Dashboard:**
   - Pada paket Pro tersedia automated daily backups; pada paket Free gunakan **Table Editor &rarr; Export to CSV** untuk tabel `telemetry_logs` dan `activity_logs`, atau gunakan `pg_dump` dari komputer pengelola.
2. **Via CLI PostgreSQL (`pg_dump`):**
   Ambil Connection String dari Supabase (**Project Settings &rarr; Database &rarr; Connection string URI**), lalu jalankan:
   ```bash
   pg_dump "postgresql://postgres:[PASSWORD_DB]@db.[PROJECT_ID].supabase.co:5432/postgres" \
     --schema=public --clean --if-exists -F c -f backup_panel_iot_$(date +%Y%m%d).dump
   ```

### B. Restore Database ke Project Baru
Jika terjadi pemindahan akun Supabase atau pemulihan bencana:
1. Buat project Supabase baru dan jalankan ulang [`database/supabase_schema.sql`](../database/supabase_schema.sql), atau restore langsung file `.dump`:
   ```bash
   pg_restore -d "postgresql://postgres:[PASSWORD_DB]@db.[NEW_PROJECT_ID].supabase.co:5432/postgres" \
     --clean --if-exists backup_panel_iot_YYYYMMDD.dump
   ```

---

## 8. Daftar Periksa Pengujian Sebelum Operasional 24 Jam (Acceptance Checklist)

- [ ] **Uji Sensor Kelistrikan:** Bandingkan nilai Tegangan (V) dan Arus (A) pada halaman *Electrical Monitoring* dengan tang ampere (*clamp meter*) / multimeter aktual.
- [ ] **Uji Sensor Suhu:** Verifikasi pembacaan DS18B20 dan DHT22 tidak bernilai `NaN` atau `0` konstan.
- [ ] **Uji Kontrol Mode MANUAL:** Pindahkan mode ke `MANUAL`, aktifkan Relay Lampu & Kipas, pastikan relay fisik berbunyi dan *Status Aktual ESP32* berubah dalam $\le 5$ detik.
- [ ] **Uji Mode AUTO & Histeresis:** Kembalikan ke mode `AUTO`, panaskan sensor suhu melewati batas Kipas/AC, pastikan aktuator aktif otomatis.
- [ ] **Uji Putus Internet (Fail-Safe):** Matikan router WiFi selama 30 detik; pastikan ESP32 tetap menyalakan kipas/AC jika panel panas (tidak macet menunggu internet) dan kembali tersambung otomatis saat WiFi dinyalakan kembali.
- [ ] **Uji Keamanan Role:** Login dengan akun `viewer`, pastikan seluruh tombol kontrol pada Halaman 4 terkunci.

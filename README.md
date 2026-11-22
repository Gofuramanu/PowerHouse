# Power House Monitoring & Control System (ESP32 IoT)

Sistem monitoring kelistrikan, pemantauan kondisi termal lingkungan panel, serta kendali jarak jauh aktuator (Kipas, AC Split, Buzzer, Lampu) berbasis **ESP32**, **Supabase (PostgreSQL + Auth + Realtime)**, dan **Dashboard Web 6 Halaman** yang siap di-deploy ke Vercel atau Cloudflare Pages.

> **Catatan Audit File Lama:** File `index.html..html` sebelumnya mengalami error akibat ekstensi ganda dan URL CDN Firebase `13.4.0` yang tidak valid (404). Alat diagnostik Firebase versi perbaikan kini tersedia di [`firebase-legacy-test.html`](./firebase-legacy-test.html), sementara dashboard utama 6 halaman berada di [`index.html`](./index.html).

---

## Struktur Direktori Proyek

```text
Kendali Akuisisi Data/
├── index.html                                  # Aplikasi Dashboard Web 6 Halaman (Utama)
├── firebase-legacy-test.html                   # Alat Audit & Diagnostik Firebase RTDB Lama (SDK v10.14.1)
├── index.html..html                            # Arsip file awal sebelum audit (referensi)
├── css/
│   └── styles.css                              # Tema industri dark-mode responsif (Desktop & Mobile)
├── js/
│   ├── app.js                                  # Controller (Mode Simulasi, Supabase Live, & Firebase Bridge)
│   └── config.example.js                       # Template konfigurasi frontend (tanpa kredensial asli)
├── database/
│   └── supabase_schema.sql                     # Skema PostgreSQL, RPC 2-arah ESP32, RLS, & Realtime
├── esp32/
│   └── panel_iot_controller/
│       ├── panel_iot_controller.ino            # Firmware ESP32 non-blocking + Hardware Fail-Safe + WDT
│       └── config.example.h                    # Template WiFi, Supabase, & Pinout GPIO ESP32
├── docs/
│   └── PANDUAN_SERAH_TERIMA_DAN_DEPLOYMENT.md  # Dokumentasi lengkap serah terima, wiring, deploy & backup
├── .env.example                                # Template environment variables tanpa kredensial asli
├── .gitignore                                  # Mencegah kredensial rahasia ter-commit ke Git
└── vercel.json                                 # Konfigurasi deployment & security headers Vercel
```

---

## Fitur Utama

1. **Dashboard Web 6 Halaman ([`index.html`](./index.html)):**
   - **1. Overview:** Ringkasan kesehatan sistem, indikator *Heartbeat* ESP32 (`ONLINE`/`OFFLINE`), uptime, kelistrikan, suhu, status aktuator, dan log aktivitas.
   - **2. Electrical Monitoring:** Tegangan (V), Arus (A), Daya Aktif (W), Energi (kWh), Frekuensi (Hz), Power Factor ($\cos\varphi$), estimasi biaya, dan grafik real-time.
   - **3. Environment Monitoring:** Suhu Panel (DS18B20), Suhu Udara (DHT22), Kelembapan (%), selisih termal ($\Delta T$), dan grafik tren.
   - **4. Device Control:** Pemilihan mode `AUTO` vs `MANUAL`, tombol kontrol Kipas, AC, Buzzer, dan Lampu dengan indikator *Target vs Aktual* serta kunci keamanan berdasarkan role (`admin`/`operator` vs `viewer`).
   - **5. History & Analytics:** Filter rentang waktu (`1 Jam`, `24 Jam`, `7 Hari`, `30 Hari`, `Custom`), grafik historis, ringkasan energi, tabel Audit Trail, dan **Export CSV**.
   - **6. Settings:** Konfigurasi koneksi (*Simulasi Interaktif*, *Supabase Cloud*, atau *Firebase Legacy*), pengaturan ambang batas suhu (`Fan`, `AC`, `Alarm`), dan manajemen login.
2. **Keamanan & Keandalan Hardware (ESP32):**
   - Pemisahan tabel **`panel_state`** (*reported state* dari ESP32) dan **`panel_config`** (*desired state* dari dashboard) sehingga tidak terjadi *race condition*.
   - **Hardware Fail-Safe:** Jika internet putus > 15 detik atau suhu mencapai batas darurat, ESP32 otomatis mengaktifkan mode pendinginan aman secara lokal.
   - **Watchdog Timer (WDT):** Otomatis me-restart mikrokontroler apabila terjadi *hang* selama operasi 24 jam.

---

## Memulai Cepat (Quick Start)

### 1. Uji Coba Dashboard Langsung (Tanpa Hardware)
Jalankan server statis lokal pada folder proyek (misalnya lewat ekstensi **Live Server** di editor atau terminal):
```bash
npx serve .
```
Buka `http://localhost:3000` (atau port yang muncul). Secara default dashboard berjalan dalam **Mode Simulasi Interaktif** sehingga seluruh 6 halaman, grafik real-time, kontrol `AUTO`/`MANUAL`, dan export CSV dapat langsung diuji.

### 2. Audit Koneksi Firebase Lama
Buka `http://localhost:3000/firebase-legacy-test.html` untuk melihat payload JSON mentah dari database Firebase lama (`kendali-akuisisi-data-default-rtdb.firebaseio.com`).

### 3. Migrasi Penuh ke Supabase & Deployment
Ikuti langkah detail pada [`docs/PANDUAN_SERAH_TERIMA_DAN_DEPLOYMENT.md`](./docs/PANDUAN_SERAH_TERIMA_DAN_DEPLOYMENT.md).

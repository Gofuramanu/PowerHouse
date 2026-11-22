/**
 * ============================================================================
 * KONFIGURASI DASHBOARD WEB — TEMPLATE (.example)
 * ============================================================================
 * Catatan Keamanan:
 * - JANGAN PERNAH memasukkan Supabase `service_role` key atau password ke file ini.
 * - Frontend hanya boleh menggunakan `anon` public key yang sudah dilindungi
 *   oleh Row Level Security (RLS) di PostgreSQL Supabase.
 * - Anda juga dapat langsung mengisi konfigurasi ini dari Halaman 6 (Settings)
 *   di dalam aplikasi web tanpa perlu mengedit file kode.
 * ============================================================================
 */

window.APP_CONFIG = {
  // Pilihan mode: 'simulator' | 'supabase' | 'firebase'
  mode: "supabase",

  supabase: {
    url: "https://PROJECT_ID_ANDA.supabase.co",
    anonKey: "SUPABASE_ANON_PUBLIC_KEY_ANDA",
    deviceId: "panel-utama-01"
  },

  firebase: {
    apiKey: "FIREBASE_WEB_API_KEY_ANDA",
    authDomain: "PROJECT_ID_ANDA.firebaseapp.com",
    databaseURL: "https://PROJECT_ID_ANDA-default-rtdb.firebaseio.com/",
    projectId: "PROJECT_ID_ANDA",
    storageBucket: "PROJECT_ID_ANDA.firebasestorage.app",
    messagingSenderId: "000000000000",
    appId: "1:000000000000:web:0000000000000000"
  }
};

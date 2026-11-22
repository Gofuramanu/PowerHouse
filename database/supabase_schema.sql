-- ============================================================================
-- SKEMA DATABASE SUPABASE (POSTGRESQL)
-- Sistem IoT Monitoring dan Control Panel Listrik Berbasis ESP32
-- ============================================================================
-- Jalankan seluruh script ini pada Supabase SQL Editor.
-- Script ini idempoten (aman dijalankan ulang tanpa merusak tabel yang ada).
-- ============================================================================

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ----------------------------------------------------------------------------
-- 1. TABEL ROLE PENGGUNA (RBAC: admin, operator, viewer)
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.user_roles (
  user_id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  email TEXT,
  role TEXT NOT NULL DEFAULT 'viewer' CHECK (role IN ('admin', 'operator', 'viewer')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Fungsi helper untuk memeriksa role user yang sedang login di RLS
CREATE OR REPLACE FUNCTION public.get_my_role()
RETURNS TEXT
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT COALESCE(
    (SELECT role FROM public.user_roles WHERE user_id = auth.uid()),
    'viewer'
  );
$$;

-- Trigger otomatis saat user baru mendaftar di Supabase Auth -> default role 'viewer'
-- Untuk user pertama (atau admin), ubah role secara manual di SQL Editor:
-- UPDATE public.user_roles SET role = 'admin' WHERE email = 'email_anda@domain.com';
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  INSERT INTO public.user_roles (user_id, email, role)
  VALUES (NEW.id, NEW.email, 'viewer')
  ON CONFLICT (user_id) DO NOTHING;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();

-- ----------------------------------------------------------------------------
-- 2. TABEL PERANGKAT TERDAFTAR (Autentikasi ESP32)
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.devices (
  device_id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  location TEXT,
  device_secret_hash TEXT NULL,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Pastikan kolom device_secret_hash boleh NULL jika tabel sudah dibuat sebelumnya
ALTER TABLE public.devices ALTER COLUMN device_secret_hash DROP NOT NULL;

-- ----------------------------------------------------------------------------
-- 3. TABEL REPORTED STATE (1 Baris per Perangkat - Update dari ESP32)
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.panel_state (
  device_id TEXT PRIMARY KEY REFERENCES public.devices(device_id) ON DELETE CASCADE,
  voltage DOUBLE PRECISION NOT NULL DEFAULT 0,
  current DOUBLE PRECISION NOT NULL DEFAULT 0,
  power DOUBLE PRECISION NOT NULL DEFAULT 0,
  energy DOUBLE PRECISION NOT NULL DEFAULT 0,
  frequency DOUBLE PRECISION NOT NULL DEFAULT 0,
  power_factor DOUBLE PRECISION NOT NULL DEFAULT 0,
  temp_air DOUBLE PRECISION NOT NULL DEFAULT 0,
  temp_panel DOUBLE PRECISION NOT NULL DEFAULT 0,
  humidity DOUBLE PRECISION NOT NULL DEFAULT 0,
  actual_mode TEXT NOT NULL DEFAULT 'AUTO' CHECK (actual_mode IN ('AUTO', 'MANUAL')),
  actual_fan BOOLEAN NOT NULL DEFAULT FALSE,
  actual_ac BOOLEAN NOT NULL DEFAULT FALSE,
  actual_buzzer BOOLEAN NOT NULL DEFAULT FALSE,
  actual_lamp BOOLEAN NOT NULL DEFAULT FALSE,
  uptime_seconds BIGINT NOT NULL DEFAULT 0,
  wifi_connected BOOLEAN NOT NULL DEFAULT FALSE,
  wifi_rssi INTEGER,
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ----------------------------------------------------------------------------
-- 4. TABEL DESIRED STATE & KONFIGURASI (1 Baris per Perangkat - Update dari Web)
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.panel_config (
  device_id TEXT PRIMARY KEY REFERENCES public.devices(device_id) ON DELETE CASCADE,
  target_mode TEXT NOT NULL DEFAULT 'AUTO' CHECK (target_mode IN ('AUTO', 'MANUAL')),
  target_fan BOOLEAN NOT NULL DEFAULT FALSE,
  target_ac BOOLEAN NOT NULL DEFAULT FALSE,
  target_buzzer BOOLEAN NOT NULL DEFAULT FALSE,
  target_lamp BOOLEAN NOT NULL DEFAULT FALSE,
  temp_threshold_fan DOUBLE PRECISION NOT NULL DEFAULT 32.0 CHECK (temp_threshold_fan BETWEEN 15 AND 80),
  temp_threshold_ac DOUBLE PRECISION NOT NULL DEFAULT 35.0 CHECK (temp_threshold_ac BETWEEN 15 AND 85),
  temp_threshold_alarm DOUBLE PRECISION NOT NULL DEFAULT 45.0 CHECK (temp_threshold_alarm BETWEEN 20 AND 100),
  log_interval_seconds INTEGER NOT NULL DEFAULT 60 CHECK (log_interval_seconds BETWEEN 5 AND 3600),
  updated_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ----------------------------------------------------------------------------
-- 5. TABEL HISTORI TELEMETRY (Time-Series Logs)
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.telemetry_logs (
  id BIGSERIAL PRIMARY KEY,
  device_id TEXT NOT NULL REFERENCES public.devices(device_id) ON DELETE CASCADE,
  voltage DOUBLE PRECISION NULL DEFAULT 0,
  current DOUBLE PRECISION NOT NULL DEFAULT 0,
  power DOUBLE PRECISION NOT NULL DEFAULT 0,
  energy DOUBLE PRECISION NOT NULL DEFAULT 0,
  frequency DOUBLE PRECISION NOT NULL DEFAULT 0,
  power_factor DOUBLE PRECISION NOT NULL DEFAULT 0,
  temp_air DOUBLE PRECISION NOT NULL DEFAULT 0,
  temp_panel DOUBLE PRECISION NOT NULL DEFAULT 0,
  humidity DOUBLE PRECISION NOT NULL DEFAULT 0,
  mode TEXT NOT NULL DEFAULT 'AUTO',
  fan BOOLEAN NOT NULL DEFAULT FALSE,
  ac BOOLEAN NOT NULL DEFAULT FALSE,
  buzzer BOOLEAN NOT NULL DEFAULT FALSE,
  lamp BOOLEAN NOT NULL DEFAULT FALSE,
  uptime_seconds BIGINT NULL DEFAULT 0,
  wifi_connected BOOLEAN NOT NULL DEFAULT TRUE,
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Pastikan kolom tambahan tersedia jika tabel telemetry_logs sudah dibuat sebelumnya
ALTER TABLE public.telemetry_logs ALTER COLUMN voltage DROP NOT NULL;
ALTER TABLE public.telemetry_logs ADD COLUMN IF NOT EXISTS uptime_seconds BIGINT NULL DEFAULT 0;
ALTER TABLE public.telemetry_logs ADD COLUMN IF NOT EXISTS wifi_connected BOOLEAN NOT NULL DEFAULT TRUE;

CREATE INDEX IF NOT EXISTS idx_telemetry_device_time
  ON public.telemetry_logs (device_id, recorded_at DESC);

-- ----------------------------------------------------------------------------
-- 6. TABEL AUDIT LOG AKTIVITAS (Perubahan Mode, Kontrol, Alarm)
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.activity_logs (
  id BIGSERIAL PRIMARY KEY,
  device_id TEXT NOT NULL REFERENCES public.devices(device_id) ON DELETE CASCADE,
  actor_type TEXT NOT NULL CHECK (actor_type IN ('ESP32', 'USER', 'SYSTEM')),
  actor_name TEXT NOT NULL,
  event_type TEXT NOT NULL,
  description TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_activity_device_time
  ON public.activity_logs (device_id, created_at DESC);

-- ----------------------------------------------------------------------------
-- 7. TRIGGER AUDIT PERUBAHAN KONFIGURASI DARI DASHBOARD
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.log_panel_config_changes()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_actor_email TEXT;
  v_changes TEXT := '';
BEGIN
  NEW.updated_at := NOW();
  IF auth.uid() IS NOT NULL THEN
    NEW.updated_by := auth.uid();
  END IF;

  SELECT COALESCE(email, 'Operator') INTO v_actor_email
  FROM auth.users WHERE id = NEW.updated_by;

  IF OLD.target_mode IS DISTINCT FROM NEW.target_mode THEN
    v_changes := v_changes || format('Mode: %s -> %s; ', OLD.target_mode, NEW.target_mode);
  END IF;
  IF OLD.target_fan IS DISTINCT FROM NEW.target_fan THEN
    v_changes := v_changes || format('Kipas: %s; ', CASE WHEN NEW.target_fan THEN 'ON' ELSE 'OFF' END);
  END IF;
  IF OLD.target_ac IS DISTINCT FROM NEW.target_ac THEN
    v_changes := v_changes || format('AC: %s; ', CASE WHEN NEW.target_ac THEN 'ON' ELSE 'OFF' END);
  END IF;
  IF OLD.target_buzzer IS DISTINCT FROM NEW.target_buzzer THEN
    v_changes := v_changes || format('Buzzer: %s; ', CASE WHEN NEW.target_buzzer THEN 'ON' ELSE 'OFF' END);
  END IF;
  IF OLD.target_lamp IS DISTINCT FROM NEW.target_lamp THEN
    v_changes := v_changes || format('Lampu: %s; ', CASE WHEN NEW.target_lamp THEN 'ON' ELSE 'OFF' END);
  END IF;
  IF OLD.temp_threshold_fan IS DISTINCT FROM NEW.temp_threshold_fan
     OR OLD.temp_threshold_ac IS DISTINCT FROM NEW.temp_threshold_ac
     OR OLD.temp_threshold_alarm IS DISTINCT FROM NEW.temp_threshold_alarm THEN
    v_changes := v_changes || format(
      'Threshold [Fan:%sC, AC:%sC, Alarm:%sC]; ',
      NEW.temp_threshold_fan, NEW.temp_threshold_ac, NEW.temp_threshold_alarm
    );
  END IF;

  IF v_changes <> '' THEN
    INSERT INTO public.activity_logs (device_id, actor_type, actor_name, event_type, description)
    VALUES (NEW.device_id, 'USER', COALESCE(v_actor_email, 'Dashboard User'), 'CONTROL_COMMAND', btrim(v_changes));
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_panel_config_audit ON public.panel_config;
CREATE TRIGGER trg_panel_config_audit
  BEFORE UPDATE ON public.panel_config
  FOR EACH ROW EXECUTE FUNCTION public.log_panel_config_changes();

-- ----------------------------------------------------------------------------
-- 8. RPC ENDPOINT TUNGGAL UNTUK ESP32 (Kirim Telemetry + Ambil Perintah Kontrol)
-- ----------------------------------------------------------------------------
DROP FUNCTION IF EXISTS public.sync_esp32_telemetry(
  TEXT, TEXT, DOUBLE PRECISION, DOUBLE PRECISION, DOUBLE PRECISION,
  DOUBLE PRECISION, DOUBLE PRECISION, DOUBLE PRECISION, DOUBLE PRECISION,
  DOUBLE PRECISION, DOUBLE PRECISION, TEXT, BOOLEAN, BOOLEAN, BOOLEAN,
  BOOLEAN, BIGINT, BOOLEAN, INTEGER
);

CREATE OR REPLACE FUNCTION public.sync_esp32_telemetry(
  p_device_id TEXT,
  p_device_key TEXT DEFAULT NULL,
  p_voltage DOUBLE PRECISION DEFAULT NULL,
  p_current DOUBLE PRECISION DEFAULT 0,
  p_power DOUBLE PRECISION DEFAULT 0,
  p_energy DOUBLE PRECISION DEFAULT 0,
  p_frequency DOUBLE PRECISION DEFAULT 0,
  p_power_factor DOUBLE PRECISION DEFAULT 0,
  p_temp_air DOUBLE PRECISION DEFAULT 0,
  p_temp_panel DOUBLE PRECISION DEFAULT 0,
  p_humidity DOUBLE PRECISION DEFAULT 0,
  p_actual_mode TEXT DEFAULT 'AUTO',
  p_actual_fan BOOLEAN DEFAULT FALSE,
  p_actual_ac BOOLEAN DEFAULT FALSE,
  p_actual_buzzer BOOLEAN DEFAULT FALSE,
  p_actual_lamp BOOLEAN DEFAULT FALSE,
  p_uptime_seconds BIGINT DEFAULT 0,
  p_wifi_connected BOOLEAN DEFAULT TRUE,
  p_wifi_rssi INTEGER DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
  v_secret_hash TEXT;
  v_is_active BOOLEAN;
  v_prev_state public.panel_state%ROWTYPE;
  v_config public.panel_config%ROWTYPE;
  v_last_log_time TIMESTAMPTZ;
  v_state_changed BOOLEAN := FALSE;
  v_is_alarm BOOLEAN := FALSE;
  v_safe_mode TEXT;
  v_pf DOUBLE PRECISION;
BEGIN
  -- 1. Cek perangkat & auto-register jika device_id baru (tanpa wajib secret key)
  SELECT device_secret_hash, is_active
  INTO v_secret_hash, v_is_active
  FROM public.devices
  WHERE device_id = p_device_id;

  IF NOT FOUND THEN
    INSERT INTO public.devices (device_id, name, device_secret_hash, is_active)
    VALUES (p_device_id, p_device_id, NULL, TRUE)
    ON CONFLICT (device_id) DO NOTHING;

    v_secret_hash := NULL;
    v_is_active := TRUE;
  END IF;

  IF NOT v_is_active THEN
    RAISE EXCEPTION 'Device nonaktif' USING ERRCODE = '28000';
  END IF;

  -- Verifikasi kunci hanya dijalankan jika admin mengisi device_secret_hash di tabel devices
  IF v_secret_hash IS NOT NULL AND v_secret_hash <> '' THEN
    IF p_device_key IS NULL OR encode(digest(p_device_key, 'sha256'), 'hex') <> v_secret_hash THEN
      RAISE EXCEPTION 'Autentikasi device_key tidak valid' USING ERRCODE = '28000';
    END IF;
  END IF;

  -- 2. Sanitasi & validasi input sensor agar data rusak tidak merusak statistik
  v_safe_mode := CASE WHEN p_actual_mode IN ('AUTO', 'MANUAL') THEN p_actual_mode ELSE 'AUTO' END;
  v_pf := LEAST(GREATEST(COALESCE(p_power_factor, 0), 0), 1);

  IF p_voltage < 0 OR p_voltage > 1000 OR p_current < 0 OR p_current > 2000 THEN
    RAISE EXCEPTION 'Nilai kelistrikan di luar rentang wajar' USING ERRCODE = '22023';
  END IF;

  -- 3. Ambil state sebelumnya & konfigurasi aktif
  SELECT * INTO v_prev_state FROM public.panel_state WHERE device_id = p_device_id;
  SELECT * INTO v_config FROM public.panel_config WHERE device_id = p_device_id;

  IF v_config.device_id IS NULL THEN
    INSERT INTO public.panel_config (device_id) VALUES (p_device_id)
    RETURNING * INTO v_config;
  END IF;

  v_is_alarm := (p_temp_panel >= v_config.temp_threshold_alarm) OR p_actual_buzzer;

  IF v_prev_state.device_id IS NOT NULL THEN
    v_state_changed := (
      v_prev_state.actual_mode IS DISTINCT FROM v_safe_mode OR
      v_prev_state.actual_fan IS DISTINCT FROM p_actual_fan OR
      v_prev_state.actual_ac IS DISTINCT FROM p_actual_ac OR
      v_prev_state.actual_buzzer IS DISTINCT FROM p_actual_buzzer OR
      v_prev_state.actual_lamp IS DISTINCT FROM p_actual_lamp
    );
  END IF;

  -- 4. Update panel_state (1 baris live state)
  INSERT INTO public.panel_state (
    device_id, voltage, current, power, energy, frequency, power_factor,
    temp_air, temp_panel, humidity,
    actual_mode, actual_fan, actual_ac, actual_buzzer, actual_lamp,
    uptime_seconds, wifi_connected, wifi_rssi, last_seen_at, updated_at
  )
  VALUES (
    p_device_id, COALESCE(GREATEST(p_voltage, 0), 0), GREATEST(p_current, 0), GREATEST(p_power, 0),
    GREATEST(p_energy, 0), GREATEST(p_frequency, 0), v_pf,
    p_temp_air, p_temp_panel, LEAST(GREATEST(p_humidity, 0), 100),
    v_safe_mode, p_actual_fan, p_actual_ac, p_actual_buzzer, p_actual_lamp,
    GREATEST(p_uptime_seconds, 0), p_wifi_connected, p_wifi_rssi, NOW(), NOW()
  )
  ON CONFLICT (device_id) DO UPDATE SET
    voltage = EXCLUDED.voltage,
    current = EXCLUDED.current,
    power = EXCLUDED.power,
    energy = EXCLUDED.energy,
    frequency = EXCLUDED.frequency,
    power_factor = EXCLUDED.power_factor,
    temp_air = EXCLUDED.temp_air,
    temp_panel = EXCLUDED.temp_panel,
    humidity = EXCLUDED.humidity,
    actual_mode = EXCLUDED.actual_mode,
    actual_fan = EXCLUDED.actual_fan,
    actual_ac = EXCLUDED.actual_ac,
    actual_buzzer = EXCLUDED.actual_buzzer,
    actual_lamp = EXCLUDED.actual_lamp,
    uptime_seconds = EXCLUDED.uptime_seconds,
    wifi_connected = EXCLUDED.wifi_connected,
    wifi_rssi = EXCLUDED.wifi_rssi,
    last_seen_at = NOW(),
    updated_at = NOW();

  -- 5. Simpan ke telemetry_logs hanya jika interval terlewati atau ada perubahan status/alarm
  SELECT MAX(recorded_at) INTO v_last_log_time
  FROM public.telemetry_logs
  WHERE device_id = p_device_id;

  IF v_last_log_time IS NULL
     OR NOW() - v_last_log_time >= make_interval(secs => v_config.log_interval_seconds)
     OR v_state_changed THEN
    INSERT INTO public.telemetry_logs (
      device_id, voltage, current, power, energy, frequency, power_factor,
      temp_air, temp_panel, humidity, mode, fan, ac, buzzer, lamp,
      uptime_seconds, wifi_connected, recorded_at
    )
    VALUES (
      p_device_id,
      CASE WHEN p_voltage IS NULL THEN NULL ELSE GREATEST(p_voltage, 0) END,
      GREATEST(p_current, 0), GREATEST(p_power, 0),
      GREATEST(p_energy, 0), GREATEST(p_frequency, 0), v_pf,
      p_temp_air, p_temp_panel, LEAST(GREATEST(p_humidity, 0), 100),
      v_safe_mode, p_actual_fan, p_actual_ac, p_actual_buzzer, p_actual_lamp,
      GREATEST(p_uptime_seconds, 0), p_wifi_connected, NOW()
    );
  END IF;

  -- 6. Catat perubahan status aktuator atau alarm di activity_logs
  IF v_state_changed THEN
    INSERT INTO public.activity_logs (device_id, actor_type, actor_name, event_type, description)
    VALUES (
      p_device_id,
      'ESP32',
      p_device_id,
      CASE WHEN v_is_alarm THEN 'ALARM_TRIGGERED' ELSE 'STATE_SYNC' END,
      format(
        'Status aktual [%s] -> Kipas:%s, AC:%s, Buzzer:%s, Lampu:%s (T.Panel: %s C)',
        v_safe_mode,
        CASE WHEN p_actual_fan THEN 'ON' ELSE 'OFF' END,
        CASE WHEN p_actual_ac THEN 'ON' ELSE 'OFF' END,
        CASE WHEN p_actual_buzzer THEN 'ON' ELSE 'OFF' END,
        CASE WHEN p_actual_lamp THEN 'ON' ELSE 'OFF' END,
        round(p_temp_panel::numeric, 1)
      )
    );
  END IF;

  -- 7. Kembalikan Desired State (panel_config) ke ESP32 dalam 1 respons
  RETURN jsonb_build_object(
    'status', 'ok',
    'server_time', NOW(),
    'target_mode', v_config.target_mode,
    'target_fan', v_config.target_fan,
    'target_ac', v_config.target_ac,
    'target_buzzer', v_config.target_buzzer,
    'target_lamp', v_config.target_lamp,
    'temp_threshold_fan', v_config.temp_threshold_fan,
    'temp_threshold_ac', v_config.temp_threshold_ac,
    'temp_threshold_alarm', v_config.temp_threshold_alarm,
    'log_interval_seconds', v_config.log_interval_seconds
  );
END;
$$;

REVOKE ALL ON FUNCTION public.sync_esp32_telemetry(
  TEXT, TEXT, DOUBLE PRECISION, DOUBLE PRECISION, DOUBLE PRECISION,
  DOUBLE PRECISION, DOUBLE PRECISION, DOUBLE PRECISION, DOUBLE PRECISION,
  DOUBLE PRECISION, DOUBLE PRECISION, TEXT, BOOLEAN, BOOLEAN, BOOLEAN,
  BOOLEAN, BIGINT, BOOLEAN, INTEGER
) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION public.sync_esp32_telemetry(
  TEXT, TEXT, DOUBLE PRECISION, DOUBLE PRECISION, DOUBLE PRECISION,
  DOUBLE PRECISION, DOUBLE PRECISION, DOUBLE PRECISION, DOUBLE PRECISION,
  DOUBLE PRECISION, DOUBLE PRECISION, TEXT, BOOLEAN, BOOLEAN, BOOLEAN,
  BOOLEAN, BIGINT, BOOLEAN, INTEGER
) TO anon, authenticated;

-- ----------------------------------------------------------------------------
-- 9. ROW LEVEL SECURITY (RLS) POLICIES
-- ----------------------------------------------------------------------------
ALTER TABLE public.user_roles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.devices ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.panel_state ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.panel_config ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.telemetry_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.activity_logs ENABLE ROW LEVEL SECURITY;

-- Kebijakan tabel user_roles
DROP POLICY IF EXISTS "User baca role sendiri atau admin baca semua" ON public.user_roles;
CREATE POLICY "User baca role sendiri atau admin baca semua"
  ON public.user_roles FOR SELECT TO authenticated
  USING (auth.uid() = user_id OR public.get_my_role() = 'admin');

DROP POLICY IF EXISTS "Hanya admin kelola role" ON public.user_roles;
CREATE POLICY "Hanya admin kelola role"
  ON public.user_roles FOR ALL TO authenticated
  USING (public.get_my_role() = 'admin')
  WITH CHECK (public.get_my_role() = 'admin');

-- Kebijakan baca data untuk semua user yang sudah login (admin, operator, viewer)
DROP POLICY IF EXISTS "Authenticated baca devices" ON public.devices;
CREATE POLICY "Authenticated baca devices"
  ON public.devices FOR SELECT TO authenticated
  USING (TRUE);

DROP POLICY IF EXISTS "Admin kelola devices" ON public.devices;
CREATE POLICY "Admin kelola devices"
  ON public.devices FOR ALL TO authenticated
  USING (public.get_my_role() = 'admin')
  WITH CHECK (public.get_my_role() = 'admin');

DROP POLICY IF EXISTS "Authenticated baca panel_state" ON public.panel_state;
CREATE POLICY "Authenticated baca panel_state"
  ON public.panel_state FOR SELECT TO authenticated
  USING (TRUE);

DROP POLICY IF EXISTS "Authenticated baca panel_config" ON public.panel_config;
CREATE POLICY "Authenticated baca panel_config"
  ON public.panel_config FOR SELECT TO authenticated
  USING (TRUE);

-- Hanya admin & operator yang boleh mengirim perintah kontrol / ubah threshold
DROP POLICY IF EXISTS "Admin dan operator update panel_config" ON public.panel_config;
CREATE POLICY "Admin dan operator update panel_config"
  ON public.panel_config FOR UPDATE TO authenticated
  USING (public.get_my_role() IN ('admin', 'operator'))
  WITH CHECK (public.get_my_role() IN ('admin', 'operator'));

DROP POLICY IF EXISTS "Authenticated baca telemetry_logs" ON public.telemetry_logs;
CREATE POLICY "Authenticated baca telemetry_logs"
  ON public.telemetry_logs FOR SELECT TO authenticated
  USING (TRUE);

DROP POLICY IF EXISTS "Authenticated baca activity_logs" ON public.activity_logs;
CREATE POLICY "Authenticated baca activity_logs"
  ON public.activity_logs FOR SELECT TO authenticated
  USING (TRUE);

-- ----------------------------------------------------------------------------
-- 10. AKTIVASI SUPABASE REALTIME PUBLICATION
-- ----------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'panel_state'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.panel_state;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'panel_config'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.panel_config;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'activity_logs'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.activity_logs;
  END IF;
END $$;

-- ----------------------------------------------------------------------------
-- 11. COMPATIBILITY VIEW DENGAN SKEMA `panel_monitoring.sql`
-- ----------------------------------------------------------------------------
-- View ini memetakan `telemetry_logs` ke nama kolom persis milik `panel_telemetry`
-- (MySQL schema) dengan security_invoker = true agar tetap tunduk pada RLS.
CREATE OR REPLACE VIEW public.panel_telemetry
WITH (security_invoker = true) AS
SELECT
  id,
  device_id,
  recorded_at,
  temp_air::NUMERIC(6,2) AS temperature_air_c,
  temp_panel::NUMERIC(6,2) AS temperature_panel_c,
  humidity::NUMERIC(6,2) AS humidity_percent,
  voltage::NUMERIC(10,2) AS voltage_v,
  current::NUMERIC(10,3) AS current_a,
  power::NUMERIC(10,2) AS power_w,
  energy::NUMERIC(12,3) AS energy_kwh,
  frequency::NUMERIC(6,2) AS frequency_hz,
  power_factor::NUMERIC(5,3) AS power_factor,
  mode,
  ac AS output_ac,
  buzzer AS output_buzzer,
  fan AS output_fan,
  lamp AS output_lamp,
  uptime_seconds,
  wifi_connected
FROM public.telemetry_logs;

GRANT SELECT ON public.panel_telemetry TO authenticated;

-- ----------------------------------------------------------------------------
-- 12. DATA AWAL (SEED) PERANGKAT DEFAULT & SAMPLE `panel_monitoring.sql`
-- ----------------------------------------------------------------------------
-- Secara default device_secret_hash diset NULL sehingga ESP32 dapat langsung
-- mengirim data tanpa kunci rahasia (hanya memakai SUPABASE_ANON_KEY + DEVICE_ID).
-- Jika suatu saat ingin menambah kunci rahasia, isi device_secret_hash dengan SHA-256.
INSERT INTO public.devices (device_id, name, location, device_secret_hash, is_active)
VALUES
  (
    'panel-utama-01',
    'Panel Listrik Utama (Power House)',
    'Gedung Utama Lt. 1',
    NULL,
    TRUE
  ),
  (
    'panel',
    'Panel Listrik Default (Kompatibel Skema Legacy)',
    'Panel Utama',
    NULL,
    TRUE
  )
ON CONFLICT (device_id) DO UPDATE SET device_secret_hash = NULL;

INSERT INTO public.panel_config (device_id)
VALUES ('panel-utama-01'), ('panel')
ON CONFLICT (device_id) DO NOTHING;

INSERT INTO public.panel_state (device_id, temp_air, temp_panel, humidity, uptime_seconds, wifi_connected)
VALUES
  ('panel-utama-01', 0, 0, 0, 0, FALSE),
  ('panel', 31.50, 28.00, 81.20, 175, TRUE)
ON CONFLICT (device_id) DO NOTHING;

-- Seed 1 baris sample dari panel_monitoring.sql (hanya jika belum ada data untuk device 'panel')
INSERT INTO public.telemetry_logs (
  device_id, temp_air, temp_panel, humidity,
  voltage, current, power, energy, frequency, power_factor,
  mode, ac, buzzer, fan, lamp, uptime_seconds, wifi_connected
)
SELECT
  'panel', 31.50, 28.00, 81.20,
  NULL, 0.000, 0.00, 0.000, 0.00, 0.000,
  'AUTO', FALSE, FALSE, FALSE, FALSE, 175, TRUE
WHERE NOT EXISTS (
  SELECT 1 FROM public.telemetry_logs WHERE device_id = 'panel'
);

CREATE TABLE IF NOT EXISTS credentials (
  credential_id TEXT PRIMARY KEY,
  public_key TEXT NOT NULL,
  counter INTEGER NOT NULL DEFAULT 0,
  transports TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  id_hash TEXT PRIMARY KEY,
  csrf_token TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS webauthn_challenges (
  id TEXT PRIMARY KEY,
  challenge TEXT NOT NULL,
  kind TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS energy_samples (
  ts INTEGER PRIMARY KEY,
  solar_w REAL NOT NULL,
  home_w REAL NOT NULL,
  battery_w REAL NOT NULL,
  battery_soc REAL,
  grid_w REAL NOT NULL,
  charger_w REAL
);

-- Exact coordinates stay in this table. Public queries must not select them.
CREATE TABLE IF NOT EXISTS vehicle_samples (
  ts INTEGER PRIMARY KEY,
  online INTEGER NOT NULL,
  battery_level REAL,
  charging_state TEXT,
  charge_limit_soc REAL,
  charger_power_w REAL,
  charging_amps REAL,
  odometer_km REAL,
  latitude REAL,
  longitude REAL,
  climate_on INTEGER,
  charge_port_latch TEXT
);

CREATE TABLE IF NOT EXISTS charge_slices (
  ts INTEGER PRIMARY KEY,
  solar_kwh REAL NOT NULL,
  grid_kwh REAL NOT NULL
);

CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  action TEXT NOT NULL,
  outcome TEXT NOT NULL,
  detail TEXT
);

CREATE TABLE IF NOT EXISTS oauth_pending (
  state TEXT PRIMARY KEY,
  verifier TEXT,
  provider TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS poll_state (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_energy_ts ON energy_samples(ts);
CREATE INDEX IF NOT EXISTS idx_vehicle_ts ON vehicle_samples(ts);
CREATE INDEX IF NOT EXISTS idx_charge_ts ON charge_slices(ts);
CREATE INDEX IF NOT EXISTS idx_audit_ts ON audit_log(ts);

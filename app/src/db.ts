import type { HistoryPoint, PublicEnergy, PublicVehicle } from "./energy/public";
import type { ChargeSlice, OdometerSample } from "./energy/score";
import type { TrailSample } from "./location/fuzz";

export interface StoredSession {
  csrf_token: string;
  expires_at: number;
}

export async function countPasskeys(db: D1Database): Promise<number> {
  const row = await db.prepare("SELECT COUNT(*) AS n FROM credentials").first<{ n: number }>();
  return Number(row?.n ?? 0);
}

export async function insertSession(db: D1Database, idHash: string, csrf: string, now: number, ttlSeconds: number): Promise<void> {
  await db
    .prepare("INSERT INTO sessions (id_hash, csrf_token, expires_at, created_at) VALUES (?, ?, ?, ?)")
    .bind(idHash, csrf, now + ttlSeconds * 1000, now)
    .run();
}

export async function readSession(db: D1Database, idHash: string): Promise<StoredSession | null> {
  return db.prepare("SELECT csrf_token, expires_at FROM sessions WHERE id_hash = ?").bind(idHash).first<StoredSession>();
}

export async function deleteSession(db: D1Database, idHash: string): Promise<void> {
  await db.prepare("DELETE FROM sessions WHERE id_hash = ?").bind(idHash).run();
}

export async function saveChallenge(db: D1Database, id: string, challenge: string, kind: string, expiresAt: number): Promise<void> {
  await db.prepare("DELETE FROM webauthn_challenges WHERE expires_at < ?").bind(Date.now()).run();
  await db
    .prepare("INSERT INTO webauthn_challenges (id, challenge, kind, expires_at) VALUES (?, ?, ?, ?)")
    .bind(id, challenge, kind, expiresAt)
    .run();
}

export async function takeChallenge(db: D1Database, id: string, kind: string): Promise<string | null> {
  const row = await db
    .prepare("SELECT challenge, expires_at FROM webauthn_challenges WHERE id = ? AND kind = ?")
    .bind(id, kind)
    .first<{ challenge: string; expires_at: number }>();
  await db.prepare("DELETE FROM webauthn_challenges WHERE id = ?").bind(id).run();
  if (!row || row.expires_at < Date.now()) return null;
  return row.challenge;
}

export async function audit(db: D1Database, action: string, outcome: string, detail?: string): Promise<void> {
  await db
    .prepare("INSERT INTO audit_log (ts, action, outcome, detail) VALUES (?, ?, ?, ?)")
    .bind(Date.now(), action, outcome, detail ? detail.slice(0, 300) : null)
    .run();
}

export async function latestEnergy(db: D1Database): Promise<(PublicEnergy & { ts: number; chargerW: number | null }) | null> {
  const row = await db
    .prepare(
      "SELECT ts, solar_w, home_w, battery_w, battery_soc, grid_w, charger_w FROM energy_samples ORDER BY ts DESC LIMIT 1",
    )
    .first<{
      ts: number;
      solar_w: number;
      home_w: number;
      battery_w: number;
      battery_soc: number | null;
      grid_w: number;
      charger_w: number | null;
    }>();
  if (!row) return null;
  return {
    ts: row.ts,
    solarW: row.solar_w,
    homeW: row.home_w,
    batteryW: row.battery_w,
    batterySoc: row.battery_soc,
    gridW: row.grid_w,
    chargerW: row.charger_w,
  };
}

export async function energyHistory(db: D1Database, since: number): Promise<HistoryPoint[]> {
  const result = await db
    .prepare(
      "SELECT ts, solar_w, home_w, grid_w, battery_soc FROM energy_samples WHERE ts >= ? ORDER BY ts ASC",
    )
    .bind(since)
    .all<{ ts: number; solar_w: number; home_w: number; grid_w: number; battery_soc: number | null }>();
  return (result.results ?? []).map((row) => ({
    ts: row.ts,
    solarW: row.solar_w,
    homeW: row.home_w,
    gridW: row.grid_w,
    batterySoc: row.battery_soc,
  }));
}

export interface VehicleReading extends PublicVehicle {
  ts: number;
  chargingAmps: number | null;
  chargerPowerW: number | null;
  odometerKm: number | null;
  chargePortLatch: string | null;
}

export async function latestVehicle(db: D1Database): Promise<VehicleReading | null> {
  const row = await db
    .prepare(
      `SELECT ts, online, battery_level, charging_state, charge_limit_soc, charger_power_w, charging_amps,
              odometer_km, climate_on, charge_port_latch
       FROM vehicle_samples ORDER BY ts DESC LIMIT 1`,
    )
    .first<{
      ts: number;
      online: number;
      battery_level: number | null;
      charging_state: string | null;
      charge_limit_soc: number | null;
      charger_power_w: number | null;
      charging_amps: number | null;
      odometer_km: number | null;
      climate_on: number | null;
      charge_port_latch: string | null;
    }>();
  if (!row) return null;
  return {
    ts: row.ts,
    online: row.online === 1,
    batteryPercent: row.battery_level,
    chargingState: row.charging_state,
    chargeLimitPercent: row.charge_limit_soc,
    climateOn: row.climate_on === null ? null : row.climate_on === 1,
    chargingAmps: row.charging_amps,
    chargerPowerW: row.charger_power_w,
    odometerKm: row.odometer_km,
    chargePortLatch: row.charge_port_latch,
  };
}

export async function privateLocation(db: D1Database): Promise<(TrailSample) | null> {
  const row = await db
    .prepare("SELECT ts, latitude, longitude FROM vehicle_samples WHERE latitude IS NOT NULL AND longitude IS NOT NULL ORDER BY ts DESC LIMIT 1")
    .first<{ ts: number; latitude: number; longitude: number }>();
  if (!row) return null;
  return { ts: row.ts, lat: row.latitude, lon: row.longitude };
}

export async function privateTrail(db: D1Database, since: number): Promise<TrailSample[]> {
  const result = await db
    .prepare(
      "SELECT ts, latitude, longitude FROM vehicle_samples WHERE ts >= ? AND latitude IS NOT NULL AND longitude IS NOT NULL ORDER BY ts ASC",
    )
    .bind(since)
    .all<{ ts: number; latitude: number; longitude: number }>();
  return (result.results ?? []).map((row) => ({ ts: row.ts, lat: row.latitude, lon: row.longitude }));
}

export async function odometerSince(db: D1Database, since: number): Promise<OdometerSample[]> {
  const result = await db
    .prepare("SELECT ts, odometer_km AS km FROM vehicle_samples WHERE ts >= ? AND odometer_km IS NOT NULL ORDER BY ts ASC")
    .bind(since)
    .all<OdometerSample>();
  return result.results ?? [];
}

export async function chargeSince(db: D1Database, since: number): Promise<ChargeSlice[]> {
  const result = await db
    .prepare("SELECT ts, solar_kwh AS solarKwh, grid_kwh AS gridKwh FROM charge_slices WHERE ts >= ? ORDER BY ts ASC")
    .bind(since)
    .all<ChargeSlice>();
  return result.results ?? [];
}

export async function readPoll(db: D1Database, key: string): Promise<string | null> {
  const row = await db.prepare("SELECT value FROM poll_state WHERE key = ?").bind(key).first<{ value: string }>();
  return row?.value ?? null;
}

export async function writePoll(db: D1Database, key: string, value: string): Promise<void> {
  await db
    .prepare("INSERT INTO poll_state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
    .bind(key, value)
    .run();
}

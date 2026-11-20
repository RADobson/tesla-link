import { mocksEnabled, stationId } from "./config";
import { latestEnergy, readPoll, writePoll } from "./db";
import { attributeChargeInterval } from "./energy/score";
import { illustrativePoints, SAMPLE_POINT } from "./mock/sample";
import { callSigenTool } from "./sigen/client";
import { normalizeEnergyFlow, parseChargerInfo, parseSocSettings } from "./sigen/parse";
import { readVehicleData, vehicleOnline } from "./tesla/command";
import { parseVehicleData } from "./tesla/parse";

export async function pollAll(env: Env): Promise<void> {
  if (mocksEnabled(env)) {
    await writeMockSample(env);
    return;
  }
  await pollSigen(env);
  await pollTesla(env);
}

async function writeMockSample(env: Env): Promise<void> {
  const now = Date.now();
  const point = illustrativePoints(now, env.HOUSE_TIMEZONE).at(-1);
  if (!point) return;
  await env.DB.prepare(
    `INSERT INTO energy_samples (ts, solar_w, home_w, battery_w, battery_soc, grid_w, charger_w)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(ts) DO NOTHING`,
  )
    .bind(now, point.solarW, point.homeW, 0, point.batterySoc, point.gridW, point.chargerW)
    .run();
  await env.DB.prepare(
    `INSERT INTO vehicle_samples
      (ts, online, battery_level, charging_state, charge_limit_soc, charger_power_w, charging_amps, odometer_km, latitude, longitude, climate_on, charge_port_latch)
     VALUES (?, 1, 64, ?, 80, ?, 32, ?, ?, ?, 0, 'Engaged')
     ON CONFLICT(ts) DO NOTHING`,
  )
    .bind(now, point.chargerW > 0 ? "Charging" : "Disconnected", point.chargerW, point.odometerKm, SAMPLE_POINT.lat, SAMPLE_POINT.lon)
    .run();
}

async function pollSigen(env: Env): Promise<void> {
  const vault = env.TOKEN_VAULT.getByName("owner");
  const status = await vault.connectionStatus();
  if (!status.sigen) return;
  const token = await vault.accessToken("sigen");
  const station = stationId(env);
  try {
    const flow = normalizeEnergyFlow(await callSigenTool(env, token, "get_energy_flow", { station_id: station }));
    const info = parseChargerInfo(await callSigenTool(env, token, "get_charger_info", { station_id: station }));
    if (info?.sn) await vault.setCharger({ sn: info.sn });
    if (info?.mode) await writePoll(env.DB, "sigen_mode", info.mode);
    const chargerW = info?.powerW ?? flow.chargerW ?? 0;
    const now = Date.now();
    const previous = await latestEnergy(env.DB);
    await env.DB.prepare(
      `INSERT INTO energy_samples (ts, solar_w, home_w, battery_w, battery_soc, grid_w, charger_w)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(now, flow.solarW, flow.homeW, flow.batteryW, flow.batterySoc, flow.gridW, chargerW)
      .run();
    if (previous) {
      const slice = attributeChargeInterval(
        { ts: previous.ts, solarW: previous.solarW, homeW: previous.homeW, chargerW: previous.chargerW ?? 0, gridW: previous.gridW },
        { ts: now, solarW: flow.solarW, homeW: flow.homeW, chargerW, gridW: flow.gridW },
      );
      if (slice.solarKwh > 0 || slice.gridKwh > 0) {
        await env.DB.prepare("INSERT INTO charge_slices (ts, solar_kwh, grid_kwh) VALUES (?, ?, ?)").bind(now, slice.solarKwh, slice.gridKwh).run();
      }
    }
    const settings = parseSocSettings(await callSigenTool(env, token, "get_battery_soc_settings", { station_id: station }));
    if (settings.chargeSOC !== undefined) await writePoll(env.DB, "sigen_charge_soc", String(settings.chargeSOC));
    await readExtras(env, token, station, info?.sn ?? null);
    console.log(JSON.stringify({ message: "sigen_poll", ok: true }));
  } catch (error) {
    console.error(JSON.stringify({ message: "sigen_poll_failed", error: error instanceof Error ? error.message : "error" }));
  }
}

async function readExtras(env: Env, token: string, station: number, sn: string | null): Promise<void> {
  const extras: { name: string; args: Record<string, unknown> }[] = [
    { name: "get_operational_mode", args: { station_id: station } },
    { name: "get_energy_summary", args: { station_id: station, period: "week" } },
    { name: "get_station_energy_data", args: { station_id: station, dataset: "energy_statistics", period: "day" } },
  ];
  if (sn) extras.push({ name: "get_charger_energy", args: { station_id: station, sn_code: sn, kind: "ac", period: "week" } });
  for (const extra of extras) {
    try {
      await callSigenTool(env, token, extra.name, extra.args);
    } catch (error) {
      console.error(JSON.stringify({ message: "sigen_extra_failed", tool: extra.name, error: error instanceof Error ? error.message : "error" }));
    }
  }
}

async function pollTesla(env: Env): Promise<void> {
  const vault = env.TOKEN_VAULT.getByName("owner");
  const vehicle = await vault.getVehicle();
  if (!vehicle) return;
  const now = Date.now();
  const backoffUntil = Number((await readPoll(env.DB, "tesla_backoff_until")) ?? "0");
  if (now < backoffUntil) return;
  try {
    const online = await vehicleOnline(env, vehicle.id);
    if (!online) {
      const previous = Number((await readPoll(env.DB, "tesla_backoff_ms")) ?? "0");
      const wait = Math.min(60 * 60 * 1000, previous === 0 ? 10 * 60 * 1000 : previous * 2);
      await writePoll(env.DB, "tesla_backoff_ms", String(wait));
      await writePoll(env.DB, "tesla_backoff_until", String(now + wait));
      await env.DB.prepare(
        `INSERT INTO vehicle_samples (ts, online, battery_level, charging_state, charge_limit_soc, charger_power_w, charging_amps, odometer_km, latitude, longitude, climate_on, charge_port_latch)
         VALUES (?, 0, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL)`,
      )
        .bind(now)
        .run();
      console.log(JSON.stringify({ message: "tesla_poll", online: false }));
      return;
    }
    await writePoll(env.DB, "tesla_backoff_ms", "0");
    await writePoll(env.DB, "tesla_backoff_until", "0");
    const reading = parseVehicleData(await readVehicleData(env, vehicle.id));
    await env.DB.prepare(
      `INSERT INTO vehicle_samples
        (ts, online, battery_level, charging_state, charge_limit_soc, charger_power_w, charging_amps, odometer_km, latitude, longitude, climate_on, charge_port_latch)
       VALUES (?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(
        now,
        reading.batteryPercent,
        reading.chargingState,
        reading.chargeLimitPercent,
        reading.chargerPowerW,
        reading.chargingAmps,
        reading.odometerKm,
        reading.lat,
        reading.lon,
        reading.climateOn === null ? null : reading.climateOn ? 1 : 0,
        reading.chargePortLatch,
      )
      .run();
    console.log(JSON.stringify({ message: "tesla_poll", online: true }));
  } catch (error) {
    console.error(JSON.stringify({ message: "tesla_poll_failed", error: error instanceof Error ? error.message : "error" }));
  }
}

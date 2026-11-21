/** Catalog 0.1.4 maps these actions onto the app's enable flag: start is 0, stop is 1. */
export const CHARGER_ENABLE = { start: 0, stop: 1 } as const;

export type ChargerAction = keyof typeof CHARGER_ENABLE;
export type AcChargeMode = "fast" | "pv_surplus";

const BLOCKED_TOOLS = new Set(["login_with_password", "api_call"]);

export function assertToolAllowed(name: string): void {
  if (BLOCKED_TOOLS.has(name)) throw new Error("tool_blocked");
}

export function controlChargerArgs(stationId: number, action: ChargerAction, sn?: string | null): Record<string, unknown> {
  return {
    station_id: stationId,
    kind: "ac",
    action,
    ...(sn ? { sn_code: sn } : {}),
  };
}

export function acChargeModeArgs(stationId: number, sn: string, mode: AcChargeMode): Record<string, unknown> {
  return { station_id: stationId, sn_code: sn, mode };
}

export function withChargeSoc(current: Record<string, unknown>, chargeSoc: number): Record<string, unknown> {
  if (!Number.isFinite(chargeSoc) || chargeSoc < 0 || chargeSoc > 100) throw new Error("charge_soc_range");
  const { confirm_token: _ignored, ...rest } = current;
  return { ...rest, chargeSOC: chargeSoc.toFixed(1) };
}

export function findConfirmToken(value: unknown): string | null {
  if (!value || typeof value !== "object") return null;
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findConfirmToken(item);
      if (found) return found;
    }
    return null;
  }
  for (const [key, child] of Object.entries(value)) {
    if (key === "confirm_token" && typeof child === "string" && child.length > 0) return child;
    const found = findConfirmToken(child);
    if (found) return found;
  }
  return null;
}

export function unwrapToolResult(result: unknown): unknown {
  if (!result || typeof result !== "object") return result;
  const record = result as { structuredContent?: unknown; content?: { type?: string; text?: string }[] };
  if (record.structuredContent && typeof record.structuredContent === "object") return record.structuredContent;
  const text = record.content?.find((item) => item.type === "text")?.text;
  if (typeof text === "string") {
    try {
      return JSON.parse(text) as unknown;
    } catch {
      return { text };
    }
  }
  return result;
}

export interface NormalizedFlow {
  solarW: number;
  homeW: number;
  batteryW: number;
  batterySoc: number | null;
  gridW: number;
  chargerW: number | null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function numberAt(record: Record<string, unknown>, keys: string[]): number | null {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))) return Number(value);
  }
  return null;
}

function watts(value: number): number {
  return Math.abs(value) > 200 ? value : value * 1000;
}

function directionSign(direction: string | undefined, intoPositive: boolean): number | null {
  if (!direction) return null;
  const text = direction.toLowerCase();
  const out = ["discharg", "export", "sell", "feed", "out"].some((word) => text.includes(word));
  const into = !out && ["charg", "import", "buy", "in"].some((word) => text.includes(word));
  if (into === out) return null;
  if (into) return intoPositive ? 1 : -1;
  return intoPositive ? -1 : 1;
}

function signedWatts(power: number, direction: string | undefined, intoPositive: boolean, rawSign = 1): number {
  const magnitude = Math.abs(watts(power));
  if (magnitude === 0) return 0;
  const sign = directionSign(direction, intoPositive);
  if (sign !== null) return sign * magnitude;
  return rawSign * watts(power);
}

function nested(record: Record<string, unknown>, names: string[]): Record<string, unknown> | null {
  for (const name of names) {
    const value = asRecord(record[name]);
    if (value) return value;
  }
  return null;
}

export function normalizeEnergyFlow(input: unknown): NormalizedFlow {
  const root = asRecord(input) ?? {};
  const body = asRecord(root.data) ?? asRecord(root.result) ?? root;
  const pv = nested(body, ["pv", "solar", "photovoltaic"]) ?? body;
  const load = nested(body, ["load", "home", "consumption"]) ?? body;
  const battery = nested(body, ["battery", "storage"]) ?? body;
  const grid = nested(body, ["grid"]) ?? body;
  const ev = nested(body, ["ev", "charger", "evac", "ev_ac"]);

  const raw = asRecord(body.raw) ?? {};
  const solar = numberAt(pv, ["power_kw", "pv_kw", "power", "pvPower", "pv_power", "solarPower", "solar_power", "solarW"]);
  const home = numberAt(load, ["power_kw", "load_kw", "power", "loadPower", "load_power", "homePower", "home_w"]);
  const batteryPower = numberAt(battery, ["power_kw", "power", "batteryPower", "battery_power"]);
  const batteryDirection = typeof battery.direction === "string" ? battery.direction : undefined;
  const soc = numberAt(battery, ["soc_pct", "soc", "batterySoc", "battery_soc", "percent"]) ?? numberAt(body, ["battery_soc_pct"]) ?? numberAt(raw, ["batterySoc"]);
  const gridPower = numberAt(grid, ["power_kw", "power", "gridPower", "grid_power"]);
  const gridDirection = typeof grid.direction === "string" ? grid.direction : undefined;
  const charger = ev ? numberAt(ev, ["power_kw", "power", "evPower", "charger_power"]) : numberAt(body, ["evPower", "chargerPower"]);

  return {
    solarW: Math.abs(watts(solar ?? numberAt(raw, ["pvPower"]) ?? 0)),
    homeW: Math.abs(watts(home ?? numberAt(raw, ["loadPower"]) ?? 0)),
    batteryW: batteryPower === null ? 0 : signedWatts(batteryPower, batteryDirection, true),
    batterySoc: soc,
    gridW: gridPower === null ? 0 : signedWatts(gridPower, gridDirection, true, -1),
    chargerW: charger === null ? null : Math.abs(watts(charger)),
  };
}

export interface ChargerSnapshot {
  sn: string | null;
  runningStatus: number | null;
  cableConnected: boolean;
  charging: boolean;
  powerW: number | null;
  mode: "fast" | "pv_surplus" | "sigen_ai" | null;
}

function modeFrom(value: unknown): ChargerSnapshot["mode"] {
  if (value === 0 || value === "0" || value === "fast") return "fast";
  if (value === 1 || value === "1" || value === "pv_surplus") return "pv_surplus";
  if (value === 2 || value === "2" || value === "sigen_ai") return "sigen_ai";
  return null;
}

function oneCharger(record: Record<string, unknown>): ChargerSnapshot | null {
  const kind = String(record.kind ?? record.type ?? "ac").toLowerCase();
  if (kind && kind !== "ac") return null;
  const basic = asRecord(record.device_basic) ?? asRecord(record.deviceBasic) ?? record;
  const snValue = basic.sn ?? basic.snCode ?? basic.sn_code ?? basic.showSnCode ?? record.sn_code;
  const status = numberAt(record, ["running_status", "runningStatus"]);
  const realtime = asRecord(record.realtime) ?? record;
  const power = numberAt(realtime, ["power_kw", "power", "charge_power"]);
  const mode = modeFrom(record.global_charge_mode ?? record.globalChargeMode ?? record.charge_mode);
  const running = status ?? null;
  return {
    sn: typeof snValue === "string" && snValue ? snValue : null,
    runningStatus: running,
    cableConnected: running === 1 || running === 2 || running === 3,
    charging: running === 2,
    powerW: power === null ? null : Math.abs(watts(power)),
    mode,
  };
}

export function parseChargerInfo(input: unknown): ChargerSnapshot | null {
  const root = asRecord(unwrapToolResult(input)) ?? {};
  const body = asRecord(root.data) ?? root;
  const list = body.chargers ?? body.devices ?? body.ac_chargers;
  if (Array.isArray(list)) {
    for (const item of list) {
      const record = asRecord(item);
      if (!record) continue;
      const parsed = oneCharger(record);
      if (parsed) return parsed;
    }
  }
  return oneCharger(body);
}

export function parseSocSettings(input: unknown): Record<string, unknown> {
  const root = asRecord(unwrapToolResult(input)) ?? {};
  const body = asRecord(root.data) ?? root;
  const settings = asRecord(body.battery_soc_settings) ?? asRecord(body.settings) ?? body;
  const { confirm_token: _ignored, ...rest } = settings;
  return rest;
}

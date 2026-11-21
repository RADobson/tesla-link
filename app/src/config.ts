import type { LatLon } from "./location/fuzz";

export function mocksEnabled(env: Env): boolean {
  const flag: string = env.MOCK_INTEGRATIONS;
  return flag === "true";
}

export function stationId(env: Env): number {
  const id = Number(env.SIGEN_STATION_ID);
  if (!Number.isSafeInteger(id)) throw new Error("bad_station_id");
  return id;
}

export function gridPrice(env: Env): number {
  const price = Number(env.GRID_PRICE_PER_KWH);
  return Number.isFinite(price) && price >= 0 ? price : 0.35;
}

export function homePoint(env: Env): LatLon | null {
  if (!env.HOME_LATITUDE || !env.HOME_LONGITUDE) return null;
  const lat = Number(env.HOME_LATITUDE);
  const lon = Number(env.HOME_LONGITUDE);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
  return { lat, lon };
}

export function fleetUrl(env: Env, path: string): string {
  const base = env.TESLA_FLEET_API.endsWith("/") ? env.TESLA_FLEET_API : `${env.TESLA_FLEET_API}/`;
  return base + path.replace(/^\//, "");
}

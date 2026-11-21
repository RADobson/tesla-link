export const CELL_DEGREES = 0.2;
export const PUBLIC_RADIUS_METERS = 20_000;
export const HOME_MASK_METERS = 2_000;
export const TRAIL_DELAY_MS = 24 * 60 * 60 * 1000;
const MIN_CENTER_SEPARATION_METERS = 250;

export interface LatLon {
  lat: number;
  lon: number;
}

export interface CoarseArea {
  center: LatLon;
  radiusMeters: number;
  precision: "0.2deg-cell";
}

export interface TrailSample extends LatLon {
  ts: number;
}

export interface FuzzedTrailPoint extends CoarseArea {
  ts: number;
}

function assertPoint(point: LatLon): void {
  if (!Number.isFinite(point.lat) || !Number.isFinite(point.lon)) throw new Error("invalid_coordinates");
  if (Math.abs(point.lat) > 90 || Math.abs(point.lon) > 180) throw new Error("invalid_coordinates");
}

export function haversineMeters(a: LatLon, b: LatLon): number {
  const radius = 6_371_000;
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * radius * Math.asin(Math.min(1, Math.sqrt(h)));
}

function cellCenter(latIndex: number, lonIndex: number): LatLon {
  const round = (value: number) => Math.round(value * 1e6) / 1e6;
  return {
    lat: round((latIndex + 0.5) * CELL_DEGREES),
    lon: round((lonIndex + 0.5) * CELL_DEGREES),
  };
}

/**
 * Snap a point to the centre of a 0.2° cell (about 22 km north-south) and
 * publish a 20 km radius. The centre is moved when it would sit on the raw
 * point or on the stored home coordinate.
 */
export function coarseArea(point: LatLon, home?: LatLon | null): CoarseArea {
  assertPoint(point);
  if (home) assertPoint(home);
  let latIndex = Math.floor(point.lat / CELL_DEGREES);
  const lonIndex = Math.floor(point.lon / CELL_DEGREES);
  let center = cellCenter(latIndex, lonIndex);
  if (haversineMeters(center, point) < MIN_CENTER_SEPARATION_METERS) {
    latIndex += 1;
    center = cellCenter(latIndex, lonIndex);
  }
  if (home && haversineMeters(center, home) < 500) {
    latIndex += 1;
    center = cellCenter(latIndex, lonIndex);
  }
  return { center, radiusMeters: PUBLIC_RADIUS_METERS, precision: "0.2deg-cell" };
}

/** Positions from the last 24 hours are dropped. Points near home are dropped. */
export function delayedTrail(samples: TrailSample[], now: number, home?: LatLon | null): FuzzedTrailPoint[] {
  const points: FuzzedTrailPoint[] = [];
  for (const sample of samples) {
    if (now - sample.ts < TRAIL_DELAY_MS) continue;
    if (home && haversineMeters(sample, home) <= HOME_MASK_METERS) continue;
    points.push({ ...coarseArea(sample, home), ts: sample.ts });
  }
  return points;
}

const FORBIDDEN_KEYS = new Set([
  "vin",
  "refresh_token",
  "refreshtoken",
  "access_token",
  "accesstoken",
  "latitude",
  "longitude",
  "serial",
  "serialnumber",
  "sn",
  "sn_code",
  "sncode",
  "showsncode",
  "credential",
  "private_key",
  "privatekey",
  "client_secret",
  "clientsecret",
  "confirm_token",
  "confirmtoken",
]);

export function findForbiddenKeys(value: unknown, path = ""): string[] {
  if (Array.isArray(value)) {
    return value.flatMap((item, index) => findForbiddenKeys(item, `${path}[${index}]`));
  }
  if (!value || typeof value !== "object") return [];
  const found: string[] = [];
  for (const [key, child] of Object.entries(value)) {
    const here = path ? `${path}.${key}` : key;
    if (FORBIDDEN_KEYS.has(key.toLowerCase())) found.push(here);
    found.push(...findForbiddenKeys(child, here));
  }
  return found;
}

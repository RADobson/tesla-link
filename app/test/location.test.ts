import { describe, expect, it } from "vitest";
import {
  CELL_DEGREES,
  coarseArea,
  delayedTrail,
  findForbiddenKeys,
  haversineMeters,
  HOME_MASK_METERS,
  PUBLIC_RADIUS_METERS,
  TRAIL_DELAY_MS,
} from "../src/location/fuzz";
import { toPublicDashboard, type PrivateSnapshot } from "../src/energy/public";

const home = { lat: -33.87, lon: 151.21 };
const car = { lat: -33.8612, lon: 151.2044 };

describe("location fuzzing", () => {
  it("never returns the exact point and always uses a large radius", () => {
    const area = coarseArea(car, home);
    expect(area.center.lat).not.toBe(car.lat);
    expect(area.center.lon).not.toBe(car.lon);
    expect(area.radiusMeters).toBeGreaterThanOrEqual(15_000);
    expect(area.radiusMeters).toBe(PUBLIC_RADIUS_METERS);
    const distance = haversineMeters(area.center, car);
    const cellMeters = CELL_DEGREES * 111_000;
    expect(distance).toBeGreaterThanOrEqual(250);
    expect(distance).toBeLessThan(cellMeters * 2);
  });

  it("moves the centre off a point that already sits on a cell centre", () => {
    const exact = { lat: -33.9, lon: 151.1 };
    const area = coarseArea(exact);
    expect(haversineMeters(area.center, exact)).toBeGreaterThanOrEqual(250);
  });

  it("does not centre a public area on the home coordinate", () => {
    const area = coarseArea(home, home);
    expect(haversineMeters(area.center, home)).toBeGreaterThanOrEqual(500);
  });

  it("delays trips by 24 hours and masks home", () => {
    const now = 1_800_000_000_000;
    const far = { lat: -33.7, lon: 151.05, ts: now - TRAIL_DELAY_MS - 60_000 };
    const recent = { lat: -33.7, lon: 151.05, ts: now - 60_000 };
    const atHome = { lat: home.lat + 0.001, lon: home.lon, ts: now - TRAIL_DELAY_MS - 60_000 };
    expect(haversineMeters(atHome, home)).toBeLessThan(HOME_MASK_METERS);
    const trail = delayedTrail([far, recent, atHome], now, home);
    expect(trail).toHaveLength(1);
    expect(trail[0]?.ts).toBe(far.ts);
    expect(trail[0]?.center.lat === far.lat && trail[0]?.center.lon === far.lon).toBe(false);
  });

  it("keeps exact coordinates out of the public dashboard", () => {
    const snapshot: PrivateSnapshot = {
      asOf: 1_800_000_000_000,
      vehicleName: "White Lotus",
      currency: "AUD",
      stale: false,
      energy: { solarW: 1000, homeW: 400, batteryW: -100, batterySoc: 70, gridW: -500 },
      vehicle: { online: true, batteryPercent: 64, chargingState: "Charging", chargeLimitPercent: 80, climateOn: false },
      score: { kmDriven: 12, solarKwh: 4, gridKwh: 1, solarShare: 0.8, dollarsSaved: 1.4 },
      location: { ...car, ts: 1_800_000_000_000 - 1000 },
      home,
      trail: [{ ...car, ts: 1_800_000_000_000 - TRAIL_DELAY_MS - 1000 }],
      history: [{ ts: 1, solarW: 1, homeW: 1, gridW: 1, batterySoc: 70 }],
    };
    const secretBlob = {
      ...snapshot,
      vin: "5YJ3E1EA7LF000000",
      refresh_token: "secret",
      latitude: car.lat,
      longitude: car.lon,
    };
    expect(findForbiddenKeys(secretBlob).length).toBeGreaterThan(0);
    const pub = toPublicDashboard(snapshot, 1_800_000_000_000);
    expect(findForbiddenKeys(pub)).toEqual([]);
    expect(JSON.stringify(pub)).not.toContain(String(car.lat));
    expect(JSON.stringify(pub)).not.toContain(String(car.lon));
    expect(pub.map?.center.lat).not.toBe(car.lat);
  });
});

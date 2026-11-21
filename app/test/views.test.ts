import { describe, expect, it } from "vitest";
import { toPublicDashboard, type PrivateSnapshot } from "../src/energy/public";
import { chargeSessions, dayMarks } from "../src/energy/views";
import { findForbiddenKeys } from "../src/location/fuzz";

describe("dashboard aggregates", () => {
  it("groups a sunny day and splits charge sessions on a long gap", () => {
    const start = Date.UTC(2026, 0, 5, 0, 0, 0);
    const points = Array.from({ length: 9 }, (_, index) => ({
      ts: start + index * 3_600_000,
      solarW: index < 4 ? 0 : 3000,
      homeW: 1000,
    }));
    const days = dayMarks(points, "UTC");
    expect(days).toHaveLength(1);
    expect(days[0]?.self).toBeGreaterThan(0);
    expect(days[0]?.self).toBeLessThanOrEqual(1);

    const sessions = chargeSessions([
      { ts: 0, solarKwh: 1, gridKwh: 0 },
      { ts: 10 * 60 * 1000, solarKwh: 1, gridKwh: 0.2 },
      { ts: 3 * 60 * 60 * 1000, solarKwh: 0.4, gridKwh: 1 },
    ]);
    expect(sessions).toHaveLength(2);
    expect(sessions[0]?.solarKwh).toBeCloseTo(2);
    expect(sessions[1]?.gridKwh).toBeCloseTo(1);
  });

  it("keeps new public fields free of exact coordinates and secrets", () => {
    const car = { lat: -33.8612, lon: 151.2044 };
    const snapshot: PrivateSnapshot = {
      asOf: 1_800_000_000_000,
      vehicleName: "White Lotus",
      currency: "AUD",
      stale: false,
      energy: { solarW: 1000, homeW: 400, batteryW: -100, batterySoc: 70, gridW: -500, chargerW: 2000 },
      vehicle: { online: true, batteryPercent: 64, chargingState: "Charging", chargeLimitPercent: 80, climateOn: false },
      score: { kmDriven: 12, solarKwh: 4, gridKwh: 1, solarShare: 0.8, dollarsSaved: 1.4 },
      location: { ...car, ts: 1_800_000_000_000 - 1000 },
      home: { lat: -33.87, lon: 151.21 },
      trail: [],
      history: [{ ts: 1, solarW: 1, homeW: 1, gridW: 1, batterySoc: 70 }],
      timeZone: "Australia/Sydney",
      days: [{ label: "Mon 5", self: 0.5 }],
      sessions: [{ start: 10, end: 20, solarKwh: 1, gridKwh: 0.2 }],
    };
    const pub = toPublicDashboard(snapshot, 1_800_000_000_000);
    expect(findForbiddenKeys(pub)).toEqual([]);
    expect(JSON.stringify(pub)).not.toContain(String(car.lat));
    expect(pub.days).toHaveLength(1);
    expect(pub.sessions).toHaveLength(1);
    expect(pub.timeZone).toBe("Australia/Sydney");
  });
});

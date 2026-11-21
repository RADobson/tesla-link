import { describe, expect, it } from "vitest";
import { normalizeEnergyFlow } from "../src/sigen/parse";

describe("Sigen energy parsing", () => {
  it("reads Sigen field names and treats positive grid power as export", () => {
    const named = normalizeEnergyFlow({
      pv_kw: 5.4,
      load_kw: 1.25,
      soc_pct: 62,
      grid_power: 2.4,
    });
    expect(named.solarW).toBe(5400);
    expect(named.homeW).toBe(1250);
    expect(named.batterySoc).toBe(62);
    expect(named.gridW).toBe(-2400);

    const raw = normalizeEnergyFlow({
      raw: { pvPower: 3200, loadPower: 800, batterySoc: 41 },
      grid_power: 1.5,
    });
    expect(raw.solarW).toBe(3200);
    expect(raw.homeW).toBe(800);
    expect(raw.batterySoc).toBe(41);
    expect(raw.gridW).toBe(-1500);
  });
});

import { describe, expect, it } from "vitest";
import { attributeChargeInterval, kilometresDriven, solarScore } from "../src/energy/score";
import { CHARGER_ENABLE, controlChargerArgs, withChargeSoc } from "../src/sigen/parse";

describe("solar score", () => {
  it("sums forward odometer steps and ignores a backwards jump", () => {
    const km = kilometresDriven(
      [
        { ts: 0, km: 100 },
        { ts: 1, km: 112.5 },
        { ts: 2, km: 90 },
        { ts: 3, km: 104 },
      ],
      0,
      10,
    );
    expect(km).toBe(26.5);
  });

  it("attributes midday charging to solar and prices the saving", () => {
    const slice = attributeChargeInterval(
      { ts: 0, solarW: 0, homeW: 0, chargerW: 0, gridW: 0 },
      { ts: 3_600_000, solarW: 5000, homeW: 8000, chargerW: 7000, gridW: 3000 },
    );
    expect(slice.solarKwh).toBeCloseTo(4, 5);
    expect(slice.gridKwh).toBeCloseTo(3, 5);
    const score = solarScore({
      odometer: [
        { ts: 0, km: 10 },
        { ts: 5, km: 28 },
      ],
      charge: [{ ts: 1, ...slice }],
      weekStart: 0,
      weekEnd: 10,
      gridPricePerKwh: 0.35,
    });
    expect(score.kmDriven).toBe(18);
    expect(score.solarShare).toBeCloseTo(4 / 7, 5);
    expect(score.dollarsSaved).toBeCloseTo(1.4, 2);
  });
});

describe("sigen write arguments", () => {
  it("starts with action start, which the catalog maps to enable 0", () => {
    expect(CHARGER_ENABLE.start).toBe(0);
    expect(CHARGER_ENABLE.stop).toBe(1);
    expect(controlChargerArgs(2610281435597087, "start")).toEqual({
      station_id: 2610281435597087,
      kind: "ac",
      action: "start",
    });
  });

  it("changes only chargeSOC", () => {
    const next = withChargeSoc(
      { chargeSOC: "90.0", dischargeSOC: "10.0", backupSOC: "20.0", peakShavingSOC: "30.0", ja12SOC: "0.0", confirm_token: "nope" },
      80,
    );
    expect(next).toEqual({
      chargeSOC: "80.0",
      dischargeSOC: "10.0",
      backupSOC: "20.0",
      peakShavingSOC: "30.0",
      ja12SOC: "0.0",
    });
  });
});

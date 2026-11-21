export interface OdometerSample {
  ts: number;
  km: number;
}

export interface ChargeSlice {
  ts: number;
  solarKwh: number;
  gridKwh: number;
}

export interface FlowSample {
  ts: number;
  solarW: number;
  homeW: number;
  chargerW: number;
  gridW: number;
}

export interface SolarScore {
  kmDriven: number;
  solarKwh: number;
  gridKwh: number;
  solarShare: number;
  dollarsSaved: number;
}

function round(value: number, digits: number): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

/** Positive odometer steps only. A backwards jump or a huge teleport is ignored. */
export function kilometresDriven(samples: OdometerSample[], weekStart: number, weekEnd: number): number {
  const ordered = samples
    .filter((sample) => sample.ts >= weekStart && sample.ts < weekEnd && Number.isFinite(sample.km))
    .sort((a, b) => a.ts - b.ts);
  let km = 0;
  for (let i = 1; i < ordered.length; i++) {
    const delta = ordered[i].km - ordered[i - 1].km;
    if (delta > 0 && delta < 2_000) km += delta;
  }
  return round(km, 1);
}

/**
 * Live solar is what the roof is producing beyond the rest of the house.
 * The remainder that matches grid import is counted as grid. Battery energy
 * is not called solar and is not called grid.
 */
export function attributeChargeInterval(prev: FlowSample, next: FlowSample): { solarKwh: number; gridKwh: number } {
  const hours = (next.ts - prev.ts) / 3_600_000;
  if (hours <= 0 || hours > 1) return { solarKwh: 0, gridKwh: 0 };
  const chargerW = Math.max(0, next.chargerW);
  if (chargerW < 50) return { solarKwh: 0, gridKwh: 0 };
  const houseOther = Math.max(0, next.homeW - chargerW);
  const surplus = Math.max(0, next.solarW - houseOther);
  const solarW = Math.min(chargerW, surplus);
  const gridW = Math.min(chargerW - solarW, Math.max(0, next.gridW));
  return { solarKwh: (solarW * hours) / 1000, gridKwh: (gridW * hours) / 1000 };
}

export function solarScore(input: {
  odometer: OdometerSample[];
  charge: ChargeSlice[];
  weekStart: number;
  weekEnd: number;
  gridPricePerKwh: number;
}): SolarScore {
  const slices = input.charge.filter((slice) => slice.ts >= input.weekStart && slice.ts < input.weekEnd);
  const solarKwh = slices.reduce((sum, slice) => sum + Math.max(0, slice.solarKwh), 0);
  const gridKwh = slices.reduce((sum, slice) => sum + Math.max(0, slice.gridKwh), 0);
  const total = solarKwh + gridKwh;
  return {
    kmDriven: kilometresDriven(input.odometer, input.weekStart, input.weekEnd),
    solarKwh: round(solarKwh, 2),
    gridKwh: round(gridKwh, 2),
    solarShare: total > 0 ? solarKwh / total : 0,
    dollarsSaved: round(solarKwh * Math.max(0, input.gridPricePerKwh), 2),
  };
}

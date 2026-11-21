import type { HistoryPoint, PrivateSnapshot, PublicEnergy } from "../energy/public";
import { attributeChargeInterval, solarScore, type FlowSample, type OdometerSample } from "../energy/score";
import { weekRange, zonedParts } from "../energy/time";
import { chargeSessions, dayMarks } from "../energy/views";
import type { TrailSample } from "../location/fuzz";

/** A public waterfront used only as sample data. It is not a home. */
export const SAMPLE_POINT = { lat: -33.8688, lon: 151.2093 };

interface Point extends FlowSample {
  batteryW: number;
  batterySoc: number;
  odometerKm: number;
}

function hourValue(ts: number, timeZone: string): { hour: number; weekday: number } {
  const parts = zonedParts(new Date(ts), timeZone);
  return { hour: parts.hour + parts.minute / 60, weekday: parts.weekday };
}

function solarWatts(hour: number): number {
  if (hour < 6.2 || hour > 19.2) return 0;
  const x = (hour - 6.2) / (19.2 - 6.2);
  return Math.round(7600 * Math.sin(Math.PI * x) ** 1.25);
}

export function illustrativePoints(now: number, timeZone: string): Point[] {
  const step = 15 * 60 * 1000;
  const start = now - 7 * 24 * 60 * 60 * 1000;
  const points: Point[] = [];
  let soc = 62;
  let odometer = 41_000;
  for (let ts = start; ts <= now; ts += step) {
    const { hour, weekday } = hourValue(ts, timeZone);
    const solarW = solarWatts(hour);
    const homeW = Math.round(980 + 380 * Math.max(0, Math.sin(((hour - 7) / 24) * Math.PI * 2)));
    const surplusForCar = solarW - homeW - 600;
    const chargerW = weekday <= 5 && hour >= 10.5 && hour < 15 && surplusForCar > 800 ? Math.min(7000, Math.round(surplusForCar)) : 0;
    const surplus = solarW - homeW - chargerW;
    let batteryW = 0;
    if (surplus > 500 && soc < 94) batteryW = Math.min(2800, Math.round(surplus * 0.4));
    else if (soc > 30 && (hour >= 17 || hour < 6.2)) batteryW = -Math.min(homeW, 1400);
    soc = Math.min(100, Math.max(15, soc + (batteryW * (step / 3_600_000)) / 1000 / 48 * 100));
    const gridW = Math.round(homeW + chargerW + batteryW - solarW);
    if (weekday <= 5 && hour >= 8 && hour < 8.25) odometer += 18;
    if (weekday <= 5 && hour >= 18 && hour < 18.25) odometer += 16;
    points.push({
      ts,
      solarW,
      homeW,
      chargerW,
      batteryW,
      gridW,
      batterySoc: Math.round(soc),
      odometerKm: Math.round(odometer * 10) / 10,
    });
  }
  return points;
}

export function illustrativeSnapshot(now: number, timeZone: string, price: number, currency: string, vehicleName: string): PrivateSnapshot {
  const points = illustrativePoints(now, timeZone);
  const latest = points[points.length - 1];
  const week = weekRange(new Date(now), timeZone);
  const charge = [];
  const odometer: OdometerSample[] = [];
  for (let i = 1; i < points.length; i++) {
    const slice = attributeChargeInterval(points[i - 1], points[i]);
    if (slice.solarKwh > 0 || slice.gridKwh > 0) charge.push({ ts: points[i].ts, ...slice });
    odometer.push({ ts: points[i].ts, km: points[i].odometerKm });
  }
  const history: HistoryPoint[] = points
    .filter((point) => point.ts >= now - 24 * 60 * 60 * 1000)
    .map((point) => ({
      ts: point.ts,
      solarW: point.solarW,
      homeW: point.homeW,
      gridW: point.gridW,
      batterySoc: point.batterySoc,
    }));
  const trail: TrailSample[] = [
    { ts: now - 26 * 60 * 60 * 1000, lat: -33.75, lon: 151.02 },
    { ts: now - 30 * 60 * 1000, ...SAMPLE_POINT },
  ];
  const energy: PublicEnergy = {
    solarW: latest?.solarW ?? 0,
    homeW: latest?.homeW ?? 0,
    batteryW: latest?.batteryW ?? 0,
    batterySoc: latest?.batterySoc ?? null,
    gridW: latest?.gridW ?? 0,
    chargerW: latest?.chargerW ?? 0,
  };
  return {
    asOf: now,
    vehicleName,
    currency,
    stale: false,
    energy,
    vehicle: {
      online: true,
      batteryPercent: 64,
      chargingState: (latest?.chargerW ?? 0) > 0 ? "Charging" : "Disconnected",
      chargeLimitPercent: 80,
      climateOn: false,
    },
    score: solarScore({ odometer, charge, weekStart: week.start, weekEnd: week.end, gridPricePerKwh: price }),
    location: { ...SAMPLE_POINT, ts: now - 5 * 60 * 1000 },
    home: null,
    trail,
    history,
    timeZone,
    days: dayMarks(points, timeZone),
    sessions: chargeSessions(charge),
  };
}

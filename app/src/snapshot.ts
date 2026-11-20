import { gridPrice, homePoint, mocksEnabled } from "./config";
import { chargeSince, energyHistory, latestEnergy, latestVehicle, odometerSince, privateLocation, privateTrail } from "./db";
import type { PrivateSnapshot } from "./energy/public";
import { solarScore } from "./energy/score";
import { weekRange } from "./energy/time";
import { illustrativeSnapshot } from "./mock/sample";

export async function loadSnapshot(env: Env): Promise<PrivateSnapshot> {
  const now = Date.now();
  const history = await energyHistory(env.DB, now - 24 * 60 * 60 * 1000);
  if (mocksEnabled(env) && history.length < 8) {
    return illustrativeSnapshot(now, env.HOUSE_TIMEZONE, gridPrice(env), env.CURRENCY, env.VEHICLE_NAME);
  }
  const energy = await latestEnergy(env.DB);
  const vehicle = await latestVehicle(env.DB);
  const week = weekRange(new Date(now), env.HOUSE_TIMEZONE);
  return {
    asOf: energy?.ts ?? now,
    vehicleName: env.VEHICLE_NAME,
    currency: env.CURRENCY,
    stale: !energy || now - energy.ts > 20 * 60 * 1000,
    energy: energy
      ? {
          solarW: energy.solarW,
          homeW: energy.homeW,
          batteryW: energy.batteryW,
          batterySoc: energy.batterySoc,
          gridW: energy.gridW,
        }
      : { solarW: 0, homeW: 0, batteryW: 0, batterySoc: null, gridW: 0 },
    vehicle: vehicle ?? {
      online: false,
      batteryPercent: null,
      chargingState: null,
      chargeLimitPercent: null,
      climateOn: null,
    },
    score: solarScore({
      odometer: await odometerSince(env.DB, week.start),
      charge: await chargeSince(env.DB, week.start),
      weekStart: week.start,
      weekEnd: week.end,
      gridPricePerKwh: gridPrice(env),
    }),
    location: await privateLocation(env.DB),
    home: homePoint(env),
    trail: await privateTrail(env.DB, now - 8 * 24 * 60 * 60 * 1000),
    history,
  };
}

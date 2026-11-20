import { coarseArea, delayedTrail, findForbiddenKeys, type LatLon, type TrailSample } from "../location/fuzz";
import type { SolarScore } from "./score";

export interface PublicEnergy {
  solarW: number;
  homeW: number;
  batteryW: number;
  batterySoc: number | null;
  gridW: number;
}

export interface PublicVehicle {
  online: boolean;
  batteryPercent: number | null;
  chargingState: string | null;
  chargeLimitPercent: number | null;
  climateOn: boolean | null;
}

export interface HistoryPoint {
  ts: number;
  solarW: number;
  homeW: number;
  gridW: number;
  batterySoc: number | null;
}

export interface PublicDashboard {
  asOf: string;
  vehicleName: string;
  stale: boolean;
  energy: PublicEnergy;
  vehicle: PublicVehicle;
  score: SolarScore & { currency: string };
  map: {
    mode: "coarse-area";
    center: LatLon;
    radiusMeters: number;
    precision: "0.2deg-cell";
    asOf: string;
  } | null;
  trail: { mode: "delayed-24h"; points: { ts: number; center: LatLon; radiusMeters: number }[] };
  history: HistoryPoint[];
}

export interface PrivateSnapshot {
  asOf: number;
  vehicleName: string;
  currency: string;
  stale: boolean;
  energy: PublicEnergy;
  vehicle: PublicVehicle;
  score: SolarScore;
  location: (LatLon & { ts: number }) | null;
  home: LatLon | null;
  trail: TrailSample[];
  history: HistoryPoint[];
}

export function toPublicDashboard(input: PrivateSnapshot, now: number): PublicDashboard {
  const area = input.location ? coarseArea(input.location, input.home) : null;
  const dashboard: PublicDashboard = {
    asOf: new Date(input.asOf).toISOString(),
    vehicleName: input.vehicleName,
    stale: input.stale,
    energy: input.energy,
    vehicle: input.vehicle,
    score: { ...input.score, currency: input.currency },
    map: area
      ? {
          mode: "coarse-area",
          center: area.center,
          radiusMeters: area.radiusMeters,
          precision: area.precision,
          asOf: new Date(input.location?.ts ?? input.asOf).toISOString(),
        }
      : null,
    trail: {
      mode: "delayed-24h",
      points: delayedTrail(input.trail, now, input.home).map((point) => ({
        ts: point.ts,
        center: point.center,
        radiusMeters: point.radiusMeters,
      })),
    },
    history: input.history,
  };
  const leaks = findForbiddenKeys(dashboard);
  if (leaks.length > 0) throw new Error("public_leak");
  return dashboard;
}

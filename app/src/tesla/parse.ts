export interface ListedVehicle {
  id: string;
  vin: string;
  name: string;
  state: string;
}

export interface VehicleReading {
  online: boolean;
  batteryPercent: number | null;
  chargingState: string | null;
  chargeLimitPercent: number | null;
  chargingAmps: number | null;
  chargerPowerW: number | null;
  chargePortLatch: string | null;
  climateOn: boolean | null;
  odometerKm: number | null;
  lat: number | null;
  lon: number | null;
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function parseVehicleList(payload: unknown): ListedVehicle[] {
  const root = record(payload);
  const list = root?.response;
  if (!Array.isArray(list)) return [];
  const vehicles: ListedVehicle[] = [];
  for (const item of list) {
    const row = record(item);
    if (!row) continue;
    const vin = typeof row.vin === "string" ? row.vin : "";
    const id = typeof row.id_s === "string" ? row.id_s : row.id !== undefined ? String(row.id) : "";
    if (!vin || !id) continue;
    vehicles.push({
      id,
      vin,
      name: typeof row.display_name === "string" ? row.display_name : "",
      state: typeof row.state === "string" ? row.state : "unknown",
    });
  }
  return vehicles;
}

export function parseVehicleState(payload: unknown): string {
  const response = record(record(payload)?.response);
  return typeof response?.state === "string" ? response.state : "unknown";
}

const MILES_TO_KM = 1.609344;

export function parseVehicleData(payload: unknown): VehicleReading {
  const response = record(record(payload)?.response) ?? {};
  const charge = record(response.charge_state) ?? {};
  const vehicle = record(response.vehicle_state) ?? {};
  const climate = record(response.climate_state) ?? {};
  const drive = record(response.drive_state) ?? {};
  const location = record(response.location_data) ?? {};
  const powerKw = num(charge.charger_power);
  const odometerMiles = num(vehicle.odometer);
  const lat = num(location.latitude) ?? num(drive.latitude);
  const lon = num(location.longitude) ?? num(drive.longitude);
  return {
    online: true,
    batteryPercent: num(charge.battery_level),
    chargingState: typeof charge.charging_state === "string" ? charge.charging_state : null,
    chargeLimitPercent: num(charge.charge_limit_soc),
    chargingAmps: num(charge.charge_amps),
    chargerPowerW: powerKw === null ? null : powerKw * 1000,
    chargePortLatch: typeof charge.charge_port_latch === "string" ? charge.charge_port_latch : null,
    climateOn: typeof climate.is_climate_on === "boolean" ? climate.is_climate_on : null,
    odometerKm: odometerMiles === null ? null : Math.round(odometerMiles * MILES_TO_KM * 10) / 10,
    lat,
    lon,
  };
}

export function chooseVehicle(vehicles: ListedVehicle[], preferredName: string): ListedVehicle | null {
  const match = vehicles.find((vehicle) => vehicle.name.toLowerCase() === preferredName.toLowerCase());
  return match ?? vehicles[0] ?? null;
}

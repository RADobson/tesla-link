import { protoBytes, protoVarint } from "./protobuf";

function action(vehicleAction: Uint8Array): Uint8Array {
  return protoBytes(2, vehicleAction);
}

function emptyField(field: number): Uint8Array {
  return protoBytes(field, new Uint8Array());
}

/** CarServer.Action for the commands this house sends. Field numbers follow vehicle-command. */
export function hvacAuto(powerOn: boolean): Uint8Array {
  const body = powerOn ? protoVarint(1, 1) : new Uint8Array();
  return action(protoBytes(10, body));
}

export function chargeStart(): Uint8Array {
  return action(protoBytes(6, emptyField(2)));
}

export function chargeStop(): Uint8Array {
  return action(protoBytes(6, emptyField(5)));
}

export function setChargeLimit(percent: number): Uint8Array {
  if (!Number.isInteger(percent) || percent < 50 || percent > 100) throw new Error("charge_limit_range");
  return action(protoBytes(5, protoVarint(1, percent)));
}

export function setChargingAmps(amps: number): Uint8Array {
  if (!Number.isInteger(amps) || amps < 1 || amps > 48) throw new Error("charging_amps_range");
  return action(protoBytes(43, protoVarint(1, amps)));
}

export function chargePortDoorOpen(): Uint8Array {
  return action(emptyField(62));
}

export function commandHex(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export const COMMANDS = {
  hvacOn: () => hvacAuto(true),
  hvacOff: () => hvacAuto(false),
  chargeStart,
  chargeStop,
  setChargeLimit,
  setChargingAmps,
  chargePortDoorOpen,
};

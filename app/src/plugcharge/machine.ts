export const PLUG_WAIT_MS = 5 * 60 * 1000;

export type PlugPhase =
  | "idle"
  | "opening_port"
  | "waiting_for_cable"
  | "starting_charge"
  | "charging"
  | "timed_out"
  | "failed"
  | "cancelled";

export interface PlugState {
  phase: PlugPhase;
  startedAt: number | null;
  deadlineAt: number | null;
  message: string;
  error: string | null;
  updatedAt: number;
}

export type PlugEffect =
  | { type: "wake_and_open_port" }
  | { type: "poll_soon" }
  | { type: "start_charging" }
  | { type: "clear_alarm" };

export type PlugEvent =
  | { type: "start"; now: number }
  | { type: "port_opened"; now: number }
  | { type: "port_failed"; now: number; error: string }
  | { type: "sample"; now: number; cableConnected: boolean }
  | { type: "charge_started"; now: number }
  | { type: "charge_failed"; now: number; error: string }
  | { type: "cancel"; now: number };

export interface PlugResult {
  state: PlugState;
  effects: PlugEffect[];
  rejected?: "busy";
}

const ACTIVE: PlugPhase[] = ["opening_port", "waiting_for_cable", "starting_charge"];

export function initialPlug(now: number): PlugState {
  return {
    phase: "idle",
    startedAt: null,
    deadlineAt: null,
    message: "Idle",
    error: null,
    updatedAt: now,
  };
}

export function cableConnected(input: {
  chargePortLatch?: string | null;
  chargingState?: string | null;
  sigenConnected?: boolean | null;
}): boolean {
  if (input.sigenConnected) return true;
  const latch = (input.chargePortLatch ?? "").toLowerCase();
  if (latch === "engaged") return true;
  const state = (input.chargingState ?? "").toLowerCase();
  return ["connected", "charging", "stopped", "complete", "starting", "nopower"].includes(state);
}

function next(state: PlugState, patch: Partial<PlugState>, now: number): PlugState {
  return { ...state, ...patch, updatedAt: now };
}

export function reducePlug(state: PlugState, event: PlugEvent): PlugResult {
  const now = event.now;
  if (event.type === "start") {
    if (ACTIVE.includes(state.phase)) return { state, effects: [], rejected: "busy" };
    return {
      state: next(
        state,
        {
          phase: "opening_port",
          startedAt: now,
          deadlineAt: null,
          message: "Waking the car and opening the charge port",
          error: null,
        },
        now,
      ),
      effects: [{ type: "wake_and_open_port" }],
    };
  }

  if (event.type === "port_opened" && state.phase === "opening_port") {
    return {
      state: next(
        state,
        {
          phase: "waiting_for_cable",
          deadlineAt: now + PLUG_WAIT_MS,
          message: "Charge port is open. Plug in within 5 minutes.",
          error: null,
        },
        now,
      ),
      effects: [{ type: "poll_soon" }],
    };
  }

  if (event.type === "port_failed" && state.phase === "opening_port") {
    return {
      state: next(state, { phase: "failed", message: "Could not open the charge port", error: event.error }, now),
      effects: [{ type: "clear_alarm" }],
    };
  }

  if (event.type === "sample" && state.phase === "waiting_for_cable") {
    if (state.deadlineAt !== null && now > state.deadlineAt) {
      return {
        state: next(
          state,
          { phase: "timed_out", message: "No cable detected within 5 minutes", error: null },
          now,
        ),
        effects: [{ type: "clear_alarm" }],
      };
    }
    if (event.cableConnected) {
      return {
        state: next(
          state,
          { phase: "starting_charge", message: "Cable connected. Starting the charger.", error: null },
          now,
        ),
        effects: [{ type: "start_charging" }],
      };
    }
    return {
      state: next(state, { message: "Waiting for the cable" }, now),
      effects: [{ type: "poll_soon" }],
    };
  }

  if (event.type === "charge_started" && state.phase === "starting_charge") {
    return {
      state: next(state, { phase: "charging", message: "Charging started", error: null }, now),
      effects: [{ type: "clear_alarm" }],
    };
  }

  if (event.type === "charge_failed" && state.phase === "starting_charge") {
    return {
      state: next(state, { phase: "failed", message: "The charger did not start", error: event.error }, now),
      effects: [{ type: "clear_alarm" }],
    };
  }

  if (event.type === "cancel" && ACTIVE.includes(state.phase)) {
    return {
      state: next(state, { phase: "cancelled", message: "Cancelled", error: null }, now),
      effects: [{ type: "clear_alarm" }],
    };
  }

  return { state, effects: [] };
}

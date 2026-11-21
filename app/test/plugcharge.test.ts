import { describe, expect, it } from "vitest";
import { cableConnected, initialPlug, PLUG_WAIT_MS, reducePlug } from "../src/plugcharge/machine";

const start = 1_700_000_000_000;

describe("plug and charge", () => {
  it("opens the port, waits, then starts charging when the cable connects", () => {
    let state = initialPlug(start);
    let step = reducePlug(state, { type: "start", now: start });
    expect(step.rejected).toBeUndefined();
    expect(step.state.phase).toBe("opening_port");
    expect(step.effects.map((effect) => effect.type)).toEqual(["wake_and_open_port"]);

    step = reducePlug(step.state, { type: "port_opened", now: start + 1_000 });
    expect(step.state.phase).toBe("waiting_for_cable");
    expect(step.state.deadlineAt).toBe(start + 1_000 + PLUG_WAIT_MS);
    expect(step.effects.map((effect) => effect.type)).toEqual(["poll_soon"]);

    step = reducePlug(step.state, { type: "sample", now: start + 20_000, cableConnected: false });
    expect(step.state.phase).toBe("waiting_for_cable");

    step = reducePlug(step.state, { type: "sample", now: start + 30_000, cableConnected: true });
    expect(step.state.phase).toBe("starting_charge");
    expect(step.effects.map((effect) => effect.type)).toEqual(["start_charging"]);

    step = reducePlug(step.state, { type: "charge_started", now: start + 31_000 });
    expect(step.state.phase).toBe("charging");
    expect(step.effects.map((effect) => effect.type)).toEqual(["clear_alarm"]);
  });

  it("times out five minutes after the port opens", () => {
    let state = reducePlug(initialPlug(start), { type: "start", now: start }).state;
    state = reducePlug(state, { type: "port_opened", now: start }).state;
    const timed = reducePlug(state, { type: "sample", now: start + PLUG_WAIT_MS + 1, cableConnected: false });
    expect(timed.state.phase).toBe("timed_out");
    expect(timed.effects.map((effect) => effect.type)).toEqual(["clear_alarm"]);
    expect(PLUG_WAIT_MS).toBe(5 * 60 * 1000);
  });

  it("does not start a second session while one is waiting", () => {
    let state = reducePlug(initialPlug(start), { type: "start", now: start }).state;
    state = reducePlug(state, { type: "port_opened", now: start }).state;
    const again = reducePlug(state, { type: "start", now: start + 10 });
    expect(again.rejected).toBe("busy");
    expect(again.state.phase).toBe("waiting_for_cable");
  });

  it("cancels cleanly and records a port failure", () => {
    let state = reducePlug(initialPlug(start), { type: "start", now: start }).state;
    const failed = reducePlug(state, { type: "port_failed", now: start + 5, error: "asleep" });
    expect(failed.state.phase).toBe("failed");
    expect(failed.state.error).toBe("asleep");

    state = reducePlug(initialPlug(start), { type: "start", now: start }).state;
    state = reducePlug(state, { type: "port_opened", now: start }).state;
    const cancelled = reducePlug(state, { type: "cancel", now: start + 5 });
    expect(cancelled.state.phase).toBe("cancelled");
    expect(cancelled.effects.map((effect) => effect.type)).toEqual(["clear_alarm"]);
  });

  it("treats an engaged latch, a connected charging state, or the Sigen plug as connected", () => {
    expect(cableConnected({ chargePortLatch: "Disengaged", chargingState: "Disconnected" })).toBe(false);
    expect(cableConnected({ chargePortLatch: "Engaged", chargingState: "Disconnected" })).toBe(true);
    expect(cableConnected({ chargingState: "Connected" })).toBe(true);
    expect(cableConnected({ chargingState: "Charging" })).toBe(true);
    expect(cableConnected({ chargingState: "Stopped" })).toBe(true);
    expect(cableConnected({ sigenConnected: true, chargingState: "Disconnected" })).toBe(true);
  });
});

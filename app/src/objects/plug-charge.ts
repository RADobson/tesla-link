import { DurableObject } from "cloudflare:workers";
import { mocksEnabled, stationId } from "../config";
import { audit } from "../db";
import { cableConnected, initialPlug, reducePlug, type PlugState } from "../plugcharge/machine";
import { callSigenTool, confirmedSigenWrite } from "../sigen/client";
import { controlChargerArgs, parseChargerInfo } from "../sigen/parse";
import { chargePortDoorOpen, chargeStart } from "../tesla/commands";
import { readVehicleData, sendVehicleCommand, vehicleOnline } from "../tesla/command";
import { parseVehicleData } from "../tesla/parse";

const POLL_MS = 5_000;

export class PlugCharge extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      this.ctx.storage.sql.exec(
        "CREATE TABLE IF NOT EXISTS plug (id INTEGER PRIMARY KEY CHECK (id = 1), state TEXT NOT NULL)",
      );
    });
  }

  async getState(): Promise<PlugState> {
    return this.load();
  }

  async start(): Promise<PlugState> {
    const now = Date.now();
    const opened = reducePlug(this.load(), { type: "start", now });
    if (opened.rejected) return opened.state;
    this.save(opened.state);
    try {
      if (!mocksEnabled(this.env)) await sendVehicleCommand(this.env, chargePortDoorOpen());
      const waiting = reducePlug(opened.state, { type: "port_opened", now: Date.now() });
      this.save(waiting.state);
      await this.ctx.storage.setAlarm(Date.now() + POLL_MS);
      return waiting.state;
    } catch (error) {
      const failed = reducePlug(opened.state, {
        type: "port_failed",
        now: Date.now(),
        error: error instanceof Error ? error.message : "open_failed",
      });
      this.save(failed.state);
      await this.ctx.storage.deleteAlarm();
      return failed.state;
    }
  }

  async cancel(): Promise<PlugState> {
    const next = reducePlug(this.load(), { type: "cancel", now: Date.now() });
    this.save(next.state);
    await this.ctx.storage.deleteAlarm();
    return next.state;
  }

  async alarm(): Promise<void> {
    const current = this.load();
    if (current.phase !== "waiting_for_cable") return;
    let connected = false;
    try {
      connected = await this.observe(current);
    } catch (error) {
      console.error(JSON.stringify({ message: "plug_observe_failed", error: error instanceof Error ? error.message : "error" }));
    }
    const step = reducePlug(current, { type: "sample", now: Date.now(), cableConnected: connected });
    this.save(step.state);
    if (step.state.phase === "starting_charge") {
      try {
        await this.startCharging();
        const done = reducePlug(step.state, { type: "charge_started", now: Date.now() });
        this.save(done.state);
        await audit(this.env.DB, "plug_and_charge", "charging", "cable connected");
      } catch (error) {
        const failed = reducePlug(step.state, {
          type: "charge_failed",
          now: Date.now(),
          error: error instanceof Error ? error.message : "start_failed",
        });
        this.save(failed.state);
        await audit(this.env.DB, "plug_and_charge", "failed", failed.state.error ?? "start_failed");
      }
      await this.ctx.storage.deleteAlarm();
      return;
    }
    if (step.effects.some((effect) => effect.type === "poll_soon")) {
      await this.ctx.storage.setAlarm(Date.now() + POLL_MS);
      return;
    }
    await this.ctx.storage.deleteAlarm();
    if (step.state.phase === "timed_out") await audit(this.env.DB, "plug_and_charge", "timed_out");
  }

  private async observe(state: PlugState): Promise<boolean> {
    if (mocksEnabled(this.env)) return state.startedAt !== null && Date.now() - state.startedAt > 8_000;
    const vault = this.env.TOKEN_VAULT.getByName("owner");
    const vehicle = await vault.getVehicle();
    let latch: string | null = null;
    let charging: string | null = null;
    if (vehicle && (await vehicleOnline(this.env, vehicle.id))) {
      const data = parseVehicleData(await readVehicleData(this.env, vehicle.id));
      latch = data.chargePortLatch;
      charging = data.chargingState;
    }
    let sigenConnected = false;
    try {
      const token = await vault.accessToken("sigen");
      const info = parseChargerInfo(await callSigenTool(this.env, token, "get_charger_info", { station_id: stationId(this.env) }));
      sigenConnected = Boolean(info?.cableConnected);
      if (info?.sn) await vault.setCharger({ sn: info.sn });
    } catch {
      sigenConnected = false;
    }
    return cableConnected({ chargePortLatch: latch, chargingState: charging, sigenConnected });
  }

  private async startCharging(): Promise<void> {
    if (mocksEnabled(this.env)) return;
    const vault = this.env.TOKEN_VAULT.getByName("owner");
    const charger = await vault.getCharger();
    const token = await vault.accessToken("sigen");
    await confirmedSigenWrite(
      this.env,
      token,
      "control_charger_charging",
      controlChargerArgs(stationId(this.env), "start", charger?.sn),
    );
    const vehicle = await vault.getVehicle();
    if (!vehicle) return;
    const online = await vehicleOnline(this.env, vehicle.id);
    const data = online ? parseVehicleData(await readVehicleData(this.env, vehicle.id)) : null;
    if (!data || data.chargingState !== "Charging") await sendVehicleCommand(this.env, chargeStart());
  }

  private load(): PlugState {
    const rows = this.ctx.storage.sql.exec<{ state: string }>("SELECT state FROM plug WHERE id = 1").toArray();
    if (!rows[0]) return initialPlug(Date.now());
    return JSON.parse(rows[0].state) as PlugState;
  }

  private save(state: PlugState): void {
    this.ctx.storage.sql.exec(
      "INSERT INTO plug (id, state) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET state = excluded.state",
      JSON.stringify(state),
    );
  }
}

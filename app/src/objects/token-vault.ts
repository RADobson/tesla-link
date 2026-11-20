import { DurableObject } from "cloudflare:workers";
import { refreshSigen } from "../sigen/client";
import { refreshTesla } from "../tesla/oauth";
import { rotateIfNeeded, SingleFlight, type TokenRecord } from "../tokens/rotate";

export interface VehicleIdentity {
  id: string;
  vin: string;
  name: string;
}

export interface DomainSession {
  epochHex: string;
  counter: number;
  clockTime: number;
  syncedAt: number;
  vehiclePublicHex: string;
  sharedKeyHex: string;
  detached: boolean;
  routingAddressHex: string;
}

export class TokenVault extends DurableObject<Env> {
  private flight = new SingleFlight();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      this.ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
    });
  }

  async accessToken(provider: "tesla" | "sigen"): Promise<string> {
    return this.rotate(provider, false);
  }

  async refreshAccessToken(provider: "tesla" | "sigen"): Promise<string> {
    return this.rotate(provider, true);
  }

  async importTokens(
    provider: "tesla" | "sigen",
    tokens: { accessToken: string; refreshToken: string; expiresIn: number },
  ): Promise<void> {
    const existing = this.read<TokenRecord>(`tokens:${provider}`);
    this.write(`tokens:${provider}`, {
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      expiresAt: Date.now() + Math.max(0, tokens.expiresIn) * 1000,
      version: (existing?.version ?? 0) + 1,
    } satisfies TokenRecord);
  }

  async connectionStatus(): Promise<{ tesla: boolean; sigen: boolean; vehicleName: string | null; chargerKnown: boolean }> {
    const vehicle = this.read<VehicleIdentity>("vehicle");
    return {
      tesla: Boolean(this.read<TokenRecord>("tokens:tesla")?.refreshToken),
      sigen: Boolean(this.read<TokenRecord>("tokens:sigen")?.refreshToken),
      vehicleName: vehicle?.name || null,
      chargerKnown: Boolean(this.read<{ sn: string }>("charger")?.sn),
    };
  }

  async getVehicle(): Promise<VehicleIdentity | null> {
    return this.read<VehicleIdentity>("vehicle");
  }

  async setVehicle(vehicle: VehicleIdentity): Promise<void> {
    this.write("vehicle", vehicle);
  }

  async getCharger(): Promise<{ sn: string } | null> {
    return this.read<{ sn: string }>("charger");
  }

  async setCharger(charger: { sn: string }): Promise<void> {
    this.write("charger", charger);
  }

  async getDomainSession(): Promise<DomainSession | null> {
    return this.read<DomainSession>("session:infotainment");
  }

  async saveDomainSession(session: DomainSession): Promise<void> {
    this.write("session:infotainment", session);
  }

  async clearDomainSession(): Promise<void> {
    this.ctx.storage.sql.exec("DELETE FROM kv WHERE key = ?", "session:infotainment");
  }

  private async rotate(provider: "tesla" | "sigen", force: boolean): Promise<string> {
    return rotateIfNeeded({
      store: {
        get: async () => {
          const row = this.read<TokenRecord>(`tokens:${provider}`);
          if (row && force) return { ...row, expiresAt: 0 };
          return row;
        },
        compareAndSwap: async (expectedVersion, next) => {
          const row = this.read<TokenRecord>(`tokens:${provider}`);
          if ((row?.version ?? -1) !== expectedVersion) return false;
          this.write(`tokens:${provider}`, next);
          return true;
        },
      },
      refresh: (refreshToken) =>
        provider === "tesla" ? refreshTesla(this.env, refreshToken) : refreshSigen(this.env, refreshToken),
      now: Date.now(),
      flight: this.flight,
      flightKey: provider,
    });
  }

  private read<T>(key: string): T | null {
    const rows = this.ctx.storage.sql.exec<{ value: string }>("SELECT value FROM kv WHERE key = ?", key).toArray();
    if (!rows[0]) return null;
    return JSON.parse(rows[0].value) as T;
  }

  private write(key: string, value: unknown): void {
    this.ctx.storage.sql.exec(
      "INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      key,
      JSON.stringify(value),
    );
  }
}

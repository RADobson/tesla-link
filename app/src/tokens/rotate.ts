export interface TokenRecord {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  version: number;
}

export interface RefreshedToken {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
}

export interface TokenStore {
  get(): Promise<TokenRecord | null>;
  compareAndSwap(expectedVersion: number, next: TokenRecord): Promise<boolean>;
}

/** Coalesce concurrent refreshes so a single-use refresh token is spent once. */
export class SingleFlight {
  private inflight = new Map<string, Promise<string>>();

  do(key: string, fn: () => Promise<string>): Promise<string> {
    const existing = this.inflight.get(key);
    if (existing) return existing;
    const pending = fn().finally(() => {
      if (this.inflight.get(key) === pending) this.inflight.delete(key);
    });
    this.inflight.set(key, pending);
    return pending;
  }
}

export async function rotateIfNeeded(options: {
  store: TokenStore;
  refresh: (refreshToken: string) => Promise<RefreshedToken>;
  now: number;
  skewMs?: number;
  flight: SingleFlight;
  flightKey?: string;
}): Promise<string> {
  const skewMs = options.skewMs ?? 60_000;
  return options.flight.do(options.flightKey ?? "token", async () => {
    const current = await options.store.get();
    if (!current?.refreshToken) throw new Error("not_connected");
    if (current.accessToken && current.expiresAt - skewMs > options.now) return current.accessToken;

    const refreshed = await options.refresh(current.refreshToken);
    if (!refreshed.refreshToken || !refreshed.accessToken) throw new Error("refresh_incomplete");
    const next: TokenRecord = {
      accessToken: refreshed.accessToken,
      refreshToken: refreshed.refreshToken,
      expiresAt: options.now + refreshed.expiresIn * 1000,
      version: current.version + 1,
    };
    const saved = await options.store.compareAndSwap(current.version, next);
    if (saved) return next.accessToken;
    const winner = await options.store.get();
    if (winner && winner.version !== current.version && winner.accessToken) return winner.accessToken;
    throw new Error("refresh_conflict");
  });
}

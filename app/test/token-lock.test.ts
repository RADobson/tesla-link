import { describe, expect, it } from "vitest";
import { rotateIfNeeded, SingleFlight, type TokenRecord, type TokenStore } from "../src/tokens/rotate";

function memoryStore(initial: TokenRecord | null): TokenStore & { snapshot(): TokenRecord | null } {
  let current = initial;
  return {
    async get() {
      return current;
    },
    async compareAndSwap(expectedVersion, next) {
      if ((current?.version ?? -1) !== expectedVersion) return false;
      current = next;
      return true;
    },
    snapshot() {
      return current;
    },
  };
}

describe("token rotation lock", () => {
  it("spends a single-use refresh token once when callers overlap", async () => {
    const store = memoryStore({
      accessToken: "old-access",
      refreshToken: "refresh-1",
      expiresAt: 0,
      version: 1,
    });
    let calls = 0;
    const seen: string[] = [];
    const flight = new SingleFlight();
    const refresh = async (refreshToken: string) => {
      seen.push(refreshToken);
      calls += 1;
      await new Promise((resolve) => setTimeout(resolve, 20));
      return { accessToken: "access-2", refreshToken: "refresh-2", expiresIn: 3600 };
    };
    const now = 1_000_000;
    const [first, second] = await Promise.all([
      rotateIfNeeded({ store, refresh, now, flight }),
      rotateIfNeeded({ store, refresh, now, flight }),
    ]);
    expect(calls).toBe(1);
    expect(seen).toEqual(["refresh-1"]);
    expect(first).toBe("access-2");
    expect(second).toBe("access-2");
    expect(store.snapshot()).toMatchObject({ refreshToken: "refresh-2", accessToken: "access-2", version: 2 });
  });

  it("does not refresh an access token that is still inside the skew window", async () => {
    const store = memoryStore({
      accessToken: "still-good",
      refreshToken: "refresh-1",
      expiresAt: 10_000_000,
      version: 4,
    });
    let calls = 0;
    const token = await rotateIfNeeded({
      store,
      refresh: async () => {
        calls += 1;
        return { accessToken: "nope", refreshToken: "nope", expiresIn: 10 };
      },
      now: 9_000_000,
      flight: new SingleFlight(),
    });
    expect(token).toBe("still-good");
    expect(calls).toBe(0);
    expect(store.snapshot()?.refreshToken).toBe("refresh-1");
  });

  it("uses the rotated refresh token for the next refresh", async () => {
    const store = memoryStore({
      accessToken: "a1",
      refreshToken: "r1",
      expiresAt: 0,
      version: 1,
    });
    const flight = new SingleFlight();
    const seen: string[] = [];
    const refresh = async (refreshToken: string) => {
      seen.push(refreshToken);
      const n = seen.length + 1;
      return { accessToken: `a${n}`, refreshToken: `r${n}`, expiresIn: 10 };
    };
    await rotateIfNeeded({ store, refresh, now: 0, skewMs: 0, flight });
    await rotateIfNeeded({ store, refresh, now: 20_000, skewMs: 0, flight });
    expect(seen).toEqual(["r1", "r2"]);
    expect(store.snapshot()?.refreshToken).toBe("r3");
  });

  it("rejects a compare-and-swap when another writer already rotated", async () => {
    const store = memoryStore({
      accessToken: "a1",
      refreshToken: "r1",
      expiresAt: 0,
      version: 1,
    });
    const original = store.compareAndSwap.bind(store);
    store.compareAndSwap = async (expected, next) => {
      await original(expected, { ...next, accessToken: "winner", refreshToken: "r-winner", version: 2 });
      return false;
    };
    const token = await rotateIfNeeded({
      store,
      refresh: async () => ({ accessToken: "loser", refreshToken: "r-loser", expiresIn: 30 }),
      now: 0,
      flight: new SingleFlight(),
    });
    expect(token).toBe("winner");
    expect(store.snapshot()?.refreshToken).toBe("r-winner");
  });
});

import { describe, expect, it } from "vitest";
import { registrationDecision } from "../src/auth/policy";
import { clearSessionCookie, readCookie, sessionActive, sessionCookie, SESSION_TTL_SECONDS } from "../src/auth/session";
import { timingSafeEqualString } from "../src/lib/security";

describe("registration policy", () => {
  it("allows the first passkey when no setup code is configured", () => {
    expect(registrationDecision(0, false, false, false)).toBe("allow");
  });

  it("requires the setup code for the first passkey when one is configured", () => {
    expect(registrationDecision(0, true, false, false)).toBe("setup_required");
    expect(registrationDecision(0, true, false, true)).toBe("bad_code");
    expect(registrationDecision(0, true, true, true)).toBe("allow");
  });

  it("locks registration after the first passkey", () => {
    expect(registrationDecision(1, false, false, false)).toBe("locked");
    expect(registrationDecision(1, true, true, true)).toBe("locked");
    expect(registrationDecision(2, true, true, true)).toBe("locked");
  });
});

describe("sessions", () => {
  it("sets a short-lived HttpOnly Secure SameSite=Strict cookie", () => {
    const cookie = sessionCookie("abc.def");
    expect(cookie).toContain("wl_session=abc.def");
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("Secure");
    expect(cookie).toContain("SameSite=Strict");
    expect(cookie).toContain("Path=/");
    expect(cookie).toContain(`Max-Age=${SESSION_TTL_SECONDS}`);
    expect(SESSION_TTL_SECONDS).toBeLessThanOrEqual(2 * 60 * 60);
  });

  it("clears the cookie and reads it back from a header", () => {
    expect(clearSessionCookie()).toContain("Max-Age=0");
    expect(readCookie("a=1; wl_session=secret; b=2", "wl_session")).toBe("secret");
    expect(readCookie(null, "wl_session")).toBeNull();
  });

  it("rejects an expired session", () => {
    expect(sessionActive(1_000, 1_000)).toBe(false);
    expect(sessionActive(1_001, 1_000)).toBe(true);
  });
});

describe("secret comparison", () => {
  it("matches equal strings and rejects others", async () => {
    expect(await timingSafeEqualString("setup-code", "setup-code")).toBe(true);
    expect(await timingSafeEqualString("setup-code", "setup-codf")).toBe(false);
    expect(await timingSafeEqualString("short", "much-longer-value")).toBe(false);
  });
});

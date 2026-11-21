import { bytesToBase64Url, randomBytes } from "../lib/bytes";

export const SESSION_COOKIE = "wl_session";
export const SESSION_TTL_SECONDS = 2 * 60 * 60;

export function newSessionSecret(): string {
  return bytesToBase64Url(randomBytes(32));
}

export function sessionCookie(token: string, maxAge = SESSION_TTL_SECONDS): string {
  return [
    `${SESSION_COOKIE}=${token}`,
    "HttpOnly",
    "Secure",
    "SameSite=Strict",
    "Path=/",
    `Max-Age=${maxAge}`,
  ].join("; ");
}

export function clearSessionCookie(): string {
  return `${SESSION_COOKIE}=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0`;
}

export function readCookie(header: string | null, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(";")) {
    const trimmed = part.trim();
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    if (trimmed.slice(0, eq) === name) return trimmed.slice(eq + 1);
  }
  return null;
}

export function sessionActive(expiresAt: number, now: number): boolean {
  return Number.isFinite(expiresAt) && expiresAt > now;
}

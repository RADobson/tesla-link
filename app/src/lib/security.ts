import { utf8 } from "./bytes";

export async function sha256(bytes: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
}

export async function sha256Hex(value: string): Promise<string> {
  const digest = await sha256(utf8(value));
  return [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Compare secrets without leaking the expected value through an early length check. */
export async function timingSafeEqualString(a: string, b: string): Promise<boolean> {
  const [left, right] = await Promise.all([sha256(utf8(a)), sha256(utf8(b))]);
  return timingSafeEqualBytes(left, right);
}

export function timingSafeEqualBytes(a: Uint8Array, b: Uint8Array): boolean {
  const length = Math.max(a.length, b.length);
  let diff = a.length ^ b.length;
  for (let i = 0; i < length; i++) diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
  return diff === 0;
}

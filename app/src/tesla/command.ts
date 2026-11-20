import { bytesToBase64, bytesToHex, hexToBytes, randomBytes } from "../lib/bytes";
import { mocksEnabled } from "../config";
import { AppError } from "../lib/errors";
import type { DomainSession } from "../objects/token-vault";
import { teslaJson } from "./oauth";
import { parseVehicleState } from "./parse";
import {
  deriveSharedKey,
  encodeHandshake,
  encodeSignedCommand,
  exportUncompressedPublicKey,
  importPrivateKey,
  parseRoutable,
  parseSessionInfo,
  verifySessionInfoTag,
  type SessionInfo,
} from "./protocol";

const RESYNC_FAULTS = new Set([5, 6, 15]);

function ownerVault(env: Env) {
  return env.TOKEN_VAULT.getByName("owner");
}

export async function sendVehicleCommand(env: Env, action: Uint8Array): Promise<{ ok: true; fault: number | null }> {
  if (mocksEnabled(env)) return { ok: true, fault: null };
  if (!env.TESLA_PRIVATE_KEY) throw new AppError("tesla_key_missing", 503);
  const vault = ownerVault(env);
  const vehicle = await vault.getVehicle();
  if (!vehicle) throw new AppError("tesla_not_connected", 409);
  const token = await vault.accessToken("tesla");
  const privateKey = await importPrivateKey(env.TESLA_PRIVATE_KEY);
  const publicKey = await exportUncompressedPublicKey(privateKey);
  await wakeUntilOnline(env, token, vehicle.id);
  let session = await ensureSession(env, vehicle.vin, publicKey, privateKey, token);
  let attempt = await transmit(env, token, vehicle.vin, publicKey, session, action);
  if (attempt.reply.fault && RESYNC_FAULTS.has(attempt.reply.fault) && attempt.reply.sessionInfo) {
    const updated = await adoptSession(env, privateKey, vehicle.vin, attempt.reply.sessionInfo, attempt.reply.sessionInfoTag, attempt.uuid);
    if (updated) {
      session = updated;
      attempt = await transmit(env, token, vehicle.vin, publicKey, session, action);
    }
  }
  if (attempt.reply.fault && attempt.reply.fault !== 0) throw new AppError(`vehicle_fault_${attempt.reply.fault}`, 502);
  return { ok: true, fault: attempt.reply.fault };
}

async function wakeUntilOnline(env: Env, token: string, id: string): Promise<void> {
  await teslaJson(env, token, `vehicles/${encodeURIComponent(id)}/wake_up`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
  const deadline = Date.now() + 25_000;
  while (Date.now() < deadline) {
    const payload = await teslaJson(env, token, `vehicles/${encodeURIComponent(id)}`);
    if (parseVehicleState(payload) === "online") return;
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
  throw new AppError("vehicle_not_online", 504);
}

async function ensureSession(
  env: Env,
  vin: string,
  publicKey: Uint8Array,
  privateKey: CryptoKey,
  token: string,
): Promise<DomainSession> {
  const vault = ownerVault(env);
  const existing = await vault.getDomainSession();
  if (existing && Date.now() - existing.syncedAt < 12 * 60 * 60 * 1000) return existing;
  const routing = randomBytes(16);
  const uuid = randomBytes(16);
  const raw = await postSigned(env, token, vin, encodeHandshake({ publicKey, routingAddress: routing, uuid }));
  const reply = parseRoutable(raw);
  if (!reply.sessionInfo || !reply.sessionInfoTag) throw new AppError("session_missing", 502);
  const info = parseSessionInfo(reply.sessionInfo);
  if (info.status === 1) throw new AppError("key_not_paired", 409);
  const shared = await deriveSharedKey(privateKey, info.publicKey);
  const valid = await verifySessionInfoTag({
    sharedKey: shared,
    vin,
    challenge: uuid,
    sessionInfo: reply.sessionInfo,
    tag: reply.sessionInfoTag,
  });
  if (!valid) throw new AppError("session_tag", 502);
  const session = sessionFrom(info, shared, routing, (info.flags & 1) === 1);
  await vault.saveDomainSession(session);
  return session;
}

function sessionFrom(info: SessionInfo, shared: Uint8Array, routing: Uint8Array, detached: boolean): DomainSession {
  return {
    epochHex: bytesToHex(info.epoch),
    counter: info.counter + 1,
    clockTime: info.clockTime,
    syncedAt: Date.now(),
    vehiclePublicHex: bytesToHex(info.publicKey),
    sharedKeyHex: bytesToHex(shared),
    detached,
    routingAddressHex: bytesToHex(routing),
  };
}

async function adoptSession(
  env: Env,
  privateKey: CryptoKey,
  vin: string,
  sessionInfo: Uint8Array,
  tag: Uint8Array | null,
  challenge: Uint8Array,
): Promise<DomainSession | null> {
  if (!tag) return null;
  const info = parseSessionInfo(sessionInfo);
  const shared = await deriveSharedKey(privateKey, info.publicKey);
  const valid = await verifySessionInfoTag({ sharedKey: shared, vin, challenge, sessionInfo, tag });
  if (!valid) return null;
  const previous = await ownerVault(env).getDomainSession();
  const session = sessionFrom(info, shared, previous ? hexToBytes(previous.routingAddressHex) : randomBytes(16), (info.flags & 1) === 1);
  await ownerVault(env).saveDomainSession(session);
  return session;
}

async function transmit(
  env: Env,
  token: string,
  vin: string,
  publicKey: Uint8Array,
  session: DomainSession,
  action: Uint8Array,
): Promise<{ reply: ReturnType<typeof parseRoutable>; uuid: Uint8Array }> {
  const vault = ownerVault(env);
  const counter = session.counter;
  const expiresAt = session.clockTime + Math.floor((Date.now() - session.syncedAt) / 1000) + 10;
  const next = { ...session, counter: counter + 1 };
  await vault.saveDomainSession(next);
  const uuid = randomBytes(16);
  const signed = await encodeSignedCommand({
    publicKey,
    routingAddress: hexToBytes(session.routingAddressHex),
    uuid,
    sharedKey: hexToBytes(session.sharedKeyHex),
    epoch: hexToBytes(session.epochHex),
    counter,
    expiresAt,
    vin,
    action,
    detached: session.detached,
  });
  const raw = await postSigned(env, token, vin, signed.message);
  return { reply: parseRoutable(raw), uuid };
}

async function postSigned(env: Env, token: string, vin: string, message: Uint8Array): Promise<Uint8Array> {
  const payload = await teslaJson(env, token, `vehicles/${encodeURIComponent(vin)}/signed_command`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ routable_message: bytesToBase64(message) }),
  });
  const response = payload && typeof payload === "object" ? (payload as { response?: unknown }).response : null;
  if (typeof response !== "string") throw new AppError("signed_command_empty", 502);
  const binary = atob(response);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export async function vehicleOnline(env: Env, id: string): Promise<boolean> {
  if (mocksEnabled(env)) return true;
  const vault = ownerVault(env);
  const token = await vault.accessToken("tesla");
  const payload = await teslaJson(env, token, `vehicles/${encodeURIComponent(id)}`);
  return parseVehicleState(payload) === "online";
}

export async function readVehicleData(env: Env, id: string) {
  const token = await ownerVault(env).accessToken("tesla");
  const path = `vehicles/${encodeURIComponent(id)}/vehicle_data?endpoints=charge_state;drive_state;location_data;climate_state;vehicle_state`;
  return teslaJson(env, token, path);
}

import { bytesToHex, concat, hexToBytes, pemBody, utf8 } from "../lib/bytes";
import { sha256, timingSafeEqualBytes } from "../lib/security";
import { field, parseMessage, protoBytes, protoFixed32, protoVarint, splitDetached } from "./protobuf";

export const DOMAIN_INFOTAINMENT = 3;
export const FLAG_ENCRYPT_RESPONSE = 1;
export const SIGNATURE_HMAC = 6;
export const SIGNATURE_HMAC_PERSONALIZED = 8;
export const SIGNATURE_AES_GCM_RESPONSE = 9;
export const SIGNATURE_AES_GCM_DETACHED = 10;
export const SESSION_INFO_FLAG_DETACHED = 1;

const TAG_SIGNATURE_TYPE = 0;
const TAG_DOMAIN = 1;
const TAG_PERSONALIZATION = 2;
const TAG_EPOCH = 3;
const TAG_EXPIRES_AT = 4;
const TAG_COUNTER = 5;
const TAG_CHALLENGE = 6;
const TAG_FLAGS = 7;
const TAG_REQUEST_HASH = 8;
const TAG_FAULT = 9;
const TAG_COMMAND_PREFIX = 10;

export interface SessionInfo {
  counter: number;
  publicKey: Uint8Array;
  epoch: Uint8Array;
  clockTime: number;
  status: number;
  flags: number;
}

export function u32be(value: number): Uint8Array {
  const bytes = new Uint8Array(4);
  new DataView(bytes.buffer).setUint32(0, value >>> 0, false);
  return bytes;
}

export function serializeMetadata(items: { tag: number; value: Uint8Array }[]): Uint8Array {
  const ordered = [...items].sort((a, b) => a.tag - b.tag);
  const parts: Uint8Array[] = [];
  for (const item of ordered) {
    if (item.value.length > 255) throw new Error("tlv_too_long");
    parts.push(Uint8Array.of(item.tag, item.value.length), item.value);
  }
  parts.push(Uint8Array.of(0xff));
  return concat(parts);
}

export async function hmacSha256(key: Uint8Array, data: Uint8Array): Promise<Uint8Array> {
  const cryptoKey = await crypto.subtle.importKey("raw", key, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", cryptoKey, data));
}

export async function aesGcm(
  key: Uint8Array,
  nonce: Uint8Array,
  plaintext: Uint8Array,
  aad: Uint8Array,
): Promise<{ ciphertext: Uint8Array; tag: Uint8Array }> {
  const cryptoKey = await crypto.subtle.importKey("raw", key, "AES-GCM", false, ["encrypt"]);
  const sealed = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce, additionalData: aad, tagLength: 128 }, cryptoKey, plaintext),
  );
  return { ciphertext: sealed.slice(0, -16), tag: sealed.slice(-16) };
}

export async function aesGcmOpen(
  key: Uint8Array,
  nonce: Uint8Array,
  ciphertext: Uint8Array,
  tag: Uint8Array,
  aad: Uint8Array,
): Promise<Uint8Array> {
  const cryptoKey = await crypto.subtle.importKey("raw", key, "AES-GCM", false, ["decrypt"]);
  const sealed = concat([ciphertext, tag]);
  return new Uint8Array(
    await crypto.subtle.decrypt({ name: "AES-GCM", iv: nonce, additionalData: aad, tagLength: 128 }, cryptoKey, sealed),
  );
}

const EC_PUBLIC_KEY = hexToBytes("06072a8648ce3d0201");
const P256 = hexToBytes("06082a8648ce3d030107");

function derLength(length: number): Uint8Array {
  if (length < 128) return Uint8Array.of(length);
  if (length < 256) return Uint8Array.of(0x81, length);
  return Uint8Array.of(0x82, (length >> 8) & 0xff, length & 0xff);
}

function der(tag: number, content: Uint8Array): Uint8Array {
  return concat([Uint8Array.of(tag), derLength(content.length), content]);
}

function sec1ToPkcs8(sec1: Uint8Array): Uint8Array {
  const algorithm = der(0x30, concat([EC_PUBLIC_KEY, P256]));
  return der(0x30, concat([hexToBytes("020100"), algorithm, der(0x04, sec1)]));
}

export async function importPrivateKey(pem: string): Promise<CryptoKey> {
  const body = pemBody(pem);
  const pkcs8 = pem.includes("BEGIN PRIVATE KEY") ? body : sec1ToPkcs8(body);
  return crypto.subtle.importKey("pkcs8", pkcs8, { name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
}

export async function exportUncompressedPublicKey(privateKey: CryptoKey): Promise<Uint8Array> {
  const jwk = await crypto.subtle.exportKey("jwk", privateKey);
  if (jwk instanceof ArrayBuffer || typeof jwk.x !== "string" || typeof jwk.y !== "string") {
    throw new Error("missing_public_key");
  }
  const decode = (value: string) => {
    const padded = value.replaceAll("-", "+").replaceAll("_", "/") + "===".slice((value.length + 3) % 4);
    const binary = atob(padded);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  };
  return concat([Uint8Array.of(0x04), decode(jwk.x), decode(jwk.y)]);
}

/** K = SHA1(x-coordinate of ECDH(client, vehicle))[:16], as specified by vehicle-command. */
export async function deriveSharedKey(privateKey: CryptoKey, vehiclePublic: Uint8Array): Promise<Uint8Array> {
  const peer = await crypto.subtle.importKey("raw", vehiclePublic, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const x = new Uint8Array(
    await crypto.subtle.deriveBits({ name: "ECDH", public: peer } as SubtleCryptoDeriveKeyAlgorithm, privateKey, 256),
  );
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-1", x));
  return digest.slice(0, 16);
}

export function encodeHandshake(options: {
  publicKey: Uint8Array;
  routingAddress: Uint8Array;
  uuid: Uint8Array;
}): Uint8Array {
  const request = protoBytes(1, options.publicKey);
  return concat([
    protoBytes(6, protoVarint(1, DOMAIN_INFOTAINMENT)),
    protoBytes(7, protoBytes(2, options.routingAddress)),
    protoBytes(14, request),
    protoBytes(51, options.uuid),
  ]);
}

export function parseSessionInfo(buf: Uint8Array): SessionInfo {
  const fields = parseMessage(buf);
  const counter = field(fields, 1)?.varint;
  const publicKey = field(fields, 2)?.value;
  const epoch = field(fields, 3)?.value;
  const clock = field(fields, 4)?.fixed32;
  if (counter === undefined || !publicKey || !epoch || clock === undefined) throw new Error("bad_session_info");
  return {
    counter,
    publicKey,
    epoch,
    clockTime: clock,
    status: field(fields, 5)?.varint ?? 0,
    flags: field(fields, 7)?.varint ?? 0,
  };
}

export async function sessionInfoTag(options: {
  sharedKey: Uint8Array;
  vin: string;
  challenge: Uint8Array;
  sessionInfo: Uint8Array;
}): Promise<Uint8Array> {
  const infoKey = await hmacSha256(options.sharedKey, utf8("session info"));
  const metadata = serializeMetadata([
    { tag: TAG_SIGNATURE_TYPE, value: Uint8Array.of(SIGNATURE_HMAC) },
    { tag: TAG_PERSONALIZATION, value: utf8(options.vin) },
    { tag: TAG_CHALLENGE, value: options.challenge },
  ]);
  return hmacSha256(infoKey, concat([metadata, options.sessionInfo]));
}

export async function verifySessionInfoTag(options: {
  sharedKey: Uint8Array;
  vin: string;
  challenge: Uint8Array;
  sessionInfo: Uint8Array;
  tag: Uint8Array;
}): Promise<boolean> {
  const expected = await sessionInfoTag(options);
  return timingSafeEqualBytes(expected, options.tag);
}

export interface SignedCommand {
  message: Uint8Array;
  tag: Uint8Array;
  signatureType: number;
}

export async function encodeSignedCommand(options: {
  publicKey: Uint8Array;
  routingAddress: Uint8Array;
  uuid: Uint8Array;
  sharedKey: Uint8Array;
  epoch: Uint8Array;
  counter: number;
  expiresAt: number;
  vin: string;
  action: Uint8Array;
  detached: boolean;
}): Promise<SignedCommand> {
  const flags = 1 << FLAG_ENCRYPT_RESPONSE;
  const metadataItems: { tag: number; value: Uint8Array }[] = [
    { tag: TAG_DOMAIN, value: Uint8Array.of(DOMAIN_INFOTAINMENT) },
    { tag: TAG_PERSONALIZATION, value: utf8(options.vin) },
    { tag: TAG_EPOCH, value: options.epoch },
    { tag: TAG_EXPIRES_AT, value: u32be(options.expiresAt) },
    { tag: TAG_COUNTER, value: u32be(options.counter) },
    { tag: TAG_FLAGS, value: u32be(flags) },
  ];

  let payload = options.action;
  let signature: Uint8Array;
  let signatureType: number;
  let tag: Uint8Array;

  if (options.detached) {
    const split = splitDetached(options.action);
    signatureType = SIGNATURE_AES_GCM_DETACHED;
    metadataItems.push(
      { tag: TAG_SIGNATURE_TYPE, value: Uint8Array.of(signatureType) },
      { tag: TAG_COMMAND_PREFIX, value: split.prefix },
    );
    const metadata = serializeMetadata(metadataItems);
    const nonce = crypto.getRandomValues(new Uint8Array(12));
    const sealed = await aesGcm(options.sharedKey, nonce, split.payload, await sha256(metadata));
    tag = sealed.tag;
    payload = sealed.ciphertext;
    signature = protoBytes(
      10,
      concat([
        protoBytes(1, nonce),
        protoVarint(2, options.counter),
        protoFixed32(3, options.expiresAt),
        protoBytes(4, sealed.tag),
        protoBytes(5, split.prefix),
      ]),
    );
  } else {
    signatureType = SIGNATURE_HMAC_PERSONALIZED;
    metadataItems.push({ tag: TAG_SIGNATURE_TYPE, value: Uint8Array.of(signatureType) });
    const metadata = serializeMetadata(metadataItems);
    const commandKey = await hmacSha256(options.sharedKey, utf8("authenticated command"));
    tag = await hmacSha256(commandKey, concat([metadata, options.action]));
    signature = protoBytes(
      8,
      concat([
        protoBytes(1, options.epoch),
        protoVarint(2, options.counter),
        protoFixed32(3, options.expiresAt),
        protoBytes(4, tag),
      ]),
    );
  }

  const identity = protoBytes(1, protoBytes(1, options.publicKey));
  const message = concat([
    protoBytes(6, protoVarint(1, DOMAIN_INFOTAINMENT)),
    protoBytes(7, protoBytes(2, options.routingAddress)),
    protoBytes(10, payload),
    protoBytes(13, concat([identity, signature])),
    protoVarint(52, flags),
    protoBytes(51, options.uuid),
  ]);
  return { message, tag, signatureType };
}

export interface RoutableReply {
  fault: number | null;
  sessionInfo: Uint8Array | null;
  sessionInfoTag: Uint8Array | null;
  payload: Uint8Array | null;
  response: { nonce: Uint8Array; counter: number; tag: Uint8Array } | null;
  flags: number;
  requestUuid: Uint8Array | null;
}

export function parseRoutable(buf: Uint8Array): RoutableReply {
  const fields = parseMessage(buf);
  const status = field(fields, 12)?.value;
  let fault: number | null = null;
  if (status) {
    const statusFields = parseMessage(status);
    fault = field(statusFields, 2)?.varint ?? null;
  }
  const signature = field(fields, 13)?.value;
  let sessionInfoTag: Uint8Array | null = null;
  let response: RoutableReply["response"] = null;
  if (signature) {
    const signatureFields = parseMessage(signature);
    const info = field(signatureFields, 6)?.value;
    if (info) sessionInfoTag = field(parseMessage(info), 1)?.value ?? null;
    const aes = field(signatureFields, 9)?.value;
    if (aes) {
      const aesFields = parseMessage(aes);
      const nonce = field(aesFields, 1)?.value;
      const counter = field(aesFields, 2)?.varint;
      const tag = field(aesFields, 3)?.value;
      if (nonce && counter !== undefined && tag) response = { nonce, counter, tag };
    }
  }
  return {
    fault,
    sessionInfo: field(fields, 15)?.value ?? null,
    sessionInfoTag,
    payload: field(fields, 10)?.value ?? null,
    response,
    flags: field(fields, 52)?.varint ?? 0,
    requestUuid: field(fields, 50)?.value ?? null,
  };
}

export function requestHash(signatureType: number, tag: Uint8Array): Uint8Array {
  return concat([Uint8Array.of(signatureType), tag]);
}

export async function decryptResponse(options: {
  sharedKey: Uint8Array;
  vin: string;
  reply: RoutableReply;
  requestSignatureType: number;
  requestTag: Uint8Array;
}): Promise<Uint8Array | null> {
  if (!options.reply.payload || !options.reply.response) return options.reply.payload;
  const metadata = serializeMetadata([
    { tag: TAG_SIGNATURE_TYPE, value: Uint8Array.of(SIGNATURE_AES_GCM_RESPONSE) },
    { tag: TAG_DOMAIN, value: Uint8Array.of(DOMAIN_INFOTAINMENT) },
    { tag: TAG_PERSONALIZATION, value: utf8(options.vin) },
    { tag: TAG_COUNTER, value: u32be(options.reply.response.counter) },
    { tag: TAG_FLAGS, value: u32be(options.reply.flags) },
    { tag: TAG_REQUEST_HASH, value: requestHash(options.requestSignatureType, options.requestTag) },
    { tag: TAG_FAULT, value: u32be(options.reply.fault ?? 0) },
  ]);
  try {
    return await aesGcmOpen(
      options.sharedKey,
      options.reply.response.nonce,
      options.reply.payload,
      options.reply.response.tag,
      await sha256(metadata),
    );
  } catch {
    return null;
  }
}

export function bytesEqualHex(bytes: Uint8Array, hex: string): boolean {
  return bytesToHex(bytes) === hex.toLowerCase();
}

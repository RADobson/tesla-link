import { concat } from "../lib/bytes";

export function encodeVarint(value: number): Uint8Array {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error("bad_varint");
  const bytes: number[] = [];
  let rest = value;
  while (rest > 127) {
    bytes.push((rest & 0x7f) | 0x80);
    rest = Math.floor(rest / 128);
  }
  bytes.push(rest);
  return Uint8Array.from(bytes);
}

export function protoVarint(field: number, value: number): Uint8Array {
  return concat([encodeVarint((field << 3) | 0), encodeVarint(value)]);
}

export function protoBytes(field: number, value: Uint8Array): Uint8Array {
  return concat([encodeVarint((field << 3) | 2), encodeVarint(value.length), value]);
}

export function protoFixed32(field: number, value: number): Uint8Array {
  const body = new Uint8Array(4);
  new DataView(body.buffer).setUint32(0, value >>> 0, true);
  return concat([encodeVarint((field << 3) | 5), body]);
}

export interface ProtoField {
  field: number;
  wire: number;
  value: Uint8Array;
  varint?: number;
  fixed32?: number;
  raw: Uint8Array;
}

export function parseMessage(buf: Uint8Array): ProtoField[] {
  const fields: ProtoField[] = [];
  let offset = 0;
  while (offset < buf.length) {
    const key = readVarint(buf, offset);
    offset = key.next;
    const field = key.value >>> 3;
    const wire = key.value & 7;
    const start = key.next - encodeVarint(key.value).length;
    if (wire === 0) {
      const body = readVarint(buf, offset);
      offset = body.next;
      fields.push({ field, wire, value: buf.slice(start + (key.next - start), body.next), varint: body.value, raw: buf.slice(start, body.next) });
    } else if (wire === 2) {
      const length = readVarint(buf, offset);
      offset = length.next;
      const end = offset + length.value;
      if (end > buf.length) throw new Error("truncated_protobuf");
      fields.push({ field, wire, value: buf.slice(offset, end), raw: buf.slice(start, end) });
      offset = end;
    } else if (wire === 5) {
      if (offset + 4 > buf.length) throw new Error("truncated_protobuf");
      const view = new DataView(buf.buffer, buf.byteOffset + offset, 4);
      const fixed32 = view.getUint32(0, true);
      offset += 4;
      fields.push({ field, wire, value: buf.slice(offset - 4, offset), fixed32, raw: buf.slice(start, offset) });
    } else {
      throw new Error("unsupported_wire_type");
    }
  }
  return fields;
}

function readVarint(buf: Uint8Array, offset: number): { value: number; next: number } {
  let value = 0;
  let shift = 0;
  let cursor = offset;
  while (cursor < buf.length && shift <= 28) {
    const byte = buf[cursor];
    cursor += 1;
    value |= (byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) return { value, next: cursor };
    shift += 7;
  }
  throw new Error("bad_varint");
}

export function field(fields: ProtoField[], number: number): ProtoField | undefined {
  return fields.find((item) => item.field === number);
}

/**
 * Split a CarServer action into the plaintext command prefix and the innermost
 * parameter bytes. Tesla's detached AES-GCM encrypts only those parameters.
 * The HVAC example in the protocol spec is 120452020801 → prefix 12025200, payload 0801.
 */
export function splitDetached(buf: Uint8Array): { prefix: Uint8Array; payload: Uint8Array } {
  const path = leafPath(buf);
  if (path.length === 0) return { prefix: buf.slice(), payload: new Uint8Array() };
  return rebuild(buf, path);
}

function leafPath(buf: Uint8Array): number[] {
  const fields = parseMessage(buf);
  for (let index = 0; index < fields.length; index++) {
    const item = fields[index];
    if (item.wire !== 2) continue;
    const nested = parseMessage(item.value);
    if (nested.some((child) => child.wire === 2)) return [index, ...leafPath(item.value)];
    return [index];
  }
  return [];
}

function rebuild(buf: Uint8Array, path: number[]): { prefix: Uint8Array; payload: Uint8Array } {
  const fields = parseMessage(buf);
  const index = path[0];
  const item = fields[index];
  if (!item || item.wire !== 2) throw new Error("detach_path");
  if (path.length === 1) {
    const parts = fields.map((candidate, candidateIndex) =>
      candidateIndex === index ? protoBytes(item.field, new Uint8Array()) : candidate.raw,
    );
    return { prefix: concat(parts), payload: item.value };
  }
  const inner = rebuild(item.value, path.slice(1));
  const parts = fields.map((candidate, candidateIndex) =>
    candidateIndex === index ? protoBytes(item.field, inner.prefix) : candidate.raw,
  );
  return { prefix: concat(parts), payload: inner.payload };
}

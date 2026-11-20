import { describe, expect, it } from "vitest";
import { bytesToHex, hexToBytes } from "../src/lib/bytes";
import { chargePortDoorOpen, chargeStart, chargeStop, commandHex, hvacAuto, setChargeLimit, setChargingAmps } from "../src/tesla/commands";
import { splitDetached } from "../src/tesla/protobuf";
import { aesGcm, deriveSharedKey, importPrivateKey, serializeMetadata, sessionInfoTag, u32be } from "../src/tesla/protocol";

const CLIENT_PEM = `-----BEGIN EC PRIVATE KEY-----
MHcCAQEEICU4zcKal8GcHpmmN9bPT4yXDBGLVu3h5jI+bRYsSzDboAoGCCqGSM49
AwEHoUQDQgAEsra8aMLaBmXOZWgVWUmWxiOU7di+qQX+eBp1T+aoRacUMwkC8iXp
Jp1GbgWzSZgf2p2FzCPG+0RKpztikQXcbg==
-----END EC PRIVATE KEY-----`;

const VEHICLE_PUBLIC = hexToBytes(
  "04c7a1f47138486aa4729971494878d33b1a24e39571f748a6e16c5955b3d877d3a6aaa0e955166474af5d32c410f439a2234137ad1bb085fd4e8813c958f11d97",
);

describe("vehicle command protocol", () => {
  it("derives the published shared key", async () => {
    const key = await importPrivateKey(CLIENT_PEM);
    const shared = await deriveSharedKey(key, VEHICLE_PUBLIC);
    expect(bytesToHex(shared)).toBe("1b2fce19967b79db696f909cff89ea9a");
  });

  it("authenticates the published session-info vector", async () => {
    const sessionInfo = hexToBytes(
      "0806124104c7a1f47138486aa4729971494878d33b1a24e39571f748a6e16c5955b3d877d3a6aaa0e955166474af5d32c410f439a2234137ad1bb085fd4e8813c958f11d971a104c463f9cc0d3d26906e982ed224adde6255a0a0000",
    );
    const tag = await sessionInfoTag({
      sharedKey: hexToBytes("1b2fce19967b79db696f909cff89ea9a"),
      vin: "5YJ30123456789ABC",
      challenge: hexToBytes("1588d5a30eabc6f8fc9a951b11f6fd11"),
      sessionInfo,
    });
    expect(bytesToHex(tag)).toBe("996c1fe38331be138f8039c194b14db2198846ed7d8251e6749284d7b32ea002");
  });

  it("matches the published HVAC AES-GCM vector", async () => {
    const metadata = hexToBytes(
      "000105010103021135594a333031323334353637383941424303104c463f9cc0d3d26906e982ed224adde6040400000a5f050400000007070400000002ff",
    );
    const built = serializeMetadata([
      { tag: 0, value: Uint8Array.of(0x05) },
      { tag: 1, value: Uint8Array.of(0x03) },
      { tag: 2, value: new TextEncoder().encode("5YJ30123456789ABC") },
      { tag: 3, value: hexToBytes("4c463f9cc0d3d26906e982ed224adde6") },
      { tag: 4, value: u32be(0x0a5f) },
      { tag: 5, value: u32be(7) },
      { tag: 7, value: u32be(2) },
    ]);
    expect(bytesToHex(built)).toBe(bytesToHex(metadata));
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", metadata));
    const sealed = await aesGcm(
      hexToBytes("1b2fce19967b79db696f909cff89ea9a"),
      hexToBytes("dbf79447fa156674dae1caed"),
      hexToBytes("120452020801"),
      digest,
    );
    expect(bytesToHex(sealed.ciphertext)).toBe("38038e8c0f2e");
    expect(bytesToHex(sealed.tag)).toBe("c228e0ff64991481db3a7bbc133696c5");
  });

  it("encodes the charging and climate commands", () => {
    expect(commandHex(hvacAuto(true))).toBe("120452020801");
    expect(commandHex(hvacAuto(false))).toBe("12025200");
    const hvac = splitDetached(hvacAuto(true));
    expect(commandHex(hvac.prefix)).toBe("12025200");
    expect(commandHex(hvac.payload)).toBe("0801");
    expect(commandHex(chargeStart())).toBe("120432021200");
    expect(commandHex(chargeStop())).toBe("120432022a00");
    expect(commandHex(setChargeLimit(80))).toBe("12042a020850");
    expect(commandHex(setChargingAmps(32))).toBe("1205da02020820");
    expect(commandHex(chargePortDoorOpen())).toBe("1203f20300");
    const limit = splitDetached(setChargeLimit(80));
    expect(commandHex(limit.payload)).toBe("0850");
    expect(commandHex(limit.prefix)).toBe("12022a00");
  });
});

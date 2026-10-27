import { describe, expect, test } from "bun:test";
import { keccak256 as viemKeccak, getAddress } from "viem";
import { bytesToHex, hexToBytes, keccak256Hex } from "./src/keccak";
import { isPermanentExpiry, PERMANENT_EXPIRES_AT, toChecksumAddress } from "./src/attributes";

describe("keccak256", () => {
  test("matches the standard vectors", () => {
    expect(keccak256Hex("")).toBe("0xc5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470");
    expect(keccak256Hex("abc")).toBe("0x4e03657aea45a94fc7d47ba826c8d667c0d1e6e33a64a036ec44f58fa12d6c45");
  });

  test("matches viem across the rate boundary and at 32 KiB", () => {
    for (const length of [1, 31, 32, 135, 136, 137, 271, 272, 273, 1000, 32 * 1024]) {
      const bytes = new Uint8Array(length);
      for (let index = 0; index < length; index++) bytes[index] = (index * 31 + 7) & 0xff;
      expect(keccak256Hex(bytes)).toBe(viemKeccak(bytes));
    }
  });

  test("hex round-trips and refuses odd or unprefixed input", () => {
    expect(bytesToHex(hexToBytes("0x00ff10"))).toBe("0x00ff10");
    expect(() => hexToBytes("0xabc")).toThrow();
    expect(() => hexToBytes("abcd")).toThrow();
  });
});

describe("EIP-55", () => {
  test("checksums like viem and leaves non-addresses alone", () => {
    for (const address of [
      "0x7e5f4552091a69125d5dfcb7b8c2659029395bdf",
      "0xd56007fe3c14d42427c384f7bdafeaadc2229b23",
      "0x4400000000000000000000000000000000000044",
    ]) {
      expect(toChecksumAddress(address)).toBe(getAddress(address));
      expect(toChecksumAddress(address.toUpperCase().replace("0X", "0x"))).toBe(getAddress(address));
    }
    expect(toChecksumAddress("0x1234")).toBe("0x1234");
  });
});

describe("permanence", () => {
  test("is exactly 2^64 − 1, in every spelling the API uses", () => {
    expect(isPermanentExpiry(PERMANENT_EXPIRES_AT)).toBe(true);
    expect(isPermanentExpiry("18446744073709551615")).toBe(true);
    expect(isPermanentExpiry("0xffffffffffffffff")).toBe(true);
    expect(isPermanentExpiry((1n << 64n) - 1n)).toBe(true);
  });

  test("anything else is finite, however far away", () => {
    expect(isPermanentExpiry("18446744073709551614")).toBe(false);
    expect(isPermanentExpiry("0xfffffffffffffffe")).toBe(false);
    // 100+ years at any block time is still a finite expiry.
    expect(isPermanentExpiry(String(2_000_000_000_000))).toBe(false);
    expect(isPermanentExpiry("18446744073709551616")).toBe(false);
    // A JS number can never hold 2^64 − 1 exactly.
    expect(isPermanentExpiry(Number(0xffffffffffffffffn))).toBe(false);
    expect(isPermanentExpiry(null)).toBe(false);
    expect(isPermanentExpiry(undefined)).toBe(false);
    expect(isPermanentExpiry("permanent")).toBe(false);
  });
});

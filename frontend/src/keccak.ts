// Keccak-256 (the Ethereum hash: original Keccak padding, not SHA3-256) for
// the two places the browser needs it: checking bytes loaded from a node
// against the keccak256 the index recorded, and EIP-55 address checksums.
// Self-contained so the frontend bundle carries no hashing dependency; lanes
// are held as 32-bit halves because BigInt lanes are far too slow for a 32 KiB
// bytes value.

const ROUNDS = 24;
/** 1088-bit rate of Keccak-256, in bytes. */
const RATE_BYTES = 136;

// Round constants, low and high 32-bit halves.
const RC_LO = new Uint32Array([
  0x00000001, 0x00008082, 0x0000808a, 0x80008000, 0x0000808b, 0x80000001, 0x80008081, 0x00008009,
  0x0000008a, 0x00000088, 0x80008009, 0x8000000a, 0x8000808b, 0x0000008b, 0x00008089, 0x00008003,
  0x00008002, 0x00000080, 0x0000800a, 0x8000000a, 0x80008081, 0x00008080, 0x80000001, 0x80008008,
]);
const RC_HI = new Uint32Array([
  0x00000000, 0x00000000, 0x80000000, 0x80000000, 0x00000000, 0x00000000, 0x80000000, 0x80000000,
  0x00000000, 0x00000000, 0x00000000, 0x00000000, 0x00000000, 0x80000000, 0x80000000, 0x80000000,
  0x80000000, 0x80000000, 0x00000000, 0x80000000, 0x80000000, 0x80000000, 0x00000000, 0x80000000,
]);
/** Rotation offset of lane x + 5y. */
const ROTATION = [0, 1, 62, 28, 27, 36, 44, 6, 55, 20, 3, 10, 43, 25, 39, 41, 45, 15, 21, 8, 18, 2, 61, 56, 14];

/** Lane i of the state is s[2i] (low half) and s[2i + 1] (high half). */
function permute(s: Uint32Array): void {
  const c = new Uint32Array(10);
  const b = new Uint32Array(50);
  for (let round = 0; round < ROUNDS; round++) {
    // θ
    for (let x = 0; x < 5; x++) {
      c[2 * x] = s[2 * x]! ^ s[2 * (x + 5)]! ^ s[2 * (x + 10)]! ^ s[2 * (x + 15)]! ^ s[2 * (x + 20)]!;
      c[2 * x + 1] = s[2 * x + 1]! ^ s[2 * (x + 5) + 1]! ^ s[2 * (x + 10) + 1]! ^ s[2 * (x + 15) + 1]! ^ s[2 * (x + 20) + 1]!;
    }
    for (let x = 0; x < 5; x++) {
      const next = (x + 1) % 5;
      const prev = (x + 4) % 5;
      const lo = c[2 * next]!;
      const hi = c[2 * next + 1]!;
      const dLo = c[2 * prev]! ^ ((lo << 1) | (hi >>> 31));
      const dHi = c[2 * prev + 1]! ^ ((hi << 1) | (lo >>> 31));
      for (let y = 0; y < 25; y += 5) {
        s[2 * (x + y)] ^= dLo;
        s[2 * (x + y) + 1] ^= dHi;
      }
    }
    // ρ and π
    for (let x = 0; x < 5; x++) {
      for (let y = 0; y < 5; y++) {
        const i = x + 5 * y;
        const lo = s[2 * i]!;
        const hi = s[2 * i + 1]!;
        const r = ROTATION[i]!;
        let rLo: number;
        let rHi: number;
        if (r === 0) {
          rLo = lo;
          rHi = hi;
        } else if (r < 32) {
          rLo = (lo << r) | (hi >>> (32 - r));
          rHi = (hi << r) | (lo >>> (32 - r));
        } else if (r === 32) {
          rLo = hi;
          rHi = lo;
        } else {
          const k = r - 32;
          rLo = (hi << k) | (lo >>> (32 - k));
          rHi = (lo << k) | (hi >>> (32 - k));
        }
        const j = y + 5 * ((2 * x + 3 * y) % 5);
        b[2 * j] = rLo;
        b[2 * j + 1] = rHi;
      }
    }
    // χ
    for (let y = 0; y < 25; y += 5) {
      for (let x = 0; x < 5; x++) {
        const i = x + y;
        const i1 = ((x + 1) % 5) + y;
        const i2 = ((x + 2) % 5) + y;
        s[2 * i] = b[2 * i]! ^ (~b[2 * i1]! & b[2 * i2]!);
        s[2 * i + 1] = b[2 * i + 1]! ^ (~b[2 * i1 + 1]! & b[2 * i2 + 1]!);
      }
    }
    // ι
    s[0] ^= RC_LO[round]!;
    s[1] ^= RC_HI[round]!;
  }
}

function absorbBlock(state: Uint32Array, block: Uint8Array, offset: number): void {
  for (let word = 0; word < RATE_BYTES / 4; word++) {
    const at = offset + word * 4;
    state[word] ^= block[at]! | (block[at + 1]! << 8) | (block[at + 2]! << 16) | (block[at + 3]! << 24);
  }
  permute(state);
}

/** Keccak-256 of `data`, as 32 bytes. */
export function keccak256(data: Uint8Array): Uint8Array {
  const state = new Uint32Array(50);
  const fullBlocks = Math.floor(data.length / RATE_BYTES);
  for (let index = 0; index < fullBlocks; index++) absorbBlock(state, data, index * RATE_BYTES);

  const last = new Uint8Array(RATE_BYTES);
  last.set(data.subarray(fullBlocks * RATE_BYTES));
  last[data.length - fullBlocks * RATE_BYTES] ^= 0x01;
  last[RATE_BYTES - 1] ^= 0x80;
  absorbBlock(state, last, 0);

  const out = new Uint8Array(32);
  for (let word = 0; word < 8; word++) {
    const value = state[word]!;
    out[word * 4] = value & 0xff;
    out[word * 4 + 1] = (value >>> 8) & 0xff;
    out[word * 4 + 2] = (value >>> 16) & 0xff;
    out[word * 4 + 3] = (value >>> 24) & 0xff;
  }
  return out;
}

const HEX_DIGITS = "0123456789abcdef";

export function bytesToHex(bytes: Uint8Array): string {
  let out = "0x";
  for (const byte of bytes) out += HEX_DIGITS[byte >>> 4]! + HEX_DIGITS[byte & 0x0f]!;
  return out;
}

/** Parses `0x`-prefixed hex of even length; throws on anything else. */
export function hexToBytes(hex: string): Uint8Array {
  if (!/^0x(?:[0-9a-fA-F]{2})*$/.test(hex)) throw new Error("not 0x-prefixed hex of whole bytes");
  const out = new Uint8Array((hex.length - 2) / 2);
  for (let index = 0; index < out.length; index++) out[index] = parseInt(hex.slice(2 + index * 2, 4 + index * 2), 16);
  return out;
}

/** Keccak-256 of `data` (raw bytes, or the UTF-8 of a string) as lowercase `0x` hex. */
export function keccak256Hex(data: Uint8Array | string): string {
  return bytesToHex(keccak256(typeof data === "string" ? new TextEncoder().encode(data) : data));
}

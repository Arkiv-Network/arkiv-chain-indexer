import { fail } from "./common";
import { keccak256 } from "viem";
export const FEED_DIGEST_DOMAIN = "arkiv/simulator-feed-block/v1";
export const BINARY_FEED_CAP = 8 * 1024 * 1024;
/** Version-one tagged binary metadata encoding; JSON serialization is not a hash preimage.
 * Scalars: null=0,false=1,true=2,u32=3,string=4,array=5,object=6.
 * Lengths/counts/numbers are u32 big-endian; object keys sort by UTF-8 bytes.
 */
export function encodeFeedValue(value: unknown, cap = BINARY_FEED_CAP): Buffer {
  let bytes = Buffer.allocUnsafe(Math.min(4096, cap)),
    offset = 0,
    nodes = 0;
  function room(n: number): void {
    if (n > cap - offset) return fail("LimitExceeded", 413);
    if (offset + n <= bytes.length) return;
    const grown = Buffer.allocUnsafe(
      Math.min(cap, Math.max(offset + n, bytes.length * 2)),
    );
    bytes.copy(grown, 0, 0, offset);
    bytes = grown;
  }
  function tag(n: number): void {
    room(1);
    bytes.writeUInt8(n, offset++);
  }
  function u32(n: number): void {
    room(4);
    bytes.writeUInt32BE(n, offset);
    offset += 4;
  }
  function string(s: string): void {
    tag(4);
    const size = Buffer.byteLength(s);
    u32(size);
    room(size);
    offset += bytes.write(s, offset, size, "utf8");
  }
  function emit(v: unknown, depth: number): void {
    if (depth > 64 || ++nodes > 1048576) return fail("LimitExceeded", 413);
    if (v === null) {
      tag(0);
      return;
    }
    if (v === false) {
      tag(1);
      return;
    }
    if (v === true) {
      tag(2);
      return;
    }
    if (typeof v === "number") {
      if (!Number.isInteger(v) || Object.is(v, -0) || v < 0 || v > 0xffffffff)
        return fail();
      tag(3);
      u32(v);
      return;
    }
    if (typeof v === "string") {
      string(v);
      return;
    }
    if (Array.isArray(v)) {
      tag(5);
      u32(v.length);
      for (const x of v) emit(x, depth + 1);
      return;
    }
    if (typeof v === "object") {
      const obj = v as Record<string, unknown>,
        keys = Object.keys(obj).sort((a, b) =>
          Buffer.compare(Buffer.from(a), Buffer.from(b)),
        );
      tag(6);
      u32(keys.length);
      for (const key of keys) {
        string(key);
        emit(obj[key], depth + 1);
      }
      return;
    }
    return fail();
  }
  emit(value, 0);
  return bytes.subarray(0, offset);
}
export function feedDigest(value: unknown): string {
  const domain = Buffer.from(FEED_DIGEST_DOMAIN),
    binary = encodeFeedValue(value);
  return keccak256(
    Buffer.concat([Buffer.from([domain.length]), domain, binary]),
  );
}

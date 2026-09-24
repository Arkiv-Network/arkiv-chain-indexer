/** Native simulator failures deliberately contain no upstream body or operation values. */
export class SimulatorError extends Error {
  constructor(
    readonly code: string,
    readonly status = 400,
  ) {
    super(code);
  }
}
export const fail = (code = "InvalidRequest", status = 400): never => {
  throw new SimulatorError(code, status);
};
export const U64_MAX = (1n << 64n) - 1n;
export function object(
  value: unknown,
  required: readonly string[],
  optional: readonly string[] = [],
): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return fail();
  const record = value as Record<string, unknown>;
  if (
    Object.keys(record).some(
      (k) => !required.includes(k) && !optional.includes(k),
    ) ||
    required.some((k) => !Object.hasOwn(record, k))
  )
    return fail();
  return record;
}
export function decimal(value: unknown, nonzero = false): string {
  if (typeof value !== "string" || !/^(0|[1-9][0-9]{0,19})$/.test(value))
    return fail();
  const n = BigInt(value);
  if (n > U64_MAX || (nonzero && n === 0n)) return fail();
  return value;
}
export function signed(value: unknown): string {
  if (typeof value !== "string" || !/^(0|-?[1-9][0-9]{0,18})$/.test(value))
    return fail();
  const n = BigInt(value);
  if (n < -(1n << 63n) || n >= 1n << 63n) return fail();
  return value;
}
export function integer(value: unknown, max = 0xffffffff): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    Object.is(value, -0) ||
    value < 0 ||
    value > max
  )
    return fail();
  return value;
}
export function text(value: unknown, max = 256, min = 0): string {
  if (
    typeof value !== "string" ||
    Buffer.byteLength(value) > max ||
    Buffer.byteLength(value) < min ||
    /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/u.test(
      value,
    )
  )
    return fail();
  return value;
}
export function hex(value: unknown, bytes: number, minBytes = bytes): string {
  if (
    typeof value !== "string" ||
    !/^0x(?:[0-9a-f]{2})*$/.test(value) ||
    (value.length - 2) / 2 < minBytes ||
    (value.length - 2) / 2 > bytes
  )
    return fail();
  return value;
}
export function choice<T extends string>(
  value: unknown,
  choices: readonly T[],
): T {
  if (typeof value !== "string" || !choices.includes(value as T)) return fail();
  return value as T;
}
export function array<T>(
  value: unknown,
  parse: (entry: unknown) => T,
  max: number,
): T[] {
  if (!Array.isArray(value) || value.length > max)
    return fail("LimitExceeded", 413);
  return value.map(parse);
}
export function nullable<T>(
  value: unknown,
  parse: (entry: unknown) => T,
): T | null {
  return value === null ? null : parse(value);
}
export async function boundedJson(
  message: Request | Response,
  cap: number,
  timeoutMs = 5000,
): Promise<unknown> {
  const announced = message.headers.get("content-length");
  if (
    announced !== null &&
    (!/^[0-9]+$/.test(announced) || BigInt(announced) > BigInt(cap))
  )
    return fail("LimitExceeded", 413);
  const reader = message.body?.getReader();
  if (!reader) return fail();
  const chunks: Uint8Array[] = [];
  let size = 0;
  let timer: ReturnType<typeof setTimeout>;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new SimulatorError("ReadTimeout", 408));
      void reader.cancel().catch(() => {});
    }, timeoutMs);
  });
  try {
    while (true) {
      const part = await Promise.race([reader.read(), deadline]);
      if (part.done) break;
      size += part.value.byteLength;
      if (size > cap) {
        void reader.cancel().catch(() => {});
        return fail("LimitExceeded", 413);
      }
      if (part.value.byteLength) chunks.push(part.value);
    }
  } finally {
    clearTimeout(timer!);
    reader.releaseLock();
  }
  try {
    return JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(
        Buffer.concat(chunks, size),
      ),
    );
  } catch {
    return fail();
  }
}

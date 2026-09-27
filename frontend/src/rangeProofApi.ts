import { pinSelection } from "./nodeDebugApi";
import { boundedJson, sameIdentity, type NativeIdentity, type NativeRow, type NativeSnapshot } from "./simulatorApi";

export const RANGE_PROFILE = "range-complete-v1";
export const RANGE_TYPES = ["u64", "i32", "u256", "dec"] as const;
export interface RangeBound { value: string; inclusive: boolean }
export interface RangeSelection {
  height: string; namespace: string; attribute: string;
  valueType: typeof RANGE_TYPES[number]; lower?: RangeBound; upper?: RangeBound;
}
export interface RangeResponse {
  identity: NativeIdentity; query: RangeSelection; snapshot: NativeSnapshot;
  verification: string; verificationStatus: { status: string; profile: string };
  certificateBytes: string; rows: NativeRow[]; complete: true;
  proofProfile: string; termCount: number; postingCount: number;
}

export function pinRange(request: RangeSelection, head: string): RangeSelection {
  if (!RANGE_TYPES.includes(request.valueType) || (!request.lower && !request.upper)) throw new Error("Choose at least one numeric bound.");
  const parse = (bound: RangeBound) => pinSelection({ ...request, value: bound.value, limit: 1, cursor: null }, head);
  const anchor = parse((request.lower ?? request.upper)!);
  const bound = (b?: RangeBound) => b ? { value: String(parse(b).value), inclusive: b.inclusive } : undefined;
  return { height: anchor.height, namespace: anchor.namespace, attribute: anchor.attribute, valueType: request.valueType, lower: bound(request.lower), upper: bound(request.upper) };
}

export function rangeExamples(head: string) {
  const height = BigInt(head);
  const lower = height > 2n ? height - 2n : 0n;
  const base: RangeSelection = { height: height.toString(), namespace: "1", attribute: "$createdAt", valueType: "u64" };
  return [
    { id: "recent", title: "Recent creations", description: "All live entities created in the last three blocks at this snapshot.", request: { ...base, lower: {value: lower.toString(), inclusive: true}, upper: {value: head, inclusive: true} } },
    { id: "empty", title: "Prove an empty range", description: "Creation heights after this snapshot cannot contain live entities.", request: { ...base, lower: {value: (height + 1n).toString(), inclusive: true}, upper: {value: (height + 2n).toString(), inclusive: true} } },
    { id: "exclusive", title: "Exclude the endpoints", description: "The same recent interval, with both boundary values excluded.", request: { ...base, lower: {value: lower.toString(), inclusive: false}, upper: {value: head, inclusive: false} } },
    { id: "price", title: "10 ≤ price < 20", description: "A custom indexed attribute. Demo prices 10 and 15 match; 9, 20 and 21 stay outside.", request: { ...base, attribute: "price", lower: {value: "10", inclusive: true}, upper: {value: "20", inclusive: false} } },
  ];
}

const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const uint = (v: unknown): v is string => typeof v === "string" && /^(0|[1-9]\d{0,19})$/.test(v);
const hash = (v: unknown) => typeof v === "string" && /^0x[0-9a-f]{64}$/.test(v);
function sameBound(a: unknown, b?: RangeBound) {
  return b ? object(a) && a.value === b.value && a.inclusive === b.inclusive : a === null || a === undefined;
}
/** Validate transport shape and bindings; the hosted Rust light process checks the proof. */
export function validateRangeResponse(data: unknown, identity: NativeIdentity, request: RangeSelection): RangeResponse {
  if (!object(data) || !sameIdentity(data.identity, identity) || data.complete !== true || ["cursor", "continuation", "nextCursor", "limit"].some(key => key in data) || data.proofProfile !== RANGE_PROFILE ||
      data.verification !== "proof verified against authenticated single-proposer header" ||
      !object(data.verificationStatus) || data.verificationStatus.status !== "verified" || data.verificationStatus.profile !== RANGE_PROFILE ||
      typeof data.certificateBytes !== "string" || !/^0x(?:[0-9a-f]{2})+$/.test(data.certificateBytes) ||
      !object(data.snapshot) || data.snapshot.height !== request.height || !hash(data.snapshot.hash) || !hash(data.snapshot.stateRoot) ||
      !object(data.query) || data.query.height !== request.height || data.query.namespace !== request.namespace ||
      data.query.attribute !== request.attribute || data.query.valueType !== request.valueType ||
      !sameBound(data.query.lower, request.lower) || !sameBound(data.query.upper, request.upper) ||
      !Array.isArray(data.rows) || data.rows.length > 64 || data.postingCount !== data.rows.length ||
      !Number.isInteger(data.termCount) || (data.termCount as number) < 0 || (data.termCount as number) > 64 ||
      (data.termCount as number) > data.rows.length || (data.rows.length > 0 && data.termCount === 0)) throw new Error("Range response does not match the requested complete result.");
  let previous = -1n;
  for (const row of data.rows) {
    if (!object(row) || row.namespaceId !== request.namespace || !uint(row.recordId) || BigInt(row.recordId) <= previous ||
        !hash(row.recordKey) || !uint(row.expiresAtHeight) || !Array.isArray(row.attributes) || row.attributes.length > 256 || !Array.isArray(row.fields) || row.fields.length > 256 ||
        row.attributes.some(a => !object(a) || typeof a.name !== "string" || typeof a.type !== "string" || !["string", "boolean"].includes(typeof a.value)) ||
        row.fields.some(f => !object(f) || typeof f.name !== "string" || typeof f.type !== "string" || !uint(f.byteLength))) throw new Error("Invalid range row metadata.");
    previous = BigInt(row.recordId);
  }
  return data as unknown as RangeResponse;
}

export async function verifyRange(identity: NativeIdentity, request: RangeSelection, signal: AbortSignal) {
  const response = await fetch("/node-sim/v1/query/range/verified", {
    method: "POST", headers: {"content-type": "application/json"}, credentials: "omit", cache: "no-store",
    body: JSON.stringify(request), signal: AbortSignal.any([signal, AbortSignal.timeout(20_000)]),
  });
  return validateRangeResponse(await boundedJson(response, 8 * 1024 * 1024), identity, request);
}

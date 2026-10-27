import { describe, expect, test } from "bun:test";
import type { ArkivOperationAttribute, StoredEntityOperation } from "./src/api";
import { PERMANENT_EXPIRES_AT } from "./src/attributes";
import { eventLabel, findOperationEvent, foldEntityHistory, operationRentShare } from "./src/entityHistory";

const KEY = `0x${"11".repeat(32)}`;
const OWNER = "0x7e5f4552091a69125d5dfcb7b8c2659029395bdf";
const OTHER = "0x2b5ad5c4795c026514f8317c7a215e218dccd6cf";

function attr(name: string, type: string, value: ArkivOperationAttribute["value"], indexed = true): ArkivOperationAttribute {
  const typeIds: Record<string, number> = { bool: 1, i32: 2, u64: 3, u256: 4, dec: 5, bytes32: 6, bytes: 7, str: 8, addr: 9, key: 10, tombstone: 0 };
  return { name, typeId: (typeIds[type] ?? 0) | (indexed && type !== "tombstone" ? 0x80 : 0), type, indexed: indexed && type !== "tombstone", value, size: 32 };
}

let position = 0;
function op(block: number, operation: string, overrides: Partial<StoredEntityOperation> = {}): StoredEntityOperation {
  position += 1;
  return {
    blockNumber: block,
    blockNumberDecimal: String(block),
    blockDate: "2026-10-27T10:00:00.000Z",
    position: 0,
    hash: `0x${position.toString(16).padStart(64, "0")}`,
    opIndex: 0,
    operationType: { create: 1, patch: 2, extend: 3, transfer: 4, delete: 5 }[operation] ?? 9,
    operation,
    entityKey: KEY,
    salt: null,
    creationFlags: operation === "create" ? 0 : null,
    expiresAt: null,
    minLifetime: null,
    resolvedExpiresAt: null,
    permanent: null,
    newOwner: null,
    bytesSize: 0,
    schemaName: null,
    attributes: [],
    transactionStatus: "1",
    transactionRentFeeWei: "0",
    transactionOperationCount: 1,
    ...overrides,
  };
}

describe("foldEntityHistory", () => {
  test("replays create, patch, extend to permanent, transfer and delete with versions", () => {
    const create = op(10, "create", {
      attributes: [attr("count", "u64", "0x5"), attr("note", "str", "hi", false), attr("arkiv.schema", "str", "posts")],
      resolvedExpiresAt: "1000",
      permanent: false,
      transactionRentFeeWei: "700",
    });
    const patch = op(20, "patch", { attributes: [attr("count", "dec", "5.5"), attr("note", "str", "hi", true), attr("note", "tombstone", null)] });
    const extend = op(30, "extend", { resolvedExpiresAt: PERMANENT_EXPIRES_AT, permanent: true, transactionRentFeeWei: "900", transactionOperationCount: 3 });
    const transfer = op(40, "transfer", { newOwner: OTHER });
    const remove = op(50, "delete");
    const events = foldEntityHistory({ operations: [create, patch, extend, transfer, remove] });

    expect(events.map((event) => [event.kind, event.version])).toEqual([
      ["created", 0],
      ["patched", 1],
      ["extended-to-permanent", 2],
      ["transferred", 3],
      ["deleted", 4],
    ]);
    expect(events[0]!.expiresAfter).toBe("1000");
    expect(events[1]!.changes.map((change) => [change.name, change.kind, change.retyped, change.indexChange])).toEqual([
      ["count", "changed", true, null],
      ["note", "changed", false, "indexed"],
      ["note", "unset", false, null],
    ]);
    expect(events[1]!.attributes!.map((attribute) => attribute.name)).toEqual(["arkiv.schema", "count"]);
    expect(events[2]!.expiresBefore).toBe("1000");
    expect(events[2]!.expiresAfter).toBe(PERMANENT_EXPIRES_AT);
    expect(eventLabel(events[2]!)).toBe("Extended to permanent");
    expect(events[3]!.ownerAfter).toBe(OTHER);
    expect(operationRentShare(events[2]!.rent)).toEqual({ wei: "900", sharedBy: 3 });
    expect(operationRentShare(events[0]!.rent)).toEqual({ wei: "700", sharedBy: 1 });
  });

  test("a failed operation is shown as attempted but changes nothing", () => {
    const create = op(10, "create", { attributes: [attr("a", "str", "1")], resolvedExpiresAt: "500", permanent: false });
    const failedPatch = op(11, "patch", { attributes: [attr("a", "str", "2")], transactionStatus: "0", transactionRentFeeWei: "0" });
    const failedExtend = op(12, "extend", { resolvedExpiresAt: PERMANENT_EXPIRES_AT, permanent: true, transactionStatus: "0" });
    const patch = op(13, "patch", { attributes: [attr("a", "str", "3")] });
    const events = foldEntityHistory({ operations: [create, failedPatch, failedExtend, patch] });
    expect(events.map((event) => [event.kind, event.attemptedKind, event.version])).toEqual([
      ["created", null, 0],
      ["failed", "patched", null],
      ["failed", "extended-to-permanent", null],
      ["patched", null, 1],
    ]);
    expect(eventLabel(events[1]!)).toBe("Failed patch (not applied)");
    expect(eventLabel(events[2]!)).toBe("Failed extend to permanent (not applied)");
    // The applied patch is diffed against the create, not the failed patch.
    expect(events[3]!.changes[0]!.before?.value).toBe("1");
    expect(events[3]!.expiresAfter).toBe("500");
  });

  test("an extend of a permanent entity is a no-op, a finite one is an extension", () => {
    const create = op(10, "create", { resolvedExpiresAt: PERMANENT_EXPIRES_AT, permanent: true });
    const again = op(11, "extend", { resolvedExpiresAt: PERMANENT_EXPIRES_AT, permanent: true });
    expect(foldEntityHistory({ operations: [create, again] })[1]!.kind).toBe("extend-noop");
    const finite = op(10, "create", { resolvedExpiresAt: "100", permanent: false });
    const longer = op(11, "extend", { resolvedExpiresAt: "2000000000000", permanent: false });
    expect(foldEntityHistory({ operations: [finite, longer] })[1]!.kind).toBe("extended");
  });

  test("a genesis entity starts from its genesis state", () => {
    const events = foldEntityHistory({
      genesis: {
        owner: OWNER,
        creator: OWNER,
        expiresAt: "900",
        creationFlags: 0,
        bytesSize: 3,
        schemaName: null,
        attributes: [
          { name: "body", type: "bytes", indexed: false, value: null, size: 3, keccak256: "0xaa" },
          { name: "label", type: "str", indexed: true, value: "alpha" },
        ],
      },
      operations: [op(5, "patch", { attributes: [attr("label", "str", "beta")] })],
    });
    expect(events.map((event) => [event.kind, event.version])).toEqual([["genesis", 0], ["patched", 1]]);
    expect(events[1]!.changes[0]!.before?.value).toBe("alpha");
    expect(events[1]!.ownerBefore).toBe(OWNER);
  });

  test("a truncated slice marks prior values unknown and numbers backwards from the index's version", () => {
    const events = foldEntityHistory({
      operations: [op(100, "patch", { attributes: [attr("a", "str", "x")] }), op(101, "extend", { resolvedExpiresAt: "999" })],
      truncated: true,
      currentVersion: 41,
    });
    expect(events.map((event) => event.version)).toEqual([40, 41]);
    expect(events[0]!.changes[0]!.priorUnknown).toBe(true);
    expect(events[0]!.attributes).toBeNull();
  });

  test("operations after a delete or a second create are not applied", () => {
    const events = foldEntityHistory({
      operations: [op(1, "create", { resolvedExpiresAt: "9" }), op(2, "create", { resolvedExpiresAt: "9" }), op(3, "delete"), op(4, "patch", { attributes: [attr("a", "str", "1")] })],
    });
    expect(events.map((event) => event.kind)).toEqual(["created", "ignored", "deleted", "ignored"]);
  });

  test("an operation is found by hash and op index", () => {
    const first = op(1, "create", { resolvedExpiresAt: "9" });
    const second = op(1, "patch", { hash: first.hash, opIndex: 1, attributes: [attr("a", "str", "1")] });
    const events = foldEntityHistory({ operations: [first, second] });
    expect(findOperationEvent(events, first.hash.toUpperCase().replace("0X", "0x"), 1)?.kind).toBe("patched");
    expect(findOperationEvent(events, first.hash, 7)).toBeNull();
  });
});

describe("extensions without the previous expiry", () => {
  test("a truncated history does not claim an extension to permanent", () => {
    const events = foldEntityHistory({
      operations: [op(900, "extend", { resolvedExpiresAt: PERMANENT_EXPIRES_AT, permanent: true })],
      truncated: true,
      currentVersion: 5,
    });
    expect(events[0]!.kind).toBe("extended");
    expect(events[0]!.expiresBefore).toBeNull();
    expect(events[0]!.expiresAfter).toBe(PERMANENT_EXPIRES_AT);
  });
});

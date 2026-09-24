/** Independent logical model of the documented 20-slot workload, never fed DTO changes. */
import { digest, type Change } from "./wire";
const PERMANENT = "18446744073709551615";
const ALICE = "0x" + "a1".repeat(20),
  BOB = "0x" + "b0".repeat(20);
export type OracleRow = Extract<Change, { kind: "recordUpsert" }> & {
  createdAtHeight: string;
  updatedAtHeight: string;
};
export interface OracleSnapshot {
  height: string;
  namespaces: Extract<Change, { kind: "namespaceUpsert" }>[];
  records: Map<string, OracleRow[]>;
}
export function* oracleHistory(
  blocks: number,
  seed = "7",
  payloadBytes = 64,
): Generator<OracleSnapshot> {
  const rows = new Map<string, Map<string, OracleRow>>([
      ["1", new Map()],
      ["2", new Map()],
    ]),
    ids = new Map([
      ["1", 1n],
      ["2", 1n],
    ]);
  let namespaces: OracleSnapshot["namespaces"] = [];
  const encoded = Buffer.alloc(payloadBytes + 5, 0x53);
  encoded[0] = 5;
  encoded.writeUInt32BE(payloadBytes, 1);
  const field = {
    name: "note",
    type: "bytes" as const,
    byteLength: String(payloadBytes),
    digest: digest("arkiv/simulator-value/v1", encoded),
    reference: null,
  };
  function create(
    namespaceId: string,
    key: string,
    height: number,
    expiresAtHeight = PERMANENT,
  ): void {
    const recordId = ids.get(namespaceId)!;
    ids.set(namespaceId, recordId + 1n);
    const bytes = Buffer.from(key),
      recordKey =
        bytes.length <= 32
          ? "0x" + bytes.toString("hex")
          : digest("arkiv/demo-key/v1", bytes);
    const row: OracleRow = {
      kind: "recordUpsert",
      namespaceId,
      recordId: String(recordId),
      recordKey,
      expiresAtHeight,
      attributes: [{ name: "group", type: "u64", value: "1" }],
      fields: [field],
      createdAtHeight: String(height),
      updatedAtHeight: String(height),
    };
    if (expiresAtHeight !== PERMANENT)
      row.attributes.unshift({
        name: "$expiresAt",
        type: "u64",
        value: expiresAtHeight,
      });
    rows.get(namespaceId)!.set(key, row);
  }
  yield { height: "0", namespaces: [], records: new Map() };
  for (let height = 1; height <= blocks; height++) {
    for (const records of rows.values())
      for (const [key, row] of records)
        if (BigInt(row.expiresAtHeight) <= BigInt(height)) records.delete(key);
    const round = Math.floor(height / 20),
      slot = height % 20,
      key = (kind: string) => `${seed}-${round}-${kind}`;
    if (height === 1)
      namespaces = [
        {
          kind: "namespaceUpsert",
          namespaceId: "1",
          name: "alpha",
          owner: ALICE,
          revision: "0",
        },
        {
          kind: "namespaceUpsert",
          namespaceId: "2",
          name: "beta",
          owner: ALICE,
          revision: "0",
        },
      ];
    else
      switch (slot) {
        case 2:
          create("1", key("expires"), height, String(height + 12));
          break;
        case 3:
          create("1", key("recreated"), height);
          break;
        case 4:
          create("2", key("other"), height);
          break;
        case 5:
        case 6: {
          const r = rows.get("1")!.get(key("expires"))!;
          r.attributes.find((a) => a.name === "group")!.value =
            slot === 5 ? "2" : "1";
          r.updatedAtHeight = String(height);
          break;
        }
        case 7:
          break; // entire create + missing-delete transaction rolls back, including tentative ID
        case 8:
          rows.get("1")!.delete(key("recreated"));
          break;
        case 9:
          create("1", key("recreated"), height);
          break;
        case 10:
        case 11: {
          const r = rows.get("1")!.get(key("recreated"))!;
          r.attributes.find((a) => a.name === "group")!.type =
            slot === 10 ? "str" : "u64";
          r.updatedAtHeight = String(height);
          break;
        }
        case 12:
          namespaces[1] = {
            ...namespaces[1]!,
            owner: round % 2 === 0 ? BOB : ALICE,
            revision: String(round + 1),
          };
          break;
        case 15:
        case 16:
        case 17:
        case 18:
          create("1", key(`stable-${slot}`), height);
          break;
      }
    yield {
      height: String(height),
      namespaces: structuredClone(namespaces),
      records: new Map(
        [...rows].map(([id, records]) => [
          id,
          structuredClone(
            [...records.values()].sort((a, b) =>
              BigInt(a.recordId) < BigInt(b.recordId) ? -1 : 1,
            ),
          ),
        ]),
      ),
    };
  }
}

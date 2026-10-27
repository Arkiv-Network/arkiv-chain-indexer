/**
 * An in-memory {@link GenesisSource} for tests: a list of entities in id
 * order (oldest first), paged oldest-first the way the UDC node pages
 * `arkiv_query` at block 0, with opaque cursors and a failure that can be
 * scheduled.
 */
import type { GenesisChain, GenesisPage, GenesisSource } from "./entityGenesis";

export const FAKE_GENESIS_OWNER = `0x${"5e".repeat(20)}`;

export interface FakeGenesisSource extends GenesisSource {
  /** Pages served so far. */
  readonly pages: number;
  /** Make the next page request fail with `error`. */
  failNextPage(error: Error): void;
  /** Make the n-th page request (1-based, counting from the first ever) fail with `error`. */
  failPage(n: number, error: Error): void;
}

export interface FakeGenesisSourceOptions {
  chain?: Partial<GenesisChain>;
  /** What `count()` answers; defaults to the number of entities. */
  count?: number | (() => Promise<number>);
  /** What `describe()` throws, when it should. */
  describeError?: Error;
}

export function createFakeGenesisSource(
  entities: ReadonlyArray<Record<string, unknown>>,
  options: FakeGenesisSourceOptions = {},
): FakeGenesisSource {
  const oldestFirst = [...entities];
  const failures = new Map<number, Error>();
  let pages = 0;
  return {
    get pages() {
      return pages;
    },
    failNextPage(error) {
      failures.set(pages + 1, error);
    },
    failPage(n, error) {
      failures.set(n, error);
    },
    async describe() {
      if (options.describeError) throw options.describeError;
      return {
        chainId: 7733102n,
        genesisHash: `0x${"70".repeat(32)}`,
        stateRoot: `0x${"1d".repeat(32)}`,
        ...options.chain,
      };
    },
    async count() {
      if (typeof options.count === "function") return options.count();
      return options.count ?? entities.length;
    },
    async page(cursor, limit): Promise<GenesisPage> {
      pages += 1;
      const failure = failures.get(pages);
      if (failure) {
        failures.delete(pages);
        throw failure;
      }
      const start = cursor === undefined ? 0 : Number(cursor.slice("c:".length));
      const data = oldestFirst.slice(start, start + limit);
      const end = start + data.length;
      return { data, blockNumber: "0x0", ...(end < oldestFirst.length ? { cursor: `c:${end}` } : {}) };
    },
  };
}

/**
 * An entity as the UDC node describes a genesis entity, keyed by its id. Its
 * `attributeSchema` is derived from `attributes` (all indexed but `bytes`)
 * unless an override gives one.
 */
export function fakeWireEntity(id: number, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const attributes =
    "attributes" in overrides
      ? overrides.attributes
      : [
          { name: "kind", type: "str", value: "seed" },
          { name: "n", type: "u64", value: `0x${id.toString(16)}` },
        ];
  const schema = Array.isArray(attributes)
    ? (attributes as Array<{ name?: unknown; type?: unknown }>).map((attribute) => ({
        name: attribute.name,
        type: attribute.type,
        indexed: attribute.type !== "bytes",
      }))
    : [];
  return {
    key: `0x${id.toString(16).padStart(64, "0")}`,
    owner: FAKE_GENESIS_OWNER,
    creator: FAKE_GENESIS_OWNER,
    createdAt: "0x0",
    updatedAt: "0x0",
    expiresAt: "0xffffffffffffffff",
    creationFlags: { readonly: false, permissionlessExtension: false, raw: 0 },
    attributeSchema: schema,
    ...overrides,
    attributes,
  };
}

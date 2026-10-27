// Reading entities with user-defined columns: the schema tag, the typed
// attributes and whether each can be filtered on, the literal a value is
// queried with, and the schema a page of results implies. No React here so
// `bun test` can cover it.

import { type ArkivValue, type AttributeSchema, type FullEntity, SCHEMA_ATTRIBUTE, type TypeTag } from "@arkiv-network/sdk";

/** A row as the explorer fetches it: every entity field, attributes and their schema. */
export type ExplorerEntity = FullEntity & { readonly $attributeSchema: AttributeSchema };

/**
 * The selection that fetches an {@link ExplorerEntity}. `"*"` leaves out
 * `$attributeSchema`, which only comes back when asked for by name.
 */
export const EXPLORER_SELECT = {
  $key: true,
  $owner: true,
  $creator: true,
  $createdAt: true,
  $updatedAt: true,
  $expiresAt: true,
  $creationFlags: true,
  $attributes: true,
  $attributeSchema: true,
} as const;

export type EntityAttribute = {
  name: string;
  value: ArkivValue;
  /** `undefined` when the node did not say, which the explorer treats as indexed. */
  indexed: boolean | undefined;
};

export const NUMERIC_TYPES = new Set<TypeTag>(["i32", "u64", "u256", "dec"]);

/** The tag a named schema writes on every entity, or undefined for an untagged one. */
export function getSchemaName(entity: ExplorerEntity): string | undefined {
  const tag = entity.$attributes[SCHEMA_ATTRIBUTE];
  return tag?.type === "str" ? tag.value : undefined;
}

/**
 * The entity's own attributes, in the node's order (sorted by name), without
 * the schema tag, which the explorer shows as the entity's schema instead.
 */
export function getAttributes(entity: ExplorerEntity): EntityAttribute[] {
  return Object.entries(entity.$attributes)
    .filter(([name]) => name !== SCHEMA_ATTRIBUTE)
    .map(([name, value]) => ({
      name,
      value,
      indexed: entity.$attributeSchema[name]?.indexed,
    }));
}

/** Whether a filter on this attribute can match: it is indexed, and so never `bytes`. */
export function isFilterable(attribute: EntityAttribute): boolean {
  return attribute.value.type !== "bytes" && attribute.indexed !== false;
}

/** Renders a typed value as the literal the query grammar expects. */
export function formatQueryLiteral(value: ArkivValue): string {
  switch (value.type) {
    case "str":
      // Single quotes, doubled to escape: str('it''s').
      return `str('${value.value.replace(/'/g, "''")}')`;
    case "bool":
      // Booleans are written bare. The node rejects bool(true) with a literal error.
      return String(value.value);
    default:
      return `${value.type}(${value.value})`;
  }
}

export function attributeFilter(name: string, value: ArkivValue): string {
  return `${name} = ${formatQueryLiteral(value)}`;
}

export function schemaFilter(schemaName: string): string {
  return `${SCHEMA_ATTRIBUTE} = ${formatQueryLiteral({ type: "str", value: schemaName } as ArkivValue)}`;
}

/** The range a u64 or i32 is read as Unix seconds in, roughly 2001 to 2100. */
const UNIX_SECONDS_MIN = 1_000_000_000n;
const UNIX_SECONDS_MAX = 4_102_444_800n;

/**
 * A date for an integer that looks like Unix seconds. Columns carry no unit,
 * so this is a hint for the reader rather than a claim about the data.
 */
export function asUnixDate(value: ArkivValue): Date | null {
  if (value.type !== "u64" && value.type !== "i32") return null;
  const seconds = BigInt(value.value);
  if (seconds < UNIX_SECONDS_MIN || seconds > UNIX_SECONDS_MAX) return null;
  return new Date(Number(seconds) * 1000);
}

/** Schema name for grouping; untagged entities share the empty string. */
export function schemaGroup(entity: ExplorerEntity): string {
  return getSchemaName(entity) ?? "";
}

export type InferredColumn = {
  name: string;
  /** Every type seen under this name, most common first. */
  types: { type: TypeTag; count: number }[];
  /** How many of the entities that have the column index it. */
  indexedCount: number;
  /** How many entities have the column at all. */
  count: number;
};

export type InferredSchema = {
  /** The schema tag, or null for untagged entities. */
  name: string | null;
  entityCount: number;
  columns: InferredColumn[];
};

/**
 * Works out what each group of entities looks like. Arkiv never stores a
 * schema, so this is read back from the attributes the entities carry: which
 * names appear, with which types, and whether they are indexed.
 */
export function inferSchema(entities: readonly ExplorerEntity[], name: string | null): InferredSchema {
  const columns = new Map<string, { types: Map<TypeTag, number>; indexedCount: number; count: number }>();
  for (const entity of entities) {
    for (const attribute of getAttributes(entity)) {
      let column = columns.get(attribute.name);
      if (!column) {
        column = { types: new Map(), indexedCount: 0, count: 0 };
        columns.set(attribute.name, column);
      }
      column.count++;
      if (attribute.indexed !== false && attribute.value.type !== "bytes") {
        column.indexedCount++;
      }
      column.types.set(attribute.value.type, (column.types.get(attribute.value.type) ?? 0) + 1);
    }
  }
  return {
    name,
    entityCount: entities.length,
    columns: [...columns.entries()]
      .map(([columnName, column]) => ({
        name: columnName,
        count: column.count,
        indexedCount: column.indexedCount,
        types: [...column.types.entries()].map(([type, count]) => ({ type, count })).sort((x, y) => y.count - x.count),
      }))
      // Indexed columns first, since those are the ones a query can use.
      .sort(
        (x, y) =>
          Number(y.indexedCount > 0) - Number(x.indexedCount > 0) || y.count - x.count || x.name.localeCompare(y.name),
      ),
  };
}

/** Groups entities by schema tag, largest group first, untagged last. */
export function groupBySchema(entities: readonly ExplorerEntity[]): Map<string, ExplorerEntity[]> {
  const groups = new Map<string, ExplorerEntity[]>();
  for (const entity of entities) {
    const group = schemaGroup(entity);
    const list = groups.get(group);
    if (list) list.push(entity);
    else groups.set(group, [entity]);
  }
  return new Map(
    [...groups.entries()].sort(([x, xs], [y, ys]) => Number(x === "") - Number(y === "") || ys.length - xs.length),
  );
}

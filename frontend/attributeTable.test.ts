import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { AttributeTable } from "./src/components/attribute-table";
import { applyAttributeMutations, attributeState, type AttributeView } from "./src/attributes";

const ADDR = "0x7e5f4552091a69125d5dfcb7b8c2659029395bdf";

function render(props: Parameters<typeof AttributeTable>[0]): string {
  return renderToStaticMarkup(createElement(AttributeTable, props));
}

function rows(html: string): string[] {
  return html.split("<tr").slice(2);
}

const STATE: AttributeView[] = [
  { name: "big", type: "u256", indexed: true, value: `0x${"f".repeat(64)}` },
  { name: "owner2", type: "addr", indexed: true, value: ADDR },
  { name: "note", type: "str", indexed: false, value: "stored only" },
  { name: "body", type: "bytes", indexed: false, value: null, size: 32768, keccak256: `0x${"ab".repeat(32)}` },
  { name: "flag", type: "bool", indexed: true, value: true },
];

describe("AttributeTable", () => {
  test("renders each type canonically with an indexed or stored badge", () => {
    const html = render({ attributes: STATE, actions: {} });
    expect(html).toContain(((1n << 256n) - 1n).toString());
    expect(html).toContain("0x7E5F4552091A69125d5DfCb7b8C2659029395Bdf");
    expect(html).toContain("32,768 bytes");
    expect(html).toContain("keccak 0xabababab…ababab");
    expect((html.match(/>indexed</g) ?? []).length).toBe(3);
    expect((html.match(/>stored</g) ?? []).length).toBe(2);
  });

  test("offers a query condition only for indexed attributes", () => {
    const html = render({ attributes: STATE, actions: {} });
    const [big, owner, note, body, flag] = rows(html);
    expect(big).toContain('aria-label="Query by big"');
    expect(owner).toContain('aria-label="Query by owner2"');
    expect(flag).toContain('aria-label="Query by flag"');
    expect(note).not.toContain("Query by");
    expect(note).toContain('title="stored, not queryable"');
    expect(body).not.toContain("Query by");
    expect(body).toContain("never indexed");
    // Without actions there is no query column at all.
    expect(render({ attributes: STATE })).not.toContain("Query by");
  });

  test("bytes the index holds no content for say so when there is no entity to read", () => {
    for (const bytes of [undefined, null, { entityKey: null }]) {
      const html = render({ attributes: [STATE[3]!], bytes });
      expect(html).toContain("content not held by the index");
      expect(html).not.toContain("Load from node");
    }
  });

  test("bytes load from the node for an entity, at the shown version's block", () => {
    const html = render({ attributes: [STATE[3]!], bytes: { entityKey: `0x${"11".repeat(32)}`, atBlock: 65 } });
    expect(html).toContain("Load from node");
    expect(html).toContain("at block 65");
  });

  test("a patch renders set, changed with retype and re-index highlighted, and unset with the old value", () => {
    const before = attributeState([
      { name: "count", type: "u64", indexed: true, value: "0x5" },
      { name: "note", type: "str", indexed: false, value: "hi" },
      { name: "gone", type: "str", indexed: true, value: "bye" },
    ]);
    const { changes } = applyAttributeMutations(before, [
      { name: "count", type: "dec", indexed: true, value: "5.5" },
      { name: "note", type: "str", indexed: true, value: "hi" },
      { name: "gone", type: "tombstone", indexed: false, value: null },
      { name: "fresh", type: "i32", indexed: true, value: -7 },
    ]);
    const html = render({ changes, actions: {} });
    const [count, note, gone, fresh] = rows(html);
    expect(count).toContain(">changed<");
    expect(count).toContain("Retyped");
    expect(count).toContain(">u64<");
    expect(count).toContain(">dec<");
    expect(count).toContain(">5<");
    expect(count).toContain(">5.5<");
    expect(note).toContain("Now indexed");
    // Only the flag changed: the value is shown once, not as old → new.
    expect(note.match(/>hi</g)?.length).toBe(1);
    expect(count.match(/line-through/g)?.length).toBeGreaterThan(0);
    expect(note).toContain(">stored<");
    expect(note).toContain(">indexed<");
    expect(gone).toContain(">unset<");
    expect(gone).toContain("bye");
    expect(gone).not.toContain("Query by");
    expect(fresh).toContain(">set<");
    expect(fresh).toContain("-7");
  });

  test("a patch against an unknown prior state says so", () => {
    const { changes } = applyAttributeMutations(null, [{ name: "a", type: "str", indexed: true, value: "x" }]);
    expect(render({ changes })).toContain("previous value not in the stored history");
  });
});

describe("str values with control characters", () => {
  test("show each control character as a marked escape, on one line", () => {
    const html = render({
      attributes: [
        { name: "multiline", type: "str", indexed: true, value: "line one\n\tline two" },
        { name: "nul", type: "str", indexed: true, value: "nul\u0000inside" },
      ],
    });
    expect(html).toContain('title="U+000A line feed">\\n</span><span');
    expect(html).not.toContain("\n");
    expect(html).toContain('title="U+0009 tab">\\t</span>line two');
    expect(html).toContain('nul<span class="mx-px rounded-[2px] bg-muted px-0.5 font-mono text-muted-foreground" title="U+0000 NUL">\\0</span>inside');
    expect(html).not.toContain("\u0000");
    // Both values copy both ways.
    expect(html.match(/aria-label="Copy escaped value"/g)).toHaveLength(2);
    expect(html.match(/aria-label="Copy value"/g)).toHaveLength(2);
  });
});

describe("schema badge", () => {
  test("shows a schema name's control characters as escapes", async () => {
    const { SchemaBadge } = await import("./src/components/entity-badges");
    const html = renderToStaticMarkup(createElement(SchemaBadge, { name: "a\u0000b" }));
    expect(html).toContain('a<span class="mx-px rounded-[2px] bg-muted px-0.5 font-mono text-muted-foreground" title="U+0000 NUL">\\0</span>b');
    expect(html).not.toContain("\u0000");
  });
});

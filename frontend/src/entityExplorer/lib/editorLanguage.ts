// CodeMirror support for the Arkiv query grammar with user-defined columns: a
// hand-written stream tokenizer for highlighting and a completion source.
// Ported from Arkiv-Network/data-explorer's lib/codemirror-arkiv.ts. Loaded
// lazily with the editor so the rest of the site never pays for CodeMirror.
//
// Logical operators (case-insensitive): AND OR NOT
// Comparison operators: = != < <= > >=
// Other operators:
//   <name> STARTSWITH str('prefix')   prefix match on a str attribute
//   EXISTS(<name>)                    attribute is set, any type
//   TYPEOF(<name>) = <tag>            attribute is set with exactly this type
// Literals are typed constructor calls: str('...') i32(10) u64(1200000)
//   u256(1000000) dec(3.5) addr(0x...) key(0x...) bytes32(0x...) true / false
// Filterable entity fields: $key $owner $creator $expiresAt
// Attribute names may contain `.` and `-` (arkiv.schema)
// Comments: `--` to the end of the line
//
// Example: level >= i32(10) AND (status = str('open') OR NOT EXISTS(closedAt))

import { autocompletion, type Completion, type CompletionContext } from "@codemirror/autocomplete";
import { HighlightStyle, StreamLanguage, syntaxHighlighting } from "@codemirror/language";
import { tags as t } from "@lezer/highlight";

// Only these four entity fields can be filtered on. $createdAt, $updatedAt and
// $creationFlags come back in results but are never indexed.
const SYSTEM_ATTRIBUTES: Record<string, string> = {
  $key: "key · entity key",
  $owner: "addr · entity owner",
  $creator: "addr · entity creator",
  $expiresAt: "u64 · block the entity expires at",
};

// The nine tags a literal can be built with, or named in TYPEOF(...) = <tag>.
// The tenth, `bytes`, is never indexed, so no filter can use it. Booleans are
// written bare (the node rejects bool(true)), so `bool` is only a TYPEOF tag.
const TYPE_TAGS: Record<string, string> = {
  bool: "boolean type tag",
  i32: "32-bit signed integer literal constructor",
  u64: "64-bit unsigned integer literal constructor",
  u256: "256-bit unsigned integer literal constructor",
  dec: "decimal literal constructor",
  bytes32: "32-byte hex literal constructor",
  str: "UTF-8 string literal constructor",
  addr: "address literal constructor",
  key: "entity key literal constructor",
};

/** A column seen in the loaded results, offered as a completion. */
export interface AttributeHint {
  name: string;
  types: readonly { type: string }[];
  indexedCount: number;
}

const completions: Completion[] = [
  ...Object.entries(SYSTEM_ATTRIBUTES).map(([label, detail]) => ({ label, type: "variable", detail })),
  ...Object.entries(TYPE_TAGS)
    .filter(([label]) => label !== "bool")
    .map(([label, detail]) => ({ label: `${label}()`, apply: `${label}()`, type: "function", detail })),
  ...["true", "false"].map((label) => ({ label, type: "constant", detail: "bool literal" })),
  {
    label: "arkiv.schema",
    apply: "arkiv.schema = str('')",
    type: "variable",
    detail: "str · the tag a named schema writes on every entity",
  },
  ...["AND", "OR", "NOT"].map((label) => ({ label, type: "keyword", detail: "logical operator" })),
  ...["=", "!=", "<", "<=", ">", ">="].map((label) => ({ label, type: "keyword", detail: "comparison operator" })),
  { label: "STARTSWITH", apply: "STARTSWITH str('')", type: "keyword", detail: "prefix match on a str attribute" },
  { label: "EXISTS", apply: "EXISTS()", type: "keyword", detail: "attribute is set, any type" },
  { label: "TYPEOF", apply: "TYPEOF() = ", type: "keyword", detail: "attribute is set with exactly this type" },
];

const ADDRESS_LENGTH = 42;

function rawHexCompletion(attribute: "$owner" | "$creator" | "$key", input: string): Completion {
  const ctor = attribute === "$key" ? "key" : "addr";
  const text = `${attribute} = ${ctor}(${input})`;
  return { label: text, apply: text, type: "variable" };
}

/** A bare hex value at the start of the box is almost always a key or address; offer the query for it. */
function rawHexCompletions(input: string): Completion[] {
  const options: Completion[] = [];
  if (input.length <= ADDRESS_LENGTH) {
    options.push(rawHexCompletion("$owner", input), rawHexCompletion("$creator", input));
  }
  options.push(rawHexCompletion("$key", input));
  return options;
}

/** Column names from the results on screen, indexed ones first since only those can be filtered on. */
function attributeCompletions(hints: readonly AttributeHint[]): Completion[] {
  return hints
    .filter((hint) => hint.name !== "arkiv.schema")
    .map((hint) => {
      const types = hint.types.map(({ type }) => type).join(" | ");
      const indexed = hint.indexedCount > 0;
      return {
        label: hint.name,
        type: "property",
        detail: indexed ? `${types} · indexed` : `${types} · not indexed`,
        info: indexed ? undefined : "Stored only, so a filter on it never matches. Only indexed columns can be queried.",
        boost: indexed ? 1 : -1,
      };
    });
}

function arkivCompletions(getHints: () => readonly AttributeHint[]) {
  return (context: CompletionContext) => {
    const rawHex = context.matchBefore(/0x[0-9a-fA-F]*/);
    if (rawHex && /^\s*$/.test(context.state.doc.sliceString(0, rawHex.from))) {
      return { from: rawHex.from, options: rawHexCompletions(rawHex.text), filter: false };
    }
    const word = context.matchBefore(/[\w$.-]*/);
    if (!word || (word.from === word.to && !context.explicit)) return null;
    return { from: word.from, options: [...completions, ...attributeCompletions(getHints())] };
  };
}

// Keywords are case-insensitive; whole-word matching keeps `android` from reading as AND.
const LOGICAL_KEYWORDS = new Set(["AND", "OR", "NOT"]);
const OPERATOR_WORDS = new Set(["STARTSWITH", "EXISTS", "TYPEOF"]);
const TYPE_TAG_SET = new Set(Object.keys(TYPE_TAGS));

const arkivStreamParser = StreamLanguage.define({
  token(stream) {
    if (stream.eatSpace()) return null;

    if (stream.match("--")) {
      stream.skipToEnd();
      return "comment";
    }

    if (stream.eat("(") || stream.eat(")")) return "paren";

    // Single-quoted strings, e.g. str('text'). Double quotes are not valid
    // syntax but keep highlighting so an old pasted query still reads.
    for (const quote of ["'", '"']) {
      if (stream.eat(quote)) {
        while (!stream.eol()) {
          if (stream.eat("\\")) stream.next();
          else if (stream.eat(quote)) return "string";
          else stream.next();
        }
        return "string";
      }
    }

    // Longer operators first so <= is not read as < then =.
    if (stream.match("!=") || stream.match("<=") || stream.match(">=")) return "operator";
    if (stream.match("=") || stream.match("<") || stream.match(">")) return "operator";

    if (stream.match(/^\$\w+/)) return "variableName";

    // Hex, or a decimal with an optional fraction (dec(3.5)).
    if (stream.match(/^0x[0-9a-fA-F]+/) || stream.match(/^\d+(\.\d+)?/)) return "number";

    // Names may contain `.` and `-` but never `--`, which starts a comment.
    if (stream.match(/^[a-zA-Z_](?:[\w.]|-(?!-))*/)) {
      const word = stream.current();
      const upper = word.toUpperCase();
      if (LOGICAL_KEYWORDS.has(upper) || OPERATOR_WORDS.has(upper)) return "keyword";
      if (TYPE_TAG_SET.has(word)) return "typeName";
      return "variableName.special";
    }

    stream.next();
    return null;
  },
});

// Colours come from the page's stylesheet so they follow the light/dark theme.
const arkivHighlight = HighlightStyle.define([
  { tag: t.keyword, color: "var(--q-keyword)", fontWeight: "600" },
  { tag: t.operator, color: "var(--q-operator)" },
  { tag: t.string, color: "var(--q-string)" },
  { tag: t.number, color: "var(--q-number)" },
  { tag: t.variableName, color: "var(--q-system)" },
  { tag: t.special(t.variableName), color: "var(--q-attribute)" },
  { tag: t.typeName, color: "var(--q-type)" },
  { tag: t.paren, color: "var(--q-paren)" },
  { tag: t.comment, color: "var(--q-paren)", fontStyle: "italic" },
]);

export function arkivQueryLanguage(getHints: () => readonly AttributeHint[] = () => []) {
  return [arkivStreamParser, syntaxHighlighting(arkivHighlight), autocompletion({ override: [arkivCompletions(getHints)] })];
}

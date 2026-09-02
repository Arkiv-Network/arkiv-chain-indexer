// CodeMirror support for the Arkiv 0.8 query grammar: a hand-written stream
// tokenizer for highlighting and a completion source. Ported from
// Arkiv-Network/data-explorer's lib/codemirror-arkiv.ts. Loaded lazily with the
// editor so the rest of the site never pays for CodeMirror.
//
// Logical operators (uppercase words): AND OR NOT
// Comparison operators: = != < <= > >=
// Other operators:
//   <name> STARTSWITH str('prefix')   prefix match on a str attribute
//   EXISTS(<name>)                    attribute is set, any type
//   TYPEOF(<name>) = <tag>            attribute is set with exactly this type
// Literals are typed constructor calls: str('...') i32(10) u64(1200000)
//   u256(1000000) dec(3.5) addr(0x...) key(0x...) bytes32(0x...) true / false
// System attributes: $key $owner $creator $createdAt $updatedAt $expiresAt
//   $contentType $payload $creationFlags
//
// Example: level >= i32(10) AND (status = str('open') OR NOT EXISTS(closedAt))

import { autocompletion, type Completion, type CompletionContext } from "@codemirror/autocomplete";
import { HighlightStyle, StreamLanguage, syntaxHighlighting } from "@codemirror/language";
import { tags as t } from "@lezer/highlight";

const SYSTEM_ATTRIBUTES: Record<string, string> = {
  $key: "entity key",
  $owner: "entity owner address",
  $creator: "entity creator address",
  $createdAt: "block the entity was created at",
  $updatedAt: "block the entity was last patched at",
  $expiresAt: "block the entity expires at",
  $contentType: "payload content type",
  $payload: "entity payload bytes",
  $creationFlags: "entity creation flags",
};

// The nine tags a user can construct a literal with, or name in TYPEOF(...) = <tag>.
// The tenth, `bytes`, only backs the system $payload cell and cannot be written.
const TYPE_TAGS: Record<string, string> = {
  bool: "boolean literal constructor",
  i32: "32-bit signed integer literal constructor",
  u64: "64-bit unsigned integer literal constructor",
  u256: "256-bit unsigned integer literal constructor",
  dec: "decimal literal constructor",
  bytes32: "32-byte hex literal constructor",
  str: "UTF-8 string literal constructor",
  addr: "address literal constructor",
  key: "entity key literal constructor",
};

const completions: Completion[] = [
  ...Object.entries(SYSTEM_ATTRIBUTES).map(([label, detail]) => ({ label, type: "variable", detail })),
  ...Object.entries(TYPE_TAGS).map(([label, detail]) => ({
    label: `${label}()`,
    apply: `${label}()`,
    type: "function",
    detail,
  })),
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

function arkivCompletions(context: CompletionContext) {
  const rawHex = context.matchBefore(/0x[0-9a-fA-F]*/);
  if (rawHex && /^\s*$/.test(context.state.doc.sliceString(0, rawHex.from))) {
    return { from: rawHex.from, options: rawHexCompletions(rawHex.text), filter: false };
  }
  const word = context.matchBefore(/[\w$]*/);
  if (!word || (word.from === word.to && !context.explicit)) return null;
  return { from: word.from, options: completions };
}

const LOGICAL_KEYWORDS = new Set(["AND", "OR", "NOT"]);
const OPERATOR_WORDS = new Set(["STARTSWITH", "EXISTS", "TYPEOF"]);
const TYPE_TAG_SET = new Set(Object.keys(TYPE_TAGS));

const arkivStreamParser = StreamLanguage.define({
  token(stream) {
    if (stream.eatSpace()) return null;

    if (stream.eat("(") || stream.eat(")")) return "paren";

    // Single-quoted strings, e.g. str('text'). Double quotes are not valid 0.8
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

    // Matched case-sensitively so an attribute named `android` is not half-highlighted as `AND`.
    if (stream.match(/^[a-zA-Z_]\w*/)) {
      const word = stream.current();
      if (LOGICAL_KEYWORDS.has(word) || OPERATOR_WORDS.has(word)) return "keyword";
      if (TYPE_TAG_SET.has(word)) return "typeName";
      return "variableName.special";
    }

    if (stream.eat("*")) return "operator";

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
]);

export function arkivQueryLanguage() {
  return [arkivStreamParser, syntaxHighlighting(arkivHighlight), autocompletion({ override: [arkivCompletions] })];
}

/**
 * Reading `bytes` columns. Arkiv stores them as opaque blobs with no content
 * type of their own, so everything here works from the bytes themselves plus
 * whatever hint a sibling column gives.
 */

import type { EntityAttribute } from "./entity";

export const TEXT_PREVIEW_LIMIT = 1024;
/** Bytes shown in the hex panel before the reader asks for the rest. */
export const HEX_PREVIEW_BYTES = 256;
const HEX_COLUMNS = 16;
/** Cap on inflated output, so a gzip bomb can't exhaust the tab's memory. */
const MAX_DECOMPRESSED_BYTES = 16 * 1024 * 1024;

export type BytesKind =
  | { kind: "empty" }
  | { kind: "image"; mime: string; label: string }
  | { kind: "gzip" }
  | { kind: "text"; label: "JSON" | "Text" }
  | { kind: "binary" };

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Whether decoded text is really binary. The decoder is non-fatal, so bad
 * bytes come back as U+FFFD rather than throwing; a NUL is the other tell,
 * since it decodes cleanly but never appears in text someone meant to store.
 */
export function looksBinary(text: string): boolean {
  return text.includes("�") || text.includes("\u0000");
}

export function decodeText(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}

/** Image formats a browser renders, recognised by their magic numbers. */
function sniffImage(bytes: Uint8Array): { mime: string; label: string } | null {
  const starts = (...magic: number[]) => magic.every((byte, i) => bytes[i] === byte);
  if (starts(0x89, 0x50, 0x4e, 0x47)) return { mime: "image/png", label: "PNG" };
  if (starts(0xff, 0xd8, 0xff)) return { mime: "image/jpeg", label: "JPEG" };
  if (starts(0x47, 0x49, 0x46, 0x38)) return { mime: "image/gif", label: "GIF" };
  if (starts(0x52, 0x49, 0x46, 0x46) && bytes[8] === 0x57 && bytes[9] === 0x45) {
    return { mime: "image/webp", label: "WebP" };
  }
  return null;
}

export function hasGzipMagic(bytes: Uint8Array): boolean {
  return bytes[0] === 0x1f && bytes[1] === 0x8b;
}

function isGzipLabel(value: string | undefined): boolean {
  const mime = value?.split(";")[0].trim().toLowerCase();
  return mime === "gzip" || mime === "application/gzip" || mime === "application/x-gzip";
}

export function classifyBytes(bytes: Uint8Array, hint?: BytesHint): BytesKind {
  if (bytes.byteLength === 0) return { kind: "empty" };
  const image = sniffImage(bytes);
  if (image) return { kind: "image", ...image };
  if (hasGzipMagic(bytes) || isGzipLabel(hint?.value)) return { kind: "gzip" };
  const text = decodeText(bytes.subarray(0, TEXT_PREVIEW_LIMIT * 4));
  if (looksBinary(text)) return { kind: "binary" };
  return { kind: "text", label: isJson(bytes) ? "JSON" : "Text" };
}

/** A leading `{` or `[` isn't enough: TOML sections and Markdown links start that way too. */
function isJson(bytes: Uint8Array): boolean {
  if (!/^\s*[{[]/.test(decodeText(bytes.subarray(0, 64)))) return false;
  try {
    JSON.parse(decodeText(bytes));
    return true;
  } catch {
    return false;
  }
}

export function kindLabel(kind: BytesKind): string {
  switch (kind.kind) {
    case "empty":
      return "Empty";
    case "image":
      return `${kind.label} image`;
    case "gzip":
      return "gzip";
    case "text":
      return kind.label;
    case "binary":
      return "Binary";
  }
}

/** Pretty-prints JSON, or returns the text as it is. */
export function formatText(text: string): {
  label: "JSON" | "Text";
  content: string;
} {
  try {
    return { label: "JSON", content: JSON.stringify(JSON.parse(text), null, 2) };
  } catch {
    return { label: "Text", content: text };
  }
}

/**
 * A sibling str column that says what a bytes column holds. Columns are free
 * to name this however they like, so this only looks for the common spellings.
 */
export type BytesHint = { column: string; value: string };

const HINT_SUFFIXES = ["Encoding", "ContentType", "MimeType", "Mime", "Type"];
const GENERIC_HINTS = ["contentType", "mimeType", "encoding", "mime"];

export function findBytesHint(attributes: readonly EntityAttribute[], name: string): BytesHint | undefined {
  const strings = new Map(
    attributes
      .filter((attribute) => attribute.value.type === "str")
      .map((attribute) => [attribute.name, String(attribute.value.value)]),
  );
  for (const suffix of HINT_SUFFIXES) {
    const column = `${name}${suffix}`;
    const value = strings.get(column);
    if (value) return { column, value };
  }
  // A generic `mimeType` only describes the blob when there is exactly one.
  const blobs = attributes.filter((attribute) => attribute.value.type === "bytes");
  if (blobs.length !== 1) return undefined;
  for (const column of GENERIC_HINTS) {
    const value = strings.get(column);
    if (value) return { column, value };
  }
  return undefined;
}

export async function gunzip(bytes: Uint8Array): Promise<Uint8Array> {
  const reader = new Blob([bytes as BlobPart]).stream().pipeThrough(new DecompressionStream("gzip")).getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_DECOMPRESSED_BYTES) {
      await reader.cancel();
      throw new Error(`decompressed size exceeds ${formatBytes(MAX_DECOMPRESSED_BYTES)}`);
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

/**
 * Classic offset / hex / ASCII dump. Non-printable bytes show as a dot, which
 * is what makes any embedded text stand out in the right-hand gutter.
 */
export function formatHexDump(bytes: Uint8Array, limit: number): string {
  const shown = bytes.subarray(0, limit);
  const lines: string[] = [];

  for (let offset = 0; offset < shown.length; offset += HEX_COLUMNS) {
    const row = shown.subarray(offset, offset + HEX_COLUMNS);
    let hex = "";
    let ascii = "";

    for (let i = 0; i < HEX_COLUMNS; i++) {
      const byte = row[i];
      hex += byte === undefined ? "   " : `${byte.toString(16).padStart(2, "0")} `;
      if (i === HEX_COLUMNS / 2 - 1) hex += " ";
      if (byte !== undefined) {
        ascii += byte >= 0x20 && byte < 0x7f ? String.fromCharCode(byte) : ".";
      }
    }

    lines.push(`${offset.toString(16).padStart(8, "0")}  ${hex} |${ascii}|`);
  }

  return lines.join("\n");
}

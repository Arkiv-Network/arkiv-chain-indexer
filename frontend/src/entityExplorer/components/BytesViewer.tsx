// One `bytes` column of an entity. An entity can have any number of these,
// each with no content type of its own, so the viewer works out what it holds
// from the bytes and from a sibling column such as `samplesEncoding`.

import { Binary, Check, Copy, FileArchive, FileCode, ImageIcon } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { type Hex, hexToBytes, toHex } from "viem";
import { copyText } from "@/components/copy-cell";
import {
  classifyBytes,
  decodeText,
  formatBytes,
  formatHexDump,
  formatText,
  gunzip,
  HEX_PREVIEW_BYTES,
  kindLabel,
  TEXT_PREVIEW_LIMIT,
  type BytesHint,
} from "../lib/bytes";

const toolbarButtonClass =
  "flex shrink-0 items-center gap-1 border border-border px-1.5 py-0.5 text-[10px] text-muted-foreground transition-colors hover:border-accent hover:text-accent disabled:pointer-events-none disabled:opacity-50";
const expandButtonClass =
  "absolute inset-x-0 bottom-0 flex items-end justify-center bg-linear-to-b from-transparent via-muted/80 to-muted pt-16 pb-2 text-[11px] font-medium text-foreground transition-colors hover:text-accent";

/** A data URL rather than a blob URL: a blob column is at most 128 KiB, and nothing needs revoking. */
function toDataUrl(bytes: Uint8Array, mime: string): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return `data:${mime};base64,${btoa(binary)}`;
}

function ImagePreview({ bytes, mime }: { bytes: Uint8Array; mime: string }) {
  const url = useMemo(() => toDataUrl(bytes, mime), [bytes, mime]);
  const [size, setSize] = useState<{ w: number; h: number } | null>(null);
  return (
    <div className="flex items-end gap-3 border border-border bg-muted/50 p-3">
      <img
        src={url}
        alt=""
        className="max-h-48 max-w-full bg-[repeating-conic-gradient(var(--muted)_0_25%,transparent_0_50%)] bg-size-[12px_12px] [image-rendering:pixelated]"
        style={size && size.w < 96 ? { width: size.w * 2 } : undefined}
        onLoad={(event) => setSize({ w: event.currentTarget.naturalWidth, h: event.currentTarget.naturalHeight })}
      />
      {size ? (
        <span className="font-mono text-[10px] text-muted-foreground">
          {size.w}×{size.h}
        </span>
      ) : null}
    </div>
  );
}

export function BytesViewer({ id, name, value, hint }: { id?: string; name: string; value: Hex; hint?: BytesHint }) {
  const raw = useMemo(() => hexToBytes(value), [value]);
  const [inflated, setInflated] = useState<Uint8Array | null>(null);
  const [decompressing, setDecompressing] = useState(false);
  const [inflateError, setInflateError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return;
    const timeout = window.setTimeout(() => setCopied(false), 1200);
    return () => window.clearTimeout(timeout);
  }, [copied]);

  const rawKind = useMemo(() => classifyBytes(raw, hint), [raw, hint]);
  const bytes = inflated ?? raw;
  const kind = useMemo(() => (inflated ? classifyBytes(inflated) : rawKind), [inflated, rawKind]);
  const text = useMemo(() => {
    if (kind.kind !== "text") return null;
    const full = decodeText(bytes);
    if (expanded || full.length <= TEXT_PREVIEW_LIMIT) return { ...formatText(full), full, truncated: false };
    return { label: kind.label, content: full.slice(0, TEXT_PREVIEW_LIMIT), full, truncated: true };
  }, [bytes, expanded, kind]);

  async function toggleInflate() {
    setExpanded(false);
    setInflateError(null);
    if (inflated) {
      setInflated(null);
      return;
    }
    setDecompressing(true);
    try {
      setInflated(await gunzip(raw));
    } catch (error) {
      // DecompressionStream rejects corrupt input with an empty message.
      setInflateError(`Couldn't decompress ${name}: ${(error instanceof Error && error.message) || "not valid gzip data"}`);
    } finally {
      setDecompressing(false);
    }
  }

  async function copy() {
    if (await copyText(text ? text.full : toHex(bytes))) setCopied(true);
  }

  const Icon = kind.kind === "image" ? ImageIcon : kind.kind === "text" ? FileCode : kind.kind === "gzip" ? FileArchive : Binary;

  return (
    <section id={id} className="min-w-0 scroll-mt-32">
      <div className="mb-1.5 flex min-w-0 items-center gap-1.5">
        <Icon className="size-3 shrink-0 text-muted-foreground" />
        <span className="truncate font-mono text-xs text-foreground">{name}</span>
        <span className="shrink-0 text-[10px] font-medium tracking-wider text-muted-foreground uppercase">
          {inflated ? "Decompressed · " : ""}
          {text?.label ?? kindLabel(kind)} · {formatBytes(bytes.byteLength)}
        </span>
        {hint ? (
          <span
            className="hidden truncate border border-border px-1 font-mono text-[10px] text-muted-foreground sm:inline"
            title={`Read from the ${hint.column} column`}
          >
            {hint.column}: {hint.value}
          </span>
        ) : null}
        <div className="ml-auto flex items-center gap-1">
          {rawKind.kind === "gzip" ? (
            <button
              type="button"
              className={toolbarButtonClass}
              disabled={decompressing}
              onClick={toggleInflate}
              title={inflated ? "Show the compressed bytes" : "Decompress the gzip data"}
            >
              <FileArchive className="size-3" />
              {inflated ? "Show raw" : decompressing ? "Decompressing…" : "Decompress"}
            </button>
          ) : null}
          {kind.kind !== "empty" ? (
            <button
              type="button"
              className="inline-flex size-5 shrink-0 items-center justify-center border border-border text-muted-foreground opacity-70 transition-colors hover:border-accent hover:text-accent hover:opacity-100"
              title={text ? `Copy ${name} as text` : `Copy ${name} as hex`}
              aria-label={`Copy ${name}`}
              onClick={copy}
            >
              {copied ? <Check className="size-3" /> : <Copy className="size-3" />}
            </button>
          ) : null}
        </div>
      </div>

      {inflateError ? (
        <p className="mb-1.5 border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive">{inflateError}</p>
      ) : null}

      {kind.kind === "empty" ? (
        <p className="border border-border bg-muted/50 p-3 text-xs text-muted-foreground">(empty)</p>
      ) : kind.kind === "image" ? (
        <ImagePreview bytes={bytes} mime={kind.mime} />
      ) : text ? (
        <div className="relative">
          <pre className="max-h-75 overflow-auto border border-border bg-muted/50 p-3 font-mono text-xs leading-relaxed wrap-break-word whitespace-pre-wrap">
            {text.content || "(empty)"}
          </pre>
          {text.truncated ? (
            <button type="button" onClick={() => setExpanded(true)} className={expandButtonClass}>
              Show all · {formatBytes(Math.max(0, bytes.byteLength - TEXT_PREVIEW_LIMIT))} hidden
            </button>
          ) : null}
        </div>
      ) : (
        <div className="relative">
          <pre className="max-h-75 overflow-auto border border-border bg-muted/50 p-3 font-mono text-xs leading-relaxed whitespace-pre">
            {formatHexDump(bytes, expanded ? bytes.byteLength : HEX_PREVIEW_BYTES)}
          </pre>
          {!expanded && bytes.byteLength > HEX_PREVIEW_BYTES ? (
            <button type="button" onClick={() => setExpanded(true)} className={expandButtonClass}>
              Show all bytes · {formatBytes(bytes.byteLength - HEX_PREVIEW_BYTES)} more
            </button>
          ) : null}
        </div>
      )}
    </section>
  );
}

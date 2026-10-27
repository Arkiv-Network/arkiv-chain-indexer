import { Check, Download, Loader2, TriangleAlert } from "lucide-react";
import { useState } from "react";
import { CopyButton } from "@/components/copy-cell";
import type { AttributeView } from "@/attributes";
import type { RpcSource } from "@/dataRpc";
import { NODE_RPC_URL } from "@/nodeRpc";
import { bytesAsText, loadBytesFromNode, type LoadedBytes } from "@/nodeBytes";
import { cn } from "@/lib/utils";

/** How much of a loaded value is shown inline; the copy button always copies all of it. */
const PREVIEW_BYTES = 256;

/** Where the "load from node" action reads from, and at which block. */
export interface BytesSource {
  entityKey: string | null;
  /** The block the shown version is from; the node's head when omitted. */
  atBlock?: number;
  /** Defaults to the deployment's node; null hides the action. */
  rpc?: RpcSource | null;
}

function shortHash(hash: string): string {
  return hash.length > 18 ? `${hash.slice(0, 10)}…${hash.slice(-6)}` : hash;
}

/**
 * A bytes attribute: its size and keccak256 (all the index keeps), and an
 * action that loads the content from the node — in the browser, never through
 * the indexer backend — and checks it against that hash.
 */
export function BytesValue({ attribute, source }: { attribute: AttributeView; source?: BytesSource | null }) {
  const [loaded, setLoaded] = useState<LoadedBytes | null>(() =>
    attribute.content
      ? { content: attribute.content, size: attribute.size ?? 0, keccak256: attribute.keccak256 ?? "", blockNumber: null, matches: null }
      : null,
  );
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [asText, setAsText] = useState(false);

  const rpc = source?.rpc === undefined ? (NODE_RPC_URL ? { kind: "node" as const, customUrl: "" } : null) : source.rpc;
  const canLoad = !loaded && rpc !== null && Boolean(source?.entityKey);
  const size = attribute.size ?? loaded?.size;

  const load = async () => {
    if (!source?.entityKey || !rpc) return;
    setLoading(true);
    setError(null);
    try {
      setLoaded(
        await loadBytesFromNode(
          { entityKey: source.entityKey, name: attribute.name, atBlock: source.atBlock, expectedKeccak256: attribute.keccak256 },
          rpc,
        ),
      );
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setLoading(false);
    }
  };

  const text = loaded && asText ? bytesAsText(loaded.content) : null;
  const printable = loaded ? bytesAsText(loaded.content) !== null : false;
  const previewHex = loaded ? loaded.content.slice(0, 2 + PREVIEW_BYTES * 2) : "";

  return (
    <div className="flex min-w-0 flex-col gap-1">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <span className="font-mono tabular-nums text-foreground">
          {size === undefined ? "bytes (size withheld)" : `${size.toLocaleString("en-US")} bytes`}
        </span>
        {attribute.keccak256 ? (
          <span className="inline-flex items-center gap-1 text-muted-foreground" title={`keccak256 ${attribute.keccak256}`}>
            <span className="font-mono text-[11px]">keccak {shortHash(attribute.keccak256)}</span>
            <CopyButton value={attribute.keccak256} label="keccak256" />
          </span>
        ) : null}
        {canLoad ? (
          <button
            type="button"
            className="inline-flex items-center gap-1 border border-border px-1.5 py-0.5 text-[11px] text-muted-foreground transition-colors hover:border-accent hover:text-accent disabled:opacity-50"
            onClick={() => void load()}
            disabled={loading}
            title={`Read the content from the node${source?.atBlock !== undefined ? ` at block ${source.atBlock}` : ""}; the index never holds it`}
          >
            {loading ? <Loader2 className="size-3 animate-spin" /> : <Download className="size-3" />}
            Load from node
          </button>
        ) : !loaded && rpc === null ? (
          <span className="text-[11px] text-muted-foreground" title="Set VITE_NODE_RPC_URL to load bytes contents from a node">
            content not held by the index
          </span>
        ) : null}
      </div>
      {error ? <p className="text-[11px] text-destructive">Could not load: {error}</p> : null}
      {loaded ? (
        <div className="flex min-w-0 flex-col gap-1">
          <div className="flex flex-wrap items-center gap-2 text-[11px]">
            {loaded.matches === true ? (
              <span className="inline-flex items-center gap-1 text-emerald-700 dark:text-emerald-400">
                <Check className="size-3" /> matches the recorded keccak256
              </span>
            ) : loaded.matches === false ? (
              <span className="inline-flex items-center gap-1 text-amber-700 dark:text-amber-400" title={`node content hashes to ${loaded.keccak256}`}>
                <TriangleAlert className="size-3" /> differs from the recorded keccak256 (the node holds another value
                {loaded.blockNumber !== null ? ` at block ${loaded.blockNumber}` : ""})
              </span>
            ) : (
              <span className="text-muted-foreground">from the node</span>
            )}
            <CopyButton value={loaded.content} label="content as hex" />
            {printable ? (
              <button type="button" className="text-accent hover:underline" onClick={() => setAsText((value) => !value)}>
                {asText ? "show hex" : "show as text"}
              </button>
            ) : null}
          </div>
          <pre
            className={cn(
              "max-h-32 overflow-auto border border-border bg-muted/40 p-1.5 font-mono text-[10px] leading-snug break-all whitespace-pre-wrap text-foreground",
            )}
          >
            {text ?? previewHex}
            {!text && loaded.size > PREVIEW_BYTES ? `… (${(loaded.size - PREVIEW_BYTES).toLocaleString("en-US")} more bytes)` : ""}
          </pre>
        </div>
      ) : null}
    </div>
  );
}

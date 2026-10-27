import { ExternalLink } from "lucide-react";
import { useEffect, useState, type MouseEvent, type ReactNode } from "react";
import {
  fetchTransactionByHash,
  type StoredArkivOperation,
  type StoredTransaction,
} from "./api";
import { AddressCell } from "./TransactionsView";
import { BlockNumberLink } from "./blockLinks";
import { CedricOnTimer } from "./Cedric";
import { CopyButton } from "@/components/copy-cell";

// Re-exported so existing `import { CopyButton } from "./TransactionView"`
// call sites (DataView, EntityView) keep working against the shared component.
export { CopyButton } from "@/components/copy-cell";
import { OpBadge, StatusBadge, type StatusTone } from "@/components/op-badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import {
  fmtBytes,
  fmtDate,
  fmtGasPrice,
  fmtInteger,
  fmtRatio,
  fmtTokenAmount,
} from "./format";
import { PageBreadcrumbs } from "./PageBreadcrumbs";
import {
  entityDetailHref,
  transactionDetailHref,
  writeEntityPermalink,
  writeTransactionPermalink,
} from "./permalinks";
import { transactionDecoderHref } from "./transactionLinks";

interface TransactionViewProps {
  hash: string | null;
  onLocationChange: () => void;
  timeZone: string;
  tokenSymbol: string;
  blockTimeMs: number;
}

const TX_HASH_RE = /^0x[0-9a-fA-F]{64}$/;

type LoadStatus = "idle" | "loading" | "loaded" | "notfound" | "error";

export function TransactionView({
  hash,
  onLocationChange,
  timeZone,
  tokenSymbol,
  blockTimeMs,
}: TransactionViewProps) {
  const [query, setQuery] = useState(hash ?? "");
  const [formError, setFormError] = useState<string | null>(null);
  const [data, setData] = useState<StoredTransaction | null>(null);
  const [status, setStatus] = useState<LoadStatus>("idle");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setQuery(hash ?? "");
    setFormError(null);
  }, [hash]);

  useEffect(() => {
    if (!hash) {
      setData(null);
      setStatus("idle");
      setError(null);
      return;
    }

    let cancelled = false;
    setStatus("loading");
    setError(null);
    setData(null);
    fetchTransactionByHash(hash)
      .then((tx) => {
        if (cancelled) return;
        if (!tx) {
          setStatus("notfound");
          return;
        }
        setData(tx);
        setStatus("loaded");
      })
      .catch((err: Error) => {
        if (cancelled) return;
        setError(err.message);
        setStatus("error");
      });

    return () => {
      cancelled = true;
    };
  }, [hash]);

  const onSubmit = (event: React.FormEvent) => {
    event.preventDefault();
    const value = query.trim();
    if (!TX_HASH_RE.test(value)) {
      setFormError("Enter a 0x-prefixed 32-byte transaction hash (66 characters).");
      return;
    }
    setFormError(null);
    if (value.toLowerCase() === (hash ?? "").toLowerCase()) return;
    if (writeTransactionPermalink(value)) onLocationChange();
  };

  return (
    <section className="mx-auto flex w-full max-w-415 flex-col gap-4 px-3 md:px-6">
      <PageBreadcrumbs
        items={[
          { view: "home", label: "Home" },
          { view: "blocks", label: "Block list" },
          { view: "transaction", label: "Transaction details" },
        ]}
        onLocationChange={onLocationChange}
      />
      <h2 className="font-heading text-lg font-black tracking-tight">Transaction</h2>

      <form onSubmit={onSubmit} className="flex max-w-2xl gap-2">
        <input
          type="text"
          inputMode="text"
          spellCheck={false}
          autoComplete="off"
          placeholder="0x… transaction hash"
          className="h-8 min-w-0 flex-1 rounded-none border border-input bg-transparent px-2.5 py-1 font-mono text-xs outline-none transition-colors focus-visible:border-ring focus-visible:ring-1 focus-visible:ring-ring/50 dark:bg-input/30"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        <Button type="submit" size="sm" className="shrink-0">
          Look up
        </Button>
      </form>
      {formError ? <p className="text-xs text-destructive">{formError}</p> : null}

      {!hash ? (
        <p className="text-xs text-muted-foreground">Enter a transaction hash above to view its details.</p>
      ) : status === "loading" ? (
        <p className="text-xs text-muted-foreground">Loading transaction…</p>
      ) : status === "error" ? (
        <p className="text-xs text-destructive">Failed to load transaction: {error}</p>
      ) : status === "notfound" ? (
        <p className="text-xs text-destructive">
          Transaction <span className="font-mono">{hash}</span> was not found in storage.
        </p>
      ) : data ? (
        <TransactionDetail
          transaction={data}
          timeZone={timeZone}
          tokenSymbol={tokenSymbol}
          blockTimeMs={blockTimeMs}
          onLocationChange={onLocationChange}
        />
      ) : null}
    </section>
  );
}

function TransactionDetail({
  transaction,
  timeZone,
  tokenSymbol,
  onLocationChange,
}: {
  transaction: StoredTransaction;
  timeZone: string;
  tokenSymbol: string;
  /** Unused since operations carry their resolved expiry block; kept for callers. */
  blockTimeMs: number;
  onLocationChange: () => void;
}) {
  const status = statusInfo(transaction.status);
  const decoderHref = transactionDecoderHref(transaction.hash);
  const isContractCreation = !transaction.to && Boolean(transaction.contractAddress);
  const operations = transaction.operations ?? [];

  return (
    <div className="relative sm:mt-6">
      <CedricOnTimer />
      <div className="relative z-10 flex flex-col gap-4 border border-border bg-card p-4">
        <div className="flex flex-wrap items-center gap-2 border-b border-border pb-3">
          <StatusBadge tone={status.tone}>{status.label}</StatusBadge>
          <span className="truncate font-mono text-xs text-foreground">{transaction.hash}</span>
          <CopyButton value={transaction.hash} label="transaction hash" />
          {decoderHref ? (
            <a
              className="ml-auto inline-flex items-center gap-1 text-xs text-accent hover:underline"
              href={decoderHref}
              target="_blank"
              rel="noreferrer"
            >
              Decode
              <ExternalLink className="size-3" />
            </a>
          ) : null}
        </div>

        <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
          <section className="flex flex-col gap-1">
            <h3 className="text-[10px] font-medium tracking-wider text-muted-foreground uppercase">Overview</h3>
            <dl className="flex flex-col">
              <Row label="Status">
                <StatusBadge tone={status.tone}>{status.label}</StatusBadge>
              </Row>
              <Row label="Block">
                <span className="inline-flex flex-wrap items-baseline gap-2">
                  <BlockNumberLink blockNumber={transaction.blockNumberDecimal} onLocationChange={onLocationChange} />
                  <span className="text-xs text-muted-foreground">pos {transaction.position}</span>
                </span>
              </Row>
              <Row label="Timestamp" title={transaction.blockDate ?? undefined}>
                {fmtDate(transaction.blockDate, timeZone)}
              </Row>
              <Row label="From">
                <AddressCell address={transaction.from} />
              </Row>
              <Row label={isContractCreation ? "Contract created" : "To"}>
                <AddressCell address={transaction.to ?? transaction.contractAddress} />
              </Row>
              {transaction.to && transaction.contractAddress ? (
                <Row label="Contract">
                  <AddressCell address={transaction.contractAddress} />
                </Row>
              ) : null}
              <Row label="Type">{txTypeLabel(transaction.type)}</Row>
              <Row label="Nonce">{transaction.nonce ?? "—"}</Row>
              <Row label="Value">{fmtTokenAmount(transaction.valueWei, tokenSymbol)}</Row>
            </dl>
          </section>

          <section className="flex flex-col gap-1">
            <h3 className="text-[10px] font-medium tracking-wider text-muted-foreground uppercase">Gas</h3>
            <dl className="flex flex-col">
              <Row label="Gas limit">{fmtInteger(transaction.gasLimit)}</Row>
              <Row label="Gas used (of limit)">{fmtRatio(transaction.gasUsed, transaction.gasLimit)}</Row>
              <Row label="Input data">{fmtBytes(transaction.inputDataSizeBytes)}</Row>
              <Row label="Input data zstd">{fmtBytes(transaction.inputDataCompressedSizeBytes)}</Row>
              <Row label="Cumulative gas">{fmtInteger(transaction.cumulativeGasUsed)}</Row>
            </dl>
          </section>

          <section className="flex flex-col gap-1">
            <h3 className="text-[10px] font-medium tracking-wider text-muted-foreground uppercase">Fees</h3>
            <dl className="flex flex-col">
              <Row label="Transaction fee">{fmtTokenAmount(transaction.transactionFeeWei, tokenSymbol)}</Row>
              <Row label="Effective gas price">{fmtGasPrice(transaction.effectiveGasPriceWei)}</Row>
              <Row label="Base fee">{fmtGasPrice(transaction.baseBlockFeeWei)}</Row>
              <Row label="Priority fee">{fmtGasPrice(transaction.priorityFeeWei)}</Row>
              <Row label="Gas price">{fmtGasPrice(transaction.gasPriceWei)}</Row>
              <Row label="Max fee per gas">{fmtGasPrice(transaction.maxFeePerGasWei)}</Row>
              <Row label="Max priority per gas">{fmtGasPrice(transaction.maxPriorityFeePerGasWei)}</Row>
            </dl>
          </section>
        </div>

        {operations.length > 0 ? (
          <section className="flex flex-col gap-3 border-t border-border pt-4">
            <h3 className="text-[10px] font-medium tracking-wider text-muted-foreground uppercase">
              Arkiv operations ({operations.length})
            </h3>
            {operations.map((operation) => (
              <OperationCard
                key={operation.opIndex}
                operation={operation}
                onLocationChange={onLocationChange}
              />
            ))}
          </section>
        ) : null}
      </div>
    </div>
  );
}

function OperationCard({
  operation,
  onLocationChange,
}: {
  operation: StoredArkivOperation;
  onLocationChange?: () => void;
}) {
  const entityKey =
    operation.entityKey && !isAllZeroBytes32(operation.entityKey) ? operation.entityKey : null;

  return (
    <div className="border border-border p-3">
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <OpBadge operation={operation.operation} />
        <span className="text-xs text-muted-foreground">#{operation.opIndex}</span>
      </div>
      <dl className="flex flex-col">
        <Row label="Entity key">
          {entityKey ? (
            <span className="inline-flex flex-wrap items-baseline gap-1.5">
              <a
                className="truncate font-mono text-foreground transition-colors hover:text-accent hover:underline"
                href={entityDetailHref(entityKey)}
                onClick={(event) => {
                  if (!onLocationChange) return;
                  event.preventDefault();
                  if (writeEntityPermalink(entityKey)) onLocationChange();
                }}
                title="View entity history"
              >
                {entityKey}
              </a>
              <CopyButton value={entityKey} label="entity key" />
            </span>
          ) : (
            "—"
          )}
        </Row>
        {operation.schemaName ? <Row label="Schema">{operation.schemaName}</Row> : null}
        {operation.bytesSize > 0 ? (
          <Row label="Bytes" title={`${fmtInteger(operation.bytesSize)} bytes in bytes attributes (contents are not stored)`}>
            {fmtBytes(operation.bytesSize)}
          </Row>
        ) : null}
        {operation.attributes.length > 0 ? (
          <Row label="Attributes">
            <div className="flex flex-col gap-0.5">
              {operation.attributes.map((attribute, index) => (
                <div key={`${attribute.name}:${index}`} title={`${attribute.type}${attribute.indexed ? ", indexed" : ", stored"}`}>
                  {attribute.name} ={" "}
                  <span className="font-mono">
                    {attribute.type === "tombstone"
                      ? "(unset)"
                      : attribute.value === null
                        ? attribute.keccak256 ?? "—"
                        : String(attribute.value)}
                  </span>
                </div>
              ))}
            </div>
          </Row>
        ) : null}
        {operation.resolvedExpiresAt !== null ? (
          <Row label="Expires">
            {operation.permanent ? "Permanent" : `block ${fmtInteger(operation.resolvedExpiresAt)}`}
          </Row>
        ) : null}
        {operation.newOwner ? (
          <Row label="New owner">
            <AddressCell address={operation.newOwner} />
          </Row>
        ) : null}
      </dl>
    </div>
  );
}

function isAllZeroBytes32(value: string): boolean {
  return /^0x0{64}$/i.test(value.trim());
}

function Row({ label, children, title }: { label: string; children: ReactNode; title?: string }) {
  return (
    <div className="grid grid-cols-[minmax(7rem,9rem)_minmax(0,1fr)] items-baseline gap-2 border-b border-dashed border-border py-1 last:border-0">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className={cn("min-w-0 truncate font-mono text-xs text-foreground")} title={title}>
        {children}
      </dd>
    </div>
  );
}

function statusInfo(status: string | null): { label: string; tone: StatusTone } {
  if (status === "1") return { label: "Success", tone: "ok" };
  if (status === "0") return { label: "Failed", tone: "fail" };
  return { label: status ?? "Unknown", tone: "unknown" };
}

function txTypeLabel(type: string | null): string {
  switch (type) {
    case "0":
      return "Legacy (0)";
    case "1":
      return "Access list (1)";
    case "2":
      return "EIP-1559 (2)";
    case "3":
      return "Blob (3)";
    case "4":
      return "Set code (4)";
    default:
      return type ?? "—";
  }
}

/**
 * In-app link to the transaction detail panel (`/tx/<hash>`). Mirrors
 * BlockNumberLink: renders an anchor with a real href (so middle-click /
 * open-in-new-tab works) while intercepting plain left-clicks for SPA nav.
 */
export function TransactionHashLink({
  hash,
  onLocationChange,
  className = "truncate font-mono text-xs",
  label,
}: {
  hash: string | null | undefined;
  onLocationChange?: () => void;
  className?: string;
  label?: string;
}) {
  const value = hash?.trim() || "";
  const display = label ?? shortHash(value || null);

  if (!value) {
    return (
      <span className={className} title={hash ?? undefined}>
        {display}
      </span>
    );
  }

  const onClick = (event: MouseEvent<HTMLAnchorElement>) => {
    if (!onLocationChange) return;
    event.preventDefault();
    if (writeTransactionPermalink(value)) onLocationChange();
  };

  return (
    <a
      className={cn(className, "text-foreground transition-colors hover:text-accent hover:underline")}
      href={transactionDetailHref(value)}
      onClick={onClick}
      title={hash ?? undefined}
    >
      {display}
    </a>
  );
}

function shortHash(value: string | null | undefined): string {
  if (!value) return "-";
  if (value.length <= 18) return value;
  return `${value.slice(0, 10)}…${value.slice(-8)}`;
}

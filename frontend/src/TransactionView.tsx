import { ExternalLink } from "lucide-react";
import { useEffect, useState, type MouseEvent, type ReactNode } from "react";
import {
  fetchEntityByKey,
  fetchTransactionByHash,
  type StoredArkivOperation,
  type StoredTransaction,
} from "./api";
import {
  applyAttributeMutations,
  fromOperationAttribute,
  isPermanentExpiry,
  summarizeChanges,
  toChecksumAddress,
  withoutSchemaTag,
} from "./attributes";
import { AttributeTable } from "@/components/attribute-table";
import { PermanentBadge, SchemaBadge } from "@/components/entity-badges";
import { findOperationEvent, foldEntityHistory, type EntityHistoryEvent } from "./entityHistory";
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
  fmtExactTokenAmount,
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
}

const TX_HASH_RE = /^0x[0-9a-fA-F]{64}$/;

type LoadStatus = "idle" | "loading" | "loaded" | "notfound" | "error";

export function TransactionView({
  hash,
  onLocationChange,
  timeZone,
  tokenSymbol,
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
  onLocationChange: () => void;
}) {
  const status = statusInfo(transaction.status);
  const decoderHref = transactionDecoderHref(transaction.hash);
  const isContractCreation = !transaction.to && Boolean(transaction.contractAddress);
  const operations = transaction.operations ?? [];
  const failed = transaction.status === "0";
  const histories = useEntityHistories(operations);
  const totalCostWei = transaction.totalCostWei ?? addWei(transaction.transactionFeeWei, transaction.rentFeeWei);

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

        {failed ? (
          <p className="border border-red-600/30 bg-red-600/5 px-3 py-2 text-xs text-red-700 dark:border-red-400/30 dark:text-red-300" role="note">
            The transaction reverted: gas was charged, no rent was, and{" "}
            {operations.length === 0
              ? "it changed no state."
              : operations.length === 1
                ? "its operation changed no entity."
                : `none of its ${operations.length} operations changed any entity.`}
          </p>
        ) : null}

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
            <h3 className="text-[10px] font-medium tracking-wider text-muted-foreground uppercase">Cost</h3>
            <dl className="flex flex-col">
              <Row label="Gas fee" title={`${fmtExactTokenAmount(transaction.transactionFeeWei, tokenSymbol)}: gasUsed × effective gas price`}>
                {fmtTokenAmount(transaction.transactionFeeWei, tokenSymbol)}
              </Row>
              <Row
                label="Rent"
                title={`${fmtExactTokenAmount(transaction.rentFeeWei, tokenSymbol)}: storage rent, burned from the sender's balance outside gas and the gas limit (receipt rentFee)`}
              >
                {failed ? (
                  <span className="text-muted-foreground">none — gas charged, no rent</span>
                ) : (
                  <span>
                    {fmtTokenAmount(transaction.rentFeeWei, tokenSymbol)}
                    <span className="ml-1.5 text-[10px] text-muted-foreground">outside gas</span>
                  </span>
                )}
              </Row>
              <Row label="Total cost" title={`${fmtExactTokenAmount(totalCostWei, tokenSymbol)}: gas fee + rent`}>
                <span className="font-semibold">{fmtTokenAmount(totalCostWei, tokenSymbol)}</span>
              </Row>
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
                transaction={transaction}
                failed={failed}
                history={operation.entityKey ? histories.get(operation.entityKey.toLowerCase()) : undefined}
                onLocationChange={onLocationChange}
              />
            ))}
          </section>
        ) : null}
      </div>
    </div>
  );
}

/** What the entity's stored history says an operation did; undefined while loading or unavailable. */
type HistoryState = { status: "loading" } | { status: "loaded"; events: EntityHistoryEvent[] } | { status: "failed"; error: string };

/** Operations that need the entity's earlier state to be shown as a change. */
const NEEDS_HISTORY = new Set(["patch", "extend", "transfer"]);
/** A transaction with more distinct entities than this shows their patches without old values. */
const MAX_HISTORY_FETCHES = 24;

/**
 * Fetches and folds the stored history of every entity the transaction
 * patches, extends or transfers, so the cards can say old → new.
 */
function useEntityHistories(operations: readonly StoredArkivOperation[]): Map<string, HistoryState> {
  const keys = [
    ...new Set(
      operations
        .filter((operation) => NEEDS_HISTORY.has(operation.operation) && operation.entityKey && !isAllZeroBytes32(operation.entityKey))
        .map((operation) => operation.entityKey!.toLowerCase()),
    ),
  ].slice(0, MAX_HISTORY_FETCHES);
  const signature = keys.join(",");
  const [histories, setHistories] = useState<Map<string, HistoryState>>(new Map());

  useEffect(() => {
    if (keys.length === 0) {
      setHistories(new Map());
      return;
    }
    let cancelled = false;
    setHistories(new Map(keys.map((key) => [key, { status: "loading" } as HistoryState])));
    for (const key of keys) {
      fetchEntityByKey(key)
        .then((body) => {
          if (cancelled) return;
          const state: HistoryState = body
            ? {
                status: "loaded",
                events: foldEntityHistory({
                  genesis: body.genesis ?? null,
                  operations: body.operations,
                  truncated: body.truncated ?? false,
                  currentVersion: body.state?.version ?? null,
                }),
              }
            : { status: "failed", error: "no stored history" };
          setHistories((previous) => new Map(previous).set(key, state));
        })
        .catch((error: Error) => {
          if (!cancelled) setHistories((previous) => new Map(previous).set(key, { status: "failed", error: error.message }));
        });
    }
    return () => {
      cancelled = true;
    };
    // `signature` stands for `keys`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signature]);

  return histories;
}

function OperationCard({
  operation,
  transaction,
  failed,
  history,
  onLocationChange,
}: {
  operation: StoredArkivOperation;
  transaction: StoredTransaction;
  failed: boolean;
  history: HistoryState | undefined;
  onLocationChange: () => void;
}) {
  const entityKey =
    operation.entityKey && !isAllZeroBytes32(operation.entityKey) ? operation.entityKey : null;
  const event = history?.status === "loaded" ? findOperationEvent(history.events, transaction.hash, operation.opIndex) : null;
  const mutations = operation.attributes.map(fromOperationAttribute);
  const blockNumber = Number(transaction.blockNumberDecimal);
  const bytesSource = { entityKey, atBlock: Number.isSafeInteger(blockNumber) ? blockNumber : undefined };
  // A failed operation's values never reached the chain, so there is nothing to query by.
  const actions = failed ? undefined : { onLocationChange };
  const kind = event ? (event.kind === "failed" ? event.attemptedKind : event.kind) : null;

  return (
    <div className={cn("border border-border p-3", failed && "border-dashed")}>
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <OpBadge operation={operation.operation} />
        <span className="text-xs text-muted-foreground">#{operation.opIndex}</span>
        {kind === "extended-to-permanent" ? <span className="text-xs font-medium text-violet-700 dark:text-violet-300">extended to permanent</span> : null}
        {operation.schemaName ? <SchemaBadge name={operation.schemaName} actions={{ onLocationChange }} /> : null}
        {failed ? <StatusBadge tone="fail">not applied</StatusBadge> : null}
      </div>
      <dl className="flex flex-col">
        <Row label="Entity key">
          {entityKey ? (
            <span className="inline-flex flex-wrap items-baseline gap-1.5">
              <a
                className="truncate font-mono text-foreground transition-colors hover:text-accent hover:underline"
                href={entityDetailHref(entityKey)}
                onClick={(event) => {
                  event.preventDefault();
                  if (writeEntityPermalink(entityKey)) onLocationChange();
                }}
                title="View entity history"
              >
                {entityKey}
              </a>
              <CopyButton value={entityKey} label="entity key" />
            </span>
          ) : operation.operation === "create" && failed ? (
            <span className="text-muted-foreground">none — the create did not apply</span>
          ) : (
            "—"
          )}
        </Row>
        {operation.operation === "create" ? (
          <>
            {operation.salt !== null ? <Row label="Salt" title="uint128 salt, decimal">{operation.salt}</Row> : null}
            <Row label="Flags">{describeCreationFlags(operation.creationFlags)}</Row>
          </>
        ) : null}
        {operation.resolvedExpiresAt !== null ? (
          <Row
            label="Expires"
            title={`Requested expiresAt ${operation.expiresAt ?? "—"}, minLifetime ${operation.minLifetime ?? "—"}; resolved max(expiresAt, block + minLifetime)`}
          >
            <ExpiryChange
              before={operation.operation === "extend" ? event?.expiresBefore ?? null : null}
              after={operation.resolvedExpiresAt}
              permanent={operation.permanent === true}
              onLocationChange={onLocationChange}
            />
          </Row>
        ) : null}
        {operation.newOwner ? (
          <Row label="New owner">
            <span className="inline-flex items-center gap-1.5">
              <AddressCell address={toChecksumAddress(operation.newOwner)} />
              {event?.ownerBefore ? <span className="text-[11px] text-muted-foreground">from {shortAddress(event.ownerBefore)}</span> : null}
            </span>
          </Row>
        ) : null}
        {operation.bytesSize > 0 ? (
          <Row label="Bytes" title={`${fmtInteger(operation.bytesSize)} bytes in bytes attributes (the index keeps sizes and hashes, never contents)`}>
            {fmtBytes(operation.bytesSize)}
          </Row>
        ) : null}
      </dl>
      {operation.operation === "create" ? (
        <div className="mt-3">
          <h4 className="mb-1 text-[10px] font-medium tracking-wider text-muted-foreground uppercase">Attributes ({withoutSchemaTag(mutations).length})</h4>
          <AttributeTable attributes={withoutSchemaTag(mutations)} actions={actions} bytes={bytesSource} onLocationChange={onLocationChange} />
        </div>
      ) : operation.operation === "patch" ? (
        <div className="mt-3">
          <h4 className="mb-1 flex flex-wrap items-baseline gap-2 text-[10px] font-medium tracking-wider text-muted-foreground uppercase">
            <span>{failed ? "Attempted changes" : "Changes"} ({mutations.length})</span>
            <span className="normal-case tracking-normal">
              {event ? summarizeChanges(event.changes) : history?.status === "loading" ? "loading the previous values…" : "previous values unavailable"}
            </span>
          </h4>
          <AttributeTable
            changes={event ? event.changes : applyAttributeMutations(null, mutations).changes}
            actions={actions}
            bytes={bytesSource}
            onLocationChange={onLocationChange}
          />
        </div>
      ) : null}
    </div>
  );
}

function ExpiryChange({
  before,
  after,
  permanent,
  onLocationChange,
}: {
  before: string | null;
  after: string;
  permanent: boolean;
  onLocationChange: () => void;
}) {
  const show = (value: string, isPermanent: boolean) =>
    isPermanent ? <PermanentBadge /> : <span>block <BlockNumberLink blockNumber={value} onLocationChange={onLocationChange} /></span>;
  return (
    <span className="inline-flex flex-wrap items-center gap-1.5">
      {before !== null && before !== after ? (
        <>
          <span className="text-muted-foreground">{show(before, isPermanentExpiry(before))}</span>
          <span className="text-muted-foreground">→</span>
        </>
      ) : null}
      {show(after, permanent || isPermanentExpiry(after))}
    </span>
  );
}

function describeCreationFlags(flags: number | null): string {
  if (flags === null) return "—";
  const names: string[] = [];
  if (flags & 1) names.push("readonly");
  if (flags & 2) names.push("permissionless extension");
  const rest = flags & ~3;
  if (rest) names.push(`other bits 0x${rest.toString(16)}`);
  return names.length > 0 ? names.join(", ") : "none";
}

function addWei(a: string | null | undefined, b: string | null | undefined): string {
  try {
    return (BigInt(a ?? "0") + BigInt(b ?? "0")).toString();
  } catch {
    return a ?? "0";
  }
}

function shortAddress(value: string): string {
  const checksum = toChecksumAddress(value);
  return checksum.length > 18 ? `${checksum.slice(0, 8)}…${checksum.slice(-6)}` : checksum;
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

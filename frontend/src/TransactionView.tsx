import { useEffect, useState, type MouseEvent, type ReactNode } from "react";
import { fetchTransactionByHash, type ArkivOperation, type StoredTransaction } from "./api";
import { AddressCell } from "./TransactionsView";
import { BlockNumberLink } from "./blockLinks";
import { fmtBytes, fmtDate, fmtDurationSeconds, fmtEth, fmtGwei, fmtInteger, fmtRatio } from "./format";
import { transactionDetailHref, writeTransactionPermalink } from "./permalinks";
import { transactionExplorerHref } from "./transactionLinks";

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
    <section className="view transaction-view">
      <h2>Transaction</h2>

      <form onSubmit={onSubmit} className="tx-lookup-form">
        <input
          type="text"
          inputMode="text"
          spellCheck={false}
          autoComplete="off"
          placeholder="0x… transaction hash"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        <button type="submit">Look up</button>
      </form>
      {formError ? <p className="summary error">{formError}</p> : null}

      {!hash ? (
        <p className="summary">Enter a transaction hash above to view its details.</p>
      ) : status === "loading" ? (
        <p className="summary">Loading transaction…</p>
      ) : status === "error" ? (
        <p className="summary error">Failed to load transaction: {error}</p>
      ) : status === "notfound" ? (
        <p className="summary error">
          Transaction <span className="mono">{hash}</span> was not found in storage.
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
  blockTimeMs,
  onLocationChange,
}: {
  transaction: StoredTransaction;
  timeZone: string;
  tokenSymbol: string;
  blockTimeMs: number;
  onLocationChange: () => void;
}) {
  const status = statusInfo(transaction.status);
  const explorerHref = transactionExplorerHref(transaction.hash);
  const isContractCreation = !transaction.to && Boolean(transaction.contractAddress);
  const operations = transaction.operations ?? [];

  return (
    <div className="tx-detail-card">
      <div className="tx-detail-topline">
        <span className={`tx-status-badge ${status.tone}`}>{status.label}</span>
        <span className="tx-detail-hash mono">{transaction.hash}</span>
        <CopyButton value={transaction.hash} label="transaction hash" />
        {explorerHref ? (
          <a className="tx-explorer-link" href={explorerHref} target="_blank" rel="noreferrer">
            Explorer ↗
          </a>
        ) : null}
      </div>

      <div className="tx-detail-groups">
        <section className="tx-detail-group">
          <h3>Overview</h3>
          <dl className="tx-detail-grid">
            <Row label="Status">
              <span className={`tx-status-badge ${status.tone}`}>{status.label}</span>
            </Row>
            <Row label="Block">
              <span className="tx-inline">
                <BlockNumberLink
                  blockNumber={transaction.blockNumberDecimal}
                  onLocationChange={onLocationChange}
                />
                <span className="tx-muted">pos {transaction.position}</span>
              </span>
            </Row>
            <Row label="Timestamp" title={transaction.blockDate}>
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
            <Row label={`Value (${tokenSymbol})`}>{fmtEth(transaction.valueWei)}</Row>
          </dl>
        </section>

        <section className="tx-detail-group">
          <h3>Gas</h3>
          <dl className="tx-detail-grid">
            <Row label="Gas limit">{fmtInteger(transaction.gasLimit)}</Row>
            <Row label="Gas used (of limit)">{fmtRatio(transaction.gasUsed, transaction.gasLimit)}</Row>
            <Row label="Input data">{fmtBytes(transaction.inputDataSizeBytes)}</Row>
            <Row label="Input data zstd">{fmtBytes(transaction.inputDataCompressedSizeBytes)}</Row>
            <Row label="Cumulative gas">{fmtInteger(transaction.cumulativeGasUsed)}</Row>
          </dl>
        </section>

        <section className="tx-detail-group">
          <h3>Fees</h3>
          <dl className="tx-detail-grid">
            <Row label={`Transaction fee (${tokenSymbol})`}>{fmtEth(transaction.transactionFeeWei)}</Row>
            <Row label="Effective gas price">{gwei(transaction.effectiveGasPriceWei)}</Row>
            <Row label="Base fee">{gwei(transaction.baseBlockFeeWei)}</Row>
            <Row label="Priority fee">{gwei(transaction.priorityFeeWei)}</Row>
            <Row label="Gas price">{gwei(transaction.gasPriceWei)}</Row>
            <Row label="Max fee per gas">{gwei(transaction.maxFeePerGasWei)}</Row>
            <Row label="Max priority per gas">{gwei(transaction.maxPriorityFeePerGasWei)}</Row>
          </dl>
        </section>
      </div>

      {operations.length > 0 ? (
        <section className="tx-detail-group tx-detail-operations">
          <h3>Arkiv operations ({operations.length})</h3>
          {operations.map((operation) => (
            <OperationCard key={operation.opIndex} operation={operation} blockTimeMs={blockTimeMs} />
          ))}
        </section>
      ) : null}
    </div>
  );
}

function OperationCard({ operation, blockTimeMs }: { operation: ArkivOperation; blockTimeMs: number }) {
  const entityKey =
    operation.entityKey && !isAllZeroBytes32(operation.entityKey) ? operation.entityKey : null;
  const expirySeconds = (operation.expiresAtBlocks * blockTimeMs) / 1000;

  return (
    <div className="op-card">
      <div className="op-card-head">
        <span className={`op-badge op-${operation.operation}`}>{operation.operation}</span>
        <span className="tx-muted">#{operation.opIndex}</span>
      </div>
      <dl className="tx-detail-grid">
        <Row label="Entity key">
          {entityKey ? (
            <span className="tx-inline">
              <span className="mono">{entityKey}</span>
              <CopyButton value={entityKey} label="entity key" />
            </span>
          ) : (
            "—"
          )}
        </Row>
        <Row label="Content type">{operation.contentType ?? "—"}</Row>
        <Row label="Payload size" title={`${fmtInteger(operation.payloadSizeBytes)} bytes`}>
          {fmtBytes(operation.payloadSizeBytes)}
        </Row>
        {operation.attributes.length > 0 ? (
          <Row label="Attributes">
            <div className="op-attributes">
              {operation.attributes.map((attribute, index) => (
                <div key={`${attribute.key}:${index}`} title={attribute.valueTypeName}>
                  {attribute.key} = <span className="mono">{attribute.value}</span>
                </div>
              ))}
            </div>
          </Row>
        ) : null}
        {operation.expiresAtBlocks > 0 ? (
          <Row label="Expires">
            {fmtInteger(operation.expiresAtBlocks)} blocks (~{fmtDurationSeconds(expirySeconds)})
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
    <div className="tx-detail-row">
      <dt className="tx-detail-label">{label}</dt>
      <dd className="tx-detail-value" title={title}>
        {children}
      </dd>
    </div>
  );
}

/** Render a wei value in gwei with a trailing unit, or an em dash when absent. */
function gwei(weiStr: string | null | undefined): string {
  if (weiStr === undefined || weiStr === null) return "—";
  return `${fmtGwei(weiStr)} gwei`;
}

function statusInfo(status: string | null): { label: string; tone: "ok" | "fail" | "unknown" } {
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

function CopyButton({ value, label }: { value: string; label: string }) {
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return;
    const timeout = window.setTimeout(() => setCopied(false), 1200);
    return () => window.clearTimeout(timeout);
  }, [copied]);

  const onCopy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
    } catch {
      // Clipboard unavailable (e.g. insecure context) — silently ignore.
    }
  };

  return (
    <button
      type="button"
      className="copy-cell-button"
      aria-label={`Copy ${label}`}
      title={copied ? "Copied" : `Copy ${label}`}
      onClick={onCopy}
    >
      <span aria-hidden="true" className="copy-cell-icon">
        {copied ? (
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
            <path d="M20 6 9 17l-5-5" />
          </svg>
        ) : (
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <rect x="9" y="9" width="11" height="11" rx="2" />
            <path d="M5 15a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2" />
          </svg>
        )}
      </span>
    </button>
  );
}

/**
 * In-app link to the transaction detail panel (`/tx/<hash>`). Mirrors
 * BlockNumberLink: renders an anchor with a real href (so middle-click /
 * open-in-new-tab works) while intercepting plain left-clicks for SPA nav.
 */
export function TransactionHashLink({
  hash,
  onLocationChange,
  className = "mono truncate",
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
      className={`${className} block-link`}
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

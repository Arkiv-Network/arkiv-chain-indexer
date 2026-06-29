import { useEffect, useState, type MouseEvent, type ReactNode } from "react";
import {
  fetchTransactionByHash,
  type ArkivOperation,
  type ArkivReferenceVerification,
  type PayloadProviderPaymentBreakdown,
  type StoredTransaction,
} from "./api";
import { AddressCell } from "./TransactionsView";
import { AddressFace } from "./AddressFace";
import { BlockNumberLink } from "./blockLinks";
import { CedricOnTimer } from "./Cedric";
import { fmtBytes, fmtDate, fmtDurationSeconds, fmtEth, fmtGwei, fmtInteger, fmtRatio } from "./format";
import { PageBreadcrumbs } from "./PageBreadcrumbs";
import { transactionDetailHref, writeTransactionPermalink } from "./permalinks";
import { payloadInfoHref, transactionDecoderHref } from "./transactionLinks";

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
      <div className="page-heading">
        <PageBreadcrumbs
          items={[
            { view: "home", label: "Home" },
            { view: "blocks", label: "Block list" },
            { view: "transaction", label: "Transaction details" },
          ]}
          onLocationChange={onLocationChange}
        />
        <h2>Transaction</h2>
      </div>

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
  const decoderHref = transactionDecoderHref(transaction.hash);
  const isContractCreation = !transaction.to && Boolean(transaction.contractAddress);
  const operations = transaction.operations ?? [];
  const payloadProviderPayments = transaction.payloadProviderPayments ?? null;

  return (
    <div className="tx-cedric-card-wrap">
      <CedricOnTimer />
      <div className="tx-detail-card">
      <div className="tx-detail-topline">
        <span className={`tx-status-badge ${status.tone}`}>{status.label}</span>
        <span className="tx-detail-hash mono">{transaction.hash}</span>
        <CopyButton value={transaction.hash} label="transaction hash" />
        {decoderHref ? (
          <a className="tx-explorer-link" href={decoderHref} target="_blank" rel="noreferrer">
            Decode ↗
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
          {payloadProviderPayments ? (
            <PayloadProviderPaymentsPanel
              payments={payloadProviderPayments}
              tokenSymbol={tokenSymbol}
            />
          ) : null}
          {operations.map((operation) => (
            <OperationCard key={operation.opIndex} operation={operation} blockTimeMs={blockTimeMs} />
          ))}
        </section>
      ) : null}
      </div>
    </div>
  );
}

function PayloadProviderPaymentsPanel({
  payments,
  tokenSymbol,
}: {
  payments: PayloadProviderPaymentBreakdown;
  tokenSymbol: string;
}) {
  const sourceLabel =
    payments.source === "protocolSchedule"
      ? "protocol schedule"
      : payments.source === "configuredShareBps"
        ? "configured split"
        : "split unavailable";
  const splitLabel =
    payments.providerShareBps === null ? "—" : `${(payments.providerShareBps / 100).toFixed(2)}%`;

  return (
    <div className="payload-payment-panel">
      <div className="payload-payment-head">
        <div>
          <h4>Payload provider payments</h4>
          <p>
            {payments.entries.length} reference payment
            {payments.entries.length === 1 ? "" : "s"} - {sourceLabel}
          </p>
        </div>
        <span className={`tx-status-badge ${payments.enabled ? "ok" : "unknown"}`}>
          {payments.enabled ? "enabled" : "not active"}
        </span>
      </div>
      <dl className="payload-payment-totals">
        <Row label="Signed payment">
          {paymentValue(payments.totalPaymentWei, tokenSymbol)}
          {payments.totalPaymentGasUnits ? ` (${fmtInteger(payments.totalPaymentGasUnits)} gas units)` : ""}
        </Row>
        <Row label="Provider share">{splitLabel}</Row>
        <Row label="Provider earned">{paymentValue(payments.totalProviderEarnedWei, tokenSymbol)}</Row>
        <Row label="Burned">{paymentValue(payments.totalBurnedWei, tokenSymbol)}</Row>
        <Row label="Minimum payment">
          {payments.minimumPaymentWei === null
            ? "—"
            : `${paymentValue(payments.minimumPaymentWei, tokenSymbol)}${
                payments.minimumPaymentGasUnits ? ` (${fmtInteger(payments.minimumPaymentGasUnits)} gas units)` : ""
              }`}
        </Row>
      </dl>

      <div className="payload-payment-providers">
        {payments.providers.map((provider) => (
          <div
            className="payload-payment-provider"
            key={`${provider.provider}:${provider.signer ?? ""}`}
          >
            <div>
              <strong>{provider.provider}</strong>
              <span>{provider.paymentCount} payment{provider.paymentCount === 1 ? "" : "s"}</span>
            </div>
            {provider.signer ? <AddressCell address={provider.signer} /> : <span>—</span>}
            <div>{paymentValue(provider.providerEarnedWei, tokenSymbol)}</div>
            <div className="tx-muted">burn {paymentValue(provider.burnedWei, tokenSymbol)}</div>
          </div>
        ))}
      </div>

      <div className="payload-payment-entries">
        {payments.entries.map((entry) => (
          <div className="payload-payment-entry" key={`${entry.opIndex}:${entry.payloadId}`}>
            <span className="tx-muted">op #{entry.opIndex}</span>
            <span className="mono truncate">{entry.payloadId}</span>
            <span>{paymentValue(entry.providerEarnedWei, tokenSymbol)}</span>
            <span className="tx-muted">burn {paymentValue(entry.burnedWei, tokenSymbol)}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function OperationCard({ operation, blockTimeMs }: { operation: ArkivOperation; blockTimeMs: number }) {
  const entityKey =
    operation.entityKey && !isAllZeroBytes32(operation.entityKey) ? operation.entityKey : null;
  const expirySeconds = (operation.expiresAtBlocks * blockTimeMs) / 1000;
  const reference = operation.payloadReference ?? null;
  const verification = operation.referenceVerification ?? null;
  const verdict = verification ? referenceVerdict(verification) : null;
  const payloadHref = reference ? payloadInfoHref(reference.id) : null;

  return (
    <div className="op-card">
      <div className="op-card-head">
        <span className={`op-badge op-${operation.operation}`}>{operation.operation}</span>
        {operation.isReference ? <span className="op-badge op-reference">reference</span> : null}
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
        {verdict ? (
          <Row label="Verification">
            <div className="op-verification">
              <span className={`tx-status-badge ${verdict.tone}`}>{verdict.label}</span>
              {verification && verification.errors.length > 0 ? (
                <div className="op-verification-errors">
                  {verification.errors.map((error, index) => (
                    <div key={index}>{error}</div>
                  ))}
                </div>
              ) : null}
            </div>
          </Row>
        ) : null}
        {operation.referenceError ? (
          <Row label="Reference">
            <span className="tx-status-badge fail">{operation.referenceError}</span>
          </Row>
        ) : null}
        {reference ? (
          <>
            <Row label="Provider">
              <span className="tx-inline">
                {verification?.recoveredSigner ? (
                  <AddressFace
                    address={verification.recoveredSigner}
                    width={18}
                    height={18}
                    className="op-provider-face"
                    alt=""
                    title={`Signer identicon for ${verification.recoveredSigner}`}
                  />
                ) : null}
                <span>{reference.provider}</span>
              </span>
            </Row>
            <Row label="Payload id">
              <span className="tx-inline">
                {payloadHref ? (
                  <a
                    className="mono truncate"
                    href={payloadHref}
                    target="_blank"
                    rel="noreferrer"
                    title="View payload info on the payload provider"
                  >
                    {reference.id}
                  </a>
                ) : (
                  <span className="mono truncate">{reference.id}</span>
                )}
                <CopyButton value={reference.id} label="payload id" />
              </span>
            </Row>
            <Row label="Namespace">{reference.namespace}</Row>
            <Row label="Checksum">
              <span className="mono truncate">{reference.checksum}</span>
            </Row>
            <Row label="Reference size" title={`${fmtInteger(reference.sizeBytes)} bytes`}>
              {fmtBytes(reference.sizeBytes)}
            </Row>
            {verification?.recoveredSigner ? (
              <Row label="Signer">
                <AddressCell address={verification.recoveredSigner} />
              </Row>
            ) : null}
          </>
        ) : null}
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

function paymentValue(wei: string, tokenSymbol: string): string {
  return `${fmtInteger(wei)} wei (${fmtEth(wei)} ${tokenSymbol})`;
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

/**
 * Map a reference verification verdict to a badge label/tone. `valid` already
 * implies the signer is trusted (the decoder records an untrusted signer as an
 * error that fails the verdict), so an untrusted signer surfaces under `fail`.
 */
function referenceVerdict(
  verification: ArkivReferenceVerification,
): { label: string; tone: "ok" | "fail" } {
  if (verification.valid) return { label: "Verified", tone: "ok" };
  if (!verification.signerTrusted) return { label: "Untrusted signer", tone: "fail" };
  return { label: "Invalid", tone: "fail" };
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

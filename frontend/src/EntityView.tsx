import { useEffect, useState, type ReactNode } from "react";
import { fetchEntityByKey, type StoredEntityOperation } from "./api";
import { BlockNumberLink } from "./blockLinks";
import { fmtBytes, fmtDate, fmtDurationSeconds, fmtInteger } from "./format";
import { PageBreadcrumbs } from "./PageBreadcrumbs";
import { writeEntityPermalink } from "./permalinks";
import { AddressCell } from "./TransactionsView";
import { CopyButton, TransactionHashLink } from "./TransactionView";

interface EntityViewProps {
  entityKey: string | null;
  onLocationChange: () => void;
  timeZone: string;
  blockTimeMs: number;
}

const ENTITY_KEY_RE = /^0x[0-9a-fA-F]{64}$/;

type LoadStatus = "idle" | "loading" | "loaded" | "notfound" | "error";

export function EntityView({ entityKey, onLocationChange, timeZone, blockTimeMs }: EntityViewProps) {
  const [query, setQuery] = useState(entityKey ?? "");
  const [formError, setFormError] = useState<string | null>(null);
  const [operations, setOperations] = useState<StoredEntityOperation[]>([]);
  const [status, setStatus] = useState<LoadStatus>("idle");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setQuery(entityKey ?? "");
    setFormError(null);
  }, [entityKey]);

  useEffect(() => {
    if (!entityKey) {
      setOperations([]);
      setStatus("idle");
      setError(null);
      return;
    }

    let cancelled = false;
    setStatus("loading");
    setError(null);
    setOperations([]);
    fetchEntityByKey(entityKey)
      .then((body) => {
        if (cancelled) return;
        if (!body || body.operations.length === 0) {
          setStatus("notfound");
          return;
        }
        setOperations(body.operations);
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
  }, [entityKey]);

  const onSubmit = (event: React.FormEvent) => {
    event.preventDefault();
    const value = query.trim();
    if (!ENTITY_KEY_RE.test(value)) {
      setFormError("Enter a 0x-prefixed 32-byte entity key (66 characters).");
      return;
    }
    setFormError(null);
    if (value.toLowerCase() === (entityKey ?? "").toLowerCase()) return;
    if (writeEntityPermalink(value)) onLocationChange();
  };

  return (
    <section className="view entity-view">
      <div className="page-heading">
        <PageBreadcrumbs
          items={[
            { view: "home", label: "Home" },
            { view: "entity", label: "Entity details" },
          ]}
          onLocationChange={onLocationChange}
        />
        <h2>Entity</h2>
      </div>

      <form onSubmit={onSubmit} className="tx-lookup-form">
        <input
          type="text"
          inputMode="text"
          spellCheck={false}
          autoComplete="off"
          placeholder="0x… entity key"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        <button type="submit">Look up</button>
      </form>
      {formError ? <p className="summary error">{formError}</p> : null}

      {!entityKey ? (
        <p className="summary">
          Enter an entity key above to view the entity and its operation history.
        </p>
      ) : status === "loading" ? (
        <EntityDetailSkeleton />
      ) : status === "error" ? (
        <p className="summary error">Failed to load entity history: {error}</p>
      ) : status === "notfound" ? (
        <p className="summary error">
          No operations for entity <span className="mono">{entityKey}</span> were found in storage.
          Blocks scanned before entity keys were indexed may not be linked to their entity yet.
        </p>
      ) : operations.length > 0 ? (
        <EntityDetail
          entityKey={entityKey}
          operations={operations}
          timeZone={timeZone}
          blockTimeMs={blockTimeMs}
          onLocationChange={onLocationChange}
        />
      ) : null}
    </section>
  );
}

function EntityDetail({
  entityKey,
  operations,
  timeZone,
  blockTimeMs,
  onLocationChange,
}: {
  entityKey: string;
  operations: StoredEntityOperation[];
  timeZone: string;
  blockTimeMs: number;
  onLocationChange: () => void;
}) {
  // Operations arrive in chain order (block, position, op index ascending).
  const created = operations.find((operation) => operation.operation === "create") ?? null;
  const latest = operations[operations.length - 1]!;
  const lifecycle = lifecycleInfo(latest);
  const newestFirst = [...operations].reverse();
  const latestContent = newestFirst.find((operation) => operation.contentType !== null) ?? null;
  const latestExpiry = newestFirst.find((operation) => operation.expiresAtBlocks > 0) ?? null;
  const lastTransfer = newestFirst.find((operation) => operation.newOwner !== null) ?? null;

  return (
    <div className="tx-detail-card">
      <div className="tx-detail-topline">
        <span className={`tx-status-badge ${lifecycle.tone}`}>{lifecycle.label}</span>
        <span className="tx-detail-hash mono">{entityKey}</span>
        <CopyButton value={entityKey} label="entity key" />
      </div>

      <div className="tx-detail-groups">
        <section className="tx-detail-group">
          <h3>Overview</h3>
          <dl className="tx-detail-grid">
            <Row label="Status">
              <span className={`tx-status-badge ${lifecycle.tone}`}>{lifecycle.label}</span>
            </Row>
            <Row label="Operations">{fmtInteger(operations.length)}</Row>
            {latestContent?.contentType ? (
              <Row label="Content type">{latestContent.contentType}</Row>
            ) : null}
            {latestContent && latestContent.payloadSizeBytes > 0 ? (
              <Row
                label="Payload"
                title={`${fmtInteger(latestContent.payloadSizeBytes)} bytes, from the ${latestContent.operation} in block ${latestContent.blockNumberDecimal}`}
              >
                {fmtBytes(latestContent.payloadSizeBytes)}
              </Row>
            ) : null}
            {lastTransfer?.newOwner ? (
              <Row label="Owner (last transfer)">
                <AddressCell address={lastTransfer.newOwner} />
              </Row>
            ) : null}
          </dl>
        </section>

        <section className="tx-detail-group">
          <h3>Created</h3>
          {created ? (
            <dl className="tx-detail-grid">
              <Row label="Block">
                <BlockNumberLink
                  blockNumber={created.blockNumberDecimal}
                  onLocationChange={onLocationChange}
                />
              </Row>
              <Row label="Date" title={created.blockDate}>
                {fmtDate(created.blockDate, timeZone)}
              </Row>
              <Row label="Transaction">
                <TransactionHashLink hash={created.hash} onLocationChange={onLocationChange} />
              </Row>
            </dl>
          ) : (
            <p className="tx-detail-note">
              The create operation is outside the stored history — older than the scanned range or
              not yet linked to this key.
            </p>
          )}
        </section>

        <section className="tx-detail-group">
          <h3>Last activity</h3>
          <dl className="tx-detail-grid">
            <Row label="Operation">
              <span className="op-badge-list">
                <span className={`op-badge op-${latest.operation}`}>{latest.operation}</span>
                {latest.isReference ? (
                  <span className="op-badge op-reference">reference</span>
                ) : null}
              </span>
            </Row>
            <Row label="Date" title={latest.blockDate}>
              {fmtDate(latest.blockDate, timeZone)}
            </Row>
            <Row label="Block">
              <BlockNumberLink
                blockNumber={latest.blockNumberDecimal}
                onLocationChange={onLocationChange}
              />
            </Row>
            <Row label="Transaction">
              <TransactionHashLink hash={latest.hash} onLocationChange={onLocationChange} />
            </Row>
            {latestExpiry ? (
              <Row
                label="Expires"
                title={`Set by the ${latestExpiry.operation} in block ${latestExpiry.blockNumberDecimal}`}
              >
                {fmtInteger(latestExpiry.expiresAtBlocks)} blocks (~
                {fmtDurationSeconds((latestExpiry.expiresAtBlocks * blockTimeMs) / 1000)}) from block{" "}
                {latestExpiry.blockNumberDecimal}
              </Row>
            ) : null}
          </dl>
        </section>
      </div>

      <section className="tx-detail-group tx-detail-operations">
        <h3>Operation history ({operations.length})</h3>
        <div className="table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <th>Block</th>
                <th>Date</th>
                <th>Transaction</th>
                <th>Op</th>
                <th>Operation</th>
                <th>Content type</th>
                <th>Payload</th>
                <th>Expires</th>
                <th>New owner</th>
              </tr>
            </thead>
            <tbody>
              {operations.map((operation) => (
                <tr key={`${operation.blockNumberDecimal}:${operation.position}:${operation.opIndex}`}>
                  <td>
                    <BlockNumberLink
                      blockNumber={operation.blockNumberDecimal}
                      onLocationChange={onLocationChange}
                    />
                  </td>
                  <td title={operation.blockDate}>{fmtDate(operation.blockDate, timeZone)}</td>
                  <td>
                    <TransactionHashLink hash={operation.hash} onLocationChange={onLocationChange} />
                  </td>
                  <td>#{operation.opIndex}</td>
                  <td>
                    <span className={`op-badge op-${operation.operation}`}>{operation.operation}</span>
                    {operation.isReference ? (
                      <span className="op-badge op-reference">reference</span>
                    ) : null}
                  </td>
                  <td>{operation.contentType ?? "—"}</td>
                  <td title={`${fmtInteger(operation.payloadSizeBytes)} bytes`}>
                    {operation.payloadSizeBytes > 0 ? fmtBytes(operation.payloadSizeBytes) : "—"}
                  </td>
                  <td>
                    {operation.expiresAtBlocks > 0
                      ? `${fmtInteger(operation.expiresAtBlocks)} blocks`
                      : "—"}
                  </td>
                  <td>{operation.newOwner ? <AddressCell address={operation.newOwner} /> : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}

/**
 * Lifecycle badge derived from the newest stored operation: a trailing delete
 * means the entity is gone; a trailing expire means the chain reaped it;
 * anything else leaves it active as far as the stored history knows.
 */
function lifecycleInfo(latest: StoredEntityOperation): {
  label: string;
  tone: "ok" | "fail" | "unknown";
} {
  if (latest.operation === "delete") return { label: "Deleted", tone: "fail" };
  if (latest.operation === "expire") return { label: "Expired", tone: "fail" };
  return { label: "Active", tone: "ok" };
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

/**
 * Placeholder with the same card silhouette as EntityDetail so the page keeps
 * its shape while the history loads, instead of collapsing to a one-line
 * message and jumping when the data arrives.
 */
function EntityDetailSkeleton() {
  return (
    <div className="tx-detail-card detail-skeleton" role="status" aria-label="Loading entity history">
      <span className="visually-hidden">Loading entity history…</span>
      <div aria-hidden="true">
        <div className="tx-detail-topline">
          <span className="skeleton-bar skeleton-badge" />
          <span className="skeleton-bar skeleton-hash" />
        </div>
        <div className="tx-detail-groups">
          {[4, 3, 4].map((rows, group) => (
            <section key={group} className="tx-detail-group">
              <h3>
                <span className="skeleton-bar skeleton-title" />
              </h3>
              <div className="tx-detail-grid">
                {Array.from({ length: rows }, (_, row) => (
                  <div key={row} className="tx-detail-row">
                    <span className="tx-detail-label">
                      <span className="skeleton-bar skeleton-label" />
                    </span>
                    <span className="tx-detail-value">
                      <span className="skeleton-bar skeleton-value" />
                    </span>
                  </div>
                ))}
              </div>
            </section>
          ))}
        </div>
        <section className="tx-detail-group tx-detail-operations">
          <h3>
            <span className="skeleton-bar skeleton-title" />
          </h3>
          <div className="skeleton-table" />
        </section>
      </div>
    </div>
  );
}

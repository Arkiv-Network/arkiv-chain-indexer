import { useEffect, useState, type ReactNode } from "react";
import { fetchEntityByKey, type EntityByKeyResponse, type StoredEntityOperation } from "./api";
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
  const [history, setHistory] = useState<EntityByKeyResponse | null>(null);
  const [status, setStatus] = useState<LoadStatus>("idle");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setQuery(entityKey ?? "");
    setFormError(null);
  }, [entityKey]);

  useEffect(() => {
    if (!entityKey) {
      setHistory(null);
      setStatus("idle");
      setError(null);
      return;
    }

    let cancelled = false;
    setStatus("loading");
    setError(null);
    setHistory(null);
    fetchEntityByKey(entityKey)
      .then((body) => {
        if (cancelled) return;
        if (!body || (body.operations.length === 0 && !body.genesis)) {
          setStatus("notfound");
          return;
        }
        setHistory(body);
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
      ) : history && (history.operations.length > 0 || history.genesis) ? (
        <EntityDetail
          entityKey={entityKey}
          history={history}
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
  history,
  timeZone,
  blockTimeMs,
  onLocationChange,
}: {
  entityKey: string;
  history: EntityByKeyResponse;
  timeZone: string;
  blockTimeMs: number;
  onLocationChange: () => void;
}) {
  // Operations arrive in chain order (block, position, op index ascending) and
  // hold the newest slice of the history; older backends omit the total.
  const operations = history.operations;
  const totalOperations = history.totalOperations ?? operations.length;
  const truncated = history.truncated ?? totalOperations > operations.length;
  const hiddenOperations = Math.max(totalOperations - operations.length, 0);
  // The create may sit outside a truncated slice; the server then sends the
  // earliest stored operation separately so the Created panel stays accurate.
  const firstOperation = history.firstOperation ?? null;
  const created =
    operations.find((operation) => operation.operation === "create") ??
    (firstOperation?.operation === "create" ? firstOperation : null);
  // An entity the chain was born with (a seeded genesis) has no create and
  // may have no operations at all; the backend then sends its genesis state.
  const genesis = history.genesis ?? null;
  const latest = operations.length > 0 ? operations[operations.length - 1]! : null;
  const lifecycle = latest ? lifecycleInfo(latest) : { label: "Active", tone: "ok" as const };
  const newestFirst = [...operations].reverse();
  const latestContent = newestFirst.find((operation) => operation.contentType !== null) ?? null;
  const latestExpiry = newestFirst.find((operation) => operation.expiresAtBlocks > 0) ?? null;
  const lastTransfer = newestFirst.find((operation) => operation.newOwner !== null) ?? null;
  const contentType = latestContent?.contentType ?? genesis?.contentType ?? null;

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
            <Row
              label="Operations"
              title={
                truncated
                  ? `Only the ${fmtInteger(operations.length)} most recent operations are listed below.`
                  : undefined
              }
            >
              {fmtInteger(totalOperations)}
            </Row>
            {contentType ? <Row label="Content type">{contentType}</Row> : null}
            {latestContent && latestContent.payloadSizeBytes > 0 ? (
              <Row
                label="Payload"
                title={`${fmtInteger(latestContent.payloadSizeBytes)} bytes, from the ${latestContent.operation} in block ${latestContent.blockNumberDecimal}`}
              >
                {fmtBytes(latestContent.payloadSizeBytes)}
              </Row>
            ) : genesis && genesis.payloadSize > 0 ? (
              <Row label="Payload" title={`${fmtInteger(genesis.payloadSize)} bytes in the genesis state`}>
                {fmtBytes(genesis.payloadSize)}
              </Row>
            ) : null}
            {lastTransfer?.newOwner ? (
              <Row label="Owner (last transfer)">
                <AddressCell address={lastTransfer.newOwner} />
              </Row>
            ) : genesis ? (
              <Row label="Owner">
                <AddressCell address={genesis.owner} />
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
          ) : genesis ? (
            <dl className="tx-detail-grid">
              <Row label="Block" title="Part of the chain's genesis state; no transaction created it">
                <BlockNumberLink blockNumber="0" onLocationChange={onLocationChange} /> (genesis state)
              </Row>
              <Row label="Creator">
                <AddressCell address={genesis.creator} />
              </Row>
              <Row label="Expires" title={`Absolute expiry block ${genesis.expiresAt}`}>
                {genesis.expiresAt === NEVER_EXPIRES ? "never" : `block ${fmtInteger(Number(genesis.expiresAt))}`}
              </Row>
              {genesis.creationFlags ? (
                <Row label="Flags">{describeCreationFlags(genesis.creationFlags)}</Row>
              ) : null}
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
          {latest === null ? (
            <p className="tx-detail-note">No operations since the genesis state.</p>
          ) : (
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
          )}
        </section>
      </div>

      {genesis && genesis.attributes.length > 0 ? (
        <section className="tx-detail-group tx-detail-operations">
          <h3>Genesis attributes ({fmtInteger(genesis.attributes.length)})</h3>
          <div className="table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Type</th>
                  <th>Value</th>
                </tr>
              </thead>
              <tbody>
                {genesis.attributes.map((attribute) => (
                  <tr key={attribute.name}>
                    <td className="mono">{attribute.name}</td>
                    <td>{attribute.type}</td>
                    <td className="mono">{String(attribute.value)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      ) : null}

      <section className="tx-detail-group tx-detail-operations">
        <h3>
          Operation history (
          {truncated
            ? `last ${fmtInteger(operations.length)} of ${fmtInteger(totalOperations)}`
            : fmtInteger(operations.length)}
          )
        </h3>
        {truncated ? (
          <p className="tx-detail-note">
            Only the {fmtInteger(operations.length)} most recent operations are listed —{" "}
            {fmtInteger(hiddenOperations)} older{" "}
            {hiddenOperations === 1 ? "operation is" : "operations are"} not shown.
          </p>
        ) : null}
        {operations.length === 0 && genesis ? (
          <p className="tx-detail-note">
            No transaction has touched this entity: it was part of the chain&apos;s genesis state.
          </p>
        ) : null}
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
const NEVER_EXPIRES = "18446744073709551615";

function describeCreationFlags(flags: number): string {
  const names: string[] = [];
  if (flags & 1) names.push("readonly");
  if (flags & 2) names.push("permissionless extension");
  const rest = flags & ~3;
  if (rest) names.push(`other bits 0x${rest.toString(16)}`);
  return names.join(", ");
}

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

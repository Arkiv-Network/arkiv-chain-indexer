import { useEffect, useState, type ReactNode } from "react";
import { BlockCell } from "@/components/block-cell";
import { CopyButton } from "@/components/copy-cell";
import { OpBadge, StatusBadge, type StatusTone } from "@/components/op-badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { fetchEntityByKey, type EntityByKeyResponse, type StoredEntityOperation } from "./api";
import { fmtBytes, fmtDurationSeconds, fmtInteger } from "./format";
import { PageBreadcrumbs } from "./PageBreadcrumbs";
import { writeEntityPermalink } from "./permalinks";
import { AddressCell } from "./TransactionsView";
import { TransactionHashLink } from "./TransactionView";

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
        if (!body || body.operations.length === 0) {
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
    <section className="mx-auto flex w-full max-w-415 flex-col gap-6 px-3 py-6 md:px-6">
      <div className="flex flex-col gap-1.5">
        <PageBreadcrumbs
          items={[
            { view: "home", label: "Home" },
            { view: "entity", label: "Entity details" },
          ]}
          onLocationChange={onLocationChange}
        />
        <h2 className="font-heading text-lg font-black tracking-tight">Entity</h2>
      </div>

      <form onSubmit={onSubmit} className="flex flex-wrap items-center gap-2">
        <Input
          type="text"
          inputMode="text"
          spellCheck={false}
          autoComplete="off"
          placeholder="0x… entity key"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          className="max-w-xl font-mono"
        />
        <Button type="submit" size="sm">
          Look up
        </Button>
      </form>
      {formError ? <p className="text-xs text-destructive">{formError}</p> : null}

      {!entityKey ? (
        <p className="text-xs text-muted-foreground">Enter an entity key above to view the entity and its operation history.</p>
      ) : status === "loading" ? (
        <EntityDetailSkeleton />
      ) : status === "error" ? (
        <p className="text-xs text-destructive">Failed to load entity history: {error}</p>
      ) : status === "notfound" ? (
        <p className="text-xs text-destructive">
          No operations for entity <span className="font-mono">{entityKey}</span> were found in storage. Blocks scanned
          before entity keys were indexed may not be linked to their entity yet.
        </p>
      ) : history && history.operations.length > 0 ? (
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
  const latest = operations[operations.length - 1]!;
  const lifecycle = lifecycleInfo(latest);
  const newestFirst = [...operations].reverse();
  const latestContent = newestFirst.find((operation) => operation.contentType !== null) ?? null;
  const latestExpiry = newestFirst.find((operation) => operation.expiresAtBlocks > 0) ?? null;
  const lastTransfer = newestFirst.find((operation) => operation.newOwner !== null) ?? null;

  return (
    <Card className="gap-4 p-4">
      <div className="flex flex-wrap items-center gap-3">
        <StatusBadge tone={lifecycle.tone}>{lifecycle.label}</StatusBadge>
        <span className="min-w-0 flex-1 font-mono text-xs break-all text-foreground">{entityKey}</span>
        <CopyButton value={entityKey} label="entity key" />
      </div>

      <div className="grid gap-6 border-t border-border pt-4 sm:grid-cols-3">
        <section className="flex flex-col gap-2">
          <h3 className="text-xs font-semibold text-foreground">Overview</h3>
          <dl className="flex flex-col gap-2">
            <Row label="Status">
              <StatusBadge tone={lifecycle.tone}>{lifecycle.label}</StatusBadge>
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
            {latestContent?.contentType ? <Row label="Content type">{latestContent.contentType}</Row> : null}
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

        <section className="flex flex-col gap-2">
          <h3 className="text-xs font-semibold text-foreground">Created</h3>
          {created ? (
            <dl className="flex flex-col gap-2">
              <Row label="Block">
                <BlockCell
                  blockNumber={created.blockNumberDecimal}
                  date={created.blockDate}
                  timeZone={timeZone}
                  onLocationChange={onLocationChange}
                />
              </Row>
              <Row label="Transaction">
                <TransactionHashLink hash={created.hash} onLocationChange={onLocationChange} />
              </Row>
            </dl>
          ) : (
            <p className="text-xs text-muted-foreground">
              The create operation is outside the stored history — older than the scanned range or not yet linked to
              this key.
            </p>
          )}
        </section>

        <section className="flex flex-col gap-2">
          <h3 className="text-xs font-semibold text-foreground">Last activity</h3>
          <dl className="flex flex-col gap-2">
            <Row label="Operation">
              <span className="inline-flex flex-wrap items-center gap-1">
                <OpBadge operation={latest.operation} />
                {latest.isReference ? <OpBadge operation="reference" /> : null}
              </span>
            </Row>
            <Row label="Block">
              <BlockCell
                blockNumber={latest.blockNumberDecimal}
                date={latest.blockDate}
                timeZone={timeZone}
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

      <section className="flex flex-col gap-2 border-t border-border pt-4">
        <h3 className="text-xs font-semibold text-foreground">
          Operation history (
          {truncated
            ? `last ${fmtInteger(operations.length)} of ${fmtInteger(totalOperations)}`
            : fmtInteger(operations.length)}
          )
        </h3>
        {truncated ? (
          <p className="text-xs text-muted-foreground">
            Only the {fmtInteger(operations.length)} most recent operations are listed —{" "}
            {fmtInteger(hiddenOperations)} older {hiddenOperations === 1 ? "operation is" : "operations are"} not
            shown.
          </p>
        ) : null}
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Block</TableHead>
              <TableHead>Transaction</TableHead>
              <TableHead>Op</TableHead>
              <TableHead>Operation</TableHead>
              <TableHead>Content type</TableHead>
              <TableHead>Payload</TableHead>
              <TableHead>Expires</TableHead>
              <TableHead>New owner</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {operations.map((operation) => (
              <TableRow key={`${operation.blockNumberDecimal}:${operation.position}:${operation.opIndex}`}>
                <TableCell>
                  <BlockCell
                    blockNumber={operation.blockNumberDecimal}
                    date={operation.blockDate}
                    timeZone={timeZone}
                    onLocationChange={onLocationChange}
                  />
                </TableCell>
                <TableCell>
                  <TransactionHashLink hash={operation.hash} onLocationChange={onLocationChange} />
                </TableCell>
                <TableCell className="text-muted-foreground">#{operation.opIndex}</TableCell>
                <TableCell>
                  <span className="inline-flex flex-wrap items-center gap-1">
                    <OpBadge operation={operation.operation} />
                    {operation.isReference ? <OpBadge operation="reference" /> : null}
                  </span>
                </TableCell>
                <TableCell>{operation.contentType ?? "—"}</TableCell>
                <TableCell title={`${fmtInteger(operation.payloadSizeBytes)} bytes`}>
                  {operation.payloadSizeBytes > 0 ? fmtBytes(operation.payloadSizeBytes) : "—"}
                </TableCell>
                <TableCell>
                  {operation.expiresAtBlocks > 0 ? `${fmtInteger(operation.expiresAtBlocks)} blocks` : "—"}
                </TableCell>
                <TableCell>{operation.newOwner ? <AddressCell address={operation.newOwner} /> : "—"}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </section>
    </Card>
  );
}

/**
 * Lifecycle badge derived from the newest stored operation: a trailing delete
 * means the entity is gone; a trailing expire means the chain reaped it;
 * anything else leaves it active as far as the stored history knows.
 */
function lifecycleInfo(latest: StoredEntityOperation): { label: string; tone: StatusTone } {
  if (latest.operation === "delete") return { label: "Deleted", tone: "fail" };
  if (latest.operation === "expire") return { label: "Expired", tone: "fail" };
  return { label: "Active", tone: "ok" };
}

function Row({ label, children, title }: { label: string; children: ReactNode; title?: string }) {
  return (
    <div className="flex flex-col gap-0.5" title={title}>
      <dt className="text-[10px] font-medium tracking-wider text-muted-foreground uppercase">{label}</dt>
      <dd className="text-xs text-foreground">{children}</dd>
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
    <Card className="gap-4 p-4" role="status" aria-label="Loading entity history">
      <span className="sr-only">Loading entity history…</span>
      <div aria-hidden="true" className="flex flex-col gap-4">
        <div className="flex items-center gap-3">
          <span className="h-5 w-16 animate-pulse bg-muted" />
          <span className="h-4 w-72 max-w-full animate-pulse bg-muted" />
        </div>
        <div className="grid gap-6 border-t border-border pt-4 sm:grid-cols-3">
          {[4, 3, 4].map((rows, group) => (
            <div key={group} className="flex flex-col gap-2">
              <span className="h-3 w-20 animate-pulse bg-muted" />
              {Array.from({ length: rows }, (_, row) => (
                <div key={row} className="flex flex-col gap-1">
                  <span className="h-2.5 w-16 animate-pulse bg-muted" />
                  <span className="h-3 w-24 animate-pulse bg-muted" />
                </div>
              ))}
            </div>
          ))}
        </div>
        <div className="border-t border-border pt-4">
          <span className="h-3 w-40 animate-pulse bg-muted" />
          <div className="mt-3 h-32 animate-pulse bg-muted" />
        </div>
      </div>
    </Card>
  );
}

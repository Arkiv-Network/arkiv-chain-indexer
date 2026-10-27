import { ChevronRight } from "lucide-react";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { BlockNumberLink } from "./blockLinks";
import { BlockCell } from "@/components/block-cell";
import { CopyButton } from "@/components/copy-cell";
import { AttributeTable } from "@/components/attribute-table";
import { PermanentBadge, SchemaBadge } from "@/components/entity-badges";
import { OpBadge, StatusBadge, type StatusTone } from "@/components/op-badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { cn } from "@/lib/utils";
import { fetchEntityByKey, type EntityByKeyResponse } from "./api";
import {
  fromEntityAttribute,
  isPermanentExpiry,
  schemaNameOf,
  summarizeChanges,
  toChecksumAddress,
  withoutSchemaTag,
  type AttributeView,
} from "./attributes";
import { eventLabel, foldEntityHistory, operationRentShare, type EntityHistoryEvent } from "./entityHistory";
import { fmtBytes, fmtDurationSeconds, fmtInteger, fmtTokenAmount } from "./format";
import { PageBreadcrumbs } from "./PageBreadcrumbs";
import { writeEntityPermalink } from "./permalinks";
import { AddressCell } from "./TransactionsView";
import { TransactionHashLink } from "./TransactionView";

interface EntityViewProps {
  entityKey: string | null;
  onLocationChange: () => void;
  timeZone: string;
  blockTimeMs: number;
  tokenSymbol: string;
}

const ENTITY_KEY_RE = /^0x[0-9a-fA-F]{64}$/;
/** Histories up to this long open every version's changes; longer ones start collapsed. */
const EXPAND_ALL_LIMIT = 12;

type LoadStatus = "idle" | "loading" | "loaded" | "notfound" | "error";

export function EntityView({ entityKey, onLocationChange, timeZone, blockTimeMs, tokenSymbol }: EntityViewProps) {
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
        if (!body || (body.operations.length === 0 && !body.genesis && !body.state)) {
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
    <section className="mx-auto flex w-full max-w-415 flex-col gap-6 px-3 md:px-6">
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
        <p className="text-xs text-muted-foreground">Enter an entity key above to view the entity, its current state and its version history.</p>
      ) : status === "loading" ? (
        <EntityDetailSkeleton />
      ) : status === "error" ? (
        <p className="text-xs text-destructive">Failed to load entity history: {error}</p>
      ) : status === "notfound" ? (
        <p className="text-xs text-destructive">
          No operations for entity <span className="font-mono">{entityKey}</span> were found in storage. Blocks scanned
          before entity keys were indexed may not be linked to their entity yet.
        </p>
      ) : history ? (
        <EntityDetail
          entityKey={entityKey}
          history={history}
          timeZone={timeZone}
          blockTimeMs={blockTimeMs}
          tokenSymbol={tokenSymbol}
          onLocationChange={onLocationChange}
        />
      ) : null}
    </section>
  );
}

/** What the page shows as the entity now: the index's state, else the end of the folded history. */
interface CurrentView {
  source: "index" | "history";
  status: "live" | "expired" | "deleted" | "active";
  version: number | null;
  owner: string | null;
  creator: string | null;
  createdAt: string | null;
  updatedAt: string | null;
  expiresAt: string | null;
  permanent: boolean;
  creationFlags: number | null;
  bytesSize: number | null;
  schemaName: string | null;
  asOfBlock: string | null;
  /** null when the history cannot tell (a truncated slice without the index). */
  attributes: AttributeView[] | null;
}

function currentView(history: EntityByKeyResponse, events: readonly EntityHistoryEvent[]): CurrentView {
  const state = history.state;
  if (state) {
    const attributes = state.attributes.map(fromEntityAttribute);
    return {
      source: "index",
      status: state.status,
      version: state.version,
      owner: state.owner,
      creator: state.creator,
      createdAt: state.createdAt,
      updatedAt: state.updatedAt,
      expiresAt: state.expiresAt,
      permanent: state.permanent || isPermanentExpiry(state.expiresAt),
      creationFlags: state.creationFlags,
      bytesSize: state.bytesSize,
      schemaName: state.schemaName ?? schemaNameOf(attributes),
      asOfBlock: state.asOfBlock,
      attributes,
    };
  }
  const applied = events.filter((event) => event.kind !== "failed" && event.kind !== "ignored");
  const last = applied[applied.length - 1] ?? null;
  const created = applied.find((event) => event.kind === "created" || event.kind === "genesis") ?? null;
  const genesis = history.genesis ?? null;
  const attributes = last?.attributes ?? null;
  const expiresAt = last?.expiresAfter ?? genesis?.expiresAt ?? null;
  return {
    source: "history",
    status: last?.kind === "deleted" ? "deleted" : "active",
    version: last?.version ?? null,
    owner: last?.ownerAfter ?? genesis?.owner ?? null,
    creator: genesis?.creator ?? null,
    createdAt: created ? created.operation?.blockNumberDecimal ?? "0" : null,
    updatedAt: last?.operation?.blockNumberDecimal ?? null,
    expiresAt,
    permanent: isPermanentExpiry(expiresAt),
    creationFlags: created?.operation?.creationFlags ?? genesis?.creationFlags ?? null,
    bytesSize: attributes ? attributes.reduce((total, attribute) => total + (attribute.type === "bytes" ? attribute.size ?? 0 : 0), 0) : null,
    schemaName: attributes ? schemaNameOf(attributes) : null,
    asOfBlock: null,
    attributes,
  };
}

const STATUS_BADGE: Record<CurrentView["status"], { label: string; tone: StatusTone }> = {
  live: { label: "Live", tone: "ok" },
  active: { label: "Active", tone: "ok" },
  expired: { label: "Expired", tone: "fail" },
  deleted: { label: "Deleted", tone: "fail" },
};

function EntityDetail({
  entityKey,
  history,
  timeZone,
  blockTimeMs,
  tokenSymbol,
  onLocationChange,
}: {
  entityKey: string;
  history: EntityByKeyResponse;
  timeZone: string;
  blockTimeMs: number;
  tokenSymbol: string;
  onLocationChange: () => void;
}) {
  // Operations arrive in chain order (block, position, op index ascending) and
  // hold the newest slice of the history.
  const operations = history.operations;
  const totalOperations = history.totalOperations ?? operations.length;
  const truncated = history.truncated ?? totalOperations > operations.length;
  const hiddenOperations = Math.max(totalOperations - operations.length, 0);
  const genesis = history.genesis ?? null;
  const events = useMemo(
    () => foldEntityHistory({ genesis, operations, truncated, currentVersion: history.state?.version ?? null }),
    [genesis, operations, truncated, history.state?.version],
  );
  const current = currentView(history, events);
  const badge = STATUS_BADGE[current.status];
  // The create may sit outside a truncated slice; the server then sends the
  // earliest stored operation separately.
  const createOp =
    operations.find((operation) => operation.operation === "create" && operation.transactionStatus !== "0") ??
    (history.firstOperation?.operation === "create" ? history.firstOperation : null);
  const actions = { onLocationChange };
  const stateRows = current.attributes ? withoutSchemaTag(current.attributes) : null;

  return (
    <Card className="gap-4 p-4">
      <div className="flex flex-wrap items-center gap-3">
        <StatusBadge tone={badge.tone}>{badge.label}</StatusBadge>
        {/* A basis keeps the key readable: on a narrow screen the badges wrap below it instead of squeezing it. */}
        <span className="min-w-0 flex-[1_1_18rem] font-mono text-xs break-all text-foreground">{entityKey}</span>
        {current.schemaName ? <SchemaBadge name={current.schemaName} actions={actions} /> : null}
        {current.permanent ? <PermanentBadge /> : null}
        <CopyButton value={entityKey} label="entity key" />
      </div>

      <div className="grid gap-6 border-t border-border pt-4 sm:grid-cols-3">
        <section className="flex flex-col gap-2">
          <h3 className="text-xs font-semibold text-foreground">Overview</h3>
          <dl className="flex flex-col gap-2">
            <Row label="Status" title={current.source === "index" ? `As of indexed block ${current.asOfBlock}` : "Derived from the stored operation history"}>
              <StatusBadge tone={badge.tone}>{badge.label}</StatusBadge>
            </Row>
            <Row label="Owner">{current.owner ? <AddressCell address={toChecksumAddress(current.owner)} /> : "—"}</Row>
            {current.creator && current.creator.toLowerCase() !== current.owner?.toLowerCase() ? (
              <Row label="Creator"><AddressCell address={toChecksumAddress(current.creator)} /></Row>
            ) : null}
            <Row label="Version" title="0 for the create (or the genesis state), one more per applied operation">
              {current.version === null ? "—" : fmtInteger(current.version)}
            </Row>
            <Row
              label="Operations"
              title={truncated ? `Only the ${fmtInteger(operations.length)} most recent operations are listed below.` : undefined}
            >
              {fmtInteger(totalOperations)}
            </Row>
          </dl>
        </section>

        <section className="flex flex-col gap-2">
          <h3 className="text-xs font-semibold text-foreground">Created</h3>
          {createOp ? (
            <dl className="flex flex-col gap-2">
              <Row label="Block">
                <BlockCell blockNumber={createOp.blockNumberDecimal} date={createOp.blockDate} timeZone={timeZone} onLocationChange={onLocationChange} />
              </Row>
              <Row label="Transaction">
                <TransactionHashLink hash={createOp.hash} onLocationChange={onLocationChange} />
              </Row>
            </dl>
          ) : genesis || current.createdAt === "0" ? (
            <dl className="flex flex-col gap-2">
              <Row label="Block" title="Part of the chain's genesis state; no transaction created it">
                <span>
                  <BlockNumberLink blockNumber="0" onLocationChange={onLocationChange} /> (genesis state)
                </span>
              </Row>
            </dl>
          ) : current.createdAt !== null ? (
            <dl className="flex flex-col gap-2">
              <Row label="Block">
                <BlockNumberLink blockNumber={current.createdAt} onLocationChange={onLocationChange} />
              </Row>
              <p className="text-xs text-muted-foreground">The create operation is outside the stored history slice.</p>
            </dl>
          ) : (
            <p className="text-xs text-muted-foreground">
              The create operation is outside the stored history — older than the scanned range or not yet linked to
              this key.
            </p>
          )}
          {current.creationFlags ? (
            <Row label="Flags">{describeCreationFlags(current.creationFlags)}</Row>
          ) : null}
        </section>

        <section className="flex flex-col gap-2">
          <h3 className="text-xs font-semibold text-foreground">Lifetime</h3>
          <dl className="flex flex-col gap-2">
            <Row label="Expires" title={current.expiresAt ? `Absolute expiry block ${current.expiresAt}` : undefined}>
              {current.permanent ? (
                <PermanentBadge />
              ) : current.expiresAt ? (
                <ExpiryText expiresAt={current.expiresAt} asOfBlock={current.asOfBlock} blockTimeMs={blockTimeMs} onLocationChange={onLocationChange} />
              ) : (
                "—"
              )}
            </Row>
            {current.updatedAt !== null ? (
              <Row label="Last updated">
                <BlockNumberLink blockNumber={current.updatedAt} onLocationChange={onLocationChange} />
              </Row>
            ) : null}
            {current.bytesSize ? (
              <Row label="Bytes held" title={`${fmtInteger(current.bytesSize)} bytes in bytes attributes; the index keeps sizes and hashes, never contents`}>
                {fmtBytes(current.bytesSize)}
              </Row>
            ) : null}
          </dl>
          {!current.permanent && current.expiresAt && current.createdAt !== null && current.asOfBlock !== null ? (
            <LifetimeBar createdAt={current.createdAt} expiresAt={current.expiresAt} asOfBlock={current.asOfBlock} />
          ) : null}
        </section>
      </div>

      <section className="flex flex-col gap-2 border-t border-border pt-4">
        <h3 className="flex flex-wrap items-baseline gap-2 text-xs font-semibold text-foreground">
          <span>Current state</span>
          <span className="text-[11px] font-normal text-muted-foreground">
            {current.source === "index"
              ? `version ${current.version ?? "?"}, as of indexed block ${current.asOfBlock}`
              : "derived from the stored operation history (the entity index is not available)"}
          </span>
        </h3>
        {current.status === "deleted" ? (
          <p className="text-xs text-muted-foreground">The entity was deleted; its last attributes are shown in the history below.</p>
        ) : stateRows === null ? (
          <p className="text-xs text-muted-foreground">The stored history is truncated, so the current attributes cannot be derived without the entity index.</p>
        ) : (
          <AttributeTable
            attributes={stateRows}
            actions={actions}
            bytes={{ entityKey, atBlock: undefined }}
            onLocationChange={onLocationChange}
          />
        )}
        {current.status === "expired" ? (
          <p className="text-xs text-muted-foreground">Expired: these are the attributes it held when it expired; a node no longer returns it.</p>
        ) : null}
      </section>

      <VersionHistory
        entityKey={entityKey}
        events={events}
        truncated={truncated}
        shownOperations={operations.length}
        hiddenOperations={hiddenOperations}
        totalOperations={totalOperations}
        timeZone={timeZone}
        tokenSymbol={tokenSymbol}
        onLocationChange={onLocationChange}
      />
    </Card>
  );
}

function VersionHistory({
  entityKey,
  events,
  truncated,
  shownOperations,
  hiddenOperations,
  totalOperations,
  timeZone,
  tokenSymbol,
  onLocationChange,
}: {
  entityKey: string;
  events: EntityHistoryEvent[];
  truncated: boolean;
  shownOperations: number;
  hiddenOperations: number;
  totalOperations: number;
  timeZone: string;
  tokenSymbol: string;
  onLocationChange: () => void;
}) {
  const newestFirst = [...events].reverse();
  const [expanded, setExpanded] = useState<Set<number>>(
    () => new Set(events.length <= EXPAND_ALL_LIMIT ? events.map((_, index) => index) : [events.length - 1]),
  );
  const toggle = (index: number) =>
    setExpanded((previous) => {
      const next = new Set(previous);
      if (next.has(index)) next.delete(index);
      else next.add(index);
      return next;
    });
  const actions = { onLocationChange };

  return (
    <section className="flex flex-col gap-2 border-t border-border pt-4">
      <h3 className="text-xs font-semibold text-foreground">
        Version history (
        {truncated ? `last ${fmtInteger(shownOperations)} of ${fmtInteger(totalOperations)} operations` : `${fmtInteger(shownOperations)} operations`})
      </h3>
      {truncated ? (
        <p className="text-xs text-muted-foreground">
          Only the {fmtInteger(shownOperations)} most recent operations are listed — {fmtInteger(hiddenOperations)} older{" "}
          {hiddenOperations === 1 ? "operation is" : "operations are"} not shown, so a patch&apos;s previous values may be unknown.
        </p>
      ) : null}
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead className="w-6"><span className="sr-only">Details</span></TableHead>
            <TableHead>Version</TableHead>
            <TableHead>Block</TableHead>
            <TableHead>Transaction</TableHead>
            <TableHead>Event</TableHead>
            <TableHead>Changes</TableHead>
            <TableHead>Expires</TableHead>
            <TableHead className="text-right">Rent</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {newestFirst.map((event) => {
            const index = events.indexOf(event);
            const operation = event.operation;
            const open = expanded.has(index);
            const hasDetail = event.changes.length > 0;
            const blockNumber = operation ? Number(operation.blockNumberDecimal) : 0;
            return [
              <TableRow key={`row-${index}`} className={cn(event.kind === "failed" && "text-muted-foreground")}>
                <TableCell className="align-top">
                  {hasDetail ? (
                    <button
                      type="button"
                      className="inline-flex size-5 items-center justify-center text-muted-foreground hover:text-foreground"
                      aria-expanded={open}
                      aria-label={open ? "Hide changes" : "Show changes"}
                      onClick={() => toggle(index)}
                    >
                      <ChevronRight className={cn("size-3.5 transition-transform", open && "rotate-90")} />
                    </button>
                  ) : null}
                </TableCell>
                <TableCell className="align-top font-mono tabular-nums">{event.version === null ? "—" : event.version}</TableCell>
                <TableCell className="align-top">
                  {operation ? (
                    <BlockCell blockNumber={operation.blockNumberDecimal} date={operation.blockDate} timeZone={timeZone} onLocationChange={onLocationChange} />
                  ) : (
                    <span>
                      <BlockNumberLink blockNumber="0" onLocationChange={onLocationChange} /> genesis
                    </span>
                  )}
                </TableCell>
                <TableCell className="align-top">
                  {operation ? (
                    <span className="inline-flex flex-col gap-0.5">
                      <TransactionHashLink hash={operation.hash} onLocationChange={onLocationChange} />
                      <span className="text-[11px] text-muted-foreground">op #{operation.opIndex}</span>
                    </span>
                  ) : (
                    "—"
                  )}
                </TableCell>
                <TableCell className="align-top">
                  <span className="inline-flex flex-wrap items-center gap-1.5">
                    {operation ? <OpBadge operation={operation.operation} /> : null}
                    <span className={cn(event.kind === "extended-to-permanent" && "font-medium text-violet-700 dark:text-violet-300", event.kind === "failed" && "text-red-700 dark:text-red-400")}>
                      {eventLabel(event)}
                    </span>
                  </span>
                </TableCell>
                <TableCell className="align-top">
                  <EventChanges event={event} />
                </TableCell>
                <TableCell className="align-top">
                  <EventExpiry event={event} onLocationChange={onLocationChange} />
                </TableCell>
                <TableCell className="align-top text-right font-mono tabular-nums">
                  <EventRent event={event} tokenSymbol={tokenSymbol} />
                </TableCell>
              </TableRow>,
              open && hasDetail ? (
                <TableRow key={`detail-${index}`} className="hover:bg-transparent">
                  <TableCell />
                  <TableCell colSpan={7} className="pb-3">
                    {event.kind === "failed" ? (
                      <p className="mb-1 text-[11px] text-red-700 dark:text-red-400">The transaction reverted: these changes were not applied.</p>
                    ) : null}
                    <AttributeTable
                      changes={event.changes}
                      actions={event.kind === "failed" ? undefined : actions}
                      bytes={{ entityKey, atBlock: operation && Number.isSafeInteger(blockNumber) ? blockNumber : undefined }}
                      onLocationChange={onLocationChange}
                    />
                  </TableCell>
                </TableRow>
              ) : null,
            ];
          })}
        </TableBody>
      </Table>
    </section>
  );
}

function EventChanges({ event }: { event: EntityHistoryEvent }) {
  const kind = event.kind === "failed" ? event.attemptedKind : event.kind;
  if (kind === "created" || kind === "genesis") {
    const count = event.changes.length;
    return <span>{count} {count === 1 ? "attribute" : "attributes"}</span>;
  }
  if (kind === "patched") return <span>{summarizeChanges(event.changes)}</span>;
  if (kind === "transferred") {
    return (
      <span className="inline-flex flex-wrap items-center gap-1">
        to <AddressCell address={event.ownerAfter ? toChecksumAddress(event.ownerAfter) : null} />
      </span>
    );
  }
  if (kind === "deleted") return <span className="text-muted-foreground">removed</span>;
  return <span className="text-muted-foreground">—</span>;
}

function EventExpiry({ event, onLocationChange }: { event: EntityHistoryEvent; onLocationChange: () => void }) {
  const kind = event.kind === "failed" ? event.attemptedKind : event.kind;
  if (kind !== "created" && kind !== "genesis" && kind !== "extended" && kind !== "extended-to-permanent" && kind !== "extend-noop") {
    return <span className="text-muted-foreground">—</span>;
  }
  const show = (value: string | null) =>
    value === null ? "—" : isPermanentExpiry(value) ? <PermanentBadge /> : <BlockNumberLink blockNumber={value} onLocationChange={onLocationChange} />;
  if ((kind === "extended" || kind === "extended-to-permanent") && event.expiresBefore !== null && event.expiresBefore !== event.expiresAfter) {
    return (
      <span className="inline-flex flex-wrap items-center gap-1">
        <span className="text-muted-foreground">{show(event.expiresBefore)}</span>
        <span className="text-muted-foreground">→</span>
        {show(event.expiresAfter)}
      </span>
    );
  }
  return <span>{show(event.expiresAfter)}</span>;
}

function EventRent({ event, tokenSymbol }: { event: EntityHistoryEvent; tokenSymbol: string }) {
  if (!event.operation) return <span className="text-muted-foreground">—</span>;
  if (event.operation.transactionStatus === "0") return <span className="text-muted-foreground" title="A failed transaction is charged gas, never rent">none</span>;
  const share = operationRentShare(event.rent);
  if (!share) return <span className="text-muted-foreground">—</span>;
  return (
    <span className="inline-flex flex-col items-end gap-0.5" title="The transaction's receipt rentFee; a batch's rent is not split by operation">
      <span>{fmtTokenAmount(share.wei, tokenSymbol)}</span>
      {share.sharedBy > 1 ? <span className="text-[10px] text-muted-foreground">tx total, shared by {share.sharedBy} ops</span> : null}
    </span>
  );
}

function ExpiryText({
  expiresAt,
  asOfBlock,
  blockTimeMs,
  onLocationChange,
}: {
  expiresAt: string;
  asOfBlock: string | null;
  blockTimeMs: number;
  onLocationChange: () => void;
}) {
  let relative: string | null = null;
  if (asOfBlock !== null && blockTimeMs > 0) {
    const delta = Number(BigInt(expiresAt) - BigInt(asOfBlock));
    const seconds = Math.abs(delta) * (blockTimeMs / 1000);
    relative = delta > 0 ? `in ~${fmtDurationSeconds(seconds)}` : delta === 0 ? "now" : `~${fmtDurationSeconds(seconds)} ago`;
  }
  return (
    <span className="inline-flex flex-wrap items-baseline gap-1.5">
      <span>
        block <BlockNumberLink blockNumber={expiresAt} onLocationChange={onLocationChange} />
      </span>
      {relative ? <span className="text-[11px] text-muted-foreground">{relative}</span> : null}
    </span>
  );
}

function LifetimeBar({ createdAt, expiresAt, asOfBlock }: { createdAt: string; expiresAt: string; asOfBlock: string }) {
  const start = BigInt(createdAt);
  const end = BigInt(expiresAt);
  const now = BigInt(asOfBlock);
  const total = end - start;
  const consumed = total <= 0n ? 1 : Math.max(0, Math.min(1, Number(now - start) / Number(total)));
  const left = 1 - consumed;
  const tone = now >= end ? "bg-muted-foreground/40" : left < 0.2 ? "bg-red-500" : left < 0.5 ? "bg-amber-500" : "bg-emerald-500";
  return (
    <div title={`${Math.round(left * 100)}% of the lifetime remains at block ${asOfBlock}`}>
      <div className="flex items-baseline justify-between text-[10px] text-muted-foreground">
        <span className="font-medium tracking-wider uppercase">Lifetime</span>
        <span>{now >= end ? "expired" : `${Math.round(left * 100)}% left`}</span>
      </div>
      <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-muted">
        <div className={cn("h-full", tone)} style={{ width: `${consumed * 100}%` }} />
      </div>
    </div>
  );
}

function describeCreationFlags(flags: number): string {
  const names: string[] = [];
  if (flags & 1) names.push("readonly");
  if (flags & 2) names.push("permissionless extension");
  const rest = flags & ~3;
  if (rest) names.push(`other bits 0x${rest.toString(16)}`);
  return names.join(", ");
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

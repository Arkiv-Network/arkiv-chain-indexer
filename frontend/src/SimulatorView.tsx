import { useEffect, useRef, useState } from "react";
import { AccountControls } from "./AccountControls";
import { useAuth } from "./useAuth";
import {
  displayNative,
  sameIdentity,
  retrySameControl,
  localVerifiedQuery,
  nativeControl,
  nativeGet,
  nativeQuery,
  type EqSelection,
  type NativePage,
  type NativeRow,
  type NativeStatus,
  type VerifiedPage,
} from "./simulatorApi";
import "./simulator.css";

const tabs = [
  "overview",
  "blocks",
  "transactions",
  "operations",
  "namespaces",
  "records",
  "raw",
  "record-history",
  "query",
] as const;
type Tab = (typeof tabs)[number];
const columns: Record<string, string[]> = {
  blocks: [
    "height",
    "hash",
    "stateRoot",
    "transactionCount",
    "operationCount",
    "spentUnits",
    "timestampMs",
  ],
  transactions: [
    "height",
    "position",
    "digest",
    "actor",
    "status",
    "spentUnits",
    "budgetUnits",
  ],
  operations: [
    "height",
    "phase",
    "groupPosition",
    "operationPosition",
    "kind",
    "namespaceId",
    "recordId",
    "outcome",
    "receipt",
  ],
  namespaces: ["namespaceId", "name", "owner", "revision"],
  records: [
    "recordId",
    "recordKey",
    "attributes",
    "fields",
    "expiresAtHeight",
    "createdAtHeight",
    "updatedAtHeight",
  ],
  raw: ["key", "byteLength", "digest"],
  "record-history": [
    "height",
    "phase",
    "groupPosition",
    "operationPosition",
    "kind",
    "recordId",
    "outcome",
    "receipt",
  ],
};
const labels: Record<string, string> = {
  spentUnits: "Execution units",
  budgetUnits: "Unit budget",
  expiresAtHeight: "Expires at block",
  stateRoot: "State root",
  recordId: "Record ID",
  recordKey: "Record key",
  namespaceId: "Namespace",
  byteLength: "Value bytes",
  transactionCount: "Transactions",
  operationCount: "Operations",
  timestampMs: "Logical time (ms)",
};
const title = (value: string) =>
  labels[value] ??
  value.replace(/([A-Z])/g, " $1").replace(/^./, (c) => c.toUpperCase());
const short = (value: string) =>
  /^0x[0-9a-f]{40,}$/.test(value)
    ? `${value.slice(0, 12)}…${value.slice(-8)}`
    : value;

function Table({
  rows,
  kind,
  select,
}: {
  rows: NativeRow[];
  kind: string;
  select?: (row: NativeRow) => void;
}) {
  return (
    <div className="sim-table-wrap">
      <table className="sim-table">
        <thead>
          <tr>
            {(columns[kind] ?? columns.records).map((c) => (
              <th key={c}>{title(c)}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, index) => (
            <tr key={index}>
              {(columns[kind] ?? columns.records).map((c, cell) => {
                const text =
                  c === "expiresAtHeight" && row[c] === "18446744073709551615"
                    ? "Permanent"
                    : displayNative(row[c]);
                return (
                  <td key={c} title={text}>
                    {cell === 0 && select ? (
                      <button className="sim-link" onClick={() => select(row)}>
                        {short(text)}
                      </button>
                    ) : (
                      <span>{short(text)}</span>
                    )}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
      {!rows.length && (
        <p className="sim-empty">No matching metadata at this snapshot.</p>
      )}
    </div>
  );
}

function Metadata({ value }: { value: NativeRow }) {
  return (
    <dl className="sim-metadata">
      {Object.entries(value).map(([key, v]) => (
        <div key={key}>
          <dt>{title(key)}</dt>
          <dd>{displayNative(v)}</dd>
        </div>
      ))}
    </dl>
  );
}

export function SimulatorView() {
  const auth = useAuth();
  const initial = new URLSearchParams(window.location.search);
  const [tab, setTab] = useState<Tab>(
    tabs.includes(initial.get("sim") as Tab)
      ? (initial.get("sim") as Tab)
      : "overview",
  );
  const [status, setStatus] = useState<NativeStatus | null>(null);
  const [statistics, setStatistics] = useState<Record<string, string>>({});
  const [statusError, setStatusError] = useState("");
  const [height, setHeight] = useState(initial.get("at") ?? "latest");
  const [namespace, setNamespace] = useState(initial.get("namespace") ?? "1");
  const [recordKey, setRecordKey] = useState(initial.get("key") ?? "");
  const [recordId, setRecordId] = useState(initial.get("record") ?? "");
  const [actor, setActor] = useState("");
  const [outcome, setOutcome] = useState("");
  const [page, setPage] = useState<NativePage | null>(null);
  const [detail, setDetail] = useState<NativeRow | null>(null);
  const [blockDetail, setBlockDetail] = useState<NativeRow | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [attribute, setAttribute] = useState("group");
  const [valueType, setValueType] = useState<EqSelection["valueType"]>("u64");
  const [value, setValue] = useState("1");
  const [operator, setOperator] = useState("eq");
  const [pageSize, setPageSize] = useState(3);
  const [verified, setVerified] = useState<VerifiedPage | null>(null);
  const [verifiedRequest, setVerifiedRequest] = useState<EqSelection | null>(
    null,
  );
  const [controlResult, setControlResult] = useState("");
  const [controlError, setControlError] = useState("");
  const [controlBusy, setControlBusy] = useState(false);
  const [retryCommand, setRetryCommand] = useState<NativeRow | null>(null);
  const [payloadBytes, setPayloadBytes] = useState(64);
  const [extraRows, setExtraRows] = useState(0);
  const request = useRef(0);
  const identityKey = useRef("");
  const controlGeneration = useRef(0);

  useEffect(() => {
    const controller = new AbortController();
    let active = true;
    let inFlight = false;
    const poll = async () => {
      if (inFlight) return;
      inFlight = true;
      try {
        const result = (await nativeGet(
          "statistics",
          {},
          controller.signal,
        )) as NativeStatus;
        if (!active) return;
        const key = JSON.stringify(result.identity);
        if (identityKey.current && identityKey.current !== key) {
          ++request.current;
          ++controlGeneration.current;
          setControlBusy(false);
          setBusy(false);
          setBlockDetail(null);
          setPage(null);
          setVerified(null);
          setVerifiedRequest(null);
          setDetail(null);
          setRetryCommand(null);
          setControlResult("");
          setControlError("");
          setError("Source identity changed. Start a new snapshot query.");
        }
        identityKey.current = key;
        setStatus(result);
        setStatistics(result.counters ?? {});
        setStatusError("");
      } catch (e) {
        if (active)
          setStatusError(e instanceof Error ? e.message : "Source unavailable");
      } finally {
        inFlight = false;
      }
    };
    void poll();
    const timer = window.setInterval(() => void poll(), 2000);
    return () => {
      active = false;
      controller.abort();
      window.clearInterval(timer);
    };
  }, []);

  function navigate(next: Tab, selected?: NativeRow) {
    ++request.current;
    setTab(next);
    setPage(null);
    setDetail(null);
    setBlockDetail(null);
    setError("");
    setVerified(null);
    setVerifiedRequest(null);
    setBusy(false);
    const params = new URLSearchParams({ sim: next, at: height });
    if (["records", "raw", "record-history", "query"].includes(next))
      params.set("namespace", namespace);
    if (selected?.recordKey ?? recordKey)
      params.set("key", String(selected?.recordKey ?? recordKey));
    if (selected?.recordId ?? recordId)
      params.set("record", String(selected?.recordId ?? recordId));
    window.history.replaceState(null, "", `/?${params}`);
  }
  function clearResult() {
    ++request.current;
    setPage(null);
    setVerified(null);
    setVerifiedRequest(null);
    setDetail(null);
    setBlockDetail(null);
    setBusy(false);
    setError("");
  }
  const scalar = (): string | boolean => {
    if (valueType === "bool") {
      if (value !== "true" && value !== "false")
        throw new Error("Boolean values are true or false.");
      return value === "true";
    }
    return value;
  };
  async function load(cursor?: string) {
    if (!status) {
      setError("Wait for source identity before querying.");
      return;
    }
    const generation = ++request.current;
    setBusy(true);
    setError("");
    setVerified(null);
    setVerifiedRequest(null);
    if (!cursor) {
      setPage(null);
      setDetail(null);
      setBlockDetail(null);
    }
    try {
      const params: Record<string, string> = {
        atHeight: height,
        limit: String(pageSize),
      };
      if (cursor) params.cursor = cursor;
      if (
        ["records", "raw", "record-history", "operations", "query"].includes(
          tab,
        )
      )
        params.namespaceId = namespace;
      if (recordKey && ["records", "record-history"].includes(tab))
        params.recordKey = recordKey;
      if (recordId && ["records", "record-history"].includes(tab))
        params.recordId = recordId;
      if (actor && tab === "transactions") params.actor = actor;
      if (outcome && tab === "transactions") params.status = outcome;
      const data =
        tab === "query"
          ? await nativeQuery({
              namespaceId: namespace,
              atHeight: height,
              limit: pageSize,
              ...(cursor ? { cursor } : {}),
              predicate:
                operator === "exists"
                  ? { op: "exists", name: attribute }
                  : {
                      op: operator,
                      attribute: {
                        name: attribute,
                        type: valueType,
                        value: scalar(),
                      },
                    },
            })
          : await nativeGet(tab, params);
      const next = data as NativePage;
      if (
        next.verification !== "unverified-projection" ||
        !Array.isArray(next.rows) ||
        !next.snapshot ||
        !sameIdentity(next.identity, status.identity) ||
        (height !== "latest" && next.snapshot.height !== height)
      )
        throw new Error("Invalid projection response");
      if (generation === request.current) {
        setPage(next);
        setHeight(next.snapshot.height);
      }
    } catch (e) {
      if (generation === request.current) {
        setPage(null);
        setError(e instanceof Error ? e.message : "Request failed");
      }
    } finally {
      if (generation === request.current) setBusy(false);
    }
  }
  async function verify(next = false) {
    if (!status) return;
    const generation = ++request.current;
    setBusy(true);
    setError("");
    setPage(null);
    const previous = verified;
    setVerified(null);
    try {
      const resolved = height === "latest" ? status.indexed?.height : height;
      if (!resolved)
        throw new Error(
          "Wait for an indexed block or select an explicit height.",
        );
      const selection: EqSelection =
        next && verifiedRequest && previous?.continuation
          ? { ...verifiedRequest, cursor: previous.continuation }
          : {
              height: resolved,
              namespace,
              attribute,
              valueType,
              value: scalar(),
              limit: pageSize,
              cursor: null,
            };
      const result = await localVerifiedQuery(status.identity, selection);
      if (
        next &&
        previous &&
        (result.snapshot.hash !== previous.snapshot.hash ||
          result.snapshot.stateRoot !== previous.snapshot.stateRoot)
      )
        throw new Error("Verifier snapshot changed during pagination");
      if (generation === request.current) {
        setVerified(result);
        setVerifiedRequest(selection);
        setHeight(result.snapshot.height);
      }
    } catch (e) {
      if (generation === request.current) {
        setVerifiedRequest(null);
        setError(e instanceof Error ? e.message : "Verification failed");
      }
    } finally {
      if (generation === request.current) setBusy(false);
    }
  }
  async function select(row: NativeRow) {
    const generation = ++request.current;
    setDetail(row);
    setBlockDetail(null);
    if (tab === "blocks" || tab === "transactions") {
      try {
        const block = (await nativeGet(
          `blocks/${String(row.height)}`,
        )) as NativeRow;
        if (
          !status ||
          !sameIdentity(block, status.identity) ||
          (block.header as NativeRow)?.height !== String(row.height)
        )
          throw new Error("Block binding mismatch");
        if (generation === request.current) setBlockDetail(block);
      } catch {
        if (generation === request.current)
          setError("Block metadata unavailable");
      }
    }
  }
  const lag =
    status?.producer && status.indexed
      ? (
          BigInt(status.producer.head.height) - BigInt(status.indexed.height)
        ).toString()
      : "—";
  async function control(
    action: "pause" | "resume" | "step" | "configure",
    retry = false,
  ) {
    if (
      !status?.producer ||
      auth.session.role !== "admin" ||
      !auth.session.csrfToken ||
      controlBusy
    )
      return;
    const generation = ++controlGeneration.current;
    setControlBusy(true);
    setControlError("");
    setControlResult("");
    const producer = status.producer;
    const command =
      retry && retryCommand
        ? retryCommand
        : {
            commandId:
              "0x" +
              Array.from(crypto.getRandomValues(new Uint8Array(32)), (b) =>
                b.toString(16).padStart(2, "0"),
              ).join(""),
            runId: status.identity.runId,
            expectedRevision: producer.configRevision,
            expectedHeight: action === "step" ? producer.head.height : null,
            action,
            config:
              action === "configure"
                ? {
                    ...producer.workload,
                    payloadBytes,
                    extraRowsPerBlock: extraRows,
                  }
                : null,
          };
    try {
      const result = (await nativeControl(
        command,
        auth.session.csrfToken,
      )) as NativeRow;
      if (generation !== controlGeneration.current) return;
      setRetryCommand(null);
      setControlResult(
        `${displayNative(result.status)} · head ${displayNative((result.head as NativeRow)?.height)} · revision ${displayNative(result.configRevision)}`,
      );
    } catch (e) {
      if (generation !== controlGeneration.current) return;
      const uncertain = retrySameControl(e);
      setRetryCommand(uncertain ? command : null);
      setControlError(
        `${e instanceof Error ? e.message : "Control unavailable"}. ${uncertain ? "Retry preserves this command ID; do not create another step to guess its outcome." : "Command rejected. Refreshing producer state; a new command can be submitted."}`,
      );
      if (!uncertain) {
        try {
          const current = (await nativeGet("statistics")) as NativeStatus;
          if (
            generation === controlGeneration.current &&
            sameIdentity(current.identity, status.identity)
          )
            setStatus(current);
        } catch {
          /* Normal status polling will retry. */
        }
      }
    } finally {
      if (generation === controlGeneration.current) setControlBusy(false);
    }
  }

  useEffect(() => {
    ++controlGeneration.current;
    setControlBusy(false);
    setRetryCommand(null);
    setControlResult("");
    setControlError("");
    return () => {
      ++controlGeneration.current;
    };
  }, [auth.session.role, auth.session.user?.id]);

  return (
    <div className="sim-shell">
      <header className="sim-header">
        <div>
          <div className="sim-eyebrow">ARKIV / NATIVE EXPLORER</div>
          <h1>Chain simulator</h1>
          <p>Independent PostgreSQL explorer · complete retained history</p>
        </div>
        <AccountControls auth={auth} />
      </header>
      <div className="sim-trust">
        <strong>Unsigned simulator</strong>
        <span>
          Configured source trust. No consensus or producer authentication.
        </span>
        <span className="sim-badge">Unverified projection</span>
      </div>
      {statusError && (
        <div role="alert" className="sim-error">
          Source unavailable: {statusError}
        </div>
      )}
      <div className="sim-metrics">
        {[
          ["Producer head", status?.producer?.head.height ?? "—"],
          ["Indexed head", status?.indexed?.height ?? "—"],
          ["Observed lag", lag],
          ["Execution units", statistics.spentUnits ?? "—"],
          ["Live records", statistics.liveRecords ?? "—"],
          [
            "Producer",
            status?.producer
              ? status.producer.health ===
                (status.producer.paused ? "paused" : "running")
                ? title(status.producer.health)
                : `${status.producer.health} · ${status.producer.paused ? "paused" : "active"}`
              : "Unavailable",
          ],
        ].map(([label, text]) => (
          <div key={label}>
            <span>{label}</span>
            <strong>{text}</strong>
          </div>
        ))}
      </div>
      <nav className="sim-nav" aria-label="Simulator views">
        {tabs.map((t) => (
          <button
            key={t}
            className={tab === t ? "active" : ""}
            onClick={() => navigate(t)}
          >
            {title(t.replace("-", " "))}
          </button>
        ))}
      </nav>
      {tab === "overview" ? (
        <section className="sim-panel">
          <h2>Run identity & coverage</h2>
          {status ? (
            <>
              <Metadata
                value={{
                  ...status.identity,
                  authentication: status.authentication,
                  indexedHeight: status.indexed?.height,
                  indexedHash: status.indexed?.hash,
                  stateRoot: status.indexed?.stateRoot,
                  coverage: status.coverage,
                  health: status.health,
                }}
              />
              <h2>Native totals</h2>
              <Metadata value={statistics} />
              <p className="sim-muted">
                Counts refer to the contiguous indexed history. Field and raw
                values are represented only by size and digest; indexed
                attributes are intentional metadata.
              </p>
              {status.producer && (
                <>
                  <h2>Workload & noncanonical telemetry</h2>
                  <Metadata
                    value={{
                      ...status.producer.workload,
                      configRevision: status.producer.configRevision,
                      ...status.producer.memory,
                    }}
                  />
                </>
              )}
              {auth.session.role === "admin" && status.controlAvailable && (
                <div className="sim-detail">
                  <h2>Producer controls</h2>
                  <p className="sim-muted">
                    Pause and resume are volatile runtime controls. Step is
                    idempotent and commits one normal block; workload changes
                    take effect in the next block. Restart begins paused.
                  </p>
                  <div className="sim-filters">
                    {(["pause", "step", "resume"] as const).map((action) => (
                      <button
                        key={action}
                        disabled={
                          controlBusy ||
                          !!retryCommand ||
                          !status.producer ||
                          (action === "step" && !status.producer.paused)
                        }
                        onClick={() => void control(action)}
                      >
                        {title(action)}
                      </button>
                    ))}
                    <label>
                      Field payload bytes
                      <input
                        type="number"
                        min={0}
                        max={1024}
                        value={payloadBytes}
                        onChange={(e) =>
                          setPayloadBytes(Number(e.target.value))
                        }
                      />
                    </label>
                    <label>
                      Extra rows / block
                      <input
                        type="number"
                        min={0}
                        max={4}
                        value={extraRows}
                        onChange={(e) => setExtraRows(Number(e.target.value))}
                      />
                    </label>
                    <button
                      className="secondary"
                      disabled={
                        controlBusy || !!retryCommand || !status.producer
                      }
                      onClick={() => void control("configure")}
                    >
                      Queue workload configuration
                    </button>
                  </div>
                  {controlResult && <p role="status">{controlResult}</p>}
                  {controlError && (
                    <div className="sim-error" role="alert">
                      {controlError}
                    </div>
                  )}
                  {retryCommand && (
                    <button
                      className="secondary"
                      disabled={controlBusy}
                      onClick={() =>
                        void control(retryCommand.action as "step", true)
                      }
                    >
                      Retry same command
                    </button>
                  )}
                </div>
              )}
            </>
          ) : (
            <p>Waiting for the native scanner…</p>
          )}
        </section>
      ) : (
        <section className="sim-panel">
          <div className="sim-section-heading">
            <div>
              <h2>{title(tab.replace("-", " "))}</h2>
              <p className="sim-muted">
                Queries resolve one terminal block. Loading newer blocks never
                changes a pinned page.
              </p>
            </div>
            <span className="sim-badge">
              Ascending{" "}
              {tab === "records" || tab === "query"
                ? "record ID"
                : "execution order"}
            </span>
          </div>
          <form
            className="sim-filters"
            onChange={clearResult}
            onSubmit={(e) => {
              e.preventDefault();
              void load();
            }}
          >
            <label>
              Snapshot height
              <input
                aria-label="Snapshot height"
                value={height}
                onChange={(e) => setHeight(e.target.value)}
                placeholder="latest"
              />
            </label>
            <button
              type="button"
              className="secondary"
              onClick={() => {
                clearResult();
                setHeight("latest");
              }}
            >
              Use indexed latest
            </button>
            {[
              "records",
              "raw",
              "record-history",
              "operations",
              "query",
            ].includes(tab) && (
              <label>
                Namespace
                <input
                  value={namespace}
                  onChange={(e) => setNamespace(e.target.value)}
                  inputMode="numeric"
                />
              </label>
            )}
            {["records", "record-history"].includes(tab) && (
              <>
                <label>
                  Record key
                  <input
                    value={recordKey}
                    onChange={(e) => setRecordKey(e.target.value)}
                    placeholder="0x… (optional)"
                  />
                </label>
                <label>
                  Incarnation ID
                  <input
                    value={recordId}
                    onChange={(e) => setRecordId(e.target.value)}
                    placeholder="Optional"
                  />
                </label>
              </>
            )}
            {tab === "transactions" && (
              <>
                <label>
                  Actor
                  <input
                    value={actor}
                    onChange={(e) => setActor(e.target.value)}
                    placeholder="0x… (optional)"
                  />
                </label>
                <label>
                  Outcome
                  <select
                    value={outcome}
                    onChange={(e) => setOutcome(e.target.value)}
                  >
                    <option value="">All</option>
                    <option value="committed">Committed</option>
                    <option value="failed">Failed</option>
                  </select>
                </label>
              </>
            )}
            {tab === "query" && (
              <>
                <label>
                  Attribute
                  <input
                    value={attribute}
                    onChange={(e) => setAttribute(e.target.value)}
                  />
                </label>
                <label>
                  Operator
                  <select
                    value={operator}
                    onChange={(e) => setOperator(e.target.value)}
                  >
                    {["eq", "lt", "lte", "gt", "gte", "prefix", "exists"].map(
                      (op) => (
                        <option key={op}>{op}</option>
                      ),
                    )}
                  </select>
                </label>
                <label>
                  Native type
                  <select
                    value={valueType}
                    onChange={(e) =>
                      setValueType(e.target.value as EqSelection["valueType"])
                    }
                  >
                    {["bool", "i64", "u64", "str"].map((t) => (
                      <option key={t}>{t}</option>
                    ))}
                  </select>
                </label>
                <label>
                  Value
                  <input
                    value={value}
                    onChange={(e) => setValue(e.target.value)}
                  />
                </label>
              </>
            )}
            <label>
              Page size
              <select
                value={pageSize}
                onChange={(e) => setPageSize(Number(e.target.value))}
              >
                {[1, 3, 16, 64].map((n) => (
                  <option key={n}>{n}</option>
                ))}
              </select>
            </label>
            <button type="submit" disabled={busy}>
              {busy ? "Loading…" : "Read projection"}
            </button>
            {tab === "query" && (
              <button
                type="button"
                className="secondary"
                disabled={busy || operator !== "eq" || !status}
                onClick={() => void verify()}
              >
                Verify Eq locally
              </button>
            )}
          </form>
          {tab === "query" && (
            <p className="sim-muted">
              Local verification supports positive typed equality only. It uses
              the local Rust light process and its pinned unsigned simulator
              roots. A remote dashboard without that local path shows projection
              results only.
            </p>
          )}
          {error && (
            <div role="alert" className="sim-error">
              {error}
              {tab === "query" && " · No verified rows released."}
            </div>
          )}
          {page && (
            <>
              <div className="sim-result-heading">
                <span className="sim-badge">Unverified projection</span>
                <span>
                  Block {page.snapshot.height} ·{" "}
                  <code title={page.snapshot.hash}>
                    {short(page.snapshot.hash)}
                  </code>
                </span>
              </div>
              <Table
                rows={page.rows}
                kind={tab === "query" ? "records" : tab}
                select={(r) => void select(r)}
              />
              <button
                className="secondary"
                disabled={busy || !page.nextCursor}
                onClick={() => page.nextCursor && void load(page.nextCursor)}
              >
                Next pinned page
              </button>
            </>
          )}
          {verified && (
            <>
              <div className="sim-result-heading">
                <span className="sim-badge verified">
                  Proof verified against trusted simulator root; unsigned source
                </span>
                <span>
                  Block {verified.snapshot.height} · {verified.postingCount}{" "}
                  matching IDs
                </span>
              </div>
              <code className="sim-root">{verified.snapshot.stateRoot}</code>
              <Table rows={verified.rows} kind="records" />
              <button
                className="secondary"
                disabled={busy || !verified.continuation}
                onClick={() => void verify(true)}
              >
                Next verified page
              </button>
            </>
          )}
          {detail && (
            <aside className="sim-detail">
              <h3>Selected {tab === "records" ? "incarnation" : "metadata"}</h3>
              <Metadata value={detail} />
              {tab === "records" && (
                <button
                  className="secondary"
                  onClick={() => {
                    setRecordKey(String(detail.recordKey));
                    setRecordId(String(detail.recordId));
                    navigate("record-history", detail);
                  }}
                >
                  View this incarnation’s operations
                </button>
              )}
              {blockDetail && (
                <>
                  <h3>Block transactions</h3>
                  <Table
                    rows={(blockDetail.transactions ?? []) as NativeRow[]}
                    kind="transactions"
                  />
                  <h3>Ordered execution outcomes</h3>
                  <Table
                    rows={(blockDetail.operations ?? []) as NativeRow[]}
                    kind="operations"
                  />
                </>
              )}
            </aside>
          )}
        </section>
      )}
      <footer className="sim-footer">
        Engine state is authoritative. PostgreSQL can be rebuilt from genesis.
        History is retained without pruning. Abstract execution units are
        independent of Ethereum gas or fees.
      </footer>
    </div>
  );
}

import { useEffect, useRef, useState } from "react";
import { AccountControls } from "./AccountControls";
import { ProducerControls } from "./ProducerControls";
import { useAuth } from "./useAuth";
import {
  displayNative,
  sameIdentity,
  localVerifiedQuery,
  nativeGet,
  nativeNodes,
  nativeQuery,
  peerUiUrl,
  verifierText,
  type EqSelection,
  type NativeNodes,
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
/** The filters a page load reads; explicit overrides let search act before state settles. */
type Filters = {
  tab: Tab;
  height: string;
  namespace: string;
  recordKey: string;
  recordId: string;
  actor: string;
  outcome: string;
  digest: string;
};
const NODE_LABELS = {
  producer: "Producer",
  full: "Full follower",
  light: "Light follower",
} as const;
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
  const [digest, setDigest] = useState("");
  const [search, setSearch] = useState("");
  const [sources, setSources] = useState<NativeNodes | null>(null);
  const [sourcesError, setSourcesError] = useState("");
  const request = useRef(0);
  const identityKey = useRef("");
  const verifier = verifierText();
  const peer = peerUiUrl();

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
          setBusy(false);
          setBlockDetail(null);
          setPage(null);
          setVerified(null);
          setVerifiedRequest(null);
          setDetail(null);
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

  useEffect(() => {
    document.title = "Arkiv simulator explorer";
  }, []);

  // Indexing progress across the deployment's nodes; only the overview shows it.
  useEffect(() => {
    if (tab !== "overview") return;
    const controller = new AbortController();
    let active = true;
    const poll = async () => {
      try {
        const result = await nativeNodes(controller.signal);
        if (active) {
          setSources(result);
          setSourcesError("");
        }
      } catch (e) {
        if (active)
          setSourcesError(e instanceof Error ? e.message : "Sources unavailable");
      }
    };
    void poll();
    const timer = window.setInterval(() => void poll(), 5000);
    return () => {
      active = false;
      controller.abort();
      window.clearInterval(timer);
    };
  }, [tab]);

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
  async function load(cursor?: string, overrides: Partial<Filters> = {}) {
    if (!status) {
      setError("Wait for source identity before querying.");
      return;
    }
    const f: Filters = {
      tab,
      height,
      namespace,
      recordKey,
      recordId,
      actor,
      outcome,
      digest,
      ...overrides,
    };
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
        atHeight: f.height,
        limit: String(pageSize),
      };
      if (cursor) params.cursor = cursor;
      if (
        ["records", "raw", "record-history", "operations", "query"].includes(
          f.tab,
        )
      )
        params.namespaceId = f.namespace;
      if (f.recordKey && ["records", "record-history"].includes(f.tab))
        params.recordKey = f.recordKey;
      if (f.recordId && ["records", "record-history"].includes(f.tab))
        params.recordId = f.recordId;
      if (f.actor && f.tab === "transactions") params.actor = f.actor;
      if (f.outcome && f.tab === "transactions") params.status = f.outcome;
      if (f.digest && f.tab === "transactions") params.digest = f.digest;
      const data =
        f.tab === "query"
          ? await nativeQuery({
              namespaceId: f.namespace,
              atHeight: f.height,
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
          : await nativeGet(f.tab, params);
      const next = data as NativePage;
      if (
        next.verification !== "unverified-projection" ||
        !Array.isArray(next.rows) ||
        !next.snapshot ||
        !sameIdentity(next.identity, status.identity) ||
        (f.height !== "latest" && next.snapshot.height !== f.height)
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
  async function openBlock(h: string) {
    navigate("blocks");
    const generation = ++request.current;
    setDetail({ height: h });
    try {
      const block = (await nativeGet(`blocks/${h}`)) as NativeRow;
      if (
        !status ||
        !sameIdentity(block, status.identity) ||
        (block.header as NativeRow)?.height !== h
      )
        throw new Error("Block binding mismatch");
      if (generation === request.current) setBlockDetail(block);
    } catch (e) {
      if (generation === request.current)
        setError(
          `Block ${h}: ${e instanceof Error ? e.message : "metadata unavailable"}`,
        );
    }
  }
  /** One box for the identifiers people paste: a height, a 20-byte actor, a
   * 32-byte transaction digest (falling back to a 32-byte record key in the
   * current namespace) or a shorter record key. */
  async function find(term: string) {
    if (!status) return;
    const value = term.trim().toLowerCase();
    if (/^[0-9]+$/.test(value)) {
      await openBlock(value);
      return;
    }
    if (!/^0x(?:[0-9a-f]{2}){1,32}$/.test(value)) {
      setError(
        "Enter a block height, a 32-byte transaction digest, a 20-byte actor or a 1–32-byte record key.",
      );
      return;
    }
    const size = (value.length - 2) / 2;
    if (size === 20) {
      setActor(value);
      setDigest("");
      setOutcome("");
      navigate("transactions");
      await load(undefined, {
        tab: "transactions",
        actor: value,
        digest: "",
        outcome: "",
      });
      return;
    }
    if (size === 32) {
      try {
        const probe = (await nativeGet("transactions", {
          atHeight: height,
          limit: "1",
          digest: value,
        })) as NativePage;
        if (Array.isArray(probe.rows) && probe.rows.length) {
          setDigest(value);
          setActor("");
          setOutcome("");
          navigate("transactions");
          await load(undefined, {
            tab: "transactions",
            digest: value,
            actor: "",
            outcome: "",
          });
          return;
        }
      } catch {
        /* Fall through to the record-key interpretation. */
      }
    }
    setRecordKey(value);
    setRecordId("");
    navigate("records");
    await load(undefined, { tab: "records", recordKey: value, recordId: "" });
  }

  return (
    <div className="sim-shell">
      <header className="sim-header">
        <div>
          <div className="sim-eyebrow">ARKIV / NATIVE EXPLORER</div>
          <h1>Chain simulator</h1>
          <p>Independent PostgreSQL explorer · complete retained history</p>
        </div>
        <div className="sim-header-side">
          <AccountControls auth={auth} />
          {peer && (
            <a className="sim-peer-link" href={peer}>
              Debug console ↗
            </a>
          )}
        </div>
      </header>
      <form
        className="sim-search"
        role="search"
        onSubmit={(e) => {
          e.preventDefault();
          void find(search);
        }}
      >
        <input
          aria-label="Search"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Block height, transaction digest, actor or record key"
        />
        <button type="submit" disabled={!status || busy}>
          Search
        </button>
      </form>
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
              <h2>Indexing progress</h2>
              {sources ? (
                <div className="sim-sources">
                  {(["producer", "full", "light"] as const).map((role) => {
                    const r = sources.nodes[role];
                    return (
                      <div key={role}>
                        <span>{NODE_LABELS[role]}</span>
                        <strong>
                          {!r.configured
                            ? "not configured"
                            : !r.available
                              ? `unavailable · ${r.error ?? "unknown"}`
                              : `block ${r.status?.head.height} · ${r.status?.health}${r.status?.paused ? " · paused" : ""}`}
                        </strong>
                      </div>
                    );
                  })}
                  <div>
                    <span>Explorer projection</span>
                    <strong>
                      {sources.explorer.indexed
                        ? `block ${sources.explorer.indexed.height} · ${sources.explorer.health}`
                        : `nothing indexed · ${sources.explorer.health}`}
                    </strong>
                  </div>
                  <div>
                    <span>PostgreSQL relation bytes</span>
                    <strong>
                      {sources.explorer.storage.relationBytes ?? "unavailable"}
                    </strong>
                  </div>
                </div>
              ) : (
                <p className="sim-muted" role="status">
                  {sourcesError
                    ? `Sources unavailable: ${sourcesError}`
                    : "Reading sources…"}
                </p>
              )}
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
                      ...(status.producer.storage ?? {}),
                    }}
                  />
                </>
              )}
              {auth.session.role === "admin" && status.controlAvailable && (
                <ProducerControls
                  key={JSON.stringify(status.identity)}
                  status={status}
                  auth={auth}
                  onStatus={setStatus}
                />
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
                <label>
                  Digest
                  <input
                    value={digest}
                    onChange={(e) => setDigest(e.target.value)}
                    placeholder="0x… 32 bytes (optional)"
                  />
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
                {verifier.button}
              </button>
            )}
          </form>
          {tab === "query" && (
            <p className="sim-muted">
              Proof verification supports positive typed equality only. It runs
              on {verifier.where}, using the Rust light process and its pinned
              unsigned simulator roots; it is not consensus. A deployment
              without that path shows projection results only.
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
                <span className="sim-badge verified">{verifier.badge}</span>
                <span>
                  Block {verified.snapshot.height} · {verified.postingCount}{" "}
                  matching IDs
                </span>
              </div>
              <code className="sim-root">{verified.snapshot.stateRoot}</code>
              {verified.diagnostics && (
                <p className="sim-muted">
                  {verified.diagnostics.verifier} · proof{" "}
                  {verified.diagnostics.proofBytes} bytes · fetched in{" "}
                  {verified.diagnostics.fetchMs} ms · verified in{" "}
                  {verified.diagnostics.verifyMs} ms
                </p>
              )}
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

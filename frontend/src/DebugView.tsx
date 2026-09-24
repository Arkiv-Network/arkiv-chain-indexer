import { useEffect, useRef, useState } from "react";
import { AccountControls } from "./AccountControls";
import { ProducerControls } from "./ProducerControls";
import { useAuth } from "./useAuth";
import {
  displayNative,
  localVerifiedQuery,
  nativeGet,
  nativeNodes,
  nativeQuery,
  peerUiUrl,
  publicNodeUrl,
  sameIdentity,
  verifierText,
  type EqSelection,
  type NativeIdentity,
  type NativeNodes,
  type NativePage,
  type NativeStatus,
  type NodeReport,
  type VerifiedPage,
} from "./simulatorApi";
import "./simulator.css";
import "./debug.css";

const UNAVAILABLE = "unavailable";
const PERMANENT = "18446744073709551615";
const short = (value: string) =>
  /^0x[0-9a-f]{40,}$/.test(value)
    ? `${value.slice(0, 10)}…${value.slice(-6)}`
    : value;
const title = (value: string) =>
  value.replace(/([A-Z])/g, " $1").replace(/^./, (c) => c.toUpperCase());
function bytes(value: string | null | undefined): string {
  if (value === null || value === undefined) return UNAVAILABLE;
  const n = Number(value);
  if (!Number.isFinite(n)) return value;
  if (n >= 1024 * 1024 * 1024) return `${(n / 1024 / 1024 / 1024).toFixed(2)} GiB`;
  if (n >= 1024 * 1024) return `${(n / 1024 / 1024).toFixed(2)} MiB`;
  if (n >= 1024) return `${(n / 1024).toFixed(1)} KiB`;
  return `${n} B`;
}
/** Height difference when both sides are known; anything else stays explicitly unknown. */
function lag(ahead?: string | null, behind?: string | null): string {
  if (!ahead || !behind) return UNAVAILABLE;
  return (BigInt(ahead) - BigInt(behind)).toString();
}
const message = (e: unknown, fallback: string) =>
  e instanceof Error ? e.message : fallback;

interface FeedHeader {
  height: string;
  hash: string;
  parentHash: string;
  stateRoot: string;
  timestampMs: string;
  inputsDigest: string;
  outcomesDigest: string;
}
interface FeedTransaction {
  position: number;
  digest: string;
  actor: string;
  requestId: string;
  budgetUnits: string;
  status: string;
  spentUnits: string;
}
interface FeedOperation {
  phase: string;
  groupPosition: number;
  operationPosition: number;
  kind: string;
  namespaceId: string | null;
  recordId: string | null;
  recordKey: string | null;
  outcome: string;
  receipt: { modelVersion: number; scheduleId: number; spentUnits: string } | null;
  reason: string | null;
}
interface FeedChange {
  kind: string;
  namespaceId: string;
  recordId?: string;
  recordKey?: string;
  key?: string;
  expiresAtHeight?: string;
  attributes?: unknown[];
  fields?: unknown[];
  name?: string;
  owner?: string;
  revision?: string;
  byteLength?: string;
}
interface FeedBlockView extends NativeIdentity {
  feedDigest: string;
  header: FeedHeader;
  transactions: FeedTransaction[];
  operations: FeedOperation[];
  changes: FeedChange[];
  spentUnits: string;
}

function State({ kind, text }: { kind: "ok" | "warn" | "bad" | "off"; text: string }) {
  return <span className={`dbg-state ${kind}`}>{text}</span>;
}

function healthKind(report: NodeReport): "ok" | "warn" | "bad" | "off" {
  if (!report.configured) return "off";
  if (!report.available) return "bad";
  const h = report.status?.health ?? "";
  if (h === "running" || h === "following" || h === "ready") return "ok";
  if (h === "paused") return "warn";
  return "bad";
}

function NodeCard({
  label,
  report,
  producerHeight,
}: {
  label: string;
  report: NodeReport;
  producerHeight: string | null;
}) {
  const s = report.status;
  return (
    <div className="dbg-card">
      <h3>
        {label}
        <State
          kind={healthKind(report)}
          text={
            !report.configured
              ? "not configured"
              : !report.available
                ? `unavailable · ${report.error ?? "unknown"}`
                : `${s?.health ?? "unknown"}${s?.paused ? " · paused" : ""}`
          }
        />
      </h3>
      {!report.configured ? (
        <p className="sim-muted">This deployment runs no {label.toLowerCase()}.</p>
      ) : !s ? (
        <dl>
          <dt>Probe</dt>
          <dd>
            failed after {report.latencyMs ?? "?"} ms · {report.error ?? UNAVAILABLE}
          </dd>
        </dl>
      ) : (
        <dl>
          <dt>Height</dt>
          <dd>{s.head.height}</dd>
          <dt>Hash</dt>
          <dd title={s.head.hash}>{short(s.head.hash)}</dd>
          <dt>State root</dt>
          <dd title={s.head.stateRoot}>{short(s.head.stateRoot)}</dd>
          {report.role !== "producer" && (
            <>
              <dt>Lag vs producer</dt>
              <dd>{lag(producerHeight, s.head.height)}</dd>
              <dt>Observed peer</dt>
              <dd>{s.observedPeerHeight ?? UNAVAILABLE}</dd>
            </>
          )}
          {report.role === "producer" && (
            <>
              <dt>Config revision</dt>
              <dd>{s.configRevision}</dd>
              <dt>Durability</dt>
              <dd>{s.durability ?? UNAVAILABLE}</dd>
            </>
          )}
          <dt>Probe</dt>
          <dd>{report.latencyMs ?? "?"} ms</dd>
        </dl>
      )}
    </div>
  );
}

function Rows({
  rows,
  columns,
  empty,
}: {
  rows: Record<string, unknown>[];
  columns: [string, string, ((row: Record<string, unknown>) => string)?][];
  empty: string;
}) {
  return (
    <div className="sim-table-wrap">
      <table className="sim-table">
        <thead>
          <tr>
            {columns.map(([key, label]) => (
              <th key={key}>{label}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr key={i}>
              {columns.map(([key, , render]) => {
                const text = render ? render(row) : displayNative(row[key]);
                return (
                  <td key={key} title={text}>
                    <span>{short(text)}</span>
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
      {!rows.length && <p className="sim-empty">{empty}</p>}
    </div>
  );
}

export function DebugView() {
  const auth = useAuth();
  const verifier = verifierText();
  const [nodes, setNodes] = useState<NativeNodes | null>(null);
  const [nodesError, setNodesError] = useState("");
  const [status, setStatus] = useState<NativeStatus | null>(null);
  const [statusError, setStatusError] = useState("");
  const identityKey = useRef("");
  const generation = useRef(0);

  const [blockHeight, setBlockHeight] = useState("");
  const [block, setBlock] = useState<FeedBlockView | null>(null);
  const [blockError, setBlockError] = useState("");
  const [blockBusy, setBlockBusy] = useState(false);

  const [qHeight, setQHeight] = useState("latest");
  const [qNamespace, setQNamespace] = useState("1");
  const [qAttribute, setQAttribute] = useState("group");
  const [qType, setQType] = useState<EqSelection["valueType"]>("u64");
  const [qValue, setQValue] = useState("1");
  const [qLimit, setQLimit] = useState(3);
  const [projection, setProjection] = useState<NativePage | null>(null);
  const [verified, setVerified] = useState<VerifiedPage | null>(null);
  const [verifiedRequest, setVerifiedRequest] = useState<EqSelection | null>(null);
  const [qError, setQError] = useState("");
  const [qBusy, setQBusy] = useState(false);
  const [lastVerification, setLastVerification] = useState<
    { at: string; outcome: string; diagnostics: VerifiedPage["diagnostics"] | null } | null
  >(null);

  const [rKey, setRKey] = useState("");
  const [rId, setRId] = useState("");
  const [incarnations, setIncarnations] = useState<NativePage | null>(null);
  const [history, setHistory] = useState<NativePage | null>(null);
  const [rError, setRError] = useState("");
  const [rBusy, setRBusy] = useState(false);

  useEffect(() => {
    document.title = "Arkiv simulator · debug console";
  }, []);

  function resetInspection(reason: string) {
    ++generation.current;
    setBlock(null);
    setBlockError(reason);
    setProjection(null);
    setVerified(null);
    setVerifiedRequest(null);
    setQError(reason);
    setIncarnations(null);
    setHistory(null);
    setRError(reason);
    setBlockBusy(false);
    setQBusy(false);
    setRBusy(false);
  }

  useEffect(() => {
    const controller = new AbortController();
    let active = true,
      inFlight = false;
    const poll = async () => {
      if (inFlight) return;
      inFlight = true;
      const [topology, statistics] = await Promise.allSettled([
        nativeNodes(controller.signal),
        nativeGet("statistics", {}, controller.signal) as Promise<NativeStatus>,
      ]);
      inFlight = false;
      if (!active) return;
      if (topology.status === "fulfilled") {
        const key = JSON.stringify(topology.value.identity);
        if (identityKey.current && identityKey.current !== key)
          resetInspection("Source identity changed. Start a new inspection.");
        identityKey.current = key;
        setNodes(topology.value);
        setNodesError("");
      } else setNodesError(message(topology.reason, "Topology unavailable"));
      if (statistics.status === "fulfilled") {
        setStatus(statistics.value);
        setStatusError("");
      } else setStatusError(message(statistics.reason, "Explorer API unavailable"));
    };
    void poll();
    const timer = window.setInterval(() => void poll(), 2000);
    return () => {
      active = false;
      controller.abort();
      window.clearInterval(timer);
    };
  }, []);

  const identity: NativeIdentity | null = status?.identity ?? nodes?.identity ?? null;
  const producer = nodes?.nodes.producer ?? null;
  const producerHeight = producer?.status?.head.height ?? null;
  const indexedHeight = nodes?.explorer.indexed?.height ?? status?.indexed?.height ?? null;

  async function loadBlock(requested: string) {
    if (!identity) {
      setBlockError("Wait for the source identity before inspecting blocks.");
      return;
    }
    const h = requested.trim() === "" || requested === "latest" ? indexedHeight : requested.trim();
    if (!h || !/^[0-9]+$/.test(h)) {
      setBlockError("Enter a block height, or wait for an indexed block.");
      return;
    }
    const g = ++generation.current;
    setBlockBusy(true);
    setBlockError("");
    try {
      const data = (await nativeGet(`blocks/${h}`)) as FeedBlockView;
      if (
        !sameIdentity(data, identity) ||
        data.header?.height !== h ||
        !Array.isArray(data.transactions) ||
        !Array.isArray(data.operations) ||
        !Array.isArray(data.changes)
      )
        throw new Error("Invalid block response");
      if (g === generation.current) {
        setBlock(data);
        setBlockHeight(h);
      }
    } catch (e) {
      if (g === generation.current) {
        setBlock(null);
        setBlockError(
          `Block ${h}: ${message(e, "unavailable")}` +
            (message(e, "") === "CoverageUnavailable" ? " · not indexed yet" : ""),
        );
      }
    } finally {
      if (g === generation.current) setBlockBusy(false);
    }
  }

  const scalar = (): string | boolean => {
    if (qType === "bool") {
      if (qValue !== "true" && qValue !== "false")
        throw new Error("Boolean values are true or false.");
      return qValue === "true";
    }
    return qValue;
  };
  const resolvedHeight = () => (qHeight === "latest" || qHeight.trim() === "" ? indexedHeight : qHeight.trim());

  async function readProjection() {
    if (!identity) return;
    const g = ++generation.current;
    setQBusy(true);
    setQError("");
    setProjection(null);
    try {
      const data = (await nativeQuery({
        namespaceId: qNamespace,
        atHeight: resolvedHeight() ?? "latest",
        limit: qLimit,
        predicate: {
          op: "eq",
          attribute: { name: qAttribute, type: qType, value: scalar() },
        },
      })) as NativePage;
      if (
        data.verification !== "unverified-projection" ||
        !Array.isArray(data.rows) ||
        !data.snapshot ||
        !sameIdentity(data.identity, identity)
      )
        throw new Error("Invalid projection response");
      if (g === generation.current) setProjection(data);
    } catch (e) {
      if (g === generation.current) setQError(`Projection: ${message(e, "request failed")}`);
    } finally {
      if (g === generation.current) setQBusy(false);
    }
  }

  async function verify(next = false) {
    if (!identity) return;
    const g = ++generation.current;
    setQBusy(true);
    setQError("");
    const previous = verified;
    setVerified(null);
    try {
      const height = resolvedHeight();
      if (!height) throw new Error("Wait for an indexed block or enter an explicit height.");
      const selection: EqSelection =
        next && verifiedRequest && previous?.continuation
          ? { ...verifiedRequest, cursor: previous.continuation }
          : {
              height,
              namespace: qNamespace,
              attribute: qAttribute,
              valueType: qType,
              value: scalar(),
              limit: qLimit,
              cursor: null,
            };
      const result = await localVerifiedQuery(identity, selection);
      if (
        next &&
        previous &&
        (result.snapshot.hash !== previous.snapshot.hash ||
          result.snapshot.stateRoot !== previous.snapshot.stateRoot)
      )
        throw new Error("Verifier snapshot changed during pagination");
      if (g === generation.current) {
        setVerified(result);
        setVerifiedRequest(selection);
        setLastVerification({
          at: new Date().toISOString(),
          outcome: "verified",
          diagnostics: result.diagnostics ?? null,
        });
      }
    } catch (e) {
      if (g === generation.current) {
        setVerifiedRequest(null);
        setQError(`Verification: ${message(e, "failed")} · no verified rows released.`);
        setLastVerification({ at: new Date().toISOString(), outcome: `rejected · ${message(e, "failed")}`, diagnostics: null });
      }
    } finally {
      if (g === generation.current) setQBusy(false);
    }
  }

  async function lookupRecord() {
    if (!identity) return;
    if (!rKey && !rId) {
      setRError("Enter a record key or an incarnation ID.");
      return;
    }
    const g = ++generation.current;
    setRBusy(true);
    setRError("");
    setIncarnations(null);
    setHistory(null);
    try {
      const params: Record<string, string> = {
        namespaceId: qNamespace,
        atHeight: resolvedHeight() ?? "latest",
        limit: "16",
      };
      if (rKey) params.recordKey = rKey;
      if (rId) params.recordId = rId;
      const [live, ops] = await Promise.all([
        nativeGet("records", params) as Promise<NativePage>,
        nativeGet("record-history", params) as Promise<NativePage>,
      ]);
      for (const page of [live, ops])
        if (
          page.verification !== "unverified-projection" ||
          !Array.isArray(page.rows) ||
          !sameIdentity(page.identity, identity)
        )
          throw new Error("Invalid projection response");
      if (g === generation.current) {
        setIncarnations(live);
        setHistory(ops);
      }
    } catch (e) {
      if (g === generation.current) setRError(`Record lookup: ${message(e, "failed")}`);
    } finally {
      if (g === generation.current) setRBusy(false);
    }
  }

  const outcomes = block
    ? block.operations.reduce<Record<string, number>>((acc, op) => {
        acc[op.outcome] = (acc[op.outcome] ?? 0) + 1;
        return acc;
      }, {})
    : {};
  const expiryDeletions = block
    ? block.operations.filter((op) => op.phase === "expiry" && op.outcome === "applied").length
    : 0;
  const changeKinds = block
    ? block.changes.reduce<Record<string, number>>((acc, c) => {
        acc[c.kind] = (acc[c.kind] ?? 0) + 1;
        return acc;
      }, {})
    : {};
  const node = publicNodeUrl();
  const peer = peerUiUrl();

  return (
    <div className="sim-shell">
      <header className="sim-header">
        <div>
          <div className="sim-eyebrow">ARKIV / SIMULATOR DEBUG CONSOLE</div>
          <h1>Simulator debug console</h1>
          <p>Producer, followers and explorer projection of one unsigned simulator run</p>
        </div>
        <div className="dbg-header-links">
          <AccountControls auth={auth} />
          {peer && <a href={peer}>Open the explorer ↗</a>}
        </div>
      </header>
      <div className="sim-trust">
        <strong>Unsigned simulator</strong>
        <span>
          No blockchain, transaction or producer signatures. Trust is the configured
          source; equality proofs verify against its pinned root, not consensus.
          Verification on this page runs on {verifier.where}.
        </span>
        <span className="sim-badge">{verifier.location}</span>
      </div>
      {identity ? (
        <div className="dbg-identity">
          <div><span>Source</span>{identity.sourceId}</div>
          <div><span>Run</span>{identity.runId}</div>
          <div><span>Genesis</span>{identity.genesisHash}</div>
          <div><span>Chain</span>{identity.chainId}</div>
          <div><span>Trust</span>{status?.authentication ?? "unsigned-simulator-v1"}</div>
        </div>
      ) : (
        <p className="sim-muted" role="status">Reading the run identity…</p>
      )}
      {nodesError && (
        <div role="alert" className="sim-error">Topology unavailable: {nodesError}</div>
      )}
      {statusError && (
        <div role="alert" className="sim-error">Explorer API unavailable: {statusError}</div>
      )}

      <section className="sim-panel dbg-section">
        <div className="sim-section-heading">
          <div>
            <h2>Topology and heights</h2>
            <p className="sim-muted">
              Each node is probed live by the backend; the explorer column is the
              PostgreSQL projection. Missing values are shown as unavailable, never as zero.
            </p>
          </div>
          <span className="sim-badge">Polled every 2 s</span>
        </div>
        {nodes ? (
          <div className="dbg-grid">
            <NodeCard label="Producer" report={nodes.nodes.producer} producerHeight={producerHeight} />
            <NodeCard label="Full follower" report={nodes.nodes.full} producerHeight={producerHeight} />
            <NodeCard label="Light follower" report={nodes.nodes.light} producerHeight={producerHeight} />
            <div className="dbg-card">
              <h3>
                Explorer projection
                <State
                  kind={nodes.explorer.health === "running" || nodes.explorer.health === "initializing" ? "ok" : "bad"}
                  text={nodes.explorer.health}
                />
              </h3>
              <dl>
                <dt>Indexed</dt>
                <dd>{nodes.explorer.indexed?.height ?? UNAVAILABLE}</dd>
                <dt>Hash</dt>
                <dd title={nodes.explorer.indexed?.hash ?? ""}>
                  {nodes.explorer.indexed ? short(nodes.explorer.indexed.hash) : UNAVAILABLE}
                </dd>
                <dt>State root</dt>
                <dd title={nodes.explorer.indexed?.stateRoot ?? ""}>
                  {nodes.explorer.indexed ? short(nodes.explorer.indexed.stateRoot) : UNAVAILABLE}
                </dd>
                <dt>Lag vs producer</dt>
                <dd>{lag(producerHeight, nodes.explorer.indexed?.height)}</dd>
                <dt>Scanner saw</dt>
                <dd>{nodes.explorer.observed?.head.height ?? UNAVAILABLE}</dd>
                <dt>Schema</dt>
                <dd>{nodes.explorer.schema}</dd>
              </dl>
            </div>
          </div>
        ) : (
          <p className="sim-muted" role="status">{nodesError ? "No topology data." : "Loading topology…"}</p>
        )}
      </section>

      <section className="sim-panel dbg-section">
        <h2>Producer controls</h2>
        {!status ? (
          <p className="sim-muted">Waiting for the explorer API…</p>
        ) : !status.controlAvailable ? (
          <p className="sim-muted">This backend has no private control listener configured; controls are unavailable here.</p>
        ) : auth.session.role !== "admin" ? (
          <p className="sim-muted">
            Pause, step, resume and workload changes require an administrator session.
            {auth.session.loginAvailable ? " Sign in above." : " No sign-in method is configured on this deployment."}
          </p>
        ) : !status.producer ? (
          <p className="sim-muted">The scanner has not observed the producer yet; controls stay disabled.</p>
        ) : (
          <ProducerControls key={JSON.stringify(status.identity)} status={status} auth={auth} onStatus={setStatus} />
        )}
      </section>

      <section className="sim-panel dbg-section">
        <div className="sim-section-heading">
          <div>
            <h2>Block inspector</h2>
            <p className="sim-muted">
              Complete indexed metadata of one block: header, transactions with budgets,
              ordered execution outcomes (rollback, rejection, expiry) and terminal changes.
            </p>
          </div>
          <span className="sim-badge">Unverified projection</span>
        </div>
        <form
          className="sim-filters"
          onSubmit={(e) => {
            e.preventDefault();
            void loadBlock(blockHeight);
          }}
        >
          <label>
            Block height
            <input
              aria-label="Block height"
              value={blockHeight}
              onChange={(e) => setBlockHeight(e.target.value)}
              placeholder={indexedHeight ?? "latest"}
              inputMode="numeric"
            />
          </label>
          <button type="submit" disabled={blockBusy || !identity}>
            {blockBusy ? "Loading…" : "Inspect block"}
          </button>
          <button
            type="button"
            className="secondary"
            disabled={blockBusy || !indexedHeight}
            onClick={() => void loadBlock(indexedHeight ?? "")}
          >
            Indexed head
          </button>
          <button
            type="button"
            className="secondary"
            disabled={blockBusy || !block || block.header.height === "0"}
            onClick={() => block && void loadBlock((BigInt(block.header.height) - 1n).toString())}
          >
            Previous
          </button>
          <button
            type="button"
            className="secondary"
            disabled={blockBusy || !block}
            onClick={() => block && void loadBlock((BigInt(block.header.height) + 1n).toString())}
          >
            Next
          </button>
        </form>
        {blockError && (
          <div role="alert" className="sim-error">{blockError}</div>
        )}
        {block && (
          <>
            <div className="dbg-chips">
              <span className="dbg-chip">Transactions<strong>{block.transactions.length}</strong></span>
              <span className="dbg-chip">Committed<strong>{block.transactions.filter((t) => t.status === "committed").length}</strong></span>
              <span className="dbg-chip">Failed<strong>{block.transactions.filter((t) => t.status === "failed").length}</strong></span>
              <span className="dbg-chip">Operations<strong>{block.operations.length}</strong></span>
              {Object.entries(outcomes).map(([outcome, n]) => (
                <span key={outcome} className="dbg-chip">{title(outcome)}<strong>{n}</strong></span>
              ))}
              <span className="dbg-chip">Expiry deletions<strong>{expiryDeletions}</strong></span>
              <span className="dbg-chip">Execution units<strong>{block.spentUnits}</strong></span>
              {Object.entries(changeKinds).map(([kind, n]) => (
                <span key={kind} className="dbg-chip">{title(kind)}<strong>{n}</strong></span>
              ))}
            </div>
            <dl className="sim-metadata">
              {(
                [
                  ["Height", block.header.height],
                  ["Hash", block.header.hash],
                  ["Parent hash", block.header.parentHash],
                  ["State root", block.header.stateRoot],
                  ["Logical time (ms)", block.header.timestampMs],
                  ["Inputs digest", block.header.inputsDigest],
                  ["Outcomes digest", block.header.outcomesDigest],
                  ["Feed digest", block.feedDigest],
                ] as [string, string][]
              ).map(([k, v]) => (
                <div key={k}>
                  <dt>{k}</dt>
                  <dd>{v}</dd>
                </div>
              ))}
            </dl>
            <h3>Transactions and budgets</h3>
            <Rows
              rows={block.transactions as unknown as Record<string, unknown>[]}
              columns={[
                ["position", "Position"],
                ["digest", "Digest"],
                ["actor", "Actor"],
                ["status", "Status"],
                ["budgetUnits", "Unit budget"],
                ["spentUnits", "Units spent"],
              ]}
              empty="No user transactions in this block."
            />
            <h3>Ordered execution outcomes</h3>
            <Rows
              rows={block.operations as unknown as Record<string, unknown>[]}
              columns={[
                ["phase", "Phase"],
                ["groupPosition", "Group"],
                ["operationPosition", "Op"],
                ["kind", "Kind"],
                ["namespaceId", "Namespace"],
                ["recordId", "Record ID"],
                ["recordKey", "Record key"],
                ["outcome", "Outcome"],
                ["receipt", "Receipt units", (r) => {
                  const receipt = r.receipt as FeedOperation["receipt"];
                  return receipt ? `${receipt.spentUnits} (schedule ${receipt.scheduleId})` : "no receipt";
                }],
                ["reason", "Reason"],
              ]}
              empty="No operations in this block."
            />
            <h3>Terminal changes</h3>
            <Rows
              rows={block.changes as unknown as Record<string, unknown>[]}
              columns={[
                ["kind", "Kind"],
                ["namespaceId", "Namespace"],
                ["recordId", "Record ID / key", (r) => String(r.recordId ?? r.key ?? r.name ?? "—")],
                ["recordKey", "Record key", (r) => String(r.recordKey ?? r.owner ?? "—")],
                ["expiresAtHeight", "Expires at block", (r) =>
                  r.expiresAtHeight === PERMANENT ? "Permanent" : displayNative(r.expiresAtHeight ?? r.revision ?? r.byteLength),
                ],
                ["attributes", "Attributes", (r) => (Array.isArray(r.attributes) ? String(r.attributes.length) : "—")],
                ["fields", "Fields", (r) => (Array.isArray(r.fields) ? String(r.fields.length) : "—")],
              ]}
              empty="No terminal state changes in this block."
            />
          </>
        )}
      </section>

      <section className="sim-panel dbg-section">
        <div className="sim-section-heading">
          <div>
            <h2>Historical queries and proof inspection</h2>
            <p className="sim-muted">
              Read the PostgreSQL projection at a pinned height, then verify the same
              positive typed equality through {verifier.where}. A failed or malformed
              proof releases no rows.
            </p>
          </div>
          <span className="sim-badge">{verifier.location}</span>
        </div>
        <form
          className="sim-filters"
          onChange={() => {
            ++generation.current;
            setProjection(null);
            setVerified(null);
            setVerifiedRequest(null);
            setQError("");
            setQBusy(false);
          }}
          onSubmit={(e) => {
            e.preventDefault();
            void readProjection();
          }}
        >
          <label>
            Snapshot height
            <input aria-label="Snapshot height" value={qHeight} onChange={(e) => setQHeight(e.target.value)} placeholder="latest" />
          </label>
          <label>
            Namespace
            <input aria-label="Namespace" value={qNamespace} onChange={(e) => setQNamespace(e.target.value)} inputMode="numeric" />
          </label>
          <label>
            Attribute
            <input aria-label="Attribute" value={qAttribute} onChange={(e) => setQAttribute(e.target.value)} />
          </label>
          <label>
            Native type
            <select aria-label="Native type" value={qType} onChange={(e) => setQType(e.target.value as EqSelection["valueType"])}>
              {["bool", "i64", "u64", "str"].map((t) => (
                <option key={t}>{t}</option>
              ))}
            </select>
          </label>
          <label>
            Value
            <input aria-label="Value" value={qValue} onChange={(e) => setQValue(e.target.value)} />
          </label>
          <label>
            Page size
            <select aria-label="Page size" value={qLimit} onChange={(e) => setQLimit(Number(e.target.value))}>
              {[1, 3, 16, 64].map((n) => (
                <option key={n}>{n}</option>
              ))}
            </select>
          </label>
          <button type="submit" disabled={qBusy || !identity}>
            {qBusy ? "Working…" : "Read projection"}
          </button>
          <button type="button" className="secondary" disabled={qBusy || !identity} onClick={() => void verify()}>
            {verifier.button}
          </button>
        </form>
        {qError && (
          <div role="alert" className="sim-error">{qError}</div>
        )}
        {projection && (
          <>
            <div className="sim-result-heading">
              <span className="sim-badge">Unverified projection</span>
              <span>
                Block {projection.snapshot.height} · <code title={projection.snapshot.hash}>{short(projection.snapshot.hash)}</code>
                {projection.nextCursor ? " · more rows available" : ""}
              </span>
            </div>
            <Rows
              rows={projection.rows}
              columns={[
                ["recordId", "Record ID"],
                ["recordKey", "Record key"],
                ["attributes", "Attributes"],
                ["fields", "Fields"],
                ["expiresAtHeight", "Expires at block", (r) => (r.expiresAtHeight === PERMANENT ? "Permanent" : displayNative(r.expiresAtHeight))],
                ["createdAtHeight", "Created at"],
                ["updatedAtHeight", "Updated at"],
              ]}
              empty="No matching rows in the projection at this snapshot."
            />
          </>
        )}
        {verified && (
          <>
            <div className="sim-result-heading">
              <span className="sim-badge verified">{verifier.badge}</span>
              <span>
                Block {verified.snapshot.height} · {verified.postingCount} matching IDs
                {verified.continuation ? " · continuation available" : " · complete"}
              </span>
            </div>
            <code className="sim-root">state root {verified.snapshot.stateRoot}</code>
            <div className="dbg-chips">
              <span className="dbg-chip">Verifier<strong>{verified.diagnostics?.verifier ?? UNAVAILABLE}</strong></span>
              <span className="dbg-chip">Proof size<strong>{verified.diagnostics ? bytes(verified.diagnostics.proofBytes) : UNAVAILABLE}</strong></span>
              <span className="dbg-chip">Proof fetch<strong>{verified.diagnostics ? `${verified.diagnostics.fetchMs} ms` : UNAVAILABLE}</strong></span>
              <span className="dbg-chip">Verification<strong>{verified.diagnostics ? `${verified.diagnostics.verifyMs} ms` : UNAVAILABLE}</strong></span>
              <span className="dbg-chip">Rows released<strong>{verified.rows.length}</strong></span>
            </div>
            <Rows
              rows={verified.rows}
              columns={[
                ["recordId", "Record ID"],
                ["recordKey", "Record key"],
                ["attributes", "Attributes"],
                ["fields", "Fields"],
                ["expiresAtHeight", "Expires at block", (r) => (r.expiresAtHeight === PERMANENT ? "Permanent" : displayNative(r.expiresAtHeight))],
              ]}
              empty="Proof verified: no matching rows at this snapshot."
            />
            <button className="secondary" disabled={qBusy || !verified.continuation} onClick={() => void verify(true)}>
              Next verified page
            </button>
          </>
        )}
        <h3>Record incarnations and history</h3>
        <p className="sim-muted">
          The namespace and snapshot height above apply. A recreated key has a new
          incarnation ID; deleted and expired incarnations disappear from the live
          rows but keep their ordered operation history.
        </p>
        <form
          className="sim-filters"
          onSubmit={(e) => {
            e.preventDefault();
            void lookupRecord();
          }}
        >
          <label>
            Record key
            <input aria-label="Record key" value={rKey} onChange={(e) => setRKey(e.target.value)} placeholder="0x…" />
          </label>
          <label>
            Incarnation ID
            <input aria-label="Incarnation ID" value={rId} onChange={(e) => setRId(e.target.value)} placeholder="optional" inputMode="numeric" />
          </label>
          <button type="submit" disabled={rBusy || !identity}>
            {rBusy ? "Loading…" : "Lookup record"}
          </button>
        </form>
        {rError && (
          <div role="alert" className="sim-error">{rError}</div>
        )}
        {incarnations && (
          <>
            <div className="sim-result-heading">
              <span className="sim-badge">Unverified projection</span>
              <span>Live incarnations at block {incarnations.snapshot.height}</span>
            </div>
            <Rows
              rows={incarnations.rows}
              columns={[
                ["recordId", "Record ID"],
                ["recordKey", "Record key"],
                ["attributes", "Attributes"],
                ["expiresAtHeight", "Expires at block", (r) => (r.expiresAtHeight === PERMANENT ? "Permanent" : displayNative(r.expiresAtHeight))],
                ["createdAtHeight", "Created at"],
                ["updatedAtHeight", "Updated at"],
              ]}
              empty="No live incarnation at this snapshot (deleted, expired or never created)."
            />
          </>
        )}
        {history && (
          <>
            <div className="sim-result-heading">
              <span className="sim-badge">Unverified projection</span>
              <span>Operation history up to block {history.snapshot.height}{history.nextCursor ? " · more available" : ""}</span>
            </div>
            <Rows
              rows={history.rows}
              columns={[
                ["height", "Height"],
                ["phase", "Phase"],
                ["kind", "Kind"],
                ["recordId", "Record ID"],
                ["outcome", "Outcome"],
                ["receipt", "Receipt units", (r) => {
                  const receipt = r.receipt as FeedOperation["receipt"];
                  return receipt ? receipt.spentUnits : "no receipt";
                }],
                ["reason", "Reason"],
              ]}
              empty="No operations touched this record up to the snapshot."
            />
          </>
        )}
      </section>

      <section className="sim-panel dbg-section">
        <h2>Diagnostics</h2>
        <div className="dbg-two">
          <div>
            <h3>Producer engine and storage</h3>
            {producer?.status ? (
              <dl className="sim-metadata">
                {(
                  [
                    ["Engine cache bytes", displayNative(producer.status.memory.engineCacheBytes)],
                    ["Engine cache entries", displayNative(producer.status.memory.engineCacheEntries)],
                    ["Resident manifests", displayNative(producer.status.memory.residentManifests)],
                    ["Retained history file", producer.status.storage ? bytes(producer.status.storage.fileBytes) : UNAVAILABLE],
                    ["Workload", `seed ${producer.status.workload.seed} · period ${producer.status.workload.blockPeriodMs} ms · payload ${producer.status.workload.payloadBytes} B · extra rows ${producer.status.workload.extraRowsPerBlock}`],
                    ["Config revision", producer.status.configRevision],
                    ["Coverage", producer.status.coverage ? `${producer.status.coverage.from}–${producer.status.coverage.through}${producer.status.coverage.complete ? " complete" : " incomplete"}` : UNAVAILABLE],
                  ] as [string, string][]
                ).map(([k, v]) => (
                  <div key={k}>
                    <dt>{k}</dt>
                    <dd>{v}</dd>
                  </div>
                ))}
              </dl>
            ) : (
              <p className="sim-muted">Producer telemetry unavailable{producer?.error ? ` · ${producer.error}` : ""}.</p>
            )}
          </div>
          <div>
            <h3>Explorer projection and probes</h3>
            {nodes ? (
              <dl className="sim-metadata">
                {(
                  [
                    ["PostgreSQL relation bytes", bytes(nodes.explorer.storage.relationBytes)],
                    ...Object.entries(nodes.explorer.counters).map(([k, v]) => [title(k), v] as [string, string]),
                    ["Producer probe", nodes.nodes.producer.latencyMs === null ? UNAVAILABLE : `${nodes.nodes.producer.latencyMs} ms`],
                    ["Full follower probe", nodes.nodes.full.latencyMs === null ? UNAVAILABLE : `${nodes.nodes.full.latencyMs} ms`],
                    ["Light follower probe", nodes.nodes.light.latencyMs === null ? UNAVAILABLE : `${nodes.nodes.light.latencyMs} ms`],
                    ["Last verification", lastVerification ? `${lastVerification.outcome} · ${lastVerification.at}` : "none in this session"],
                    ["Last proof size", lastVerification?.diagnostics ? bytes(lastVerification.diagnostics.proofBytes) : UNAVAILABLE],
                  ] as [string, string][]
                ).map(([k, v]) => (
                  <div key={k}>
                    <dt>{k}</dt>
                    <dd>{v}</dd>
                  </div>
                ))}
              </dl>
            ) : (
              <p className="sim-muted">Explorer diagnostics unavailable.</p>
            )}
          </div>
        </div>
      </section>

      <section className="sim-panel dbg-section">
        <h2>Run your own light client</h2>
        <p className="sim-muted">
          This page's verification is {verifier.location === "local light process" ? "local to this machine" : "server-side"}.
          The genuinely local workflow pins this run's identity in a light process on your
          machine, which fetches headers and complete equality proofs from the public node
          endpoint and verifies them itself. Pin the identity through an independent channel;
          the unsigned protocol cannot supply trust anchors by itself.
        </p>
        {identity ? (
          node ? (
            <pre className="dbg-command">{`python3 scripts/simulator.py init --state-dir .simulator-remote \\
  --peer ${node} \\
  --source-id ${identity.sourceId} \\
  --run-id ${identity.runId} \\
  --genesis-hash ${identity.genesisHash} \\
  --chain-id ${identity.chainId}`}</pre>
          ) : (
            <p className="dbg-note">No public node endpoint is configured for this deployment, so the pins above are the only thing to copy.</p>
          )
        ) : null}
        <p className="dbg-note">
          The launcher lives in the arkiv-chain-indexer repository on the experimental branch
          beside an arkiv-db-pure-astra checkout; see docs/simulator-run.md.
        </p>
      </section>
      <footer className="sim-footer">
        Engine state is authoritative. PostgreSQL can be rebuilt from genesis. History is
        retained without pruning. Abstract execution units are independent of Ethereum gas or fees.
      </footer>
    </div>
  );
}

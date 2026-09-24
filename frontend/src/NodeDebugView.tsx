import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { ArrowDown, ArrowRight, ArrowUpRight, Check, ChevronRight, Copy, Database, Download, FileCode2, GitBranch, Layers3, LoaderCircle, Radio, Search, ShieldCheck, Terminal, Workflow } from "lucide-react";
import { PatriciaProofVisualizer } from "./PatriciaProofVisualizer";
import { fetchNodeBlock, fetchNodeStatus, formatNodeBytes, inspectNodeQuery, pinSelection, QUERY_EXAMPLES, readableKey, type FeedBlock, type InspectedPage, type NodeUiMode } from "./nodeDebugApi";
import { displayNative, type EqSelection, type NativeRow, type NativeSourceStatus } from "./simulatorApi";
import "./nodeDebug.css";

const FULL_URL = "https://fullnode.experimental.arkiv-global.net";
const LIGHT_URL = "https://lightnode.experimental.arkiv-global.net";
const EXPLORER_URL = "https://explorer.experimental.arkiv-global.net";
const json = (value: unknown) => JSON.stringify(value, null, 2);
const errorText = (error: unknown) => error instanceof Error ? error.message : "Request failed";
const isReady = (status: NativeSourceStatus | null, height: string) => !!status && /^\d+$/.test(height) && BigInt(status.head.height) >= BigInt(height);
const explainError = (error: string) => ({
  BlockNotSynced: "This snapshot is ahead of the node. Choose an earlier block or wait for it to sync.",
  CursorMismatch: "This continuation is no longer retained by the light node. Run the query again to start a new page sequence.",
  NamespaceNotFound: "This namespace does not exist at the selected block.",
  VerifierBindingMismatch: "The response does not match the requested source, snapshot, or query. No result is shown.",
  ChainConflict: "The node detected conflicting chain history. It has stopped accepting this chain.",
  NodeIdentityMismatch: "The endpoint did not return the expected node role and identity.",
}[error] ?? error);

function useNodeStatus(mode: NodeUiMode) {
  const [status, setStatus] = useState<NativeSourceStatus | null>(null);
  const [error, setError] = useState("");
  const [updated, setUpdated] = useState<Date | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const next = await fetchNodeStatus(mode, controller.signal);
        if (controller.signal.aborted) return;
        setStatus(next); setError(""); setUpdated(new Date());
      } catch (e) {
        if (!controller.signal.aborted) setError(errorText(e));
      }
      if (!controller.signal.aborted) timer = setTimeout(poll, 3000);
    };
    void poll();
    return () => { controller.abort(); clearTimeout(timer); };
  }, [mode]);
  return { status, error, updated };
}

function CopyButton({ value, label = "Copy" }: { value: string; label?: string }) {
  const [message, setMessage] = useState("");
  const timer = useRef<ReturnType<typeof setTimeout>>();
  useEffect(() => () => clearTimeout(timer.current), []);
  return <button type="button" className="nd-button nd-button-small" title={label} onClick={() => {
    void navigator.clipboard.writeText(value).then(() => {
      setMessage("Copied"); clearTimeout(timer.current); timer.current = setTimeout(() => setMessage(""), 1800);
    }).catch(() => setMessage("Copy unavailable"));
  }}>{message === "Copied" ? <Check size={13}/> : <Copy size={13}/>} {message || label}</button>;
}

function download(value: unknown, name: string) {
  const href = URL.createObjectURL(new Blob([typeof value === "string" ? value : json(value)], { type: "application/json" }));
  const a = document.createElement("a"); a.href = href; a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(href), 1000);
}

function RawData({ title, value, name, hex = false }: { title: string; value: unknown; name: string; hex?: boolean }) {
  const content = typeof value === "string" ? value : json(value);
  return <details className="nd-raw"><summary><FileCode2 size={16}/>{title}<ChevronRight size={15}/></summary><div className="nd-raw-body"><div className="nd-raw-actions"><span>{hex ? `${formatNodeBytes((content.length - 2) / 2)} · canonical hex` : "JSON response"}</span><CopyButton value={content}/><button type="button" className="nd-button nd-button-small" onClick={() => download(value, name)}><Download size={13}/> Download</button></div><pre tabIndex={0}>{content}</pre></div></details>;
}

function Stat({ label, value, detail, icon }: { label: string; value: ReactNode; detail: string; icon: ReactNode }) {
  return <div className="nd-stat"><div className="nd-stat-label">{label}{icon}</div><strong>{value}</strong><span>{detail}</span></div>;
}

function Topology({ mode, status }: { mode: NodeUiMode; status: NativeSourceStatus | null }) {
  return <section className="nd-topology" aria-label="Node architecture"><div className="nd-topology-intro"><Workflow size={18}/><span>One chain.<br/><strong>Three independent processes.</strong></span></div><div className="nd-topology-flow"><div className="nd-topology-node"><Radio size={18}/><span><strong>Producer</strong><small>Creates unsigned blocks</small></span></div><div className="nd-connection"><span>replication</span><ArrowRight size={20}/></div><a href={FULL_URL} className={`nd-topology-node ${mode === "fullnode" ? "is-current" : ""}`}><Database size={18}/><span><strong>Full node {mode === "fullnode" && <b>YOU ARE HERE</b>}</strong><small>{mode === "fullnode" && status ? `Replayed through #${status.head.height}` : "Replays state · serves proofs"}</small></span></a><div className="nd-connection"><span>headers + proofs</span><ArrowRight size={20}/></div><a href={LIGHT_URL} className={`nd-topology-node ${mode === "lightnode" ? "is-current" : ""}`}><ShieldCheck size={18}/><span><strong>Light node {mode === "lightnode" && <b>YOU ARE HERE</b>}</strong><small>{mode === "lightnode" && status ? `Headers through #${status.head.height}` : "Retains headers · checks proofs"}</small></span></a></div></section>;
}

function HashLine({ label, value }: { label: string; value: string }) {
  return <div className="nd-hashline"><span>{label}</span><code>{value}</code><CopyButton value={value} label={`Copy ${label.toLowerCase()}`}/></div>;
}

export function NodeDebugView({ mode }: { mode: NodeUiMode }) {
  const { status, error, updated } = useNodeStatus(mode);
  const light = mode === "lightnode";
  useEffect(() => { document.title = `Arkiv ${light ? "Light" : "Full"} Node · Experimental`; }, [light]);
  const peerGap = status?.observedPeerHeight && /^\d+$/.test(status.observedPeerHeight) ? (BigInt(status.observedPeerHeight) - BigInt(status.head.height)).toString() : "—";
  const frozen = !!status && ["chain-conflict", "storage-fenced"].includes(status.health);
  const healthy = !!status && !error && !frozen && ["following", "running", "ready"].includes(status.health);
  return <div className={`nd-app ${light ? "nd-light" : "nd-full"}`}>
    <header className="nd-header"><a className="nd-brand" href={light ? LIGHT_URL : FULL_URL} aria-label="Arkiv node home"><span className="nd-brand-mark">a<span>↗</span></span><strong>arkiv</strong><span className="nd-brand-divider"/><span>node lab</span></a><nav aria-label="Node navigation"><a className={!light ? "is-active" : ""} href={FULL_URL}>Full node</a><a className={light ? "is-active" : ""} href={LIGHT_URL}>Light node</a><a href={EXPLORER_URL}>Explorer <ArrowUpRight size={13}/></a></nav><span className="nd-environment">Experimental</span></header>
    <main className="nd-main"><section className="nd-hero"><div><div className="nd-eyebrow"><span className="nd-kicker-line"/>{light ? "HEADER FOLLOWER / PROOF VERIFIER" : "STATE REPLAY / PROOF SERVER"}</div><h1>{light ? <>A small node.<br/>A verifiable answer<span>.</span></> : <>Every block.<br/>Every state transition<span>.</span></>}</h1><p>{light ? "Ask the full node for data. Watch this independent light process verify the answer against its trusted state root, then explore the exact proof." : "Follow the live chain, replay its operations, and retain the state needed to answer queries with cryptographic proofs."}</p></div><aside className="nd-hero-aside"><div className={`nd-status-pill ${healthy ? "is-healthy" : "is-waiting"}`}><span/>{error ? "Connection interrupted" : status ? frozen ? status.health : status.paused ? "Paused" : status.health : "Connecting to node"}</div><div className="nd-hero-aside-label">{light ? "Light" : "Full"} node / live status</div><code>{light ? "lightnode" : "fullnode"}.experimental</code><small>{updated ? `Last read ${updated.toLocaleTimeString()} · polls every 3s` : "Waiting for the first status response"}</small></aside></section>
      {error && <div className="nd-alert" role="alert"><strong>Status unavailable.</strong> {explainError(error)} {status && "Showing the last successful reading."}</div>}
      {frozen && <div className="nd-alert" role="alert"><strong>Verification stopped · {status?.health}.</strong> The node has frozen its trusted history. Previous query results have been cleared. Verification will resume only after the node reports a usable state.</div>}
      <div className="nd-stats"><Stat label={light ? "Trusted header height" : "Replayed block height"} value={status ? `#${status.head.height}` : "—"} detail={light ? "Stored by the light process" : "Committed by the full process"} icon={<Layers3 size={17}/>}/><Stat label="Observed peer gap" value={peerGap === "0" ? <>0 <em>blocks</em></> : <>{peerGap} <em>blocks</em></>} detail={status?.observedPeerHeight ? `Peer last observed at #${status.observedPeerHeight}` : "Waiting for an upstream observation"} icon={<GitBranch size={17}/>}/><Stat label="Retained file" value={formatNodeBytes(status?.storage?.fileBytes)} detail={light ? "Durable headers and node metadata" : "Durable replay history and state"} icon={<Database size={17}/>}/><Stat label="Engine cache" value={formatNodeBytes(status?.memory?.engineCacheBytes)} detail={light ? "Header-only node · no state engine cache" : `${displayNative(status?.memory?.engineCacheEntries)} entries · excludes process RSS`} icon={<Layers3 size={17}/>}/></div>
      <Topology mode={mode} status={status}/>
      <div className="nd-trust-note"><ShieldCheck size={18}/><p><strong>{light ? "Proof verification happens in the hosted Rust light process." : "A native simulator with an unsigned source."}</strong> {light ? "This browser displays its result and witness. Roots come from that process’s trusted header history; the simulator’s producer is unsigned." : "The full node independently replays the producer’s blocks. Open the light node to check query proofs against its own retained headers."}</p><span>UNSIGNED SIMULATOR</span></div>
      {light ? <QueryLab key={status ? `${status.sourceId}/${status.runId}/${frozen}` : "connecting"} status={status} unavailable={!!error || frozen}/> : <BlockLab key={status ? `${status.sourceId}/${status.runId}/${frozen}` : "connecting"} status={status} unavailable={!!error || frozen}/>}
      {status && <section className="nd-card nd-identity"><div className="nd-section-heading"><div><span className="nd-eyebrow">SOURCE IDENTITY</span><h2>The chain behind this node</h2></div><span className="nd-chip">Chain {status.chainId}</span></div><HashLine label="Head state root" value={status.head.stateRoot}/><HashLine label="Head block hash" value={status.head.hash}/><div className="nd-identity-small"><span>Source <code>{status.sourceId}</code></span><span>Run <code>{status.runId}</code></span></div><RawData title="Complete node status" value={status} name={`${mode}-status.json`}/></section>}
    </main><footer className="nd-footer"><span><strong>arkiv</strong> / experimental node lab</span><span>Native data. Real proofs. Unsigned simulator.</span><a href={light ? FULL_URL : LIGHT_URL}>Open {light ? "full" : "light"} node <ArrowUpRight size={14}/></a></footer>
  </div>;
}

function QueryLab({ status, unavailable }: { status: NativeSourceStatus | null; unavailable: boolean }) {
  const [selection, setSelection] = useState<EqSelection>({ ...QUERY_EXAMPLES[0].request });
  const [example, setExample] = useState("membership");
  const [result, setResult] = useState<InspectedPage | null>(null);
  const [lastRequest, setLastRequest] = useState<EqSelection | null>(null);
  const [page, setPage] = useState(1);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [elapsed, setElapsed] = useState(0);
  const [attempted, setAttempted] = useState(false);
  const controller = useRef<AbortController | null>(null);
  const touched = useRef(false);
  useEffect(() => () => controller.current?.abort(), []);
  const run = async (draft: EqSelection, nextPage = 1) => {
    if (!status || unavailable) return;
    controller.current?.abort();
    const current = new AbortController(); controller.current = current;
    setBusy(true); setError(""); setResult(null); setAttempted(true);
    const started = performance.now();
    try {
      const request = pinSelection(draft, status.head.height);
      const next = await inspectNodeQuery(status, request, current.signal);
      if (current.signal.aborted) return;
      setResult(next); setLastRequest(request); setPage(nextPage); setElapsed(performance.now() - started);
    } catch (e) { if (!current.signal.aborted) setError(errorText(e)); }
    finally { if (!current.signal.aborted) setBusy(false); }
  };
  useEffect(() => {
    if (!touched.current && !attempted && !unavailable && isReady(status, "20")) {
      touched.current = true; void run(QUERY_EXAMPLES[0].request);
    }
    // A single automatic sample after this run has reached the fixture snapshot.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status?.head.height, unavailable]);
  const change = <K extends keyof EqSelection>(key: K, value: EqSelection[K]) => {
    touched.current = true; setSelection((s) => ({ ...s, [key]: value, cursor: null })); setExample("custom");
    controller.current?.abort(); setBusy(false); setResult(null); setError(""); setAttempted(false);
  };
  const submit = (event: FormEvent) => { event.preventDefault(); touched.current = true; void run({ ...selection, cursor: null }); };
  return <section className="nd-lab" aria-labelledby="query-title"><div className="nd-section-heading nd-lab-heading"><div><span className="nd-eyebrow">QUERY PLAYGROUND</span><h2 id="query-title">Don’t take the answer on trust.</h2><p>Pick a scenario, run a query, and follow the evidence.</p></div><span className="nd-chip"><Terminal size={13}/> Eq proof · v1</span></div>
    <div className="nd-examples">{QUERY_EXAMPLES.map((sample) => <button type="button" key={sample.id} className={`nd-example ${example === sample.id ? "is-selected" : ""}`} aria-pressed={example === sample.id} onClick={() => {
      controller.current?.abort(); setBusy(false);
      touched.current = true; setExample(sample.id); setSelection({ ...sample.request }); setResult(null); setError(""); setAttempted(false);
      if (isReady(status, sample.request.height)) void run(sample.request);
    }}><span>{sample.label}</span><strong>{sample.title}</strong><small>Block {sample.request.height} <ArrowUpRight size={13}/></small></button>)}</div>
    <div className="nd-query-layout"><section className="nd-card nd-query-card"><div className="nd-card-title"><Search size={18}/><h3>Build a query</h3><span>READ ONLY</span></div><p className="nd-query-explanation">{QUERY_EXAMPLES.find((s) => s.id === example)?.explanation ?? "Query one typed equality term at a fixed historical block. Each page is checked independently by the light process."}</p><form onSubmit={submit}><div className="nd-form-grid"><label>Snapshot block<input aria-label="Snapshot block" value={selection.height} onChange={(e) => change("height", e.target.value)} placeholder="latest" spellCheck={false}/></label><label>Namespace<input aria-label="Namespace" value={selection.namespace} onChange={(e) => change("namespace", e.target.value)} inputMode="numeric"/></label><label className="nd-field-wide">Attribute<input aria-label="Attribute" value={selection.attribute} onChange={(e) => change("attribute", e.target.value)} spellCheck={false}/></label><label>Value type<select aria-label="Value type" value={selection.valueType} onChange={(e) => change("valueType", e.target.value as EqSelection["valueType"])}><option value="u64">u64 · unsigned integer</option><option value="i64">i64 · signed integer</option><option value="str">str · text</option><option value="bool">bool · true / false</option></select></label><label>Value<input aria-label="Value" value={String(selection.value)} onChange={(e) => change("value", e.target.value)} spellCheck={false}/></label><label>Rows per page<input aria-label="Rows per page" value={selection.limit} type="number" min={1} max={64} onChange={(e) => change("limit", Number(e.target.value))}/></label><div className="nd-query-equation"><code>{selection.attribute || "attribute"} = {selection.valueType}({JSON.stringify(selection.value)})</code></div></div><button type="submit" className="nd-primary" disabled={busy || !status || unavailable}>{busy ? <LoaderCircle className="nd-spin" size={17}/> : <ShieldCheck size={17}/>} {busy ? "Fetching & verifying…" : "Run & verify query"}<ArrowRight size={16}/></button><p className="nd-form-caption">Runs on the hosted light node. “latest” is pinned to a block before the request.</p></form></section>
    <section className={`nd-card nd-result-card ${result ? "has-result" : ""}`} aria-live="polite"><div className="nd-card-title"><Layers3 size={18}/><h3>Verified response</h3>{result && <span className="nd-result-page">PAGE {page}</span>}</div>
      {busy ? <div className="nd-empty"><div className="nd-empty-symbol"><LoaderCircle size={28} className="nd-spin"/></div><h3>Following the proof</h3><p>The light node is fetching a witness and checking it against its trusted header for block {selection.height}.</p></div> : error ? <div className="nd-query-error" role="alert"><strong>Query did not complete</strong><p>{explainError(error)}</p><code>{error}</code></div> : result ? <QueryResult result={result} elapsed={elapsed} page={page} onNext={() => lastRequest && void run({ ...lastRequest, cursor: result.continuation }, page + 1)} onFirst={() => lastRequest && void run({ ...lastRequest, cursor: null })}/> : <div className="nd-empty"><div className="nd-empty-symbol"><ShieldCheck size={28}/></div><h3>{!touched.current && !isReady(status, "20") ? "The demo is warming up" : "An answer comes with evidence"}</h3><p>{!touched.current && !isReady(status, "20") ? `The first scenario starts automatically when this light node reaches block 20. Current height: ${status?.head.height ?? "connecting"}.` : "Run a sample or build your own query. Actual returned rows and verification details will appear here."}</p>{!touched.current && <div className="nd-readiness"><div style={{ width: `${status ? Math.min(100, Number(status.head.height) / 20 * 100) : 0}%` }}/></div>}</div>}
    </section></div>
    {result && <><section className="nd-proof-heading"><div><span className="nd-eyebrow">INSIDE THE PROOF</span><h2>Trace the answer to the root.</h2><p>The exact witness returned for this page, decoded by the hosted verifier.</p></div><a href="#proof-data" className="nd-button">Inspect raw evidence <ArrowDown size={14}/></a></section><PatriciaProofVisualizer key={result.canonicalRequest} inspection={result.inspection}/><section className="nd-card nd-evidence" id="proof-data"><div className="nd-section-heading"><div><span className="nd-eyebrow">PORTABLE EVIDENCE</span><h2>Request, witness, response</h2></div><button type="button" className="nd-button" onClick={() => download({ request: lastRequest, response: result }, `arkiv-proof-block-${result.snapshot.height}-page-${page}.json`)}><Download size={15}/> Download bundle</button></div><p>The canonical request and proof are the bytes checked by the light process. The JSON response includes the decoded witness and verification diagnostics.</p><HashLine label="Verified state root" value={result.snapshot.stateRoot}/><RawData title="Canonical request bytes" value={result.canonicalRequest} name="canonical-request.hex" hex/><RawData title="Canonical proof bytes" value={result.canonicalProof} name="canonical-proof.hex" hex/><RawData title="Complete inspection response" value={result} name="proof-inspection.json"/></section></>}
  </section>;
}

function QueryResult({ result, elapsed, page, onNext, onFirst }: { result: InspectedPage; elapsed: number; page: number; onNext: () => void; onFirst: () => void }) {
  return <><div className="nd-verified"><ShieldCheck size={21}/><div><strong>Proof verified</strong><span>Hosted light process · trusted simulator root</span></div><span className="nd-verified-time">{elapsed < 1000 ? `${Math.round(elapsed)} ms` : `${(elapsed / 1000).toFixed(2)} s`}</span></div><div className="nd-response-summary"><span><strong>{result.rows.length}</strong> returned</span><span><strong>{result.postingCount}</strong> total matches</span><span>Block <strong>#{result.snapshot.height}</strong></span></div>
    {result.rows.length ? <div className="nd-records">{result.rows.map((row, index) => <RecordRow key={`${displayNative(row.recordId)}-${index}`} row={row}/>)}</div> : <div className="nd-absence"><span>∅</span><h3>An empty answer, with a proof.</h3><p>No records match this typed equality term at block {result.snapshot.height}. Explore the authenticated absence path below.</p></div>}
    <div className="nd-pagination"><span>{result.continuation ? "More results · snapshot stays pinned" : "End of verified results"}</span><div>{page > 1 && <button className="nd-button nd-button-small" onClick={onFirst}>First page</button>}<button className="nd-button nd-button-small" disabled={!result.continuation} onClick={onNext}>Next page <ArrowRight size={13}/></button></div></div><div className="nd-diagnostics"><span>Proof <strong>{formatNodeBytes(result.diagnostics?.proofBytes)}</strong></span><span>Fetch <strong>{result.diagnostics?.fetchMs ?? "—"} ms</strong></span><span>Verify <strong>{result.diagnostics?.verifyMs ?? "—"} ms</strong></span></div><p className="nd-result-footnote">Results and proof share one snapshot. Fields below are the node’s returned metadata; payload bytes remain in the canonical proof.</p></>;
}

function RecordRow({ row }: { row: NativeRow }) {
  const attributes = Array.isArray(row.attributes) ? row.attributes as Array<{ name: string; type: string; value: unknown }> : [];
  const fields = Array.isArray(row.fields) ? row.fields as Array<{ name: string; byteLength: string; type: string }> : [];
  return <details className="nd-record"><summary><span className="nd-record-id">{displayNative(row.recordId).padStart(2, "0")}</span><span className="nd-record-main"><strong>{readableKey(row.recordKey)}</strong><span>{attributes.filter((a) => !a.name.startsWith("$")).map((a) => `${a.name} = ${a.type}(${displayNative(a.value)})`).join(" · ")}</span></span><span className={`nd-expiry ${row.expiresAtHeight !== "18446744073709551615" ? "has-expiry" : ""}`}>{row.expiresAtHeight === "18446744073709551615" ? "Permanent" : `Expires #${displayNative(row.expiresAtHeight)}`}</span><ChevronRight size={15}/></summary><div className="nd-record-detail"><p><strong>Record key</strong> <code>{displayNative(row.recordKey)}</code></p>{fields.map((field) => <p key={field.name}><strong>{field.name}</strong> {field.type} · {formatNodeBytes(field.byteLength)} encoded</p>)}<pre>{json(row)}</pre></div></details>;
}

function BlockLab({ status, unavailable }: { status: NativeSourceStatus | null; unavailable: boolean }) {
  const [height, setHeight] = useState("latest");
  const [block, setBlock] = useState<FeedBlock | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const initialized = useRef(false);
  const controller = useRef<AbortController | null>(null);
  useEffect(() => () => controller.current?.abort(), []);
  const inspect = async (requested: string) => {
    if (!status || unavailable) return;
    controller.current?.abort(); const current = new AbortController(); controller.current = current;
    setBusy(true); setError(""); setBlock(null);
    try {
      const resolved = requested === "latest" ? status.head.height : requested;
      if (!/^\d+$/.test(resolved) || BigInt(resolved) < 1n || BigInt(resolved) > BigInt(status.head.height)) throw new Error("BlockNotSynced");
      const data = await fetchNodeBlock(status, BigInt(resolved).toString(), current.signal);
      if (!current.signal.aborted) setBlock(data);
    } catch (e) { if (!current.signal.aborted) setError(errorText(e)); }
    finally { if (!current.signal.aborted) setBusy(false); }
  };
  useEffect(() => {
    if (status && !initialized.current && !unavailable && BigInt(status.head.height) > 0n) {
      initialized.current = true; void inspect("latest");
    }
    // One initial block inspection; live status does not replace a selected block.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status?.head.height, unavailable]);
  return <section className="nd-lab" aria-labelledby="block-title"><div className="nd-section-heading nd-lab-heading"><div><span className="nd-eyebrow">BLOCK INSPECTOR</span><h2 id="block-title">See what the node replayed.</h2><p>Inspect the native block feed, operation outcomes, and committed state roots.</p></div><a className="nd-button" href={LIGHT_URL}>Try a verified query <ArrowUpRight size={15}/></a></div><div className="nd-card nd-block-query"><form onSubmit={(event) => { event.preventDefault(); initialized.current = true; void inspect(height); }}><label>Block height<input value={height} aria-label="Block height" placeholder="latest" onChange={(e) => setHeight(e.target.value)}/></label><button className="nd-primary" disabled={!status || busy || unavailable}>{busy ? <LoaderCircle size={16} className="nd-spin"/> : <Search size={16}/>} Inspect block</button></form><div className="nd-block-presets"><span>Interesting blocks</span>{[{ height: "1", label: "Namespaces" }, { height: "7", label: "Rollback" }, { height: "14", label: "Expiry" }, { height: "18", label: "Membership" }].map((sample) => <button type="button" className="nd-button nd-button-small" key={sample.height} disabled={!isReady(status, sample.height) || busy || unavailable} onClick={() => { setHeight(sample.height); initialized.current = true; void inspect(sample.height); }}>#{sample.height} · {sample.label}</button>)}</div></div>
    {error && <div className="nd-alert" role="alert"><strong>Block unavailable.</strong> {explainError(error)}</div>}
    {busy ? <div className="nd-card nd-empty"><LoaderCircle className="nd-spin" size={26}/><p>Reading block metadata from the full node…</p></div> : block ? <section className="nd-card nd-block-result"><div className="nd-section-heading"><div><span className="nd-eyebrow">NATIVE BLOCK FEED</span><h2>Block #{block.header.height}</h2></div><span className="nd-chip" title="Deterministic simulator timestamp, not wall-clock production time">Simulated time · {new Date(Number(block.header.timestampMs)).toLocaleString()}</span></div><div className="nd-block-counts"><span><strong>{block.transactions.length}</strong> transactions</span><span><strong>{block.operations.length}</strong> operations</span><span><strong>{block.changes.length}</strong> changes</span><span><strong>{block.spentUnits}</strong> spent units</span></div><HashLine label="Block hash" value={block.header.hash}/><HashLine label="Parent hash" value={block.header.parentHash}/><HashLine label="State root" value={block.header.stateRoot}/><h3 className="nd-table-title">Execution outcomes</h3>{block.operations.length ? <div className="nd-table-scroll"><table className="nd-table"><thead><tr><th>Position</th><th>Operation</th><th>Namespace</th><th>Record</th><th>Outcome</th></tr></thead><tbody>{block.operations.map((op, index) => <tr key={index}><td>{op.phase} {op.groupPosition}.{op.operationPosition}</td><td>{op.kind}</td><td>{op.namespaceId ?? "—"}</td><td title={op.recordKey ?? ""}>{op.recordKey ? readableKey(op.recordKey) : op.recordId ?? "—"}</td><td><span className={`nd-outcome ${op.outcome === "applied" ? "is-applied" : ""}`}>{op.outcome}</span>{op.reason && <small>{op.reason}</small>}</td></tr>)}</tbody></table></div> : <div className="nd-block-empty">This block contains no operations. Its header still advances the chain.</div>}<RawData title={`Transactions · ${block.transactions.length}`} value={block.transactions} name={`block-${block.header.height}-transactions.json`}/><RawData title={`State changes · ${block.changes.length}`} value={block.changes} name={`block-${block.header.height}-changes.json`}/><RawData title="Complete sanitized block feed" value={block} name={`block-${block.header.height}.json`}/><p className="nd-result-footnote">The public feed exposes execution metadata and field digests. Query witnesses are available through the light node.</p></section> : !error && <div className="nd-card nd-empty"><Database size={28}/><h3>Waiting for the first block</h3><p>The inspector will load automatically after the full node replays a block.</p></div>}
  </section>;
}

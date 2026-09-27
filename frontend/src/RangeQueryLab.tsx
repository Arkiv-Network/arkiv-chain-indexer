import { useEffect, useRef, useState, type FormEvent } from "react";
import { ArrowRight, ChevronRight, LoaderCircle, ShieldCheck } from "lucide-react";
import { RANGE_TYPES, pinRange, rangeExamples, rangeExpression, verifyRange, type RangeResponse, type RangeSelection } from "./rangeProofApi";
import { displayNative, type NativeSourceStatus } from "./simulatorApi";

export function RangeQueryLab({ status, unavailable, simple = false }: { status: NativeSourceStatus; unavailable: boolean; simple?: boolean }) {
  const examples = rangeExamples(status.head.height);
  const [selection, setSelection] = useState<RangeSelection>(() => {
    const requested = typeof window === "undefined" ? null : new URLSearchParams(window.location.search).get("range");
    const sample = examples.find(example => example.id === requested) ?? examples[0];
    return { ...sample.request, height: "latest" };
  });
  const [result, setResult] = useState<RangeResponse | null>(null);
  const [request, setRequest] = useState<RangeSelection | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const controller = useRef<AbortController | null>(null);
  useEffect(() => () => controller.current?.abort(), []);
  useEffect(() => {
    // The target mounts after status arrives, so the browser's initial fragment scroll is too early.
    if (window.location.hash === "#range-query") document.getElementById("range-query")?.scrollIntoView();
  }, []);
  useEffect(() => { if (unavailable) { controller.current?.abort(); setBusy(false); setResult(null); } }, [unavailable]);
  const edit = (next: RangeSelection) => { controller.current?.abort(); setBusy(false); setResult(null); setError(""); setRequest(null); setSelection(next); };
  async function run(draft: RangeSelection) {
    if (unavailable) return;
    controller.current?.abort();
    const current = new AbortController(); controller.current = current;
    setResult(null); setError(""); setBusy(true); setRequest(null);
    try {
      const pinned = pinRange(draft, status.head.height);
      setSelection(pinned); setRequest(pinned);
      const response = await verifyRange(status, pinned, current.signal);
      if (!current.signal.aborted) setResult(response);
    } catch (cause) {
      if (!current.signal.aborted) setError(cause instanceof Error ? cause.message : "Range verification failed.");
    } finally { if (!current.signal.aborted) setBusy(false); }
  }
  const submit = (event: FormEvent) => { event.preventDefault(); void run(selection); };
  const exampleButton = (sample: typeof examples[number], index: number) => <button type="button" className="nd-example" key={sample.id} disabled={busy || unavailable} onClick={() => { edit(sample.request); void run(sample.request); }}><span>0{index + 1} / Run example <ArrowRight size={13}/></span><strong>{sample.title}</strong><small>{sample.description}</small></button>;
  return <section id="range-query" className="nd-lab" aria-labelledby="range-title">
    <div className="nd-section-heading nd-lab-heading"><div><span className="nd-eyebrow">{simple ? "TRY A REAL QUERY" : "RANGE QUERY PLAYGROUND"}</span><h2 id="range-title">{simple ? "Start with a price range." : "Verify a complete numeric range."}</h2><p>One indexed attribute. Every matching live entity at a fixed block.</p></div><span className="nd-chip">Range proof · no paging</span></div>
    <div className="nd-examples">{(simple ? examples.slice(0, 4) : examples).map(exampleButton)}</div>
    {simple && <details className="nd-raw nd-more-examples"><summary>More range examples <ChevronRight size={15}/></summary><div className="nd-examples">{examples.slice(4).map((sample, index) => exampleButton(sample, index + 4))}</div></details>}
    <p className="nd-range-demo-note">Price examples use five seeded u64 values: 9, 10, 15, 20 and 21. Their expiry is block 1,030,236. Results below come from the live chain at the selected snapshot.</p>
    <div className="nd-query-layout"><section className="nd-card nd-query-card"><div className="nd-card-title"><ShieldCheck size={18}/><h3>Build a range</h3><span>READ ONLY</span></div>
      <p className="nd-query-explanation">Choose an indexed numeric attribute and its bounds. Include a boundary with ≥ or ≤; exclude it with &gt; or &lt;.</p>
      <form onSubmit={submit}><div className="nd-form-grid">
        <label>Snapshot block<input aria-label="Range snapshot block" value={selection.height} placeholder="latest" onChange={e => edit({ ...selection, height: e.target.value })}/></label>
        <label>Namespace<input aria-label="Range namespace" value={selection.namespace} onChange={e => edit({ ...selection, namespace: e.target.value })}/></label>
        <label className="nd-field-wide">Indexed attribute<input aria-label="Range attribute" value={selection.attribute} onChange={e => edit({ ...selection, attribute: e.target.value })}/></label>
        <label className="nd-field-wide">Numeric type<select aria-label="Range value type" value={selection.valueType} onChange={e => edit({ ...selection, valueType: e.target.value as RangeSelection["valueType"] })}>{RANGE_TYPES.map(t => <option key={t}>{t}</option>)}</select></label>
        {(["lower", "upper"] as const).map(side => <div key={side} className="nd-range-bound"><label>{side === "lower" ? "Lower bound" : "Upper bound"}<input aria-label={`Range ${side} bound`} placeholder="Unbounded" value={selection[side]?.value ?? ""} onChange={e => edit({ ...selection, [side]: e.target.value === "" ? undefined : { value: e.target.value, inclusive: selection[side]?.inclusive ?? true } })}/></label><label>Boundary<select aria-label={`Range ${side} boundary`} disabled={!selection[side]} value={selection[side]?.inclusive === false ? "exclusive" : "inclusive"} onChange={e => edit({ ...selection, [side]: { ...selection[side]!, inclusive: e.target.value === "inclusive" } })}><option value="inclusive">Inclusive {side === "lower" ? "≥" : "≤"}</option><option value="exclusive">Exclusive {side === "lower" ? ">" : "<"}</option></select></label></div>)}
        <div className="nd-query-equation"><code>{rangeExpression(selection)}</code></div>
      </div><button className="nd-primary" disabled={busy || unavailable} type="submit">{busy ? <LoaderCircle size={17} className="nd-spin"/> : <ShieldCheck size={17}/>} {busy ? "Verifying range…" : "Run & verify range"}<ArrowRight size={16}/></button><p className="nd-form-caption">Leave one bound blank for a one-sided range. “latest” is pinned before sending. Example buttons run at the current block.</p></form>
    </section><section className="nd-card nd-result-card" aria-live="polite"><div className="nd-card-title"><ShieldCheck size={18}/><h3>Complete range result</h3></div>
      {busy ? <div className="nd-empty"><LoaderCircle className="nd-spin" size={28}/><h3>Verifying the complete interval</h3><p>Checking against the retained header at block {request?.height}.</p></div> : error ? <div className="nd-query-error" role="alert"><strong>Range did not complete</strong><p>{error}</p><p>No partial result is displayed. If a proof limit was exceeded, narrow the range and run it again.</p></div> : result ? <>
        <div className="nd-verified"><ShieldCheck size={21}/><div><strong>Complete range verified</strong><span>Hosted light process · authenticated proposer header</span></div></div>
        <p className="nd-range-result-query"><code>{rangeExpression(result.query)}</code></p>
        <div className="nd-response-summary"><span><strong>{result.rows.length}</strong> rows</span><span><strong>{result.termCount}</strong> indexed values</span><span>Block <strong>#{result.snapshot.height}</strong></span></div>
        {result.rows.length ? <div className="nd-records">{result.rows.map(row => {
          const attributes = row.attributes as Array<{ name: string; type: string; value: unknown }>;
          const matched = attributes.find(attribute => attribute.name === result.query.attribute && attribute.type === result.query.valueType);
          const key = displayNative(row.recordKey);
          return <details key={String(row.recordId)} className="nd-record"><summary><span className="nd-record-id">#{displayNative(row.recordId)}</span><span className="nd-record-main"><strong>{result.query.attribute} = {displayNative(matched?.value)}</strong><span title={key}>Entity {key.slice(0, 12)}…{key.slice(-8)} · expires #{displayNative(row.expiresAtHeight)}</span></span><ChevronRight size={15}/></summary><div className="nd-record-detail"><p><strong>Record key</strong><code>{key}</code></p><pre>{JSON.stringify(row, null, 2)}</pre></div></details>;
        })}</div> : <div className="nd-absence"><span>∅</span><h3>Verified empty range</h3><p>No live entities match these bounds at block {result.snapshot.height}.</p></div>}
        <p className="nd-result-footnote">Every match at this snapshot is included, in record ID order. There is no continuation or next page.</p>
        <details className="nd-raw"><summary>Snapshot commitments <ChevronRight size={15}/></summary><div className="nd-raw-body"><div className="nd-hashline"><span>Verified state root</span><code>{result.snapshot.stateRoot}</code></div><div className="nd-hashline"><span>Block hash</span><code>{result.snapshot.hash}</code></div></div></details>
      </> : <div className="nd-empty"><ShieldCheck size={28}/><h3>Which prices match?</h3><p>Click “10 ≤ price &lt; 20” to query the live demo. The complete answer and its verification result will appear here.</p></div>}
    </section></div>
    {result && <p><a className="nd-button" href={"/proof-inspector?" + new URLSearchParams({ height: result.query.height, namespace: result.query.namespace, attribute: result.query.attribute, valueType: result.query.valueType, lower: result.query.lower?.value ?? "", lowerInclusive: String(result.query.lower?.inclusive ?? true), upper: result.query.upper?.value ?? "", upperInclusive: String(result.query.upper?.inclusive ?? true) }).toString()}>Explain this proof on the tree <ArrowRight size={15}/></a></p>}
    <p className="nd-range-limits">Complete result or error · default maximum 1,000 rows and 1,000 distinct values (operator configurable) · proof size and work limits also apply. <a href="/range-explained#support">How limits work</a></p>
    {request && <details className="nd-raw"><summary>Exact range API request <ChevronRight size={15}/></summary><div className="nd-raw-body"><p>POST /node-sim/v1/query/range/verified</p><pre tabIndex={0}>{JSON.stringify(request, null, 2)}</pre></div></details>}
    {result && <details className="nd-raw"><summary>Verified range response and header certificate <ChevronRight size={15}/></summary><div className="nd-raw-body"><p>This is the hosted verifier’s response. Open the proof inspector for the decoded tree and its witness list.</p><pre tabIndex={0}>{JSON.stringify(result, null, 2)}</pre></div></details>}
  </section>;
}

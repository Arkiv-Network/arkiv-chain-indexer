import { useEffect, useRef, useState, type FormEvent } from "react";
import { ArrowRight, LoaderCircle, ShieldCheck } from "lucide-react";
import { RANGE_TYPES, pinRange, rangeExamples, verifyRange, type RangeResponse, type RangeSelection } from "./rangeProofApi";
import { displayNative, type NativeSourceStatus } from "./simulatorApi";

export function RangeQueryLab({status, unavailable}: {status: NativeSourceStatus; unavailable: boolean}) {
  const [selection, setSelection] = useState<RangeSelection>(() => rangeExamples(status.head.height)[0].request);
  const [result, setResult] = useState<RangeResponse | null>(null);
  const [request, setRequest] = useState<RangeSelection | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const controller = useRef<AbortController | null>(null);
  useEffect(() => () => controller.current?.abort(), []);
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
  return <section id="range-query" className="nd-lab" aria-labelledby="range-title">
    <div className="nd-section-heading nd-lab-heading"><div><span className="nd-eyebrow">RANGE QUERY PLAYGROUND</span><h2 id="range-title">Verify a complete numeric range.</h2><p>One indexed attribute. Every matching live entity at a fixed block.</p></div><span className="nd-chip">Range proof · no paging</span></div>
    <div className="nd-examples">{rangeExamples(status.head.height).map((sample, index) => <button type="button" className="nd-example" key={sample.id} disabled={busy || unavailable} onClick={() => {edit(sample.request); void run(sample.request);}}><span>0{index + 1} / Range example</span><strong>{sample.title}</strong><small>{sample.description}</small></button>)}</div>
    <div className="nd-query-layout"><section className="nd-card nd-query-card"><div className="nd-card-title"><ShieldCheck size={18}/><h3>Build a range</h3><span>READ ONLY</span></div>
      <p className="nd-query-explanation">Use u64, i32, u256 or dec values. The verifier returns the entire range or an error. Initial limits are 64 rows and 64 distinct indexed values; proof size and work limits also apply.</p>
      <form onSubmit={submit}><div className="nd-form-grid">
        <label>Snapshot block<input aria-label="Range snapshot block" value={selection.height} placeholder="latest" onChange={e => edit({...selection, height:e.target.value})}/></label>
        <label>Namespace<input aria-label="Range namespace" value={selection.namespace} onChange={e => edit({...selection, namespace:e.target.value})}/></label>
        <label className="nd-field-wide">Indexed attribute<input aria-label="Range attribute" value={selection.attribute} onChange={e => edit({...selection, attribute:e.target.value})}/></label>
        <label className="nd-field-wide">Numeric type<select aria-label="Range value type" value={selection.valueType} onChange={e => edit({...selection, valueType:e.target.value as RangeSelection["valueType"]})}>{RANGE_TYPES.map(t => <option key={t}>{t}</option>)}</select></label>
        {(["lower", "upper"] as const).map(side => <div key={side} className="nd-range-bound"><label>{side === "lower" ? "Lower bound" : "Upper bound"}<input aria-label={`Range ${side} bound`} placeholder="Unbounded" value={selection[side]?.value ?? ""} onChange={e => edit({...selection, [side]:e.target.value === "" ? undefined : {value:e.target.value, inclusive:selection[side]?.inclusive ?? true}})}/></label><label>Boundary<select aria-label={`Range ${side} boundary`} disabled={!selection[side]} value={selection[side]?.inclusive === false ? "exclusive" : "inclusive"} onChange={e => edit({...selection, [side]:{...selection[side]!, inclusive:e.target.value === "inclusive"}})}><option value="inclusive">Inclusive {side === "lower" ? "≥" : "≤"}</option><option value="exclusive">Exclusive {side === "lower" ? ">" : "<"}</option></select></label></div>)}
      </div><button className="nd-primary" disabled={busy || unavailable} type="submit">{busy ? <LoaderCircle size={17} className="nd-spin"/> : <ShieldCheck size={17}/>} {busy ? "Verifying range…" : "Run & verify range"}<ArrowRight size={16}/></button><p className="nd-form-caption">Leave one bound blank for an open-ended range. “latest” is pinned before sending. Examples use the current block when clicked.</p></form>
    </section><section className="nd-card nd-result-card" aria-live="polite"><div className="nd-card-title"><ShieldCheck size={18}/><h3>Complete range result</h3></div>
      {busy ? <div className="nd-empty"><LoaderCircle className="nd-spin" size={28}/><h3>Verifying the complete interval</h3><p>Checking against the retained header at block {request?.height}.</p></div> : error ? <div className="nd-query-error" role="alert"><strong>Range did not complete</strong><p>{error}</p><p>No partial result is displayed. If a proof limit was exceeded, narrow the range and run it again.</p></div> : result ? <>
        <div className="nd-verified"><ShieldCheck size={21}/><div><strong>Complete range verified</strong><span>Hosted light process · authenticated proposer header</span></div></div>
        <div className="nd-response-summary"><span><strong>{result.rows.length}</strong> rows</span><span><strong>{result.termCount}</strong> indexed values</span><span>Block <strong>#{result.snapshot.height}</strong></span></div>
        {result.rows.length ? <div className="nd-records">{result.rows.map(row => <details key={String(row.recordId)} className="nd-record"><summary><span className="nd-record-id">{displayNative(row.recordId)}</span><span className="nd-record-main"><strong>{displayNative(row.recordKey)}</strong><span>Expires #{displayNative(row.expiresAtHeight)}</span></span></summary><div className="nd-record-detail"><pre>{JSON.stringify(row,null,2)}</pre></div></details>)}</div> : <div className="nd-absence"><span>∅</span><h3>Verified empty range</h3><p>No live entities match these bounds at block {result.snapshot.height}.</p></div>}
        <p className="nd-result-footnote">All matches are included in record ID order. No continuation or next page.</p>
        <div className="nd-hashline"><span>Verified state root</span><code>{result.snapshot.stateRoot}</code></div>
      </> : <div className="nd-empty"><ShieldCheck size={28}/><h3>A complete answer, with a proof</h3><p>Run a range example or enter your own bounds.</p></div>}
    </section></div>
    {request && <details className="nd-raw"><summary>Exact range API request</summary><div className="nd-raw-body"><p>POST /signed/v1/query/range/verified</p><pre tabIndex={0}>{JSON.stringify(request,null,2)}</pre></div></details>}
    {result && <details className="nd-raw"><summary>Verified range response and header certificate</summary><div className="nd-raw-body"><p>This is the hosted verifier’s response. The range API does not yet expose a decoded witness visualization.</p><pre tabIndex={0}>{JSON.stringify(result,null,2)}</pre></div></details>}
  </section>;
}

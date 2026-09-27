import { useEffect, useRef, useState, type FormEvent } from "react";
import { ChevronRight, Download, LoaderCircle, ShieldCheck } from "lucide-react";
import { PatriciaProofVisualizer } from "./PatriciaProofVisualizer";
import { inspectRange, initialRangeInspection, type InspectedRange } from "./rangeInspectionApi";
import { pinRange, rangeExamples, rangeExpression, RANGE_TYPES, type RangeSelection } from "./rangeProofApi";
import type { NativeSourceStatus } from "./simulatorApi";
import "./rangeInspector.css";

export function RangeProofInspector({ status, unavailable }: { status: NativeSourceStatus; unavailable: boolean }) {
  const examples = rangeExamples(status.head.height).filter(example => example.id.startsWith("price"));
  const [selection, setSelection] = useState<RangeSelection>(() => initialRangeInspection(status.head.height, window.location.search));
  const [result, setResult] = useState<InspectedRange | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const controller = useRef<AbortController | null>(null);
  async function run(draft: RangeSelection) {
    if (unavailable) return;
    controller.current?.abort();
    const current = new AbortController(); controller.current = current;
    setResult(null); setError(""); setBusy(true);
    try {
      const pinned = pinRange(draft, status.head.height);
      setSelection(pinned);
      const next = await inspectRange(status, pinned, current.signal);
      if (!current.signal.aborted) setResult(next);
    } catch (cause) {
      if (!current.signal.aborted) setError(cause instanceof Error ? cause.message : "Range inspection failed");
    } finally { if (!current.signal.aborted) setBusy(false); }
  }
  useEffect(() => {
    void run(selection);
    return () => controller.current?.abort();
    // Load one real witness on entry. Live polling must not replace the selected snapshot.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    if (unavailable) { controller.current?.abort(); setResult(null); setBusy(false); }
  }, [unavailable]);
  const edit = (next: RangeSelection) => {
    controller.current?.abort(); setBusy(false); setResult(null); setError(""); setSelection(next);
  };
  const submit = (event: FormEvent) => { event.preventDefault(); void run(selection); };
  const download = () => {
    if (!result) return;
    const href = URL.createObjectURL(new Blob([JSON.stringify(result, null, 2)], { type: "application/json" }));
    const a = document.createElement("a"); a.href = href; a.download = `range-witness-block-${result.snapshot.height}.json`; a.click();
    setTimeout(() => URL.revokeObjectURL(href), 1000);
  };
  return <section className="ri-lab" aria-labelledby="range-inspector-title">
    <div className="nd-section-heading"><div><span className="nd-eyebrow">ONE QUERY · ITS ACTUAL WITNESS</span><h2 id="range-inspector-title">Explain this range proof.</h2><p>Follow the opened branches, check the empty gaps, and see which witness entries bind the answer to the root.</p></div></div>
    <div className="ri-presets" aria-label="Range proof examples">{examples.map(example => <button key={example.id} className="nd-button" disabled={busy || unavailable} onClick={() => void run(example.request)}>{example.title}</button>)}</div>
    <details className="nd-card ri-query"><summary><span><strong>{rangeExpression(selection)}</strong><small>Namespace {selection.namespace} · {selection.valueType} · block {selection.height}</small></span><span>Change query <ChevronRight size={16}/></span></summary>
      <form onSubmit={submit}><div className="nd-form-grid">
        <label>Snapshot block<input aria-label="Range snapshot block" value={selection.height} onChange={e => edit({ ...selection, height: e.target.value })}/></label>
        <label>Namespace<input aria-label="Range namespace" value={selection.namespace} onChange={e => edit({ ...selection, namespace: e.target.value })}/></label>
        <label>Indexed attribute<input aria-label="Range attribute" value={selection.attribute} onChange={e => edit({ ...selection, attribute: e.target.value })}/></label>
        <label>Numeric type<select aria-label="Range value type" value={selection.valueType} onChange={e => edit({ ...selection, valueType: e.target.value as RangeSelection["valueType"] })}>{RANGE_TYPES.map(type => <option key={type}>{type}</option>)}</select></label>
        {(["lower", "upper"] as const).map(side => <div className="nd-range-bound" key={side}><label>{side === "lower" ? "Lower bound" : "Upper bound"}<input aria-label={`Range ${side} bound`} placeholder="Unbounded" value={selection[side]?.value ?? ""} onChange={e => edit({ ...selection, [side]: e.target.value === "" ? undefined : { value: e.target.value, inclusive: selection[side]?.inclusive ?? true } })}/></label><label>Boundary<select aria-label={`Range ${side} boundary`} disabled={!selection[side]} value={selection[side]?.inclusive === false ? "exclusive" : "inclusive"} onChange={e => edit({ ...selection, [side]: { ...selection[side]!, inclusive: e.target.value === "inclusive" } })}><option value="inclusive">Inclusive</option><option value="exclusive">Exclusive</option></select></label></div>)}
      </div><button className="nd-primary" type="submit" disabled={busy || unavailable}><ShieldCheck size={17}/> Inspect range proof</button><p className="nd-form-caption">“latest” is pinned to one block. Leave one bound blank for a one-sided range. Results are complete, without query paging.</p></form>
    </details>
    {busy ? <div className="nd-card nd-empty" role="status"><LoaderCircle className="nd-spin" size={26}/><h3>Checking and decoding the actual witness</h3><p>The hosted light node verifies the proof before returning its tree trace.</p></div> : error ? <div className="nd-query-error" role="alert"><strong>Range inspection did not complete</strong><p>{error}</p><p>No old tree is displayed. Narrow the query if a proof or inspection limit was exceeded.</p><button className="nd-button" disabled={unavailable} onClick={() => void run(selection)}>Retry range inspection</button></div> : result ? <>
      <div className="nd-card ri-answer"><div className="nd-verified"><ShieldCheck size={22}/><div><strong>Complete range verified</strong><span>Hosted Rust light node · block #{result.snapshot.height}</span></div></div>
        <p><strong>{rangeExpression(result.query)}</strong> returns {result.rows.length === 0 ? "no matching entities" : `${result.rows.length} matching ${result.rows.length === 1 ? "entity" : "entities"}`}.</p>
        <div className="ri-matches">{result.rows.map(row => {
          const matched = (row.attributes as Array<{ name: string; type: string; value: unknown }>).find(a => a.name === result.query.attribute && a.type === result.query.valueType);
          return <span key={String(row.recordId)}><strong>{result.query.attribute} = {String(matched?.value)}</strong><small>Record {String(row.recordId)}</small></span>;
        })}</div>
        <div className="ri-result-meta"><span>{result.inspection.interval.suppliedNodeCount} index witness entries · {((result.canonicalProof.length - 2) / 2).toLocaleString()} proof bytes</span><button className="nd-button nd-button-small" onClick={download}><Download size={14}/> Download witness</button></div>
      </div>
      <PatriciaProofVisualizer key={result.canonicalRequest} inspection={result.inspection}/>
    </> : !unavailable && <button className="nd-primary" onClick={() => void run(selection)}>Inspect range proof</button>}
  </section>;
}

import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowDown, ChevronLeft, ChevronRight, GitBranch, Leaf, Link2 } from "lucide-react";
import { proofHexBytes, rangeChildExplanation, rangeNodeExplanation, rangeTreeWindow, rangeWitnessNodes, shortProofHex, type RangePathNode, type RangeProofInspection } from "./patriciaProof";

const PAGE_SIZE = 16;
function Symbol({kind}: {kind: RangePathNode["kind"]}) {
  return kind === "branch" ? <GitBranch size={17}/> : kind === "extension" ? <Link2 size={17}/> : <Leaf size={17}/>;
}
function witnessLabel(node: RangePathNode) {
  return node.source === "inline" ? `Inline in W${node.proofIndex}` : `W${node.proofIndex}`;
}
function Bytes({label, value}: {label: string; value: string}) {
  return <details className="pv-raw"><summary>{label}<span>{proofHexBytes(value)} bytes</span></summary><pre>{value.slice(0,8192)}{value.length > 8192 ? "… (preview limited)" : ""}</pre></details>;
}

export function RangeWitnessTree({inspection}: {inspection: RangeProofInspection}) {
  const interval = inspection.interval;
  const byIndex = useMemo(() => new Map(interval.nodes.map(node => [node.index,node])), [interval]);
  const witnesses = useMemo(() => rangeWitnessNodes(interval.nodes), [interval]);
  const rootIndex = interval.nodes[0]?.index ?? 0;
  const initialFocus = interval.nodes.find(node => node.kind === "branch" && node.children.filter(child => child.decision === "open").length > 1)?.index ?? rootIndex;
  const [selectedIndex,setSelected] = useState(initialFocus);
  const [focus,setFocus] = useState(initialFocus);
  const [childSlot,setChildSlot] = useState<number | null>(null);
  const [page,setPage] = useState(() => Math.floor(Math.max(0, witnesses.findIndex(node => node.index === initialFocus)) / PAGE_SIZE));
  const [termIndex,setTermIndex] = useState(0);
  const selected = byIndex.get(selectedIndex);
  const focusNode = byIndex.get(focus);
  const child = childSlot === null ? undefined : selected?.children[childSlot];
  const shown = useMemo(() => rangeTreeWindow(interval.nodes,focus), [interval,focus]);
  const treeScroll = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const viewport = treeScroll.current;
    if (!viewport) return;
    const center = () => {
      const index = shown.has(selectedIndex) ? selectedIndex : focus;
      const target = viewport.querySelector<HTMLElement>(`[data-range-node="${index}"]`);
      if (!target) return;
      const bounds = target.getBoundingClientRect();
      const outer = viewport.getBoundingClientRect();
      // Move only the diagram's horizontal viewport; never jump the page.
      viewport.scrollLeft += bounds.left - outer.left - (viewport.clientWidth - bounds.width) / 2;
    };
    center();
    const resize = new ResizeObserver(center);
    resize.observe(viewport);
    return () => resize.disconnect();
  }, [focus, selectedIndex, shown]);
  const select = (node: RangePathNode, reveal = false) => {
    setSelected(node.index); setChildSlot(null);
    if (reveal || !shown.has(node.index)) setFocus(node.parentIndex ?? node.index);
    const ordinal = witnesses.findIndex(item => item.proofIndex === node.proofIndex);
    if (ordinal >= 0) setPage(Math.floor(ordinal/PAGE_SIZE));
    const term = inspection.postingSets.findIndex(posting => posting.termNodeIndex === node.index);
    if (term >= 0) setTermIndex(term);
  };
  const renderNode = (node: RangePathNode): React.ReactNode => <li key={`node-${node.index}`} className="rw-tree-item">
    <button type="button" data-range-node={node.index} className={`rw-tree-node ${node.leaf ? node.leaf.included ? "included" : "boundary" : ""} ${selectedIndex === node.index && childSlot === null ? "is-selected" : ""}`} onClick={() => select(node)} aria-pressed={selectedIndex === node.index && childSlot === null} aria-label={`Inspect range ${node.kind} ${witnessLabel(node)}`}>
      <span className="rw-node-label"><Symbol kind={node.kind}/><strong>{witnessLabel(node)}</strong></span><span>{node.kind} · nibble {node.depth}</span>
      {node.leaf ? <><strong className="rw-leaf-value">{node.leaf.valueType}({String(node.leaf.value)})</strong><span>{node.leaf.included ? "Inside range · included" : "Boundary leaf · excluded"}</span></> : <span>{node.kind === "extension" ? `${node.compressedPath.length} shared nibbles` : `${node.children.filter(c => c.decision === "open").length} opened children`}</span>}
    </button>
    {node.kind === "branch" && <div className="rw-slot-strip" aria-label={`Authenticated slots in ${witnessLabel(node)}`}>{node.children.map((entry,index) => <button type="button" className={`rw-slot ${entry.decision}`} key={entry.slot ?? index} aria-label={`Range slot ${entry.slot}: ${entry.decision}`} title={`${entry.slot}: ${entry.decision}`} onClick={() => {select(node);setChildSlot(index);}}>{entry.slot}</button>)}</div>}
    {node.children.some(entry => entry.kind !== "empty") && <ul className="rw-tree-children">{node.children.map((entry,index) => {
      if (entry.kind === "empty") return null;
      const target = entry.childIndex === null ? undefined : byIndex.get(entry.childIndex);
      return <li key={`edge-${node.index}-${index}`} className="rw-tree-edge"><span className={`rw-edge-label ${entry.decision}`}>{entry.slot === null ? "compressed prefix" : `slot ${entry.slot}`} · {entry.decision === "open" ? entry.kind === "inline" ? "open · inline" : "open · hash" : "outside interval"}</span>
        {target && shown.has(target.index) ? <ul className="rw-subtree">{renderNode(target)}</ul> : <button type="button" className={`rw-tree-stub ${entry.decision}`} onClick={() => {if (target) {select(target);setFocus(target.index);} else {select(node);setChildSlot(index);}}}>
          <strong>{target ? `Continue at ${witnessLabel(target)}` : "Committed · not opened"}</strong><span>{target ? "More verified nodes in this subtree" : entry.kind === "inline" ? "Inline reference outside the interval" : "Opaque hash reference"}</span>{entry.hash && <code>{shortProofHex(entry.hash,6)}</code>}
        </button>}
      </li>;
    })}</ul>}
  </li>;
  const term = inspection.postingSets[termIndex];
  const includedLeaves = interval.nodes.filter(node => node.leaf?.included);
  const boundaryLeaves = interval.nodes.filter(node => node.leaf && !node.leaf.included);
  return <section className="rw-section" aria-label="Range witness tree">
    <div className="pv-path-toolbar"><div><span className="pv-eyebrow">Complete interval proof</span><h4>Why this tree proves the whole range</h4></div><span className="pv-label">{interval.suppliedNodeCount} supplied · {interval.nodes.length} visited</span></div>
    <p className="rw-intro">Every branch that could contain an indexed value in the interval is opened. Outside branches keep their authenticated reference. Every included term contributes its complete set of record IDs.</p>
    <div className="rw-legend"><span><i className="open"/>Opened: may overlap</span><span><i className="outside"/>Skipped: outside interval</span><span><i className="empty"/>Empty: no child</span><span><i className="boundary"/>Opened boundary: excluded</span></div>
    {!!interval.nodes.length && <div className="rw-guide"><div><strong>Included indexed values</strong><div>{includedLeaves.length ? includedLeaves.slice(0,8).map(node => <button type="button" key={node.index} onClick={() => select(node)}>{node.leaf!.valueType}({String(node.leaf!.value)}) · {node.leaf!.postingCount} IDs</button>) : <span>None inside these bounds</span>}</div>{includedLeaves.length > 8 && <small>First 8 of {includedLeaves.length}; use the included-value selector below for every term.</small>}</div><div><strong>Opened but excluded boundaries</strong><div>{boundaryLeaves.length ? boundaryLeaves.slice(0,8).map(node => <button type="button" className="boundary" key={node.index} onClick={() => select(node)}>Boundary {node.leaf!.valueType}({String(node.leaf!.value)}) · excluded</button>) : <span>No outside boundary leaves were needed</span>}</div></div></div>}
    <details className="rw-bounds"><summary>Encoded interval and term-index root</summary><p>Typed values are encoded into ordered index keys. These bounds include the attribute and type; they are not a scan of row data.</p><dl className="pv-facts"><dt>Lower key</dt><dd><code>{interval.lowerKey}</code></dd><dt>Upper key</dt><dd><code>{interval.upperKey}</code></dd><dt>Term root</dt><dd><code>{interval.root}</code></dd></dl></details>
    {!interval.nodes.length ? <div className="rw-empty"><h4>{interval.emptyReason === "reversed-bounds" ? "The requested interval is empty" : "The authenticated term index is empty"}</h4><p>{interval.emptyReason === "reversed-bounds" ? "After applying the bounds, the lower encoded key exceeds the upper key. No interval nodes are needed." : "The term map has the canonical empty root. No witness node is invented for an empty tree."}</p></div> : <>
      <div className="rw-layout"><aside className="rw-witnesses" aria-label="Supplied range witness list"><h4>Supplied witness</h4><p>Choose W to locate its node. Inline nodes live inside parent bytes and have no separate entry.</p>
        <ol start={page*PAGE_SIZE} className="rw-witness-list">{witnesses.slice(page*PAGE_SIZE,(page+1)*PAGE_SIZE).map(node => <li key={node.index}><button type="button" aria-label={`Locate witness W${node.proofIndex}`} aria-pressed={selected?.proofIndex === node.proofIndex} className={selected?.proofIndex === node.proofIndex ? "is-selected" : ""} onClick={() => select(node,true)}><strong>W{node.proofIndex}</strong><span>{node.kind}<small>{proofHexBytes(node.rlp)} bytes</small></span></button></li>)}</ol>
        {witnesses.length>PAGE_SIZE && <div className="pv-pagination"><button type="button" aria-label="Previous witness entries" disabled={page===0} onClick={()=>setPage(page-1)}><ChevronLeft size={15}/></button><span>{page*PAGE_SIZE+1}–{Math.min((page+1)*PAGE_SIZE,witnesses.length)} / {witnesses.length}</span><button type="button" aria-label="Next witness entries" disabled={(page+1)*PAGE_SIZE>=witnesses.length} onClick={()=>setPage(page+1)}><ChevronRight size={15}/></button></div>}
        <p className="rw-view-note">W numbers are zero-based positions in the interval witness array. List navigation changes only this view.</p>
      </aside><div className="rw-graph-wrap"><div className="rw-graph-toolbar"><span>{focus === rootIndex ? "Term-index root" : `Subtree at ${focusNode ? witnessLabel(focusNode) : focus}`}</span><div><button type="button" disabled={focus===rootIndex} onClick={()=>setFocus(rootIndex)}>Root</button><button type="button" disabled={focusNode?.parentIndex === null || !focusNode} onClick={()=>focusNode?.parentIndex !== null && focusNode?.parentIndex !== undefined && setFocus(focusNode.parentIndex)}>Parent</button></div></div>
        <p className="rw-mobile-hint">Swipe sideways to explore the branches.</p><div ref={treeScroll} className="rw-tree-scroll" tabIndex={0} aria-label="Branching range proof tree"><ul className="rw-tree">{focusNode && renderNode(focusNode)}</ul></div><p className="rw-view-note">Solid connections follow actual verifier references. The view starts at the first fork with multiple opened children when present. Earlier shared-prefix nodes remain in the witness list and are reachable with Root or Parent. At most 32 visited nodes are shown here; “Continue” opens a deeper subtree. Empty branch slots remain visible in each 16-slot strip.</p>
      {selected && <aside className="rw-inspector" aria-label="Selected range proof node"><div className="pv-inspector-kicker">{child ? "Selected child reference" : "Selected interval node"}</div><h4><Symbol kind={selected.kind}/>{witnessLabel(selected)} · {selected.kind}{child ? ` · ${child.slot === null ? "extension child" : `slot ${child.slot}`}` : ""}</h4><p>{child ? rangeChildExplanation(child) : rangeNodeExplanation(selected)}</p>
        <dl className="pv-facts"><dt>Source</dt><dd>{selected.source === "inline" ? `Embedded in W${selected.proofIndex}; no extra supplied witness` : selected.source === "root" ? "Authenticated term-index root" : "Parent's hash reference"}</dd><dt>Consumed prefix</dt><dd><code>{selected.prefix || "(root)"}</code></dd>{selected.leaf && <><dt>Indexed value</dt><dd>{selected.leaf.attribute} · {selected.leaf.valueType}({String(selected.leaf.value)})</dd><dt>Contributes results</dt><dd>{selected.leaf.included ? `Yes · ${selected.leaf.postingCount} IDs` : "No · outside exact bounds"}</dd></>}</dl>
        {child?.childIndex !== null && child?.childIndex !== undefined && <button type="button" className="pv-inline-action" onClick={()=>{const target=byIndex.get(child.childIndex!);if(target) select(target,true);}}>Follow opened child <ArrowDown size={14}/></button>}
        <details className="rw-node-evidence"><summary>Hashes and exact node bytes</summary><p>Node Keccak-256</p><code>{selected.hash}</code>{child?.hash && <><p>Child commitment</p><code>{child.hash}</code></>}<Bytes label="Selected node RLP" value={selected.rlp}/>{child?.rlp && <Bytes label="Embedded child RLP" value={child.rlp}/>}</details>
      </aside>}
      </div></div>
    </>}
    <div className="rw-postings"><div className="pv-posting-heading"><Leaf size={18}/><h4>Every included term, every matching ID</h4><span className="pv-label">{inspection.postingSets.length} complete posting sets</span></div>
      {term ? <><p>The verifier rebuilds each posting root from every listed ID and checks it against the included term leaf. It then checks every returned row and record key against their maps.</p><label className="rw-term-select">Inspect included indexed value<select value={termIndex} onChange={event=>{const index=Number(event.target.value);setTermIndex(index);const node=byIndex.get(inspection.postingSets[index].termNodeIndex);if(node) select(node,true);}}>{inspection.postingSets.map((posting,index)=><option value={index} key={posting.termNodeIndex}>{posting.termType}({posting.termValue}) · {posting.count} IDs</option>)}</select></label><div className="pv-posting-roots"><div><span className="pv-field-label">Reconstructed posting root</span><code className="pv-hex">{term.reconstructedRoot}</code></div><span className="pv-root-equality">=</span><div><span className="pv-field-label">Committed in included leaf</span><code className="pv-hex">{term.authenticatedRoot}</code></div></div><div className="pv-id-list">{term.recordIds.map(id=><code className="is-selected" key={id}>{id}</code>)}</div></> : <p>No indexed values fall inside this interval. Opened boundary leaves and unopened outside subtrees contribute no IDs.</p>}
      <p className="pv-posting-scope">Completeness is relative to the authenticated index and the execution invariant that it describes live rows. This witness does not prove execution or consensus.</p>
    </div>
  </section>;
}

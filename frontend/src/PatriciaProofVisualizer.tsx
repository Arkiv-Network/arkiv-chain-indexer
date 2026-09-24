import { useEffect, useId, useState } from "react";
import { ArrowDown, ArrowRight, Check, ChevronLeft, ChevronRight, GitBranch, Layers, Leaf, Link2 } from "lucide-react";
import {
  defaultPointPath,
  describeTerminal,
  nodeNibbleSpan,
  PATRICIA_NODE_PAGE_SIZE,
  PATRICIA_PATH_PAGE_SIZE,
  PATRICIA_POSTING_PAGE_SIZE,
  pointPathLabel,
  proofHexBytes,
  shortProofHex,
  siblingCommitments,
  type MapCommitment,
  type PatriciaChild,
  type PatriciaMap,
  type PatriciaPathNode,
  type PatriciaPointPath,
  type ProofInspection,
} from "./patriciaProof";
import "./patriciaProof.css";

export type { ProofInspection } from "./patriciaProof";

const mapPurpose: Record<PatriciaMap, string> = {
  catalog: "Authenticates the namespace and the map roots committed by its catalog entry.",
  terms: "Authenticates the equality term and its posting-set commitment, or proves the term absent.",
  rows: "Authenticates the full row returned for this record ID.",
  keys: "Authenticates the record key lookup used by this verified page.",
};

const terminalTitle: Record<PatriciaPointPath["terminal"]["reason"], string> = {
  "leaf-match": "Matching leaf · inclusion",
  "empty-root": "Empty map · absence",
  "divergent-leaf": "Divergent leaf · absence",
  "divergent-extension": "Divergent extension · absence",
  "empty-branch-slot": "Empty branch slot · absence",
};

function Hex({ value, shorten = false }: { value: string; shorten?: boolean }) {
  return <code className="pv-hex" title={value}>{shorten ? shortProofHex(value) : value}</code>;
}

function RawBytes({ label, value }: { label: string; value: string }) {
  const maxCharacters = 8192;
  return <details className="pv-raw">
    <summary>{label}<span>{proofHexBytes(value).toLocaleString()} bytes</span></summary>
    <pre>{value.slice(0, maxCharacters)}{value.length > maxCharacters ? "…" : ""}</pre>
    {value.length > maxCharacters && <p>Preview limited to {maxCharacters.toLocaleString()} characters. The canonical proof contains all bytes.</p>}
  </details>;
}

function MapCard({ name, commitment, active, onChoose, note }: {
  name: string;
  commitment: MapCommitment;
  active?: boolean;
  onChoose?: () => void;
  note?: string;
}) {
  const contents = <>
    <span className="pv-map-title"><span>{name}</span>{onChoose ? <ArrowRight size={14}/> : <Layers size={14}/>}</span>
    <Hex value={commitment.root} shorten/>
    <span className="pv-map-meta">{commitment.entries} entries{note ? ` · ${note}` : ""}</span>
  </>;
  return onChoose
    ? <button type="button" className={`pv-map ${active ? "is-active" : ""}`} onClick={onChoose} aria-pressed={active}>{contents}</button>
    : <div className="pv-map pv-map-static">{contents}</div>;
}

function StateComposition({ inspection, currentMap, onMap }: {
  inspection: ProofInspection;
  currentMap: PatriciaMap | undefined;
  onMap: (map: PatriciaMap) => void;
}) {
  const state = inspection.stateComposition;
  const hasMap = (map: PatriciaMap) => inspection.pointPaths.some((path) => path.map === map);
  return <div className="pv-composition">
    <div className="pv-state-root">
      <div className="pv-root-label"><Layers size={17}/><span>State commitment</span><span className="pv-label">Domain-separated header</span></div>
      <Hex value={state.stateRoot}/>
      <details className="pv-header-details"><summary>Inspect state header</summary>
        <dl className="pv-facts"><dt>Domain</dt><dd><code>{state.domain}</code></dd><dt>Next namespace</dt><dd>{state.nextNamespace}</dd></dl>
        <RawBytes label="Canonical header" value={state.headerBytes}/>
        <RawBytes label="Pricing encoding" value={state.pricingBytes}/>
      </details>
    </div>
    <div className="pv-composition-edge"><ArrowDown size={15}/><span>Header commits these map roots</span></div>
    <div className="pv-top-maps">
      <MapCard name="Namespace catalog" commitment={state.catalog} active={currentMap === "catalog"} onChoose={hasMap("catalog") ? () => onMap("catalog") : undefined} note="point path"/>
      <MapCard name="Host map" commitment={state.host} note="commitment only"/>
    </div>
    {state.namespace ? <div className="pv-namespace">
      <div className="pv-namespace-label"><ArrowDown size={15}/><span>Catalog leaf · namespace <strong>{state.namespace.id}</strong></span><span>next record {state.namespace.nextRecord}</span></div>
      <div className="pv-namespace-maps">
        {(["terms", "rows", "keys", "records"] as const).map((map) => <MapCard
          key={map}
          name={map === "terms" ? "Term index" : map === "rows" ? "Rows" : map === "keys" ? "Record keys" : "Record metadata"}
          commitment={state.namespace![map]}
          active={currentMap === map}
          onChoose={map !== "records" && hasMap(map) ? () => onMap(map) : undefined}
          note={map !== "records" && hasMap(map) ? "inspect path" : "commitment only"}
        />)}
      </div>
    </div> : <p className="pv-composition-note">The catalog path proves this namespace absent; there are no namespace map roots to expand.</p>}
  </div>;
}

function NodeSymbol({ kind }: { kind: PatriciaPathNode["kind"] }) {
  return kind === "branch" ? <GitBranch size={16}/> : kind === "extension" ? <Link2 size={16}/> : <Leaf size={16}/>;
}

function ChildReference({ child, selected }: { child: PatriciaChild; selected: boolean }) {
  return <div className="pv-child-detail">
    <div className="pv-inspector-kicker">{child.slot === null ? "Extension child" : `Branch slot ${child.slot}`} · {selected ? "lookup path" : "sibling reference"}</div>
    <h4>{child.kind === "empty" ? "Empty child" : child.kind === "inline" ? "Inline child" : "Hash commitment"}</h4>
    <p>{child.kind === "empty"
      ? selected ? "This empty slot terminates the lookup and proves absence." : "This branch slot has no child."
      : child.kind === "inline"
        ? "The child's exact RLP bytes are embedded in its parent."
        : selected ? "The next supplied node must hash to this commitment." : "This reference authenticates an off-path subtree. Its descendants are not disclosed by this point path."}</p>
    {child.hash && <><span className="pv-field-label">Child hash</span><Hex value={child.hash}/></>}
    {child.rlp && <RawBytes label="Embedded child RLP" value={child.rlp}/>}
  </div>;
}

function NodeInspector({ path, node, childIndex, onChild, onStep, nodePosition }: {
  path: PatriciaPointPath;
  node: PatriciaPathNode;
  childIndex: number | null;
  onChild: (index: number | null) => void;
  onStep: (delta: number) => void;
  nodePosition: number;
}) {
  const child = childIndex === null ? undefined : node.children[childIndex];
  const siblings = siblingCommitments(node);
  const span = nodeNibbleSpan(node);
  const remaining = path.keyNibbles.slice(node.depth);
  const compressedMatch = node.compressedPath === remaining.slice(0, node.compressedPath.length);
  return <aside className="pv-inspector" aria-label="Selected proof node">
    <div className="pv-inspector-top"><span className="pv-inspector-kicker">Node inspector</span><div className="pv-stepper">
      <button type="button" aria-label="Previous proof node" disabled={nodePosition === 0} onClick={() => onStep(-1)}><ChevronLeft size={15}/></button>
      <span>{nodePosition + 1} / {path.nodes.length}</span>
      <button type="button" aria-label="Next proof node" disabled={nodePosition === path.nodes.length - 1} onClick={() => onStep(1)}><ChevronRight size={15}/></button>
    </div></div>
    <h4><span className={`pv-node-symbol ${node.kind}`}><NodeSymbol kind={node.kind}/></span>{node.kind[0].toUpperCase() + node.kind.slice(1)} node</h4>
    <p className="pv-node-explanation">{node.kind === "branch" ? `Routes the next key nibble through one of 16 slots. ${siblings.length} populated sibling ${siblings.length === 1 ? "reference is" : "references are"} committed here.` : node.kind === "extension" ? "Compresses a shared sequence of key nibbles into one authenticated step." : "Carries the remaining key suffix and the authenticated value bytes."}</p>
    <dl className="pv-facts">
      <dt>Referenced by</dt><dd>{node.source === "root" ? "Map root hash" : node.source === "inline" ? "Inline parent bytes" : "Parent hash reference"}</dd>
      <dt>Proof array index</dt><dd>{node.proofIndex}{node.source === "inline" ? " · embedded" : ""}</dd>
      <dt>Nibble offset</dt><dd>{node.depth} / {path.keyNibbles.length}</dd>
      <dt>Node encoding</dt><dd>{proofHexBytes(node.rlp).toLocaleString()} bytes</dd>
      {node.kind === "leaf" && <><dt>Value encoding</dt><dd>{node.valueBytes} bytes</dd></>}
    </dl>
    <span className="pv-field-label">Node Keccak-256</span><Hex value={node.hash}/>
    {node.kind !== "branch" && <div className="pv-compressed">
      <span className="pv-field-label">Decoded compact path · {span} nibbles</span>
      <code>{node.compressedPath || "(empty suffix)"}</code>
      <span className={compressedMatch ? "pv-match" : "pv-divergence"}>{compressedMatch ? "Matches the lookup key at this offset" : "Diverges from the lookup key at this offset"}</span>
    </div>}
    {node.kind === "branch" && <div className="pv-branch-explain">Selected slot <code>{node.selectedNibble ?? "—"}</code><span>Choose a slot in the diagram to inspect its commitment.</span></div>}
    {node.kind === "extension" && node.children[0] && <button type="button" className="pv-inline-action" onClick={() => onChild(childIndex === 0 ? null : 0)}><Link2 size={14}/>Inspect extension child</button>}
    {child && <ChildReference child={child} selected={node.kind === "extension" || child.slot === node.selectedNibble}/>}
    <RawBytes label="Exact node RLP" value={node.rlp}/>
  </aside>;
}

function PathWorkbench({ path }: { path: PatriciaPointPath }) {
  const [selectedNode, setSelectedNode] = useState(0);
  const [selectedChild, setSelectedChild] = useState<number | null>(null);
  const node = path.nodes[selectedNode];
  const pageStart = Math.floor(selectedNode / PATRICIA_NODE_PAGE_SIZE) * PATRICIA_NODE_PAGE_SIZE;
  const visibleNodes = path.nodes.slice(pageStart, pageStart + PATRICIA_NODE_PAGE_SIZE);
  const selectNode = (index: number, child: number | null = null) => { setSelectedNode(index); setSelectedChild(child); };
  const span = node ? nodeNibbleSpan(node) : 0;
  return <>
    <div className="pv-key-strip"><div><span className="pv-field-label">Lookup key · nibbles</span><span>Highlighted: selected node's path segment</span></div>
      <code>{node ? <>{path.keyNibbles.slice(0, node.depth)}<mark>{path.keyNibbles.slice(node.depth, node.depth + span)}</mark>{path.keyNibbles.slice(node.depth + span)}</> : path.keyNibbles}</code>
    </div>
    <div className="pv-workbench">
      <div className="pv-graph">
        <div className="pv-graph-heading"><span><span className="pv-live-dot"/>Witness path</span><span>{path.nodes.length} visited · {path.suppliedNodeCount} supplied</span></div>
        <div className="pv-graph-root"><span>{path.map} map root</span><Hex value={path.root} shorten/></div>
        {path.nodes.length > PATRICIA_NODE_PAGE_SIZE && <div className="pv-node-pagination">
          <button type="button" disabled={pageStart === 0} onClick={() => selectNode(Math.max(0, pageStart - PATRICIA_NODE_PAGE_SIZE))}><ChevronLeft size={14}/>Earlier nodes</button>
          <span>Nodes {pageStart + 1}–{Math.min(pageStart + PATRICIA_NODE_PAGE_SIZE, path.nodes.length)} of {path.nodes.length}</span>
          <button type="button" disabled={pageStart + PATRICIA_NODE_PAGE_SIZE >= path.nodes.length} onClick={() => selectNode(pageStart + PATRICIA_NODE_PAGE_SIZE)}>Later nodes<ChevronRight size={14}/></button>
        </div>}
        <ol className="pv-path-nodes" start={pageStart + 1}>
          {visibleNodes.map((item, visibleIndex) => {
            const position = pageStart + visibleIndex;
            const active = position === selectedNode;
            const populated = item.children.filter((ref) => ref.kind !== "empty").length;
            return <li key={`${item.index}:${item.hash}`}>
              <div className="pv-edge"><span/>{position === 0 ? "Keccak-256" : item.source === "inline" ? "embedded RLP" : "hash reference"}<ArrowDown size={13}/></div>
              <div className={`pv-path-node ${active ? "is-active" : ""}`}>
                <button type="button" className="pv-node-pick" onClick={() => selectNode(position)} aria-pressed={active} aria-label={`Inspect ${item.kind} node ${position + 1} at nibble ${item.depth}`}>
                  <span className={`pv-node-symbol ${item.kind}`}><NodeSymbol kind={item.kind}/></span>
                  <span className="pv-node-name"><strong>{item.kind}</strong><span>{item.kind === "branch" ? `${populated} populated slots` : `${item.compressedPath.length} compressed nibbles`}</span></span>
                  <span className="pv-node-source">{item.source}</span><span className="pv-depth">@{item.depth}</span>
                </button>
                <div className="pv-node-hash"><Hex value={item.hash} shorten/></div>
                {item.kind === "branch" && <div className="pv-slots" aria-label={`Branch slots for node ${position + 1}`}>
                  {item.children.slice(0, 16).map((ref, childPosition) => <button type="button" key={ref.slot ?? childPosition}
                    className={`pv-slot ${ref.kind} ${ref.slot === item.selectedNibble ? "is-followed" : ""} ${active && selectedChild === childPosition ? "is-inspected" : ""}`}
                    onClick={() => selectNode(position, childPosition)}
                    aria-label={`Slot ${ref.slot}: ${ref.kind}${ref.slot === item.selectedNibble ? ", selected lookup path" : ", sibling"}`}
                    aria-pressed={active && selectedChild === childPosition}
                    title={`${ref.slot}: ${ref.kind}${ref.hash ? ` ${ref.hash}` : ""}`}><span>{ref.slot}</span><i/></button>)}
                </div>}
                {item.kind !== "branch" && <div className="pv-path-suffix"><span>{item.kind === "leaf" ? "suffix" : "skip"}</span><code>{shortProofHex(item.compressedPath, 16) || "∅"}</code></div>}
              </div>
            </li>;
          })}
        </ol>
        {pageStart + PATRICIA_NODE_PAGE_SIZE >= path.nodes.length && <div className={`pv-terminal ${path.terminal.kind}`}><Check size={15}/><span>{terminalTitle[path.terminal.reason]}</span></div>}
        <div className="pv-graph-legend"><span><i className="followed"/>Lookup path</span><span><i className="committed"/>Sibling reference</span><span><i className="empty"/>Empty slot</span></div>
        <p className="pv-graph-caption">Each card is a node visited by the strict verifier. Sibling slots show authenticated references; their undisclosed subtrees are not drawn.</p>
      </div>
      {node ? <NodeInspector path={path} node={node} nodePosition={selectedNode} childIndex={selectedChild} onChild={setSelectedChild} onStep={(delta) => selectNode(selectedNode + delta)}/>
        : <aside className="pv-inspector pv-empty-path"><Layers size={30}/><h4>No nodes to traverse</h4><p>{describeTerminal(path)}</p><span className="pv-field-label">Authenticated empty root</span><Hex value={path.root}/></aside>}
    </div>
    <p className={`pv-path-outcome ${path.terminal.kind}`}><Check size={15}/><span>{describeTerminal(path)}</span></p>
  </>;
}

function PostingCompleteness({ posting }: { posting: ProofInspection["postingSet"] }) {
  const [page, setPage] = useState(0);
  if (posting === null) return <div className="pv-posting"><div className="pv-posting-heading"><Layers size={18}/><h4>Equality completeness</h4></div><p>The namespace absence path terminates this equality query. No posting set is supplied.</p></div>;
  const start = page * PATRICIA_POSTING_PAGE_SIZE;
  const visible = posting.recordIds.slice(start, start + PATRICIA_POSTING_PAGE_SIZE);
  const selected = new Set(posting.selectedRecordIds);
  return <div className="pv-posting">
    <div className="pv-posting-heading"><Layers size={18}/><h4>Equality completeness</h4><span className="pv-label">Complete posting set</span><strong>{posting.count.toLocaleString()} IDs</strong></div>
    <p>{posting.termPresent
      ? "The verifier rebuilds the posting root from every matching record ID and compares it with the term's authenticated commitment. Point inclusion alone cannot establish that an equality page is complete."
      : "The term path proves this equality term absent. The empty posting set is reconstructed; no matching records are returned."}</p>
    <div className="pv-posting-roots"><div><span className="pv-field-label">Reconstructed root</span><Hex value={posting.reconstructedRoot}/></div><span className="pv-root-equality">{posting.authenticatedRoot === null ? "→" : "="}</span><div><span className="pv-field-label">{posting.authenticatedRoot === null ? "Authenticated by" : "Committed in term leaf"}</span>{posting.authenticatedRoot ? <Hex value={posting.authenticatedRoot}/> : <span className="pv-no-term">Term absence path</span>}</div></div>
    <details className="pv-posting-records"><summary>Inspect posting IDs<span>{posting.selectedRecordIds.length} selected for this page</span></summary>
      <p className="pv-posting-legend">Highlighted IDs belong to this page; the complete set supports ordering and pagination checks.</p>
      {visible.length ? <div className="pv-id-list">{visible.map((id) => <code key={id} className={selected.has(id) ? "is-selected" : ""} title={selected.has(id) ? "Selected for this result page" : "In complete posting set"}>{id}{selected.has(id) && <Check size={11}/>}</code>)}</div> : <p className="pv-posting-legend">The complete posting set is empty.</p>}
      {posting.recordIds.length > PATRICIA_POSTING_PAGE_SIZE && <div className="pv-pagination"><button type="button" disabled={page === 0} onClick={() => setPage(page - 1)}><ChevronLeft size={15}/>Previous IDs</button><span>{start + 1}–{Math.min(start + PATRICIA_POSTING_PAGE_SIZE, posting.recordIds.length)} of {posting.recordIds.length}</span><button type="button" disabled={start + PATRICIA_POSTING_PAGE_SIZE >= posting.recordIds.length} onClick={() => setPage(page + 1)}>Next IDs<ChevronRight size={15}/></button></div>}
    </details>
    <p className="pv-posting-scope">Completeness is relative to the authenticated index and the execution invariant that it describes live rows. This trace does not prove execution or consensus.</p>
  </div>;
}

export function PatriciaProofVisualizer({ inspection }: { inspection: ProofInspection }) {
  const headingId = useId();
  const pathSelectId = useId();
  const [selectedPathId, setSelectedPathId] = useState(() => defaultPointPath(inspection.pointPaths)?.id);
  useEffect(() => { setSelectedPathId(defaultPointPath(inspection.pointPaths)?.id); }, [inspection]);
  const path = inspection.pointPaths.find((item) => item.id === selectedPathId) ?? defaultPointPath(inspection.pointPaths);
  const pathIndex = path ? inspection.pointPaths.indexOf(path) : 0;
  const pathPage = Math.floor(pathIndex / PATRICIA_PATH_PAGE_SIZE) * PATRICIA_PATH_PAGE_SIZE;
  const paths = inspection.pointPaths.slice(pathPage, pathPage + PATRICIA_PATH_PAGE_SIZE);
  return <section className="pv-proof" aria-labelledby={headingId}>
    <header className="pv-heading"><div><span className="pv-eyebrow">Inside the proof</span><h3 id={headingId}>Patricia witness explorer</h3><p>Follow the actual authenticated path from state commitment to query evidence.</p></div><span className="pv-profile"><GitBranch size={14}/>{inspection.proofProfile}</span></header>
    <StateComposition inspection={inspection} currentMap={path?.map} onMap={(map) => setSelectedPathId(inspection.pointPaths.find((item) => item.map === map)?.id)}/>
    <div className="pv-path-section">
      <div className="pv-path-toolbar"><div><span className="pv-eyebrow">Point proof</span><h4>{path ? `${path.map[0].toUpperCase()}${path.map.slice(1)} map path` : "No point paths"}</h4></div>
        {path && <div className="pv-path-select"><label htmlFor={pathSelectId}>Inspect path</label><select id={pathSelectId} value={path.id} onChange={(event) => setSelectedPathId(event.target.value)}>{paths.map((item) => <option key={item.id} value={item.id}>{pointPathLabel(item)}</option>)}</select>
          {inspection.pointPaths.length > PATRICIA_PATH_PAGE_SIZE && <div className="pv-stepper"><button type="button" aria-label="Previous group of proof paths" disabled={pathPage === 0} onClick={() => setSelectedPathId(inspection.pointPaths[pathPage - PATRICIA_PATH_PAGE_SIZE].id)}><ChevronLeft size={15}/></button><span>{pathPage + 1}–{pathPage + paths.length} / {inspection.pointPaths.length}</span><button type="button" aria-label="Next group of proof paths" disabled={pathPage + paths.length >= inspection.pointPaths.length} onClick={() => setSelectedPathId(inspection.pointPaths[pathPage + PATRICIA_PATH_PAGE_SIZE].id)}><ChevronRight size={15}/></button></div>}
        </div>}
      </div>
      {path && <><p className="pv-path-purpose">{mapPurpose[path.map]}{path.recordId !== null && <> Record ID <code>{path.recordId}</code>.</>}</p><PathWorkbench key={`${inspection.stateComposition.stateRoot}:${path.id}:${inspection.queryDigest}`} path={path}/></>}
    </div>
    <PostingCompleteness key={`${inspection.stateComposition.stateRoot}:${inspection.queryDigest}`} posting={inspection.postingSet}/>
    <footer className="pv-footer"><span>Source: node's strict verifier trace</span><span>{inspection.pointPaths.length} point paths · full witness bytes available in the canonical proof</span></footer>
  </section>;
}

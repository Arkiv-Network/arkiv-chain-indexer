import { useState, type ReactNode } from "react";
import { ArrowRight, ArrowUpRight, ChevronRight, ShieldCheck } from "lucide-react";
import { RangeQueryLab } from "./RangeQueryLab";
import { rangeExpression } from "./rangeProofApi";
import { evaluateExample, type ExampleBoundary, type ExampleBounds } from "./rangeWalkthrough";
import type { NativeSourceStatus } from "./simulatorApi";

export type LightPage = "queries" | "range-explained" | "proof-inspector";
export function lightPage(pathname: string): LightPage {
  const path = pathname.replace(/\/+$/, "");
  return path === "/range-explained" ? "range-explained" : path === "/proof-inspector" ? "proof-inspector" : "queries";
}

export function LightNavigation({ page }: { page: LightPage }) {
  return <nav aria-label="Light node pages">
    <a href="/queries" className={page === "queries" ? "is-active" : ""} aria-current={page === "queries" ? "page" : undefined}>Simple queries</a>
    <a href="/range-explained" className={page === "range-explained" ? "is-active" : ""} aria-current={page === "range-explained" ? "page" : undefined}>Range explained</a>
    <a href="/proof-inspector" className={page === "proof-inspector" ? "is-active" : ""} aria-current={page === "proof-inspector" ? "page" : undefined}>Proof inspector</a>
  </nav>;
}

interface LightPagesProps {
  page: LightPage;
  status: NativeSourceStatus | null;
  error: string;
  frozen: boolean;
  updated: Date | null;
  fullUrl: string;
  explorerUrl: string;
  equality: ReactNode;
}

export function LightNodePages({ page, status, error, frozen, updated, fullUrl, explorerUrl, equality }: LightPagesProps) {
  const [equalityOpen, setEqualityOpen] = useState(false);
  const explained = page === "range-explained";
  const unavailable = !!error || frozen;
  const supportsRanges = status?.authentication === "signed-proposer-v1" && status.proofProfiles?.includes("range-complete-v1");
  const identityKey = status ? `${status.sourceId}/${status.runId}/${status.genesisHash}/${status.chainId}/${frozen}` : "connecting";
  return <div className="nd-app nd-light nd-query-pages">
    <header className="nd-header">
      <a className="nd-brand" href="/queries" aria-label="Arkiv simple queries"><span className="nd-brand-mark">a<span>↗</span></span><strong>arkiv</strong><span className="nd-brand-divider"/><span>light node</span></a>
      <LightNavigation page={page}/>
    </header>
    <main className="nd-main">
      <section className="nd-hero nd-query-hero">
        <div><div className="nd-eyebrow"><span className="nd-kicker-line"/>EXPERIMENTAL · {status ? status.chainId === "9009" ? "ROGUE ONE / CHAIN 9009" : `CHAIN ${status.chainId}` : "LIGHT NODE"}</div>
          <h1>{explained ? <>How a range answer<br/>proves it is complete.</> : <>Ask for a range.<br/>Get every match.</>}</h1>
          <p>{explained ? "Finding matching records is only half the job. A range proof also lets the light node check that the full node left nothing out." : "Try a price range, see the matching entities, and check the hosted light node’s verification result at one fixed block."}</p>
        </div>
        <aside className="nd-hero-aside">
          <div className={`nd-status-pill ${status && !unavailable ? "is-healthy" : "is-waiting"}`}><span/>{error ? "Connection interrupted" : frozen ? "Verification stopped" : status ? status.paused ? "Paused" : status.health : "Connecting to node"}</div>
          <strong>{status ? `Header #${status.head.height}` : "Waiting for a header"}</strong>
          <small>{updated ? `Status read ${updated.toLocaleTimeString()}` : "Live node status"}</small>
        </aside>
      </section>
      {error && <div className="nd-alert" role="alert"><strong>Status unavailable.</strong> {error} {status && "The last reading remains visible; queries are disabled."}</div>}
      {frozen && <div className="nd-alert" role="alert"><strong>Verification stopped.</strong> The node reports {status?.health}. Previous query results have been cleared.</div>}
      {explained ? <RangeExplained status={status} fullUrl={fullUrl}/> : <>
        <div className="nd-query-intro"><ShieldCheck size={20}/><p>The hosted Rust light node checks the proof. This browser displays its answer. <a href="/range-explained#trust">Understand the trust model <ArrowRight size={14}/></a></p></div>
        {status && supportsRanges ? <RangeQueryLab key={identityKey} status={status} unavailable={unavailable} simple/> : <section className="nd-card nd-empty"><ShieldCheck size={28}/><h2>{status ? "Range queries unavailable on this node" : "Connecting to the range verifier"}</h2><p>{status ? "This source does not advertise the complete numeric range proof profile. Equality queries remain below." : "The live examples will appear when the node reports its identity and supported proofs."}</p></section>}
        <aside className="nd-learn-link"><div><strong>Why can’t a full node quietly omit a match?</strong><p>Walk through the boundaries, the index, and the chain of proof.</p></div><a className="nd-button" href="/range-explained">Range explained <ArrowRight size={16}/></a></aside>
        <details className="nd-equality-disclosure" onToggle={event => setEqualityOpen(event.currentTarget.open)}>
          <summary><div><strong>Equality queries</strong><span>Find an exact typed value, with verified pages.</span></div><ChevronRight size={19}/></summary>
          {equalityOpen && equality}
        </details>
        <p className="nd-query-more">For the decoded equality witness and trie visualization, open the <a href="/proof-inspector?proof=equality">proof inspector <ArrowRight size={14}/></a>.</p>
      </>}
      <details className="nd-node-details nd-raw"><summary>Live node identity and status <ChevronRight size={15}/></summary><div className="nd-raw-body">{status ? <><p>Chain {status.chainId} · header #{status.head.height}. A status reading is separate from the fixed snapshot of a query result.</p><pre tabIndex={0}>{JSON.stringify(status, null, 2)}</pre></> : <p>Waiting for the node status.</p>}</div></details>
    </main>
    <footer className="nd-footer"><span><strong>arkiv</strong> / experimental light node</span><a href="/node-design.html">Node design &amp; review <ArrowUpRight size={13}/></a><a href={fullUrl}>Full node <ArrowUpRight size={14}/></a><a href={explorerUrl}>Explorer <ArrowUpRight size={14}/></a></footer>
  </div>;
}

function BoundaryWalkthrough() {
  const [bounds, setBounds] = useState<ExampleBounds>({ lower: "10", upper: "20", lowerBoundary: "inclusive", upperBoundary: "exclusive" });
  const evaluated = evaluateExample(bounds);
  const matches = evaluated.values.filter(value => value.matches);
  const expression = rangeExpression({ attribute: "price", lower: bounds.lowerBoundary === "unbounded" ? undefined : { value: bounds.lower, inclusive: bounds.lowerBoundary === "inclusive" }, upper: bounds.upperBoundary === "unbounded" ? undefined : { value: bounds.upper, inclusive: bounds.upperBoundary === "inclusive" } });
  return <div className="nd-boundary-demo nd-card">
    <div className="nd-demo-heading"><span className="nd-eyebrow">INTERACTIVE EXPLANATION</span><span className="nd-chip">Illustrative data · no API request</span></div>
    <h3>Move the boundaries. See which prices belong.</h3>
    <p>Imagine five indexed prices: 9, 10, 15, 20 and 21. Start with 10 ≤ price &lt; 20: the answer is 10 and 15.</p>
    <div className="nd-form-grid nd-boundary-controls">{(["lower", "upper"] as const).map(side => <div className="nd-range-bound" key={side}>
      <label>{side === "lower" ? "Lower value" : "Upper value"}<input aria-label={`Example ${side} value`} inputMode="numeric" value={bounds[side]} disabled={bounds[`${side}Boundary`] === "unbounded"} onChange={event => setBounds({ ...bounds, [side]: event.target.value })}/></label>
      <label>Boundary<select aria-label={`Example ${side} boundary`} value={bounds[`${side}Boundary`]} onChange={event => setBounds({ ...bounds, [`${side}Boundary`]: event.target.value as ExampleBoundary })}><option value="inclusive">Include ({side === "lower" ? "≥" : "≤"})</option><option value="exclusive">Exclude ({side === "lower" ? ">" : "<"})</option><option value="unbounded">No {side} bound</option></select></label>
    </div>)}</div>
    <div className="nd-boundary-output" aria-live="polite" aria-atomic="true">
      {evaluated.error ? <p className="nd-alert" role="alert">{evaluated.error}</p> : <><p className="nd-demo-equation"><code>{expression}</code></p><div className="nd-price-line">{evaluated.values.map(item => <div className={`nd-price-point ${item.matches ? "is-included" : ""}`} key={item.value}><strong>{item.value}</strong><span>{item.reason}</span></div>)}</div><p className="nd-demo-answer"><strong>Example answer: {matches.length ? matches.map(item => item.value).join(", ") : "no matches"}.</strong> {matches.length ? "A complete answer must include every highlighted value." : "An empty answer still needs evidence that the interval has no matches."}</p></>}
    </div>
    <p className="nd-illustration-note">This local teaching model is not a decoded range witness and does not verify a proof. Open the proof inspector to explore the actual decoded range witness checked by the light node.</p>
    <a className="nd-button" href="/queries?range=price#range-query">Open the live price example <ArrowRight size={15}/></a>
  </div>;
}

function GuideSection({ id, number, title, children }: { id: string; number: string; title: string; children: ReactNode }) {
  return <section id={id} className="nd-guide-section" aria-labelledby={`${id}-title`}><span className="nd-eyebrow">{number}</span><h2 id={`${id}-title`}>{title}</h2>{children}</section>;
}

function RangeExplained({ status, fullUrl }: { status: NativeSourceStatus | null; fullUrl: string }) {
  return <article className="nd-range-guide">
    <nav className="nd-guide-toc" aria-label="Range explanation sections"><a href="#bounds">The bounds</a><a href="#indexed-data">The data</a><a href="#proof-chain">The proof</a><a href="#completeness">Missing answers</a><a href="#trust">Who you trust</a><a href="#support">API & limits</a></nav>
    <GuideSection id="bounds" number="01 / START WITH THE QUESTION" title="Which values are inside the range?">
      <p>“Find every entity whose price is at least 10 and less than 20” means <code>10 ≤ price &lt; 20</code>. Both tests apply to the <em>same</em> attribute. The lower endpoint is inclusive, so 10 belongs. The upper endpoint is exclusive, so 20 does not.</p>
      <BoundaryWalkthrough/>
      <p>Use <code>≤</code> or <code>≥</code> to include an endpoint, and <code>&lt;</code> or <code>&gt;</code> to exclude it. Leaving one side unbounded gives a one-sided query such as <code>price &gt; 20</code>. At least one bound is required. Reversed bounds, or equal endpoints with either endpoint excluded, describe an empty interval.</p>
    </GuideSection>
    <GuideSection id="indexed-data" number="02 / DEFINE THE DATA AND TIME" title="One numeric attribute. One fixed snapshot.">
      <div className="nd-guide-pair"><div><h3>The attribute must be indexed</h3><p>An entity can have an indexed numeric attribute named <code>price</code>. The index groups matching entity IDs under each distinct typed value. A number inside an unindexed field or a JSON payload is not a searchable price attribute.</p><p>Types matter: <code>u64(10)</code> and <code>dec(10)</code> are different index terms. Choose the type actually stored on the entity.</p></div><div><h3>The block fixes what “every” means</h3><p>A query pins one block height, block hash and state root. It asks about live entities in that snapshot, including their values and expiry at that time. Later creations, updates or expirations cannot change that answer.</p><p>“latest” is resolved to a specific retained header before the query is sent. The live status can keep advancing while the result stays pinned.</p></div></div>
      <p>The live Rogue One example uses seeded <code>u64</code> prices 9, 10, 15, 20 and 21 in namespace 1. These entities expire at block 1,030,236; the teaching model above stays fixed. Live results always come from the selected snapshot and can change as the chain changes.</p>
    </GuideSection>
    <GuideSection id="proof-chain" number="03 / FOLLOW THE EVIDENCE" title="From a signed header to every matching entity.">
      <p>The full node sends an answer plus a witness: the pieces needed to reconstruct and check commitments. The light node follows these links to its already authenticated state root.</p>
      <ol className="nd-proof-chain">
        <li><span>1</span><div><h3>Signed header → accepted state root</h3><p>The light node authenticates its header history against the pinned proposer. The chosen header commits to the state root for this snapshot.</p></div></li>
        <li><span>2</span><div><h3>State header & catalog → namespace roots</h3><p>The state-header commitment and catalog proof bind namespace 1 to its term index, row map and record-key map. A proof for a different namespace or snapshot cannot be substituted.</p></div></li>
        <li><span>3</span><div><h3>Term index → the entire numeric interval</h3><p>The index key includes the attribute name, scalar type and value in numeric order. The interval witness accounts for every intersecting branch, including the exact inclusive or exclusive boundaries. It proves which distinct price values exist inside the requested range.</p></div></li>
        <li><span>4</span><div><h3>Each matching value → its complete posting set</h3><p>A posting set is the list of entity IDs indexed under a value. For every matching term, the verifier reconstructs the complete set and compares its commitment. If three entities have price 15, all three IDs must be supplied.</p></div></li>
        <li><span>5</span><div><h3>Entity IDs → authenticated rows & key bindings</h3><p>Row proofs bind the entity contents to those IDs; key-map proofs bind the public entity keys to the same records. The verifier checks the matched typed attributes and that each entity is live at the selected block, then returns the full set.</p></div></li>
      </ol>
      <p className="nd-illustration-note">This chain is a conceptual explanation of <code>range-complete-v1</code>, not a visualization decoded from your live range proof. The proof inspector visualizes actual range and equality witnesses.</p>
      <details className="nd-raw nd-guide-technical"><summary>More detail: how can a small proof cover a large tree? <ChevronRight size={15}/></summary><div className="nd-raw-body"><p>The term index is an authenticated Patricia trie. Its compressed key paths describe the possible keys under a subtree. A subtree that cannot intersect the requested typed interval can remain an opaque hash. Any subtree that could contain a matching key must be opened far enough to account for it.</p><p>A boundary proof may reveal an out-of-range leaf or path to establish where the interval ends. It does not need to return unrelated subtrees in full. Node hashes and child commitments bind all the opened pieces to the same root; changing a piece changes that commitment.</p></div></details>
    </GuideSection>
    <GuideSection id="completeness" number="04 / CHECK WHAT COULD BE MISSING" title="A valid row alone does not prove a complete answer.">
      <p>Showing a membership proof for price 10 would prove that one row exists. To answer <code>10 ≤ price &lt; 20</code>, the verifier must also establish that no matching term, posting or row was omitted.</p>
      <div className="nd-table-scroll"><table className="nd-table nd-guide-table"><thead><tr><th>If the full node tries to…</th><th>The range verifier checks…</th></tr></thead><tbody>
        <tr><td>Skip the interior value 15</td><td>The interval witness must account for every intersecting term-index branch. Hiding a possibly matching branch behind an unexplained hash is rejected.</td></tr>
        <tr><td>Drop price 10, or add price 20</td><td>The authenticated query boundaries are inclusive at 10 and exclusive at 20. Term coverage and the returned rows must agree with those exact bounds.</td></tr>
        <tr><td>Return only one of several price-15 entities</td><td>All IDs in that term’s posting set must reconstruct its committed set. Leaving out an ID fails that check.</td></tr>
        <tr><td>Change an entity’s price, ID or public key</td><td>Row and key-binding proofs must agree with the committed maps and the indexed term.</td></tr>
        <tr><td>Claim “nothing matches”</td><td>An authenticated interval witness must establish that there are no matching terms in the requested namespace. An empty JSON array alone proves nothing.</td></tr>
      </tbody></table></div>
      <p>For example, <code>10 &lt; price &lt; 15</code> matches none of the five demo prices. A valid proof of that gap is a successful, complete result with zero rows. It is different from a failed request: a missing namespace returns NamespaceNotFound, an unavailable block returns an error, and a proof that exceeds a resource limit also fails.</p>
      <a className="nd-button" href="/queries?range=price-empty#range-query">Open the empty-gap example <ArrowRight size={15}/></a>
    </GuideSection>
    <GuideSection id="trust" number="05 / KNOW WHO DOES WHAT" title="The light node verifies. The browser displays.">
      <div className="nd-role-grid">
        <div><span className="nd-eyebrow">PRODUCER</span><h3>Executes and signs</h3><p>Produces blocks and signs their headers with the configured proposer key.</p></div>
        <div><span className="nd-eyebrow">FULL NODE</span><h3>Replays and serves</h3><p>Replays operations, retains full state, and constructs query witnesses. <a href={fullUrl}>Open the full node <ArrowUpRight size={13}/></a></p></div>
        <div><span className="nd-eyebrow">LIGHT NODE</span><h3>Authenticates and checks</h3><p>Retains authenticated headers and checks query proofs against a pinned snapshot. It does not replay all execution or keep the full entity database.</p></div>
        <div><span className="nd-eyebrow">THIS BROWSER</span><h3>Requests and displays</h3><p>Sends your query to the hosted Rust light process and checks response bindings. It does not independently recompute the cryptographic proof.</p></div>
      </div>
      <div className="nd-trust-box"><h3>What “verified” assumes</h3><p>Rogue One, chain 9009, uses one pinned signing proposer. A signature authenticates that proposer’s commitment. This is not multi-party consensus, a proof of correct execution, or an Ethereum production state root.</p><p>The completeness guarantee is relative to the accepted state root <em>and correctly maintained indexes</em>. The system trusts correct execution and the invariant that live rows, typed terms, posting sets and keys agree. These query proofs cannot detect a proposer that commits to an incorrectly built index.</p><p>You also rely on this hosted light verifier and its connection to your browser to report the outcome honestly. Independent verification would require running a verifier with your own trusted chain identity and proposer configuration.</p>
        {status && <dl className="nd-guide-identity"><dt>Connected chain</dt><dd>{status.chainId === "9009" ? "Rogue One · 9009" : status.chainId}</dd><dt>Authentication reported</dt><dd>{status.authentication ?? "Not reported"}</dd><dt>Pinned proposer reported</dt><dd><code>{status.proposer ?? "Not included in this node’s status"}</code></dd><dt>Genesis</dt><dd><code>{status.genesisHash}</code></dd></dl>}
      </div>
    </GuideSection>
    <GuideSection id="support" number="06 / PUT IT TO WORK" title="What this range API supports today.">
      <div className="nd-guide-pair"><div><h3>Supported</h3><ul><li>One indexed attribute and one exact numeric type: <code>u64</code>, <code>i32</code>, <code>u256</code> or <code>dec</code>.</li><li>A lower bound, an upper bound, or both; each can be inclusive or exclusive.</li><li>Both bounds together on the same attribute, such as <code>price ≥ 10 AND price &lt; 20</code>.</li><li>A complete result at one retained snapshot, including verified empty results.</li></ul></div><div><h3>Outside this proof profile</h3><ul><li>Combining predicates on different attributes, or <code>OR</code> expressions.</li><li>String ranges, prefix queries, arbitrary sorting or aggregates.</li><li>Paging or continuation tokens for a range query.</li></ul><p>Typed equality has its own verified, paged endpoint and a separate proof inspector. Broader SDK query support does not imply that those queries have this range proof.</p></div></div>
      <div className="nd-profile-note"><strong>A complete answer or an error, never a truncated “success”.</strong><p>The current profile caps a response at 1,000 matching rows and 1,000 distinct matching terms by default (operator configurable). Proof bytes and verifier work are bounded too. Exceeding a cap fails the request; there is no hidden next page. Narrow the interval and run a new query if needed. Separate narrower requests each prove only their own interval.</p></div>
      <details className="nd-raw nd-guide-technical"><summary>Exact request format and numeric types <ChevronRight size={15}/></summary><div className="nd-raw-body"><p>The browser posts to <code>/node-sim/v1/query/range/verified</code>, which proxies the signed light-node endpoint <code>/signed/v1/query/range/verified</code>. Snapshot block numbers and numeric values are decimal strings, preserving large integers and decimals without JavaScript rounding.</p><pre tabIndex={0}>{JSON.stringify({height: status?.head.height ?? "30755", namespace: "1", attribute: "price", valueType: "u64", lower: {value: "10", inclusive: true}, upper: {value: "20", inclusive: false}}, null, 2)}</pre><p><code>u64</code> is an unsigned 64-bit integer; <code>i32</code> is a signed 32-bit integer; <code>u256</code> is an unsigned 256-bit integer; <code>dec</code> is signed fixed-point with up to 18 fractional places. Omit <code>lower</code> or <code>upper</code> for a one-sided range.</p><p>A successful response binds the exact query and snapshot, sets <code>complete: true</code>, and reports verification under <code>range-complete-v1</code>. Rows arrive in record ID order, which is not a request to sort by price. The certificate authenticates the header; it is not, by itself, the whole range witness.</p></div></details>
      <a className="nd-primary nd-guide-cta" href="/queries?range=price#range-query">Try 10 ≤ price &lt; 20 on the live chain <ArrowRight size={17}/></a>
    </GuideSection>
  </article>;
}

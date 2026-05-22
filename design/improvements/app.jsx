/* Arkiv Scanner — main app (React, JSX) */

const { useState, useEffect, useMemo, useRef } = React;

/* ------------------------------------------------------------------
   Helpers
------------------------------------------------------------------- */
const pad = (n, w = 2) => String(n).padStart(w, "0");
const fmtNum = (n) => n.toLocaleString("en-US");
const fmtBytes = (b) => {
  if (b < 1024) return b + " B";
  if (b < 1024 * 1024) return (b / 1024).toFixed(1) + " KB";
  if (b < 1024 * 1024 * 1024) return (b / 1024 / 1024).toFixed(2) + " MB";
  return (b / 1024 / 1024 / 1024).toFixed(2) + " GB";
};
const shortHash = (h, head = 8, tail = 6) =>
  h.length > head + tail + 1 ? `${h.slice(0, head)}…${h.slice(-tail)}` : h;
const ago = (sec) => {
  if (sec < 60) return `${sec}s ago`;
  const m = Math.floor(sec / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  return `${h}h ago`;
};
const rand = (a, b) => a + Math.random() * (b - a);
const randInt = (a, b) => Math.floor(rand(a, b + 1));
const hexChar = () => "0123456789abcdef"[randInt(0, 15)];
const randHash = (n = 64) => "0x" + Array.from({ length: n }, hexChar).join("");
const randAddr = () => randHash(40);

/* ------------------------------------------------------------------
   Generated seed data
------------------------------------------------------------------- */
const OPS = ["WRITE", "READ", "CREATE", "DELETE"];
const TABLES = [
  "user_profile", "events_log", "marketplace_lst",
  "oracle_feed", "vault_state", "graph_edges",
  "mentor_graph", "snapshot_v2", "rewards_v1",
];

function genBlock(num, prevSec = 0) {
  const txn = randInt(40, 320);
  return {
    n: num,
    hash: randHash(),
    txn,
    proposer: randAddr().slice(0, 10),
    bytes: randInt(50_000, 1_400_000),
    secAgo: prevSec + randInt(2, 4),
    gasUsed: rand(0.35, 0.92),
  };
}
function genTx(secAgo) {
  const op = OPS[randInt(0, OPS.length - 1)];
  return {
    hash: randHash(),
    op,
    table: TABLES[randInt(0, TABLES.length - 1)],
    from: randAddr(),
    bytes: randInt(120, 14_000),
    fee: rand(0.0001, 0.012),
    secAgo,
  };
}

/* ------------------------------------------------------------------
   Sparkline
------------------------------------------------------------------- */
function Spark({ values, color = "var(--ark-blue)", height = 28 }) {
  const w = 120;
  const max = Math.max(...values), min = Math.min(...values);
  const range = max - min || 1;
  const step = w / (values.length - 1);
  const pts = values
    .map((v, i) => [i * step, height - 2 - ((v - min) / range) * (height - 4)])
    .map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`)
    .join(" ");
  const area = `M0,${height} L${pts.split(" ").join(" L")} L${w},${height} Z`.replaceAll("L", "L ");
  return (
    <svg className="spark" viewBox={`0 0 ${w} ${height}`} preserveAspectRatio="none">
      <path d={`M ${pts.split(" ").join(" L ")}`} fill="none" stroke={color} strokeWidth="1.5" />
      <path d={area} fill={color} opacity="0.08" />
    </svg>
  );
}

/* ------------------------------------------------------------------
   Big chart (TPS / Gas)
------------------------------------------------------------------- */
function BigChart({ values, color = "var(--ark-blue)", height = 220 }) {
  const w = 800;
  const max = Math.max(...values), min = Math.min(...values);
  const range = max - min || 1;
  const step = w / (values.length - 1);
  const linePts = values.map((v, i) =>
    [i * step, height - 24 - ((v - min) / range) * (height - 48)]
  );
  const linePath = "M " + linePts.map(p => p.map(n => n.toFixed(1)).join(",")).join(" L ");
  const areaPath = linePath + ` L ${w},${height - 8} L 0,${height - 8} Z`;

  return (
    <svg viewBox={`0 0 ${w} ${height}`} width="100%" height={height} preserveAspectRatio="none"
         style={{ display: "block" }}>
      <defs>
        <linearGradient id="chartFill" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity="0.22" />
          <stop offset="100%" stopColor={color} stopOpacity="0" />
        </linearGradient>
        <pattern id="grid" x="0" y="0" width="80" height="44" patternUnits="userSpaceOnUse">
          <path d="M80 0 L0 0 L0 44" fill="none" stroke="var(--line)" strokeWidth="1" />
        </pattern>
      </defs>
      <rect x="0" y="0" width={w} height={height - 8} fill="url(#grid)" opacity="0.6" />
      <path d={areaPath} fill="url(#chartFill)" />
      <path d={linePath} fill="none" stroke={color} strokeWidth="2" />
      {linePts.filter((_, i) => i % 8 === 0).map(([x, y], i) => (
        <circle key={i} cx={x} cy={y} r="2" fill={color} />
      ))}
    </svg>
  );
}

/* ------------------------------------------------------------------
   NAV
------------------------------------------------------------------- */
function TopNav() {
  return (
    <header className="nav">
      <div className="container nav-inner">
        <a href="#" className="nav-brand">
          <span className="bk">[</span>
          <span className="nm">ARKIV</span>
          <span className="bk">]</span>
          <span className="sub">Scanner</span>
        </a>
        <nav className="nav-links">
          <a href="#" className="active">Home</a>
          <a href="#">Blocks</a>
          <a href="#">Transactions</a>
          <a href="#">DB‑Chains</a>
          <a href="#">Validators</a>
          <a href="#">Gas Tracker</a>
          <a href="#">API</a>
        </nav>
        <div className="nav-right">
          <button className="net-pill">
            <span className="dot"></span>
            <span>Arkiv Testnet · Holesky</span>
            <IcChevron size={12} />
          </button>
          <button className="btn ghost"><IcCode size={14} /> Docs</button>
        </div>
      </div>
    </header>
  );
}

/* ------------------------------------------------------------------
   HERO
------------------------------------------------------------------- */
function Hero({ gas, tip, head }) {
  return (
    <section className="hero">
      <span className="deco-bracket tl">[</span>
      <span className="deco-bracket br">]</span>
      <div className="container">
        <div className="hero-grid">
          <div>
            <span className="bracket-label">arkiv network scanner</span>
            <h1>
              Explore the data layer<br/>
              of <span className="accent">Ethereum.</span>
            </h1>
            <p className="lede">
              Search blocks, transactions, addresses and DB‑Chains across the Arkiv
              network — queryable, time‑scoped, verifiable.
            </p>
            <form className="search" onSubmit={(e) => e.preventDefault()}>
              <IcSearch size={18} />
              <input
                placeholder="Search by tx hash / block / address / DB‑Chain ID"
                spellCheck="false"
              />
              <span className="kbd">⌘ K</span>
              <button type="submit" className="search-go">
                Search <IcArrowOut size={13} />
              </button>
            </form>
            <div className="search-chips">
              <button className="chip">0x1f3a…b7e9 ↗</button>
              <button className="chip">block #{fmtNum(head)}</button>
              <button className="chip">db‑chain: mentor_graph</button>
              <button className="chip">tip: {tip.toFixed(2)} gwei</button>
            </div>
          </div>

          <GasCard gas={gas} />
        </div>
      </div>
    </section>
  );
}

function GasCard({ gas }) {
  return (
    <div className="gas-card">
      <div className="gas-head">
        <span className="label">gas price · gwei</span>
        <span className="live"><span className="dot"></span> LIVE</span>
      </div>
      <div className="gas-tiers">
        <div className="tier slow">
          <div className="tname"><IcGas size={12} /> slow · ~30s</div>
          <div className="tval">{gas.slow.toFixed(2)}<span className="unit">gwei</span></div>
          <div className="tsub">≈ ${(gas.slow * 0.00021 * 2480).toFixed(4)}</div>
        </div>
        <div className="tier avg">
          <div className="tname"><IcGas size={12} /> avg · ~12s</div>
          <div className="tval">{gas.avg.toFixed(2)}<span className="unit">gwei</span></div>
          <div className="tsub">≈ ${(gas.avg * 0.00021 * 2480).toFixed(4)}</div>
        </div>
        <div className="tier fast">
          <div className="tname"><IcGas size={12} /> fast · ~4s</div>
          <div className="tval">{gas.fast.toFixed(2)}<span className="unit">gwei</span></div>
          <div className="tsub">≈ ${(gas.fast * 0.00021 * 2480).toFixed(4)}</div>
        </div>
      </div>
      <div className="gas-foot">
        <span>base fee · {gas.base.toFixed(3)} gwei</span>
        <span>updated {gas.upd}s ago</span>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------
   STATS
------------------------------------------------------------------- */
function StatsGrid({ stats }) {
  return (
    <section className="section">
      <div className="container">
        <div className="section-head">
          <div>
            <span className="bracket-label">network at a glance</span>
            <h2>Live network statistics</h2>
          </div>
          <a className="card-head link" href="#">
            Open dashboard <IcArrowOut size={12} />
          </a>
        </div>

        <div className="stats">
          {stats.map((s, i) => (
            <div key={i} className="stat">
              <div className="icn">{s.icon}</div>
              <div className="label">{s.label}</div>
              <div className="value">{s.value}</div>
              {s.delta && (
                <div className={"delta " + (s.delta.startsWith("-") ? "down" : "")}>
                  {s.delta.startsWith("-") ? <IcTriDown size={10} /> : <IcTriUp size={10} />}
                  {s.delta}
                </div>
              )}
              {s.spark && <Spark values={s.spark} color={s.sparkColor || "var(--ark-blue)"} />}
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

/* ------------------------------------------------------------------
   LATEST BLOCKS & TXS
------------------------------------------------------------------- */
function Latest({ blocks, txs }) {
  return (
    <section className="section">
      <div className="container">
        <div className="section-head">
          <div>
            <span className="bracket-label">live feed</span>
            <h2>Latest blocks & transactions</h2>
          </div>
        </div>

        <div className="two-col">
          {/* Blocks */}
          <div className="card">
            <div className="card-head">
              <div className="title">
                <span className="pulse"></span>
                <IcCube size={16} /> Latest blocks
              </div>
              <a className="link" href="#">View all <IcChevron size={12} /></a>
            </div>
            {blocks.slice(0, 7).map((b, i) => (
              <div key={b.n} className={"row " + (i === 0 ? "new" : "")}>
                <div className="ico"><IcCube size={16} /></div>
                <div>
                  <div className="top">
                    <span className="blk">#{fmtNum(b.n)}</span>
                    <span className="ago">{ago(b.secAgo)}</span>
                  </div>
                  <div className="sub">
                    <span>proposer <b>{b.proposer}</b></span>
                    <span>{b.txn} txs</span>
                  </div>
                </div>
                <div className="right">
                  <span className="val">{fmtBytes(b.bytes)}</span>
                  <span>{(b.gasUsed * 100).toFixed(1)}% gas used</span>
                </div>
              </div>
            ))}
          </div>

          {/* Transactions */}
          <div className="card">
            <div className="card-head">
              <div className="title">
                <span className="pulse"></span>
                <IcArrows size={16} /> Latest transactions
              </div>
              <a className="link" href="#">View all <IcChevron size={12} /></a>
            </div>
            {txs.slice(0, 7).map((t, i) => (
              <div key={t.hash} className={"row tx " + (i === 0 ? "new" : "")}>
                <div className="ico"><IcArrows size={16} /></div>
                <div>
                  <div className="top">
                    <span className="hash">{shortHash(t.hash, 10, 8)}</span>
                    <span className={"badge " + t.op.toLowerCase()}>{t.op}</span>
                    <span className="ago">{ago(t.secAgo)}</span>
                  </div>
                  <div className="sub">
                    <span>table <b>{t.table}</b></span>
                    <span>{shortHash(t.from, 6, 4)}</span>
                  </div>
                </div>
                <div className="right">
                  <span className="val">{fmtBytes(t.bytes)}</span>
                  <span>{t.fee.toFixed(4)} GLM</span>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}

/* ------------------------------------------------------------------
   CHART
------------------------------------------------------------------- */
function ChartSection({ tpsSeries, gasSeries }) {
  const [tab, setTab] = useState("tps");
  const series = tab === "tps" ? tpsSeries : gasSeries;
  const color = tab === "tps" ? "var(--ark-blue)" : "var(--ark-orange)";
  const curr = series[series.length - 1];

  return (
    <section className="section">
      <div className="container">
        <div className="section-head">
          <div>
            <span className="bracket-label">last 24 hours</span>
            <h2>Throughput & fees</h2>
          </div>
        </div>

        <div className="chart-card">
          <div className="ch-head">
            <div className="ch-meta">
              <div>
                <div className="m-label">{tab === "tps" ? "transactions / sec" : "median gas (gwei)"}</div>
                <div className="m-val">
                  {tab === "tps" ? curr.toFixed(1) : curr.toFixed(2)}
                  <span style={{ fontSize: 12, opacity: 0.5, marginLeft: 6 }}>
                    {tab === "tps" ? "tps" : "gwei"}
                  </span>
                </div>
              </div>
              <div>
                <div className="m-label">24h avg</div>
                <div className="m-val">
                  {(series.reduce((a, b) => a + b, 0) / series.length).toFixed(tab === "tps" ? 1 : 2)}
                </div>
              </div>
              <div>
                <div className="m-label">peak</div>
                <div className="m-val">{Math.max(...series).toFixed(tab === "tps" ? 1 : 2)}</div>
              </div>
            </div>
            <div className="ch-tabs">
              <button className={tab === "tps" ? "on" : ""} onClick={() => setTab("tps")}>TPS</button>
              <button className={tab === "gas" ? "on" : ""} onClick={() => setTab("gas")}>Gas</button>
            </div>
          </div>
          <BigChart values={series} color={color} />
        </div>
      </div>
    </section>
  );
}

/* ------------------------------------------------------------------
   QUICK ACTIONS
------------------------------------------------------------------- */
function QuickActions() {
  return (
    <section className="section">
      <div className="container">
        <div className="section-head">
          <div>
            <span className="bracket-label">build on arkiv</span>
            <h2>Quick actions</h2>
          </div>
        </div>
        <div className="actions">
          <a className="action featured" href="#">
            <div className="a-icn"><IcDroplet size={22} /></div>
            <h3>Get testnet GLM</h3>
            <p>Request GLM from the public Holesky faucet to start writing data.</p>
            <span className="arrow"><IcArrowOut size={18} /></span>
          </a>
          <a className="action" href="#">
            <div className="a-icn"><IcDb size={22} /></div>
            <h3>Deploy a DB‑Chain</h3>
            <p>Spin up a Layer 3 with CRUD, indexes and programmable expiration.</p>
            <span className="arrow"><IcArrowOut size={18} /></span>
          </a>
          <a className="action" href="#">
            <div className="a-icn"><IcCode size={22} /></div>
            <h3>Read the SDK docs</h3>
            <p>TypeScript & Python clients with full type definitions and examples.</p>
            <span className="arrow"><IcArrowOut size={18} /></span>
          </a>
          <a className="action orange" href="#">
            <div className="a-icn"><IcNetwork size={22} /></div>
            <h3>Run a validator</h3>
            <p>Operate Arkiv infrastructure and earn rewards on the testnet program.</p>
            <span className="arrow"><IcArrowOut size={18} /></span>
          </a>
        </div>
      </div>
    </section>
  );
}

/* ------------------------------------------------------------------
   FOOTER
------------------------------------------------------------------- */
function Foot() {
  return (
    <footer className="foot">
      <div className="container">
        <div className="foot-grid">
          <div>
            <a className="nav-brand" href="#" style={{ fontSize: 18 }}>
              <span className="bk">[</span>
              <span className="nm">ARKIV</span>
              <span className="bk">]</span>
              <span className="sub">Scanner</span>
            </a>
            <p style={{ maxWidth: "38ch", marginTop: 14, color: "var(--ink-muted)", fontSize: 13 }}>
              A universal, cost‑efficient data layer for Ethereum. Queryable, time‑scoped,
              verifiable. Emerged from the Golem ecosystem.
            </p>
          </div>
          <div>
            <h4>scanner</h4>
            <ul>
              <li><a href="#">Blocks</a></li>
              <li><a href="#">Transactions</a></li>
              <li><a href="#">DB‑Chains</a></li>
              <li><a href="#">Validators</a></li>
            </ul>
          </div>
          <div>
            <h4>developers</h4>
            <ul>
              <li><a href="#">Docs</a></li>
              <li><a href="#">SDK · TypeScript</a></li>
              <li><a href="#">SDK · Python</a></li>
              <li><a href="#">API reference</a></li>
            </ul>
          </div>
          <div>
            <h4>connect</h4>
            <ul>
              <li><a href="#">X / Twitter</a></li>
              <li><a href="#">Discord</a></li>
              <li><a href="#">GitHub</a></li>
              <li><a href="#">Brand</a></li>
            </ul>
          </div>
        </div>
        <div className="foot-bottom">
          <span>© 2026 Arkiv — All rights reserved</span>
          <span>scanner.arkiv-global.net · v2.4.0</span>
        </div>
      </div>
    </footer>
  );
}

/* ------------------------------------------------------------------
   TWEAKS
------------------------------------------------------------------- */
const TWEAK_DEFAULTS = /*EDITMODE-BEGIN*/{
  "theme": "light",
  "accent": "orange",
  "density": "comfy",
  "showChart": true,
  "liveFeed": true
}/*EDITMODE-END*/;

function Tweaks({ tweaks, setTweak }) {
  return (
    <TweaksPanel title="Tweaks">
      <TweakSection title="Theme">
        <TweakRadio label="Mode" value={tweaks.theme}
          options={[{ value: "light", label: "Sand" }, { value: "dark", label: "Ink" }]}
          onChange={(v) => setTweak("theme", v)} />
        <TweakRadio label="Hero accent" value={tweaks.accent}
          options={[{ value: "orange", label: "Orange" }, { value: "blue", label: "Blue" }]}
          onChange={(v) => setTweak("accent", v)} />
      </TweakSection>
      <TweakSection title="Layout">
        <TweakRadio label="Density" value={tweaks.density}
          options={[{ value: "comfy", label: "Comfy" }, { value: "compact", label: "Compact" }]}
          onChange={(v) => setTweak("density", v)} />
        <TweakToggle label="Show 24h chart" value={tweaks.showChart}
          onChange={(v) => setTweak("showChart", v)} />
        <TweakToggle label="Live feed (ticks)" value={tweaks.liveFeed}
          onChange={(v) => setTweak("liveFeed", v)} />
      </TweakSection>
    </TweaksPanel>
  );
}

/* ------------------------------------------------------------------
   APP
------------------------------------------------------------------- */
function App() {
  const [tweaks, setTweak] = useTweaks(TWEAK_DEFAULTS);

  /* Apply theme + density */
  useEffect(() => {
    document.documentElement.dataset.theme = tweaks.theme;
    document.documentElement.style.setProperty(
      "--pad", tweaks.density === "compact" ? "16px" : "24px"
    );
  }, [tweaks.theme, tweaks.density]);

  /* Seed blocks */
  const [blocks, setBlocks] = useState(() => {
    const out = [];
    let head = 12_481_736;
    let sec = 0;
    for (let i = 0; i < 12; i++) {
      out.push(genBlock(head - i, sec));
      sec += randInt(2, 4);
    }
    return out;
  });
  const head = blocks[0].n;

  /* Seed txs */
  const [txs, setTxs] = useState(() => {
    const out = [];
    let s = 1;
    for (let i = 0; i < 14; i++) {
      out.push(genTx(s));
      s += randInt(1, 4);
    }
    return out;
  });

  /* Gas tracker */
  const [gas, setGas] = useState({
    slow: 7.42, avg: 9.18, fast: 12.36, base: 5.27, upd: 0,
  });

  /* Ticker */
  useEffect(() => {
    if (!tweaks.liveFeed) return;
    const blkT = setInterval(() => {
      setBlocks((prev) => [
        genBlock(prev[0].n + 1, 0),
        ...prev.map((b) => ({ ...b, secAgo: b.secAgo + randInt(2, 4) })),
      ].slice(0, 12));
    }, 4200);
    const txT = setInterval(() => {
      setTxs((prev) => [genTx(1), ...prev.map((t) => ({ ...t, secAgo: t.secAgo + randInt(1, 3) }))].slice(0, 14));
    }, 1600);
    const gasT = setInterval(() => {
      setGas((g) => {
        const jitter = () => rand(-0.6, 0.6);
        const base = Math.max(2.5, g.base + rand(-0.2, 0.2));
        return {
          base,
          slow: Math.max(base + 0.3, g.slow + jitter()),
          avg:  Math.max(base + 1.0, g.avg  + jitter()),
          fast: Math.max(base + 2.5, g.fast + jitter()),
          upd: 0,
        };
      });
    }, 5000);
    const updT = setInterval(() => {
      setGas((g) => ({ ...g, upd: g.upd + 1 }));
    }, 1000);
    return () => { clearInterval(blkT); clearInterval(txT); clearInterval(gasT); clearInterval(updT); };
  }, [tweaks.liveFeed]);

  /* Stats */
  const stats = useMemo(() => [
    {
      icon: <IcCube size={20} />, label: "Latest block",
      value: "#" + fmtNum(head), delta: "+12.4% 24h",
      spark: Array.from({ length: 20 }, (_, i) => 12 + Math.sin(i / 2) * 3 + i * 0.2),
    },
    {
      icon: <IcArrows size={20} />, label: "Transactions",
      value: fmtNum(48_392_771), delta: "+8.1% 24h",
      sparkColor: "var(--ark-orange)",
      spark: Array.from({ length: 20 }, (_, i) => 8 + Math.cos(i / 1.7) * 2 + i * 0.3),
    },
    {
      icon: <IcDb size={20} />, label: "Active DB‑Chains",
      value: fmtNum(1_284), delta: "+27 24h",
      spark: Array.from({ length: 20 }, (_, i) => 4 + i * 0.4 + Math.sin(i / 3) * 1.2),
    },
    {
      icon: <IcLightning size={20} />, label: "Avg TPS (1h)",
      value: "412.7", delta: "-2.3% 1h",
      sparkColor: "var(--ark-orange)",
      spark: Array.from({ length: 20 }, (_, i) => 20 - Math.abs(10 - i) * 0.6 + Math.sin(i) * 2),
    },
    {
      icon: <IcStack size={20} />, label: "Total bytes stored",
      value: "847.2 TB", delta: "+0.6% 24h",
      spark: Array.from({ length: 20 }, (_, i) => 5 + i * 0.5),
    },
    {
      icon: <IcNetwork size={20} />, label: "Validators",
      value: "1,038 / 1,200", delta: "+4 24h",
      sparkColor: "var(--ark-orange)",
      spark: Array.from({ length: 20 }, (_, i) => 10 + Math.sin(i / 1.4) * 2),
    },
  ], [head]);

  /* Chart series */
  const tpsSeries = useMemo(
    () => Array.from({ length: 96 },
      (_, i) => 380 + Math.sin(i / 7) * 80 + Math.sin(i / 2.3) * 22 + (Math.random() - 0.5) * 30),
    []
  );
  const gasSeries = useMemo(
    () => Array.from({ length: 96 },
      (_, i) => 8 + Math.sin(i / 5) * 2.4 + (Math.random() - 0.5) * 1.2),
    []
  );

  return (
    <div style={{
      "--ark-orange": tweaks.accent === "blue" ? "#181EA9" : "#FE7446",
    }}>
      <TopNav />
      <main>
        <Hero gas={gas} tip={gas.avg} head={head} />
        <StatsGrid stats={stats} />
        <Latest blocks={blocks} txs={txs} />
        {tweaks.showChart && (
          <ChartSection tpsSeries={tpsSeries} gasSeries={gasSeries} />
        )}
        <QuickActions />
      </main>
      <Foot />
      <Tweaks tweaks={tweaks} setTweak={setTweak} />
    </div>
  );
}

ReactDOM.createRoot(document.getElementById("root")).render(<App />);

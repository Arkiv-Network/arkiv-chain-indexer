// Block + Transaction icon explorations — Arkiv aesthetic
// Colors locked to Arkiv brand: blue #181EA9, orange #FE7446, ink #111, sand #F6F4EF, stone #E9E6DE

const BLUE = "#181EA9";
const ORANGE = "#FE7446";
const INK = "#111111";
const STONE = "#E9E6DE";
const SAND = "#F6F4EF";

// ============================================================
// BLOCK ICONS
// ============================================================

// 1. Bracketed cube — most "Arkiv" — uses the [ ] motif as block frame
function BlockBracketed({ size = 64, color = INK, accent = ORANGE }) {
  const s = size;
  const sw = s / 32 * 1.75;
  return (
    <svg width={s} height={s} viewBox="0 0 32 32" fill="none">
      {/* left bracket */}
      <path d={`M7 5 H4 V27 H7`} stroke={color} strokeWidth={sw} strokeLinecap="square" strokeLinejoin="miter" fill="none"/>
      {/* right bracket */}
      <path d={`M25 5 H28 V27 H25`} stroke={color} strokeWidth={sw} strokeLinecap="square" strokeLinejoin="miter" fill="none"/>
      {/* inner cube — isometric top face */}
      <path d={`M16 9 L22 12 L16 15 L10 12 Z`} fill={accent}/>
      {/* left face */}
      <path d={`M10 12 L16 15 L16 23 L10 20 Z`} fill={color}/>
      {/* right face */}
      <path d={`M22 12 L16 15 L16 23 L22 20 Z`} fill={color} opacity="0.55"/>
    </svg>
  );
}

// 2. Layered stack — "L1/L2/L3" stacked database chains, hallmark Arkiv visual
function BlockLayered({ size = 64, color = INK, accent = ORANGE }) {
  const s = size;
  return (
    <svg width={s} height={s} viewBox="0 0 32 32" fill="none">
      {/* top layer (accent) */}
      <path d={`M16 4 L27 9 L16 14 L5 9 Z`} fill={accent}/>
      {/* mid layer */}
      <path d={`M5 14 L16 19 L27 14`} stroke={color} strokeWidth="1.75" fill="none" strokeLinejoin="miter"/>
      <path d={`M5 14 L16 19 L27 14 L27 15.5 L16 20.5 L5 15.5 Z`} fill={color}/>
      {/* bottom layer */}
      <path d={`M5 19 L16 24 L27 19`} stroke={color} strokeWidth="1.75" fill="none" strokeLinejoin="miter"/>
      <path d={`M5 19 L16 24 L27 19 L27 20.5 L16 25.5 L5 20.5 Z`} fill={color}/>
    </svg>
  );
}

// 3. Outline isometric cube — clean, technical
function BlockIsoOutline({ size = 64, color = INK, accent = ORANGE }) {
  const s = size;
  return (
    <svg width={s} height={s} viewBox="0 0 32 32" fill="none">
      <path d={`M16 4 L27 10 L27 22 L16 28 L5 22 L5 10 Z`} stroke={color} strokeWidth="1.75" strokeLinejoin="miter" fill={SAND}/>
      <path d={`M5 10 L16 16 L27 10`} stroke={color} strokeWidth="1.75" strokeLinejoin="miter"/>
      <path d={`M16 16 L16 28`} stroke={color} strokeWidth="1.75"/>
      {/* accent corner dot */}
      <circle cx="16" cy="16" r="1.5" fill={accent}/>
    </svg>
  );
}

// 4. Solid filled block — the "filled" / heavy variant
function BlockSolid({ size = 64, color = INK, accent = ORANGE }) {
  const s = size;
  return (
    <svg width={s} height={s} viewBox="0 0 32 32" fill="none">
      {/* top face */}
      <path d={`M16 4 L27 10 L16 16 L5 10 Z`} fill={accent}/>
      {/* left face */}
      <path d={`M5 10 L16 16 L16 28 L5 22 Z`} fill={color}/>
      {/* right face */}
      <path d={`M27 10 L16 16 L16 28 L27 22 Z`} fill={color} opacity="0.6"/>
    </svg>
  );
}

// 5. Grid / hash receipt — a "block as ledger of records" reading
function BlockLedger({ size = 64, color = INK, accent = ORANGE }) {
  const s = size;
  return (
    <svg width={s} height={s} viewBox="0 0 32 32" fill="none">
      <rect x="5" y="5" width="22" height="22" stroke={color} strokeWidth="1.75" fill={SAND}/>
      {/* ledger rows */}
      <line x1="9" y1="11" x2="19" y2="11" stroke={color} strokeWidth="1.5"/>
      <line x1="9" y1="15" x2="23" y2="15" stroke={color} strokeWidth="1.5"/>
      <line x1="9" y1="19" x2="17" y2="19" stroke={color} strokeWidth="1.5"/>
      <line x1="9" y1="23" x2="21" y2="23" stroke={color} strokeWidth="1.5"/>
      {/* accent corner tab */}
      <rect x="22" y="5" width="5" height="5" fill={accent}/>
    </svg>
  );
}

// 6. Block number badge — square wrapped in brackets, very "Etherscan + Arkiv"
function BlockHashtag({ size = 64, color = INK, accent = ORANGE }) {
  const s = size;
  return (
    <svg width={s} height={s} viewBox="0 0 32 32" fill="none">
      {/* outer square */}
      <rect x="6" y="6" width="20" height="20" fill={color}/>
      {/* hash marks suggesting block id */}
      <path d="M12 11 V21 M16 11 V21 M20 11 V21" stroke={SAND} strokeWidth="1.75"/>
      <path d="M10 14 H22 M10 18 H22" stroke={SAND} strokeWidth="1.75"/>
      {/* accent corner */}
      <rect x="22" y="6" width="4" height="4" fill={accent}/>
    </svg>
  );
}

// 7. Cube wireframe with single accent edge
function BlockWireAccent({ size = 64, color = INK, accent = ORANGE }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" fill="none">
      <path d={`M16 4 L27 10 L27 22 L16 28 L5 22 L5 10 Z`} stroke={color} strokeWidth="1.75" strokeLinejoin="miter"/>
      <path d={`M5 10 L16 16 L27 10`} stroke={color} strokeWidth="1.75" strokeLinejoin="miter"/>
      <path d={`M16 16 L16 28`} stroke={color} strokeWidth="1.75"/>
      {/* accent edge highlighting the "newest" block edge */}
      <path d={`M16 4 L27 10`} stroke={accent} strokeWidth="2.5" strokeLinecap="square"/>
    </svg>
  );
}

// 8. Archival drawer — plays on "Arkiv" = archive — block as filed record
function BlockArchive({ size = 64, color = INK, accent = ORANGE }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" fill="none">
      <rect x="5" y="7" width="22" height="6" stroke={color} strokeWidth="1.75" fill={SAND}/>
      <rect x="5" y="13" width="22" height="6" stroke={color} strokeWidth="1.75" fill={SAND}/>
      <rect x="5" y="19" width="22" height="6" stroke={color} strokeWidth="1.75" fill={accent}/>
      {/* drawer handles */}
      <line x1="14" y1="10" x2="18" y2="10" stroke={color} strokeWidth="1.75"/>
      <line x1="14" y1="16" x2="18" y2="16" stroke={color} strokeWidth="1.75"/>
      <line x1="14" y1="22" x2="18" y2="22" stroke={color} strokeWidth="1.75"/>
    </svg>
  );
}

// ============================================================
// TRANSACTION ICONS
// ============================================================

// 1. Bracketed arrow — wraps an arrow inside the Arkiv [ ] mark
function TxBracketed({ size = 64, color = INK, accent = ORANGE }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" fill="none">
      <path d={`M7 5 H4 V27 H7`} stroke={color} strokeWidth="1.75" strokeLinecap="square" fill="none"/>
      <path d={`M25 5 H28 V27 H25`} stroke={color} strokeWidth="1.75" strokeLinecap="square" fill="none"/>
      {/* arrow shaft */}
      <line x1="9" y1="16" x2="22" y2="16" stroke={color} strokeWidth="2"/>
      {/* arrowhead — accent */}
      <path d={`M19 12 L23 16 L19 20`} stroke={accent} strokeWidth="2" fill="none" strokeLinejoin="miter" strokeLinecap="square"/>
    </svg>
  );
}

// 2. Two nodes with directed edge — classic "from → to" hash transaction
function TxNodes({ size = 64, color = INK, accent = ORANGE }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" fill="none">
      {/* sender node */}
      <rect x="3" y="12" width="8" height="8" fill={color}/>
      {/* receiver node */}
      <rect x="21" y="12" width="8" height="8" stroke={color} strokeWidth="1.75" fill="none"/>
      {/* arrow shaft */}
      <line x1="11" y1="16" x2="20" y2="16" stroke={color} strokeWidth="1.75"/>
      {/* accent arrowhead */}
      <path d={`M18 13 L21 16 L18 19`} stroke={accent} strokeWidth="2" fill="none" strokeLinejoin="miter" strokeLinecap="square"/>
    </svg>
  );
}

// 3. Swap arrows — bi-directional value exchange
function TxSwap({ size = 64, color = INK, accent = ORANGE }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" fill="none">
      {/* top arrow */}
      <line x1="6" y1="11" x2="24" y2="11" stroke={color} strokeWidth="2"/>
      <path d={`M21 8 L25 11 L21 14`} stroke={color} strokeWidth="2" fill="none" strokeLinejoin="miter" strokeLinecap="square"/>
      {/* bottom arrow (accent) */}
      <line x1="6" y1="21" x2="24" y2="21" stroke={accent} strokeWidth="2"/>
      <path d={`M10 18 L6 21 L10 24`} stroke={accent} strokeWidth="2" fill="none" strokeLinejoin="miter" strokeLinecap="square"/>
    </svg>
  );
}

// 4. Hash receipt — transaction as cryptographic line item
function TxReceipt({ size = 64, color = INK, accent = ORANGE }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" fill="none">
      <rect x="6" y="4" width="20" height="24" stroke={color} strokeWidth="1.75" fill={SAND}/>
      {/* hash short */}
      <rect x="9" y="8" width="14" height="2" fill={color}/>
      {/* address rows */}
      <line x1="9" y1="14" x2="20" y2="14" stroke={color} strokeWidth="1.5"/>
      <line x1="9" y1="18" x2="22" y2="18" stroke={color} strokeWidth="1.5"/>
      {/* value highlight */}
      <rect x="9" y="22" width="10" height="2.5" fill={accent}/>
    </svg>
  );
}

// 5. Pipe / flow — value flowing from one cube to another
function TxFlow({ size = 64, color = INK, accent = ORANGE }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" fill="none">
      {/* left cube */}
      <path d={`M3 10 L8 7 L13 10 L13 18 L8 21 L3 18 Z`} fill={color}/>
      <path d={`M3 10 L8 13 L13 10`} stroke={SAND} strokeWidth="1.25" fill="none"/>
      <path d={`M8 13 L8 21`} stroke={SAND} strokeWidth="1.25"/>
      {/* arrow */}
      <line x1="14" y1="14" x2="22" y2="14" stroke={accent} strokeWidth="2"/>
      <path d={`M20 11 L23 14 L20 17`} stroke={accent} strokeWidth="2" fill="none" strokeLinejoin="miter" strokeLinecap="square"/>
      {/* right cube (outline) */}
      <path d={`M19 10 L24 7 L29 10 L29 18 L24 21 L19 18 Z`} stroke={color} strokeWidth="1.5" fill="none"/>
      <path d={`M19 10 L24 13 L29 10 M24 13 L24 21`} stroke={color} strokeWidth="1.5" fill="none"/>
    </svg>
  );
}

// 6. Arrow inside cube — transaction as block-contained event
function TxInBlock({ size = 64, color = INK, accent = ORANGE }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" fill="none">
      <path d={`M16 3 L28 9 L28 22 L16 28 L4 22 L4 9 Z`} stroke={color} strokeWidth="1.75" strokeLinejoin="miter" fill={SAND}/>
      <path d={`M4 9 L16 15 L28 9 M16 15 L16 28`} stroke={color} strokeWidth="1.5" fill="none"/>
      {/* arrow on top face */}
      <line x1="9" y1="9" x2="22" y2="9" stroke={accent} strokeWidth="2.25"/>
      <path d={`M19 6 L23 9 L19 12`} stroke={accent} strokeWidth="2.25" fill="none" strokeLinejoin="miter" strokeLinecap="square"/>
    </svg>
  );
}

// 7. Lightning / dispatch — fast transaction
function TxBolt({ size = 64, color = INK, accent = ORANGE }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" fill="none">
      {/* bracket frame, light */}
      <path d={`M7 5 H4 V27 H7 M25 5 H28 V27 H25`} stroke={color} strokeWidth="1.5" fill="none" opacity="0.35"/>
      {/* bolt body */}
      <path d={`M18 4 L9 18 L15 18 L13 28 L23 12 L17 12 Z`} fill={color}/>
      {/* accent slice */}
      <path d={`M18 4 L9 18 L15 18`} fill={accent}/>
    </svg>
  );
}

// 8. Diagonal exchange — abstract two-token motion
function TxDiagonal({ size = 64, color = INK, accent = ORANGE }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" fill="none">
      {/* sender chip */}
      <rect x="4" y="4" width="9" height="9" fill={accent}/>
      {/* receiver chip */}
      <rect x="19" y="19" width="9" height="9" stroke={color} strokeWidth="1.75" fill={SAND}/>
      {/* arrow diagonal */}
      <line x1="13" y1="13" x2="20" y2="20" stroke={color} strokeWidth="2"/>
      <path d={`M17 20 L21 20 L21 16`} stroke={color} strokeWidth="2" fill="none" strokeLinejoin="miter" strokeLinecap="square"/>
    </svg>
  );
}

Object.assign(window, {
  BlockBracketed, BlockLayered, BlockIsoOutline, BlockSolid,
  BlockLedger, BlockHashtag, BlockWireAccent, BlockArchive,
  TxBracketed, TxNodes, TxSwap, TxReceipt, TxFlow, TxInBlock, TxBolt, TxDiagonal,
});

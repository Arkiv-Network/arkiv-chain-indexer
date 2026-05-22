// Block + Transaction icon set — ported from design/icons.jsx.
// Arkiv palette: blue #181EA9, orange #FE7446, ink #111, sand #F6F4EF, stone #E9E6DE.

export const ARKIV_BLUE = "#181EA9";
export const ARKIV_ORANGE = "#FE7446";
export const ARKIV_INK = "#111111";
export const ARKIV_STONE = "#E9E6DE";
export const ARKIV_SAND = "#F6F4EF";

export interface IconProps {
  size?: number;
  color?: string;
  accent?: string;
}

const defaults = { size: 64, color: ARKIV_INK, accent: ARKIV_ORANGE };

// ============================================================
// BLOCK ICONS
// ============================================================

export function BlockBracketed({ size = defaults.size, color = defaults.color, accent = defaults.accent }: IconProps) {
  const sw = (size / 32) * 1.75;
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" fill="none">
      <path d="M7 5 H4 V27 H7" stroke={color} strokeWidth={sw} strokeLinecap="square" strokeLinejoin="miter" fill="none" />
      <path d="M25 5 H28 V27 H25" stroke={color} strokeWidth={sw} strokeLinecap="square" strokeLinejoin="miter" fill="none" />
      <path d="M16 9 L22 12 L16 15 L10 12 Z" fill={accent} />
      <path d="M10 12 L16 15 L16 23 L10 20 Z" fill={color} />
      <path d="M22 12 L16 15 L16 23 L22 20 Z" fill={color} opacity="0.55" />
    </svg>
  );
}

export function BlockLayered({ size = defaults.size, color = defaults.color, accent = defaults.accent }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" fill="none">
      <path d="M16 4 L27 9 L16 14 L5 9 Z" fill={accent} />
      <path d="M5 14 L16 19 L27 14" stroke={color} strokeWidth="1.75" fill="none" strokeLinejoin="miter" />
      <path d="M5 14 L16 19 L27 14 L27 15.5 L16 20.5 L5 15.5 Z" fill={color} />
      <path d="M5 19 L16 24 L27 19" stroke={color} strokeWidth="1.75" fill="none" strokeLinejoin="miter" />
      <path d="M5 19 L16 24 L27 19 L27 20.5 L16 25.5 L5 20.5 Z" fill={color} />
    </svg>
  );
}

export function BlockIsoOutline({ size = defaults.size, color = defaults.color, accent = defaults.accent }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" fill="none">
      <path
        d="M16 4 L27 10 L27 22 L16 28 L5 22 L5 10 Z"
        stroke={color}
        strokeWidth="1.75"
        strokeLinejoin="miter"
        fill={ARKIV_SAND}
      />
      <path d="M5 10 L16 16 L27 10" stroke={color} strokeWidth="1.75" strokeLinejoin="miter" />
      <path d="M16 16 L16 28" stroke={color} strokeWidth="1.75" />
      <circle cx="16" cy="16" r="1.5" fill={accent} />
    </svg>
  );
}

export function BlockSolid({ size = defaults.size, color = defaults.color, accent = defaults.accent }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" fill="none">
      <path d="M16 4 L27 10 L16 16 L5 10 Z" fill={accent} />
      <path d="M5 10 L16 16 L16 28 L5 22 Z" fill={color} />
      <path d="M27 10 L16 16 L16 28 L27 22 Z" fill={color} opacity="0.6" />
    </svg>
  );
}

export function BlockLedger({ size = defaults.size, color = defaults.color, accent = defaults.accent }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" fill="none">
      <rect x="5" y="5" width="22" height="22" stroke={color} strokeWidth="1.75" fill={ARKIV_SAND} />
      <line x1="9" y1="11" x2="19" y2="11" stroke={color} strokeWidth="1.5" />
      <line x1="9" y1="15" x2="23" y2="15" stroke={color} strokeWidth="1.5" />
      <line x1="9" y1="19" x2="17" y2="19" stroke={color} strokeWidth="1.5" />
      <line x1="9" y1="23" x2="21" y2="23" stroke={color} strokeWidth="1.5" />
      <rect x="22" y="5" width="5" height="5" fill={accent} />
    </svg>
  );
}

export function BlockHashtag({ size = defaults.size, color = defaults.color, accent = defaults.accent }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" fill="none">
      <rect x="6" y="6" width="20" height="20" fill={color} />
      <path d="M12 11 V21 M16 11 V21 M20 11 V21" stroke={ARKIV_SAND} strokeWidth="1.75" />
      <path d="M10 14 H22 M10 18 H22" stroke={ARKIV_SAND} strokeWidth="1.75" />
      <rect x="22" y="6" width="4" height="4" fill={accent} />
    </svg>
  );
}

export function BlockWireAccent({ size = defaults.size, color = defaults.color, accent = defaults.accent }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" fill="none">
      <path
        d="M16 4 L27 10 L27 22 L16 28 L5 22 L5 10 Z"
        stroke={color}
        strokeWidth="1.75"
        strokeLinejoin="miter"
      />
      <path d="M5 10 L16 16 L27 10" stroke={color} strokeWidth="1.75" strokeLinejoin="miter" />
      <path d="M16 16 L16 28" stroke={color} strokeWidth="1.75" />
      <path d="M16 4 L27 10" stroke={accent} strokeWidth="2.5" strokeLinecap="square" />
    </svg>
  );
}

export function BlockArchive({ size = defaults.size, color = defaults.color, accent = defaults.accent }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" fill="none">
      <rect x="5" y="7" width="22" height="6" stroke={color} strokeWidth="1.75" fill={ARKIV_SAND} />
      <rect x="5" y="13" width="22" height="6" stroke={color} strokeWidth="1.75" fill={ARKIV_SAND} />
      <rect x="5" y="19" width="22" height="6" stroke={color} strokeWidth="1.75" fill={accent} />
      <line x1="14" y1="10" x2="18" y2="10" stroke={color} strokeWidth="1.75" />
      <line x1="14" y1="16" x2="18" y2="16" stroke={color} strokeWidth="1.75" />
      <line x1="14" y1="22" x2="18" y2="22" stroke={color} strokeWidth="1.75" />
    </svg>
  );
}

// ============================================================
// TRANSACTION ICONS
// ============================================================

export function TxBracketed({ size = defaults.size, color = defaults.color, accent = defaults.accent }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" fill="none">
      <path d="M7 5 H4 V27 H7" stroke={color} strokeWidth="1.75" strokeLinecap="square" fill="none" />
      <path d="M25 5 H28 V27 H25" stroke={color} strokeWidth="1.75" strokeLinecap="square" fill="none" />
      <line x1="9" y1="16" x2="22" y2="16" stroke={color} strokeWidth="2" />
      <path
        d="M19 12 L23 16 L19 20"
        stroke={accent}
        strokeWidth="2"
        fill="none"
        strokeLinejoin="miter"
        strokeLinecap="square"
      />
    </svg>
  );
}

export function TxNodes({ size = defaults.size, color = defaults.color, accent = defaults.accent }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" fill="none">
      <rect x="3" y="12" width="8" height="8" fill={color} />
      <rect x="21" y="12" width="8" height="8" stroke={color} strokeWidth="1.75" fill="none" />
      <line x1="11" y1="16" x2="20" y2="16" stroke={color} strokeWidth="1.75" />
      <path
        d="M18 13 L21 16 L18 19"
        stroke={accent}
        strokeWidth="2"
        fill="none"
        strokeLinejoin="miter"
        strokeLinecap="square"
      />
    </svg>
  );
}

export function TxSwap({ size = defaults.size, color = defaults.color, accent = defaults.accent }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" fill="none">
      <line x1="6" y1="11" x2="24" y2="11" stroke={color} strokeWidth="2" />
      <path
        d="M21 8 L25 11 L21 14"
        stroke={color}
        strokeWidth="2"
        fill="none"
        strokeLinejoin="miter"
        strokeLinecap="square"
      />
      <line x1="6" y1="21" x2="24" y2="21" stroke={accent} strokeWidth="2" />
      <path
        d="M10 18 L6 21 L10 24"
        stroke={accent}
        strokeWidth="2"
        fill="none"
        strokeLinejoin="miter"
        strokeLinecap="square"
      />
    </svg>
  );
}

export function TxReceipt({ size = defaults.size, color = defaults.color, accent = defaults.accent }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" fill="none">
      <rect x="6" y="4" width="20" height="24" stroke={color} strokeWidth="1.75" fill={ARKIV_SAND} />
      <rect x="9" y="8" width="14" height="2" fill={color} />
      <line x1="9" y1="14" x2="20" y2="14" stroke={color} strokeWidth="1.5" />
      <line x1="9" y1="18" x2="22" y2="18" stroke={color} strokeWidth="1.5" />
      <rect x="9" y="22" width="10" height="2.5" fill={accent} />
    </svg>
  );
}

export function TxFlow({ size = defaults.size, color = defaults.color, accent = defaults.accent }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" fill="none">
      <path d="M3 10 L8 7 L13 10 L13 18 L8 21 L3 18 Z" fill={color} />
      <path d="M3 10 L8 13 L13 10" stroke={ARKIV_SAND} strokeWidth="1.25" fill="none" />
      <path d="M8 13 L8 21" stroke={ARKIV_SAND} strokeWidth="1.25" />
      <line x1="14" y1="14" x2="22" y2="14" stroke={accent} strokeWidth="2" />
      <path
        d="M20 11 L23 14 L20 17"
        stroke={accent}
        strokeWidth="2"
        fill="none"
        strokeLinejoin="miter"
        strokeLinecap="square"
      />
      <path d="M19 10 L24 7 L29 10 L29 18 L24 21 L19 18 Z" stroke={color} strokeWidth="1.5" fill="none" />
      <path d="M19 10 L24 13 L29 10 M24 13 L24 21" stroke={color} strokeWidth="1.5" fill="none" />
    </svg>
  );
}

export function TxInBlock({ size = defaults.size, color = defaults.color, accent = defaults.accent }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" fill="none">
      <path
        d="M16 3 L28 9 L28 22 L16 28 L4 22 L4 9 Z"
        stroke={color}
        strokeWidth="1.75"
        strokeLinejoin="miter"
        fill={ARKIV_SAND}
      />
      <path d="M4 9 L16 15 L28 9 M16 15 L16 28" stroke={color} strokeWidth="1.5" fill="none" />
      <line x1="9" y1="9" x2="22" y2="9" stroke={accent} strokeWidth="2.25" />
      <path
        d="M19 6 L23 9 L19 12"
        stroke={accent}
        strokeWidth="2.25"
        fill="none"
        strokeLinejoin="miter"
        strokeLinecap="square"
      />
    </svg>
  );
}

export function TxBolt({ size = defaults.size, color = defaults.color, accent = defaults.accent }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" fill="none">
      <path
        d="M7 5 H4 V27 H7 M25 5 H28 V27 H25"
        stroke={color}
        strokeWidth="1.5"
        fill="none"
        opacity="0.35"
      />
      <path d="M18 4 L9 18 L15 18 L13 28 L23 12 L17 12 Z" fill={color} />
      <path d="M18 4 L9 18 L15 18" fill={accent} />
    </svg>
  );
}

export function TxDiagonal({ size = defaults.size, color = defaults.color, accent = defaults.accent }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" fill="none">
      <rect x="4" y="4" width="9" height="9" fill={accent} />
      <rect x="19" y="19" width="9" height="9" stroke={color} strokeWidth="1.75" fill={ARKIV_SAND} />
      <line x1="13" y1="13" x2="20" y2="20" stroke={color} strokeWidth="2" />
      <path
        d="M17 20 L21 20 L21 16"
        stroke={color}
        strokeWidth="2"
        fill="none"
        strokeLinejoin="miter"
        strokeLinecap="square"
      />
    </svg>
  );
}

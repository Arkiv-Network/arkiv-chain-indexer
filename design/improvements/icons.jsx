/* Arkiv-flavoured icons — geometric, sharp, 1.5px stroke, no fills.
   Each accepts {size, color} (color defaults to currentColor). */

const Ic = ({ children, size = 18, stroke = 1.5, ...rest }) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth={stroke}
    strokeLinecap="square"
    strokeLinejoin="miter"
    {...rest}
  >
    {children}
  </svg>
);

const IcSearch = (p) => (
  <Ic {...p}>
    <circle cx="11" cy="11" r="6" />
    <path d="M16 16l4.5 4.5" />
  </Ic>
);

const IcArrowOut = (p) => (
  <Ic {...p}>
    <path d="M7 17L17 7" />
    <path d="M9 7h8v8" />
  </Ic>
);

const IcCube = (p) => (
  <Ic {...p}>
    <path d="M12 3L21 7.5V16.5L12 21L3 16.5V7.5L12 3Z" />
    <path d="M3 7.5L12 12L21 7.5" />
    <path d="M12 12V21" />
  </Ic>
);

const IcDb = (p) => (
  <Ic {...p}>
    <ellipse cx="12" cy="5" rx="8" ry="3" />
    <path d="M4 5v6c0 1.66 3.58 3 8 3s8-1.34 8-3V5" />
    <path d="M4 11v6c0 1.66 3.58 3 8 3s8-1.34 8-3v-6" />
  </Ic>
);

const IcLightning = (p) => (
  <Ic {...p}>
    <path d="M13 2L4 14H11L10 22L20 9H13L13 2Z" />
  </Ic>
);

const IcClock = (p) => (
  <Ic {...p}>
    <circle cx="12" cy="12" r="9" />
    <path d="M12 7v5l3.5 2.5" />
  </Ic>
);

const IcWallet = (p) => (
  <Ic {...p}>
    <rect x="3" y="6" width="18" height="13" />
    <path d="M16 12h4" />
    <path d="M3 6l14-3v3" />
  </Ic>
);

const IcGas = (p) => (
  <Ic {...p}>
    <rect x="4" y="3" width="10" height="18" />
    <path d="M4 9h10" />
    <path d="M14 11h3a2 2 0 0 1 2 2v4a2 2 0 0 0 2 2" />
    <path d="M17 7l2-2" />
  </Ic>
);

const IcStack = (p) => (
  <Ic {...p}>
    <path d="M12 3l9 4-9 4-9-4 9-4Z" />
    <path d="M3 12l9 4 9-4" />
    <path d="M3 17l9 4 9-4" />
  </Ic>
);

const IcChip = (p) => (
  <Ic {...p}>
    <rect x="6" y="6" width="12" height="12" />
    <rect x="9" y="9" width="6" height="6" />
    <path d="M10 3v3M14 3v3M10 18v3M14 18v3M3 10h3M3 14h3M18 10h3M18 14h3" />
  </Ic>
);

const IcNetwork = (p) => (
  <Ic {...p}>
    <circle cx="12" cy="5" r="2" />
    <circle cx="5"  cy="18" r="2" />
    <circle cx="19" cy="18" r="2" />
    <path d="M12 7v3M10.5 11.5l-4 5M13.5 11.5l4 5" />
    <circle cx="12" cy="11" r="1.5" />
  </Ic>
);

const IcArrows = (p) => (
  <Ic {...p}>
    <path d="M7 7h12M19 7l-3-3M19 7l-3 3" />
    <path d="M17 17H5M5 17l3-3M5 17l3 3" />
  </Ic>
);

const IcCode = (p) => (
  <Ic {...p}>
    <path d="M8 7L3 12L8 17" />
    <path d="M16 7l5 5-5 5" />
    <path d="M14 4l-4 16" />
  </Ic>
);

const IcDroplet = (p) => (
  <Ic {...p}>
    <path d="M12 3s-6 7-6 12a6 6 0 0 0 12 0c0-5-6-12-6-12Z" />
  </Ic>
);

const IcDoc = (p) => (
  <Ic {...p}>
    <path d="M6 3h9l4 4v14H6V3Z" />
    <path d="M15 3v4h4" />
    <path d="M9 12h7M9 16h7" />
  </Ic>
);

const IcGithub = (p) => (
  <Ic {...p}>
    <path d="M9 19c-4 1.5-4-2-6-2.5M15 22v-3.5a3.4 3.4 0 0 0-1-2.6c3.3-.4 6.8-1.6 6.8-7.3A5.7 5.7 0 0 0 19.3 4.7a5.3 5.3 0 0 0-.1-4S17.9.3 15 2.2a13 13 0 0 0-7 0C5.1.3 3.8.7 3.8.7a5.3 5.3 0 0 0-.1 4 5.7 5.7 0 0 0-1.5 3.9c0 5.7 3.5 6.9 6.8 7.3a3.4 3.4 0 0 0-1 2.6V22" />
  </Ic>
);

const IcCopy = (p) => (
  <Ic {...p}>
    <rect x="9" y="9" width="12" height="12" />
    <path d="M5 15H3V3h12v2" />
  </Ic>
);

const IcChevron = (p) => (
  <Ic {...p}>
    <path d="M9 6l6 6-6 6" />
  </Ic>
);

const IcTriUp = (p) => (
  <Ic {...p}>
    <path d="M12 6l7 12H5L12 6Z" />
  </Ic>
);
const IcTriDown = (p) => (
  <Ic {...p}>
    <path d="M12 18L5 6h14L12 18Z" />
  </Ic>
);

const IcExternal = (p) => (
  <Ic {...p}>
    <path d="M14 4h6v6" />
    <path d="M10 14L20 4" />
    <path d="M19 14v6H4V5h6" />
  </Ic>
);

Object.assign(window, {
  IcSearch, IcArrowOut, IcCube, IcDb, IcLightning, IcClock, IcWallet,
  IcGas, IcStack, IcChip, IcNetwork, IcArrows, IcCode, IcDroplet,
  IcDoc, IcGithub, IcCopy, IcChevron, IcTriUp, IcTriDown, IcExternal,
});

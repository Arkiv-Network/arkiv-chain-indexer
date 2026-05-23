// Icon components backed by editable SVG files in ./icons/*.svg.
// Edit any of those files (e.g. in Inkscape) and Vite HMR will reload the app.

import blockArchiveSvg from "./icons/block-archive.svg?raw";
import blockBracketedSvg from "./icons/block-bracketed.svg?raw";
import blockEmptySvg from "./icons/block-empty.svg?raw";
import blockFilledSvg from "./icons/block-filled.svg?raw";
import blockHashtagSvg from "./icons/block-hashtag.svg?raw";
import blockIsoOutlineSvg from "./icons/block-iso-outline.svg?raw";
import blockLayeredSvg from "./icons/block-layered.svg?raw";
import blockLedgerSvg from "./icons/block-ledger.svg?raw";
import blockListSvg from "./icons/block-list.svg?raw";
import blockSolidSvg from "./icons/block-solid.svg?raw";
import blockWireAccentSvg from "./icons/block-wire-accent.svg?raw";
import txBoltSvg from "./icons/tx-bolt.svg?raw";
import txBracketedSvg from "./icons/tx-bracketed.svg?raw";
import txDiagonalSvg from "./icons/tx-diagonal.svg?raw";
import txFlowSvg from "./icons/tx-flow.svg?raw";
import txInBlockSvg from "./icons/tx-in-block.svg?raw";
import txNodesSvg from "./icons/tx-nodes.svg?raw";
import txReceiptSvg from "./icons/tx-receipt.svg?raw";
import txSwapSvg from "./icons/tx-swap.svg?raw";

export const ARKIV_BLUE = "#181EA9";
export const ARKIV_ORANGE = "#FE7446";
export const ARKIV_INK = "#111111";
export const ARKIV_STONE = "#E9E6DE";
export const ARKIV_SAND = "#F6F4EF";

export interface IconProps {
  size?: number;
  className?: string;
}

const DEFAULT_SIZE = 64;

// Strip any width/height baked into the SVG (Inkscape often re-adds them on save)
// so the wrapper's size prop is the single source of truth.
function stripIntrinsicSize(raw: string): string {
  return raw.replace(/<svg([^>]*)>/, (_, attrs: string) =>
    `<svg${attrs.replace(/\s(width|height)="[^"]*"/g, "")}>`,
  );
}

function makeIcon(raw: string) {
  const stripped = stripIntrinsicSize(raw);
  return function Icon({ size = DEFAULT_SIZE, className }: IconProps) {
    return (
      <span
        className={className ? `svg-icon ${className}` : "svg-icon"}
        style={{ width: size, height: size }}
        dangerouslySetInnerHTML={{ __html: stripped }}
      />
    );
  };
}

export const BlockArchive = makeIcon(blockArchiveSvg);
export const BlockBracketed = makeIcon(blockBracketedSvg);
export const BlockEmpty = makeIcon(blockEmptySvg);
export const BlockFilled = makeIcon(blockFilledSvg);
export const BlockHashtag = makeIcon(blockHashtagSvg);
export const BlockIsoOutline = makeIcon(blockIsoOutlineSvg);
export const BlockLayered = makeIcon(blockLayeredSvg);
export const BlockLedger = makeIcon(blockLedgerSvg);
export const BlockList = makeIcon(blockListSvg);
export const BlockSolid = makeIcon(blockSolidSvg);
export const BlockWireAccent = makeIcon(blockWireAccentSvg);
export const TxBolt = makeIcon(txBoltSvg);
export const TxBracketed = makeIcon(txBracketedSvg);
export const TxDiagonal = makeIcon(txDiagonalSvg);
export const TxFlow = makeIcon(txFlowSvg);
export const TxInBlock = makeIcon(txInBlockSvg);
export const TxNodes = makeIcon(txNodesSvg);
export const TxReceipt = makeIcon(txReceiptSvg);
export const TxSwap = makeIcon(txSwapSvg);

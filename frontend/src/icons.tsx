// Icon components backed by editable SVG files in ./icons/*.svg.
// Edit any of those files (e.g. in Inkscape) and Vite HMR will reload the app.

import blockEmptySvg from "./icons/block-empty.svg?raw";
import blockFilledSvg from "./icons/block-filled.svg?raw";
import blockListSvg from "./icons/block-list.svg?raw";
import infoSvg from "./icons/info.svg?raw";
import { cn } from "@/lib/utils";

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
        className={cn("inline-flex leading-none [&>svg]:block [&>svg]:h-full [&>svg]:w-full", className)}
        style={{ width: size, height: size }}
        dangerouslySetInnerHTML={{ __html: stripped }}
      />
    );
  };
}

export const BlockEmpty = makeIcon(blockEmptySvg);
export const BlockFilled = makeIcon(blockFilledSvg);
export const BlockList = makeIcon(blockListSvg);
export const Info = makeIcon(infoSvg);

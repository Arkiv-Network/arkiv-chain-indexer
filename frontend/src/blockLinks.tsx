import { buildRouteHref, writePermalink } from "./permalinks";
import type { MouseEvent } from "react";
import { cn } from "@/lib/utils";

export function blockPanelHref(blockNumber: string | number | null | undefined): string {
  const value = String(blockNumber ?? "").trim();
  if (!value) return buildRouteHref("block", {});
  return buildRouteHref("block", { block: value });
}

export function BlockNumberLink({
  blockNumber,
  label,
  onLocationChange,
}: {
  blockNumber: string | number | null | undefined;
  label?: string;
  onLocationChange?: () => void;
}) {
  const value = String(blockNumber ?? "").trim();
  const display = label ?? (value || "-");

  if (!value) {
    return <span className="font-mono tabular-nums">{display}</span>;
  }

  const onClick = (event: MouseEvent<HTMLAnchorElement>) => {
    if (!onLocationChange) return;
    event.preventDefault();
    if (writePermalink("block", { block: value })) {
      onLocationChange();
    }
  };

  return (
    <a
      className={cn("text-primary hover:underline", !label && "font-mono tabular-nums")}
      href={blockPanelHref(value)}
      onClick={onClick}
    >
      {display}
    </a>
  );
}

import { writePermalink } from "./permalinks";
import type { MouseEvent } from "react";

export function blockPanelHref(blockNumber: string | number | null | undefined): string {
  const value = String(blockNumber ?? "").trim();
  if (!value) return "?view=block";
  const params = new URLSearchParams();
  params.set("view", "block");
  params.set("block", value);
  return `?${params.toString()}`;
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
    return <span className="mono">{display}</span>;
  }

  const onClick = (event: MouseEvent<HTMLAnchorElement>) => {
    if (!onLocationChange) return;
    event.preventDefault();
    if (writePermalink("block", { block: value })) {
      onLocationChange();
    }
  };

  return (
    <a className={`${label ? "" : "mono "}block-link`} href={blockPanelHref(value)} onClick={onClick}>
      {display}
    </a>
  );
}

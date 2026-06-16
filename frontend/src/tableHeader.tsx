import type { ReactNode } from "react";

export function renderTableHeader(label: string): ReactNode {
  const match = label.match(/^(.*)\s+\(([^)]+)\)$/);
  if (!match) return label;

  const [, left, unit] = match;
  return (
    <span className="table-header-wrap">
      {left}
      <br />
      ({unit})
    </span>
  );
}

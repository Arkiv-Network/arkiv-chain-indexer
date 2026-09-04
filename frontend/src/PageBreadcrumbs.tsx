import { ChevronRight } from "lucide-react";
import type { MouseEvent, ReactNode } from "react";
import { buildRouteHref, shouldHandleClientNavigation, type View, writePermalink } from "./permalinks";

export interface PageBreadcrumbItem {
  view: View;
  label: string;
  icon?: ReactNode;
}

export function PageBreadcrumbs({
  items,
  onLocationChange,
}: {
  items: readonly PageBreadcrumbItem[];
  onLocationChange: () => void;
}) {
  if (items.length === 0) return null;

  const onClick = (targetView: View) => (event: MouseEvent<HTMLAnchorElement>) => {
    if (!shouldHandleClientNavigation(event)) return;
    event.preventDefault();
    if (writePermalink(targetView, {})) {
      onLocationChange();
    }
  };

  return (
    <nav className="flex flex-wrap items-center gap-1 text-xs text-muted-foreground" aria-label="Breadcrumb">
      {items.map((item, index) => {
        const last = index === items.length - 1;
        return (
          <span className="inline-flex items-center gap-1" key={`${item.view}:${item.label}`}>
            {index > 0 ? (
              <ChevronRight className="size-3 shrink-0 text-muted-foreground/50" aria-hidden="true" />
            ) : null}
            {item.icon ? (
              <span className="inline-flex items-center" aria-hidden="true">
                {item.icon}
              </span>
            ) : null}
            {last ? (
              <span className="text-foreground" aria-current="page">
                {item.label}
              </span>
            ) : (
              <a
                className="transition-colors hover:text-foreground hover:underline"
                href={buildRouteHref(item.view, {})}
                onClick={onClick(item.view)}
              >
                {item.label}
              </a>
            )}
          </span>
        );
      })}
    </nav>
  );
}

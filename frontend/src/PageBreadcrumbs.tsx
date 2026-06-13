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
    <nav className="page-breadcrumbs" aria-label="Breadcrumb">
      {items.map((item, index) => {
        const last = index === items.length - 1;
        return (
          <span className="page-breadcrumb-item" key={`${item.view}:${item.label}`}>
            {item.icon ? (
              <span className="page-breadcrumb-icon" aria-hidden="true">
                {item.icon}
              </span>
            ) : null}
            {last ? (
              <span aria-current="page">{item.label}</span>
            ) : (
              <a href={buildRouteHref(item.view, {})} onClick={onClick(item.view)}>
                {item.label}
              </a>
            )}
          </span>
        );
      })}
    </nav>
  );
}

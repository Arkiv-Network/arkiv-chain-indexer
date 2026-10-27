import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * The title row every page opens with: a heading, an optional one-line
 * description, and optional actions aligned to the right. Pages are reached
 * from the header navigation, so there is no breadcrumb trail above it.
 */
export function PageHeader({
  title,
  description,
  actions,
  className,
}: {
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("flex flex-wrap items-end justify-between gap-3", className)}>
      <div className="flex min-w-0 flex-col gap-1">
        <h1 className="font-heading text-2xl font-black tracking-tight">{title}</h1>
        {description ? <div className="text-sm text-muted-foreground">{description}</div> : null}
      </div>
      {actions ? <div className="flex flex-wrap items-center gap-3">{actions}</div> : null}
    </div>
  );
}

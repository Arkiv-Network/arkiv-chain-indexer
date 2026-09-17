import type { ReactNode } from "react";
import { Card } from "@/components/ui/card";
import { cn } from "@/lib/utils";

/**
 * A Card framed for a chart: a muted title row (with optional trailing meta)
 * over a flexible content area. Shared by the home page's live histograms
 * and the history charts view's main plot.
 */
export function ChartCard({
  title,
  meta,
  className,
  contentClassName,
  children,
}: {
  title: ReactNode;
  meta?: ReactNode;
  className?: string;
  contentClassName?: string;
  children: ReactNode;
}) {
  return (
    <Card className={cn("flex flex-col gap-0 py-0", className)}>
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-4 py-2.5">
        <div className="flex items-center gap-2 font-heading text-sm">{title}</div>
        {meta ? <div className="shrink-0 text-[10px] text-muted-foreground">{meta}</div> : null}
      </div>
      <div className={cn("min-h-0 flex-1 p-2", contentClassName)}>{children}</div>
    </Card>
  );
}

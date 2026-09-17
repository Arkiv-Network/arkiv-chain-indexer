import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/** Responsive grid of `Stat` tiles (block summary, activity KPIs). */
export function StatGrid({ className, children }: { className?: string; children: ReactNode }) {
  return (
    <dl className={cn("grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4", className)}>
      {children}
    </dl>
  );
}

/** A single label/value tile inside a `StatGrid`. */
export function Stat({
  label,
  children,
  title,
  wide = false,
  size = "sm",
}: {
  label: string;
  children: ReactNode;
  title?: string;
  wide?: boolean;
  size?: "sm" | "lg";
}) {
  return (
    <div className={cn("border border-border bg-muted/40 px-3 py-2", wide && "col-span-2")}>
      <dt className="text-[10px] font-medium tracking-wider text-muted-foreground uppercase">{label}</dt>
      <dd
        className={cn(
          "mt-1 truncate font-mono tabular-nums text-foreground",
          size === "lg" ? "text-sm font-semibold" : "text-xs",
        )}
        title={title}
      >
        {children}
      </dd>
    </div>
  );
}

import { useState } from "react";
import type { Layout, PlotRelayoutEvent } from "plotly.js";
import { chartTimeAxis } from "./chartTime";

export function useZonedChartLayout(layout: Partial<Layout>, timeZone: string) {
  const [zoom, setZoom] = useState<{ source: Partial<Layout>; range: [number, number] } | null>(null);
  const active = zoom?.source === layout && layout.xaxis?.type === "date" ? zoom : null;
  const zonedLayout = active ? {
    ...layout,
    xaxis: {
      ...layout.xaxis,
      ...chartTimeAxis(active.range[0], active.range[1], timeZone),
      range: active.range.map((value) => new Date(value).toISOString()),
      autorange: false,
    },
  } : layout;

  const onRelayout = (event: PlotRelayoutEvent) => {
    if (layout.xaxis?.type !== "date") return;
    if (event["xaxis.autorange"]) { setZoom(null); return; }
    const start = event["xaxis.range[0]"];
    const end = event["xaxis.range[1]"];
    if (start === undefined || end === undefined) return;
    // Plotly date strings omit the zone but still represent UTC coordinates.
    const parse = (value: string | number) => typeof value === "number" ? value
      : Date.parse(/[zZ]$|[+-]\d\d:\d\d$/.test(value) ? value : `${value.replace(" ", "T")}Z`);
    const range: [number, number] = [parse(start), parse(end)];
    if (range.every(Number.isFinite)) setZoom({ source: layout, range });
  };
  return { zonedLayout, onRelayout };
}

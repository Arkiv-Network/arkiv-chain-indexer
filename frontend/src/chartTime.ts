import { fmtDate } from "./format";

// Keep coordinates in UTC so repeated hours at DST boundaries remain distinct.
// Only the labels are formatted in the visitor's selected timezone.
export function chartTimeAxis(start: number, end: number, timeZone: string) {
  const count = 5;
  const tickvals = Array.from({ length: count }, (_, i) =>
    new Date(start + (end - start) * i / (count - 1)).toISOString(),
  );
  const formatter = new Intl.DateTimeFormat("en-GB", {
    timeZone, hour: "2-digit", minute: "2-digit", hourCycle: "h23",
    ...(end - start >= 86_400_000 ? { month: "short" as const, day: "2-digit" as const } : {}),
  });
  return {
    tickmode: "array" as const,
    tickvals,
    ticktext: tickvals.map((value) => formatter.format(new Date(value))),
    title: { text: timeZone },
  };
}

export function chartTimeLabels(times: number[], timeZone: string): string[] {
  return times.map((time) => fmtDate(new Date(time).toISOString(), timeZone));
}

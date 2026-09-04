import { BlockNumberLink } from "@/blockLinks";
import { fmtDate } from "@/format";

/** Block number link stacked over its formatted date, used in table rows. */
export function BlockCell({
  blockNumber,
  date,
  timeZone,
  onLocationChange,
}: {
  blockNumber: string | number | null | undefined;
  date: string | null | undefined;
  timeZone: string;
  onLocationChange: () => void;
}) {
  return (
    <div className="flex flex-col gap-0.5 leading-tight">
      <BlockNumberLink blockNumber={blockNumber} onLocationChange={onLocationChange} />
      <span className="text-[11px] text-muted-foreground">{fmtDate(date, timeZone)}</span>
    </div>
  );
}

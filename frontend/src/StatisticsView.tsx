import { useEffect, useState, type ReactNode } from "react";
import { fetchStatistics } from "./api";
import { STATISTICS_PERIODS, type StatisticsPeriod, type StatisticsResponse } from "../../src/indexerStatisticsTypes";
import { Stat, StatGrid } from "@/components/stat";
import { Card, CardContent } from "@/components/ui/card";
import { fmtDate } from "./format";
import { selectClass } from "@/components/filters-panel";
import { readStoredString, writeStoredString } from "./localStorage";
import { formatStatisticsBytes, isStatisticsByteUnit, type StatisticsByteUnit } from "./statisticsFormat";
import { isStatisticsPeriod, selectStatisticsActivity } from "./statisticsPeriods";
import { StatisticsInfo, StatisticsLabel } from "./StatisticsLabel";
import { STATISTICS_HELP, attributeExplanation, operationExplanation, type StatisticsHelpKey } from "./statisticsHelp";

const integer = (value: string | null) => value === null ? "Unavailable" : BigInt(value).toLocaleString("en-US");
const BYTE_UNIT_KEY = "statistics.byteUnit";
const PERIOD_KEY = "statistics.period";
const average = (total: string | null, count: string | null) => {
  if (total === null || count === null || count === "0") return "—";
  const hundredths = BigInt(total) * 100n / BigInt(count);
  return `${(hundredths / 100n).toLocaleString("en-US")}.${(hundredths % 100n).toString().padStart(2, "0")}`;
};

function HelpLabel({ name, label = name }: { name: StatisticsHelpKey; label?: string }) {
  return <StatisticsLabel label={label} explanation={STATISTICS_HELP[name]} />;
}

function ExplainedStat({ label, children, size }: { label: StatisticsHelpKey; children: ReactNode; size?: "sm" | "lg" }) {
  return <Stat label={<HelpLabel name={label} />} size={size}>{children}</Stat>;
}

function Section({ title, note, children }: { title: StatisticsHelpKey; note?: string; children: ReactNode }) {
  return <section className="space-y-3">
    <h2 className="text-base font-semibold"><HelpLabel name={title} /></h2>
    {note && <p className="text-xs text-muted-foreground">{note}</p>}
    {children}
  </section>;
}

export function StatisticsView({ timeZone }: { timeZone: string }) {
  const [data, setData] = useState<StatisticsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [byteUnit, setByteUnit] = useState<StatisticsByteUnit>(() =>
    readStoredString(BYTE_UNIT_KEY, "decimal", isStatisticsByteUnit) as StatisticsByteUnit);
  const [period, setPeriod] = useState<StatisticsPeriod>(() =>
    readStoredString(PERIOD_KEY, "all", isStatisticsPeriod) as StatisticsPeriod);
  const bytes = (value: string | null) => formatStatisticsBytes(value, byteUnit);
  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const load = async () => {
      try {
        const next = await fetchStatistics();
        if (!cancelled) { setData(next); setError(null); }
      } catch {
        if (!cancelled) setError("Statistics are unavailable. The statistics worker may still be gathering its first snapshot.");
      } finally {
        if (!cancelled) timer = setTimeout(load, 30_000);
      }
    };
    void load();
    return () => { cancelled = true; clearTimeout(timer); };
  }, []);

  const entity = data?.entities;
  const selectedPeriod = data?.windows?.[period] ? period : "all";
  const activity = data ? selectStatisticsActivity(data, selectedPeriod) : null;
  const periodLabel = STATISTICS_PERIODS.find(({ id }) => id === selectedPeriod)!.label;
  const activityNote = activity?.fromInclusiveUtc && activity.toExclusiveUtc
    ? `${periodLabel}: ${fmtDate(activity.fromInclusiveUtc, timeZone)} (inclusive) to ${fmtDate(activity.toExclusiveUtc, timeZone)} (exclusive). Based on block timestamps in the stored history.`
    : "All time: all stored activity at collection. Missing indexed history is not estimated.";
  return <div className="space-y-6">
    <div className="flex flex-wrap items-start justify-between gap-4">
      <div>
        <h1 className="text-xl font-semibold"><HelpLabel name="Statistics" /></h1>
        <p className="mt-1 text-sm text-muted-foreground">Indexed activity for the selected period and current projected entity state.</p>
      </div>
      <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        <div className="inline-flex items-center gap-1.5">
          <label htmlFor="statistics-period">Activity period</label>
          <StatisticsInfo label="Activity period" explanation={STATISTICS_HELP["Activity period"]} />
        </div>
        <select id="statistics-period" className={selectClass} value={selectedPeriod} onChange={(event) => {
          const value = event.target.value;
          if (!isStatisticsPeriod(value)) return;
          setPeriod(value);
          writeStoredString(PERIOD_KEY, value);
        }}>
          {STATISTICS_PERIODS.map(({ id, label }) => <option key={id} value={id} disabled={id !== "all" && !data?.windows?.[id]}>{label}</option>)}
        </select>
        <div className="inline-flex items-center gap-1.5">
          <label htmlFor="statistics-byte-unit">Byte units</label>
          <StatisticsInfo label="Byte units" explanation={STATISTICS_HELP["Byte units"]} />
        </div>
        <select id="statistics-byte-unit" className={selectClass} value={byteUnit} onChange={(event) => {
          const value = event.target.value;
          if (!isStatisticsByteUnit(value)) return;
          setByteUnit(value);
          writeStoredString(BYTE_UNIT_KEY, value);
        }}>
          <option value="bytes">Bytes (B)</option>
          <option value="decimal">Kilobytes (kB, base 1000)</option>
          <option value="binary">Kibibytes (KiB, base 1024)</option>
        </select>
      </div>
    </div>
    {error && <p role="alert" className="text-sm text-amber-600">{error}{data ? " Showing the last loaded snapshot." : ""}</p>}
    {!data && !error && <p role="status" className="text-sm text-muted-foreground">Loading statistics…</p>}
    {data && entity && activity && <>
      <Card><CardContent className="space-y-1 pt-4 text-xs text-muted-foreground">
        <div className="flex flex-wrap gap-x-4 gap-y-2">
          <p><HelpLabel name="Gathered" /> {fmtDate(data.gatheredAtUtc, timeZone)}</p>
          <p><HelpLabel name="Collection took" /> {(data.durationMs / 1000).toFixed(1)}s</p>
          <p><HelpLabel name="Refreshes about every" /> {Math.round(data.refreshIntervalMs / 60_000)} minutes</p>
        </div>
        {(data.stale || error) && <p className="font-medium text-amber-600">Snapshot is stale. Totals may have changed since collection.</p>}
      </CardContent></Card>
      {!data.windows && <p role="status" className="text-sm text-muted-foreground">Time-window activity is unavailable in this snapshot. Showing all time until the statistics worker publishes window results.</p>}
      <Section title="Chain coverage" note="All stored history, independent of the activity period. The scanned percentage excludes the newest 10 blocks to allow for normal indexing delay. Older gaps and unscanned history still reduce coverage.">
        <StatGrid>
          <ExplainedStat label="Chain scanned" size="lg">{data.chain.scannedPercent === null ? "Unknown" : `${data.chain.scannedPercent.toFixed(4)}%`}</ExplainedStat>
          <ExplainedStat label="Observed chain head">{integer(data.chain.observedHead)}</ExplainedStat>
          <ExplainedStat label="Gaps within stored range">{integer(data.blocks.missingWithinStoredRange)}</ExplainedStat>
          <ExplainedStat label="First indexed block">{integer(data.blocks.first)}</ExplainedStat>
          <ExplainedStat label="Last indexed block">{integer(data.blocks.last)}</ExplainedStat>
        </StatGrid>
        <p className="text-xs text-muted-foreground">Head observed {data.chain.observedAtUtc ? fmtDate(data.chain.observedAtUtc, timeZone) : "at an unknown time"}.
          {data.chain.headObservationStale && <span className="text-amber-600"> The chain head observation was stale or unavailable when gathered.</span>}
          {data.blocks.transactions !== data.transactions.indexed && " Block metrics and stored transaction rows have different coverage."}</p>
      </Section>
      <Section title="Indexed activity" note={activityNote}>
        <StatGrid>
          <ExplainedStat label="Indexed blocks" size="lg">{integer(activity.blocks.indexed)}</ExplainedStat>
          <ExplainedStat label="Transactions in block metrics">{integer(activity.blocks.transactions)}</ExplainedStat>
          <ExplainedStat label="Indexed transaction rows">{integer(activity.transactions.indexed)}</ExplainedStat>
        </StatGrid>
        <p className="text-xs text-muted-foreground">A zero means no matching stored activity; incomplete indexing can leave history missing.</p>
      </Section>
      <Section title="Entity operations" note={`${periodLabel} activity. Attempts grouped by receipt outcome; repeated changes count separately and genesis imports have no create transaction.`}>
        <div className="overflow-x-auto border border-border">
          <table className="w-full text-left text-xs">
            <thead className="bg-muted"><tr>{(["Operation", "Successful", "Reverted", "Unknown outcome"] as const).map((h) => <th className="px-3 py-2 font-medium" key={h}><HelpLabel name={h} /></th>)}</tr></thead>
            <tbody>{activity.operations.byType.filter((row) => row.type !== 6).map((row) => <tr key={row.type} className="border-t border-border">
              <th className="px-3 py-2 font-medium"><StatisticsLabel label={row.name === "ownerChanged" ? "Owner changes" : row.name.charAt(0).toUpperCase() + row.name.slice(1)} explanation={operationExplanation(row.type)} /></th>
              {[row.successful, row.reverted, row.unknownStatus].map((value, i) => <td key={i} className="px-3 py-2 font-mono tabular-nums">{integer(value)}</td>)}
            </tr>)}</tbody>
          </table>
        </div>
        {activity.operations.successfulCreatesWithoutKey !== "0" && <p className="text-xs text-amber-600">{integer(activity.operations.successfulCreatesWithoutKey)} successful creates lack an entity key and cannot contribute to the entity projection.</p>}
      </Section>
      <Section title="Entity state" note={entity.status === "available"
        ? `Current state, independent of the activity period. As of projected block ${integer(entity.asOfBlock)}; ${integer(entity.lagBehindObservedHead)} blocks behind the observed chain head. Active means not deleted and not expired at that block.`
        : `Entity statistics are ${entity.status}. They require a ready entity projection.`}>
        <StatGrid>
          <ExplainedStat label="Known entities" size="lg">{integer(entity.known)}</ExplainedStat>
          <ExplainedStat label="Active entities" size="lg">{integer(entity.active)}</ExplainedStat>
          <ExplainedStat label="Expired, not deleted">{integer(entity.expired)}</ExplainedStat>
          <ExplainedStat label="Deleted entities">{integer(entity.deleted)}</ExplainedStat>
        </StatGrid>
        <p className="text-xs text-muted-foreground">Projection starts at block {integer(entity.floorBlock)}. Genesis import: {entity.genesisStatus ?? "unknown"}. This is the stored entity state at collection time; a lagging or incomplete projection cannot give an exact live-chain count.</p>
      </Section>
      <Section title="Transaction input and payloads" note={`${periodLabel} activity. Input totals measure calldata, excluding signatures and envelope overhead. Referenced payload bytes are declared per write and may repeat the same payload.`}>
        <StatGrid>
          <ExplainedStat label="Input bytes in block metrics">{bytes(activity.blocks.inputBytes)}</ExplainedStat>
          <ExplainedStat label="Compressed input in block metrics">{bytes(activity.blocks.compressedInputBytes)}</ExplainedStat>
          <ExplainedStat label="Input bytes in transaction rows">{bytes(activity.transactions.inputBytes)}</ExplainedStat>
          <ExplainedStat label="Transaction rows with input">{integer(activity.transactions.withInput)}</ExplainedStat>
          <ExplainedStat label="Mean input per transaction">{formatStatisticsBytes(activity.transactions.inputBytes, byteUnit, activity.transactions.indexed)}</ExplainedStat>
          <ExplainedStat label="Largest transaction input">{bytes(activity.transactions.maxInputBytes)}</ExplainedStat>
          <ExplainedStat label="Successful writes with payload">{integer(activity.operations.successfulPayloadWrites)}</ExplainedStat>
          <ExplainedStat label="Recorded payload bytes in successful ops">{bytes(activity.operations.successfulPayloadBytes)}</ExplainedStat>
          <ExplainedStat label="Successful reference writes">{integer(activity.operations.successfulReferenceWrites)}</ExplainedStat>
          <ExplainedStat label="Declared referenced payload bytes">{bytes(activity.operations.referencedPayloadBytes)}</ExplainedStat>
          <ExplainedStat label="References without a usable size">{integer(activity.operations.referencesWithoutSize)}</ExplainedStat>
        </StatGrid>
      </Section>
      <Section title="Current active payload state" note="Current projection at the block shown above, independent of the activity period. Recorded metadata is not verified storage usage.">
        <StatGrid>
          <ExplainedStat label="Active entities with recorded payload">{integer(entity.activeWithPayload)}</ExplainedStat>
          <ExplainedStat label="Active recorded payload bytes">{bytes(entity.activeRecordedPayloadBytes)}</ExplainedStat>
          <ExplainedStat label="Largest active recorded payload">{bytes(entity.maxActiveRecordedPayloadBytes)}</ExplainedStat>
        </StatGrid>
      </Section>
      <Section title="Attributes on active entities" note="Current state, independent of the activity period. Describes the projected active state, so expired entities and superseded attribute values are excluded.">
        <StatGrid>
          <ExplainedStat label="Total attributes">{integer(entity.activeAttributes)}</ExplainedStat>
          <ExplainedStat label="Entities with attributes">{integer(entity.activeWithAttributes)}</ExplainedStat>
          <ExplainedStat label="Mean attributes per active entity">{average(entity.activeAttributes, entity.active)}</ExplainedStat>
          <ExplainedStat label="Maximum attributes per entity">{integer(entity.maxAttributesPerActiveEntity)}</ExplainedStat>
          {entity.attributeTypes.map((row) => <Stat key={row.typeId} label={<StatisticsLabel label={`${row.name} attributes`} explanation={attributeExplanation(row.typeId, row.name)} />}>{integer(row.count)}</Stat>)}
        </StatGrid>
      </Section>
      {entity.topContentTypes.length > 0 && <Section title="Top content types" note="Current state, independent of the activity period. Up to 20 content types by active entity count. Payload sizes are recorded metadata, not verified storage usage.">
        <div className="overflow-x-auto border border-border"><table className="w-full text-left text-xs">
          <thead className="bg-muted"><tr>{(["Content type", "Content-type active entities", "Recorded payload bytes"] as const).map((h) => <th key={h} className="px-3 py-2 font-medium"><HelpLabel name={h} label={h === "Content-type active entities" ? "Active entities" : h} /></th>)}</tr></thead>
          <tbody>{entity.topContentTypes.map((row) => <tr key={row.contentType} className="border-t border-border">
            <td className="px-3 py-2 break-all">{row.contentType || "Unspecified"}</td>
            <td className="px-3 py-2 font-mono">{integer(row.entities)}</td><td className="px-3 py-2 font-mono">{bytes(row.recordedPayloadBytes)}</td>
          </tr>)}</tbody>
        </table></div>
      </Section>}
      <details className="border border-border p-3 text-xs text-muted-foreground">
        <summary className="cursor-pointer font-medium text-foreground"><HelpLabel name="Coverage and measurement limitations" /></summary>
        <ul className="mt-3 list-disc space-y-2 pl-5">{data.limitations.map((note) => <li key={note}>{note}</li>)}</ul>
      </details>
    </>}
  </div>;
}

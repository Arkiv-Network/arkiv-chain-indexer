import { useEffect, useState, type ReactNode } from "react";
import { fetchStatistics } from "./api";
import type { StatisticsResponse } from "../../src/indexerStatisticsTypes";
import { Stat, StatGrid } from "@/components/stat";
import { Card, CardContent } from "@/components/ui/card";
import { fmtDate } from "./format";

const integer = (value: string | null) => value === null ? "Unavailable" : BigInt(value).toLocaleString("en-US");
const bytes = (value: string | null) => value === null ? "Unavailable" : `${integer(value)} B`;
const average = (total: string | null, count: string | null) => {
  if (total === null || count === null || count === "0") return "—";
  const hundredths = BigInt(total) * 100n / BigInt(count);
  return `${(hundredths / 100n).toLocaleString("en-US")}.${(hundredths % 100n).toString().padStart(2, "0")}`;
};

function Section({ title, note, children }: { title: string; note?: string; children: ReactNode }) {
  return <section className="space-y-3">
    <h2 className="text-base font-semibold">{title}</h2>
    {note && <p className="text-xs text-muted-foreground">{note}</p>}
    {children}
  </section>;
}

export function StatisticsView({ timeZone }: { timeZone: string }) {
  const [data, setData] = useState<StatisticsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
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
  return <div className="space-y-6">
    <div>
      <h1 className="text-xl font-semibold">Statistics</h1>
      <p className="mt-1 text-sm text-muted-foreground">Cumulative indexed activity and entity state from the latest statistics snapshot.</p>
    </div>
    {error && <p role="alert" className="text-sm text-amber-600">{error}{data ? " Showing the last loaded snapshot." : ""}</p>}
    {!data && !error && <p role="status" className="text-sm text-muted-foreground">Loading statistics…</p>}
    {data && entity && <>
      <Card><CardContent className="space-y-1 pt-4 text-xs text-muted-foreground">
        <p>Gathered {fmtDate(data.gatheredAtUtc, timeZone)} · Collection took {(data.durationMs / 1000).toFixed(1)}s · Refreshes about every {Math.round(data.refreshIntervalMs / 60_000)} minutes</p>
        {(data.stale || error) && <p className="font-medium text-amber-600">Snapshot is stale. Totals may have changed since collection.</p>}
      </CardContent></Card>
      <Section title="Chain coverage" note="Counts every stored block, including genesis. Gaps and unscanned history reduce coverage.">
        <StatGrid>
          <Stat label="Chain scanned" size="lg">{data.chain.scannedPercent === null ? "Unknown" : `${data.chain.scannedPercent.toFixed(4)}%`}</Stat>
          <Stat label="Indexed blocks" size="lg">{integer(data.blocks.indexed)}</Stat>
          <Stat label="Observed chain head">{integer(data.chain.observedHead)}</Stat>
          <Stat label="Gaps within stored range">{integer(data.blocks.missingWithinStoredRange)}</Stat>
          <Stat label="First indexed block">{integer(data.blocks.first)}</Stat>
          <Stat label="Last indexed block">{integer(data.blocks.last)}</Stat>
          <Stat label="Transactions in block metrics">{integer(data.blocks.transactions)}</Stat>
          <Stat label="Indexed transaction rows">{integer(data.transactions.indexed)}</Stat>
        </StatGrid>
        <p className="text-xs text-muted-foreground">Head observed {data.chain.observedAtUtc ? fmtDate(data.chain.observedAtUtc, timeZone) : "at an unknown time"}.
          {data.chain.headObservationStale && <span className="text-amber-600"> The chain head observation was stale or unavailable when gathered.</span>}
          {data.blocks.transactions !== data.transactions.indexed && " Block metrics and stored transaction rows have different coverage."}</p>
      </Section>
      <Section title="Entity operations" note="Successful operation counts across stored transactions. Multiple changes to one entity count separately; genesis imports have no create transaction.">
        <div className="overflow-x-auto border border-border">
          <table className="w-full text-left text-xs">
            <thead className="bg-muted"><tr>{["Operation", "Successful", "Reverted", "Unknown outcome"].map((h) => <th className="px-3 py-2 font-medium" key={h}>{h}</th>)}</tr></thead>
            <tbody>{data.operations.byType.map((row) => <tr key={row.type} className="border-t border-border">
              <th className="px-3 py-2 font-medium">{row.name === "ownerChanged" ? "Owner changes" : row.name.charAt(0).toUpperCase() + row.name.slice(1)}</th>
              {[row.successful, row.reverted, row.unknownStatus].map((value, i) => <td key={i} className="px-3 py-2 font-mono tabular-nums">{integer(value)}</td>)}
            </tr>)}</tbody>
          </table>
        </div>
        {data.operations.successfulCreatesWithoutKey !== "0" && <p className="text-xs text-amber-600">{integer(data.operations.successfulCreatesWithoutKey)} successful creates lack an entity key and cannot contribute to the entity projection.</p>}
      </Section>
      <Section title="Entity state" note={entity.status === "available"
        ? `As of projected block ${integer(entity.asOfBlock)}; ${integer(entity.lagBehindObservedHead)} blocks behind the observed chain head. Active means not deleted and not expired at that block.`
        : `Entity statistics are ${entity.status}. They require a ready entity projection.`}>
        <StatGrid>
          <Stat label="Known entities" size="lg">{integer(entity.known)}</Stat>
          <Stat label="Active entities" size="lg">{integer(entity.active)}</Stat>
          <Stat label="Expired, not deleted">{integer(entity.expired)}</Stat>
          <Stat label="Deleted entities">{integer(entity.deleted)}</Stat>
        </StatGrid>
        <p className="text-xs text-muted-foreground">Projection starts at block {integer(entity.floorBlock)}. Genesis import: {entity.genesisStatus ?? "unknown"}. This is the stored entity state at collection time; a lagging or incomplete projection cannot give an exact live-chain count.</p>
      </Section>
      <Section title="Transaction input and payloads" note="Input totals measure calldata bytes. They exclude transaction signatures and envelope overhead. Referenced payload bytes are declared per write and may repeat the same payload.">
        <StatGrid>
          <Stat label="Input bytes in block metrics">{bytes(data.blocks.inputBytes)}</Stat>
          <Stat label="Compressed input in block metrics">{bytes(data.blocks.compressedInputBytes)}</Stat>
          <Stat label="Input bytes in transaction rows">{bytes(data.transactions.inputBytes)}</Stat>
          <Stat label="Transaction rows with input">{integer(data.transactions.withInput)}</Stat>
          <Stat label="Mean input per transaction">{average(data.transactions.inputBytes, data.transactions.indexed)} B</Stat>
          <Stat label="Largest transaction input">{bytes(data.transactions.maxInputBytes)}</Stat>
          <Stat label="Successful writes with payload">{integer(data.operations.successfulPayloadWrites)}</Stat>
          <Stat label="Recorded payload bytes in successful ops">{bytes(data.operations.successfulPayloadBytes)}</Stat>
          <Stat label="Successful reference writes">{integer(data.operations.successfulReferenceWrites)}</Stat>
          <Stat label="Declared referenced payload bytes">{bytes(data.operations.referencedPayloadBytes)}</Stat>
          <Stat label="References without a usable size">{integer(data.operations.referencesWithoutSize)}</Stat>
          <Stat label="Active entities with recorded payload">{integer(entity.activeWithPayload)}</Stat>
          <Stat label="Active recorded payload bytes">{bytes(entity.activeRecordedPayloadBytes)}</Stat>
          <Stat label="Largest active recorded payload">{bytes(entity.maxActiveRecordedPayloadBytes)}</Stat>
        </StatGrid>
      </Section>
      <Section title="Attributes on active entities" note="Describes the projected active state, so expired entities and superseded attribute values are excluded.">
        <StatGrid>
          <Stat label="Total attributes">{integer(entity.activeAttributes)}</Stat>
          <Stat label="Entities with attributes">{integer(entity.activeWithAttributes)}</Stat>
          <Stat label="Mean attributes per active entity">{average(entity.activeAttributes, entity.active)}</Stat>
          <Stat label="Maximum attributes per entity">{integer(entity.maxAttributesPerActiveEntity)}</Stat>
          {entity.attributeTypes.map((row) => <Stat key={row.typeId} label={`${row.name} attributes`}>{integer(row.count)}</Stat>)}
        </StatGrid>
      </Section>
      {entity.topContentTypes.length > 0 && <Section title="Top content types" note="Up to 20 content types by active entity count. Payload sizes are recorded metadata, not verified storage usage.">
        <div className="overflow-x-auto border border-border"><table className="w-full text-left text-xs">
          <thead className="bg-muted"><tr>{["Content type", "Active entities", "Recorded payload bytes"].map((h) => <th key={h} className="px-3 py-2 font-medium">{h}</th>)}</tr></thead>
          <tbody>{entity.topContentTypes.map((row) => <tr key={row.contentType} className="border-t border-border">
            <td className="px-3 py-2 break-all">{row.contentType || "Unspecified"}</td>
            <td className="px-3 py-2 font-mono">{integer(row.entities)}</td><td className="px-3 py-2 font-mono">{bytes(row.recordedPayloadBytes)}</td>
          </tr>)}</tbody>
        </table></div>
      </Section>}
      <details className="border border-border p-3 text-xs text-muted-foreground">
        <summary className="cursor-pointer font-medium text-foreground">Coverage and measurement limitations</summary>
        <ul className="mt-3 list-disc space-y-2 pl-5">{data.limitations.map((note) => <li key={note}>{note}</li>)}</ul>
      </details>
    </>}
  </div>;
}

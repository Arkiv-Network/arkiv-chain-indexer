import { useCallback, useEffect, useState } from "react";
import { fetchHealth, type HealthResponse } from "./api";
import { fmtBytes, fmtDate, fmtDurationSeconds, fmtInteger, fmtUtcDate } from "./format";
import { SyncDetails } from "./SyncStatusBanner";
import { describeSync, type SyncTone } from "./syncStatus";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { cn } from "@/lib/utils";

interface HealthViewProps {
  timeZone: string;
}

const SYNC_TONE_STYLES: Record<SyncTone, { border: string; badge: string }> = {
  ok: { border: "border-l-emerald-500", badge: "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400" },
  info: { border: "border-l-primary", badge: "bg-primary/10 text-primary" },
  warn: { border: "border-l-amber-500", badge: "bg-amber-500/10 text-amber-600 dark:text-amber-400" },
  danger: { border: "border-l-destructive", badge: "bg-destructive/10 text-destructive" },
  muted: { border: "border-l-border", badge: "bg-muted text-muted-foreground" },
};

export function HealthView({ timeZone }: HealthViewProps) {
  const [data, setData] = useState<HealthResponse | null>(null);
  const [browserNow, setBrowserNow] = useState(() => new Date());
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const browserTimeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || timeZone;

  const load = useCallback(() => {
    setLoading(true);
    setError(null);
    fetchHealth()
      .then((body) => setData(body))
      .catch((err: Error) => setError(err.message))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    load();
    const refresh = window.setInterval(load, 15_000);
    const tick = window.setInterval(() => setBrowserNow(new Date()), 1_000);
    return () => {
      window.clearInterval(refresh);
      window.clearInterval(tick);
    };
  }, [load]);

  const scanner = data?.scanner;
  const sync = data?.sync ?? null;
  const syncPresentation = describeSync(sync);
  const syncTone = SYNC_TONE_STYLES[syncPresentation.tone];
  const database = data?.database;
  const guzzlers = data?.guzzlers;
  const guzzlersEnabled = guzzlers?.enabled ?? data?.features.guzzlers ?? false;

  return (
    <section className="mx-auto flex w-full max-w-415 flex-col gap-6 px-3 py-6 md:px-6">
      <div className="flex items-center justify-between gap-3">
        <h2 className="font-heading text-lg font-black tracking-tight">Health</h2>
        <Button type="button" variant="outline" size="sm" onClick={load} disabled={loading}>
          {loading ? "Refreshing" : "Refresh"}
        </Button>
      </div>
      {error ? <p className="text-xs text-destructive">{error}</p> : null}
      {sync ? (
        <Card className={cn("border-l-4", syncTone.border)}>
          <CardHeader>
            <div className="flex items-center gap-2">
              <CardTitle>Sync status</CardTitle>
              <Badge className={cn("rounded-full", syncTone.badge)} variant="secondary">
                {syncPresentation.label}
              </Badge>
            </div>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            <div>
              <p className="text-xs font-medium text-foreground">{syncPresentation.headline}</p>
              <p className="mt-1 text-xs text-muted-foreground">{syncPresentation.detail}</p>
            </div>
            <SyncDetails status={sync} timeZone={timeZone} />
          </CardContent>
        </Card>
      ) : null}
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <Card>
          <CardHeader>
            <CardTitle>Scanner progress</CardTitle>
          </CardHeader>
          <CardContent>
            <MetricList>
              <Metric label="Last stored block" value={fmtInteger(scanner?.lastSuccessfulBlock)} />
              <Metric label="Safe head lag" value={fmtInteger(scanner?.safeHeadLagBlocks)} />
              <Metric label="Chain head lag" value={fmtInteger(scanner?.headLagBlocks)} />
              <Metric label="Last block age" value={fmtDurationSeconds(scanner?.lastBlockAgeSeconds)} />
              <Metric label="Last block time" value={fmtDate(scanner?.lastSuccessfulBlockDate, timeZone)} />
              <Metric label="Stored at UTC" value={fmtUtcDate(scanner?.lastSuccessfulScannedAtUtc)} />
            </MetricList>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Chain observation</CardTitle>
          </CardHeader>
          <CardContent>
            <MetricList>
              <Metric label="Latest observed head" value={fmtInteger(scanner?.latestObservedBlock)} />
              <Metric label="Safe head" value={fmtInteger(scanner?.safeHeadBlock)} />
              <Metric label="Backfill next block" value={fmtInteger(scanner?.backfillNextBlock)} />
              <Metric label="Observed at UTC" value={fmtUtcDate(scanner?.latestObservedAtUtc)} />
              <Metric
                label="Observation age"
                value={fmtDurationSeconds(scanner?.latestObservationAgeSeconds)}
              />
            </MetricList>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Time and build</CardTitle>
          </CardHeader>
          <CardContent>
            <MetricList>
              <Metric label="Server UTC" value={fmtUtcDate(data?.serverTimeUtc)} />
              <Metric label="Browser time" value={fmtDate(browserNow.toISOString(), browserTimeZone)} />
              <Metric label="Selected time" value={fmtDate(browserNow.toISOString(), timeZone)} />
              <Metric label="Selected time zone" value={timeZone} />
              <Metric
                label="Transaction data"
                value={data?.features.transactionData === false ? "Disabled" : "Enabled"}
              />
              <Metric label="Build commit" value={shortCommit(data?.build.commit)} />
              <Metric label="Build date UTC" value={fmtUtcDate(data?.build.builtAtUtc)} />
            </MetricList>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Guzzler cache</CardTitle>
          </CardHeader>
          <CardContent>
            <MetricList>
              <Metric label="Status" value={guzzlersEnabled ? "Enabled" : "Disabled"} />
              <Metric
                label="Cached senders"
                value={guzzlersEnabled ? fmtInteger(guzzlers?.entryCount) : "—"}
              />
              <Metric
                label="Cached buckets"
                value={guzzlersEnabled ? fmtInteger(guzzlers?.bucketCount) : "—"}
              />
              <Metric
                label="Cache size"
                value={guzzlersEnabled ? fmtBytes(guzzlers?.totalSizeBytes) : "—"}
                title={guzzlersEnabled ? bytesTitle(guzzlers?.totalSizeBytes) : undefined}
              />
              <Metric
                label="Oldest bucket"
                value={guzzlersEnabled ? fmtDate(guzzlers?.oldestBucket, timeZone) : "—"}
              />
              <Metric
                label="Newest bucket"
                value={guzzlersEnabled ? fmtDate(guzzlers?.newestBucket, timeZone) : "—"}
              />
            </MetricList>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Database</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <MetricList>
            <Metric
              label="Total database size"
              value={fmtBytes(database?.totalSizeBytes)}
              title={bytesTitle(database?.totalSizeBytes)}
            />
          </MetricList>
          <div className="overflow-hidden rounded-none border border-border">
            <Table className="min-w-[720px]">
              <TableHeader>
                <TableRow>
                  <TableHead>Table</TableHead>
                  <TableHead className="text-right">Rows (est.)</TableHead>
                  <TableHead className="text-right">Table</TableHead>
                  <TableHead className="text-right">Indexes</TableHead>
                  <TableHead className="text-right">Total</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {(database?.tables ?? []).map((table) => (
                  <TableRow key={table.tableName}>
                    <TableCell>{table.tableName}</TableCell>
                    <TableCell className="text-right font-mono tabular-nums">
                      {fmtInteger(table.rowCount)}
                    </TableCell>
                    <TableCell
                      className="text-right font-mono tabular-nums"
                      title={bytesTitle(table.tableSizeBytes)}
                    >
                      {fmtBytes(table.tableSizeBytes)}
                    </TableCell>
                    <TableCell
                      className="text-right font-mono tabular-nums"
                      title={bytesTitle(table.indexesSizeBytes)}
                    >
                      {fmtBytes(table.indexesSizeBytes)}
                    </TableCell>
                    <TableCell
                      className="text-right font-mono tabular-nums"
                      title={bytesTitle(table.totalSizeBytes)}
                    >
                      {fmtBytes(table.totalSizeBytes)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </CardContent>
      </Card>
    </section>
  );
}

function MetricList({ children }: { children: React.ReactNode }) {
  return (
    <dl className="grid grid-cols-[minmax(7rem,max-content)_minmax(0,1fr)] items-baseline gap-x-4 gap-y-2 text-xs">
      {children}
    </dl>
  );
}

function Metric({ label, value, title }: { label: string; value: string; title?: string }) {
  return (
    <>
      <dt className="whitespace-nowrap text-muted-foreground">{label}</dt>
      <dd title={title} className="min-w-0 break-words font-mono tabular-nums text-foreground">
        {value}
      </dd>
    </>
  );
}

function shortCommit(value: string | null | undefined): string {
  if (!value) return "—";
  return value.length > 12 ? value.slice(0, 12) : value;
}

function bytesTitle(value: string | null | undefined): string | undefined {
  return value ? `${value} bytes` : undefined;
}

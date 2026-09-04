import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import {
  BASELOAD_BEHAVIOR_LABELS,
  BASELOAD_WORKER_BEHAVIORS,
  type BaseloadWorkerConfig,
} from "../../baseloadConfig";
import { type BaseloadTaskStatus } from "../../api";
import { BEHAVIOR_SHORT_LABELS, BEHAVIOR_TONE } from "./shared";

export function FleetSummary({
  workers,
  taskStatuses,
}: {
  workers: readonly BaseloadWorkerConfig[];
  taskStatuses: Record<string, BaseloadTaskStatus>;
}) {
  if (workers.length === 0) return null;
  const totalOps = workers.reduce((sum, worker) => sum + worker.opsPerMinute, 0);
  const totalEntities = workers.reduce(
    (sum, worker) => sum + worker.opsPerMinute * worker.entitiesPerRequest,
    0,
  );
  const behaviorCounts = BASELOAD_WORKER_BEHAVIORS.map((behavior) => ({
    behavior,
    count: workers.filter((worker) => worker.behavior === behavior).length,
  })).filter((entry) => entry.count > 0);
  const activeCount = workers.filter((worker) =>
    ["running", "waiting", "ready", "updated"].includes(taskStatuses[worker.id]?.status ?? ""),
  ).length;
  const errorCount = workers.filter(
    (worker) => taskStatuses[worker.id]?.status === "error",
  ).length;

  return (
    <div className="flex flex-wrap items-center gap-2">
      <Badge variant="secondary" className="font-mono">
        {workers.length} workers
      </Badge>
      <Badge variant="secondary" className="font-mono">
        {totalOps} ops/min
      </Badge>
      <Badge variant="secondary" className="font-mono">
        {totalEntities} entities/min
      </Badge>
      <Badge variant="secondary" className="font-mono">
        {activeCount} active
      </Badge>
      {errorCount > 0 ? (
        <Badge variant="destructive" className="font-mono">
          {errorCount} errors
        </Badge>
      ) : null}
      {behaviorCounts.map(({ behavior, count }) => (
        <Badge
          key={behavior}
          variant="outline"
          className={cn("border-transparent font-mono", BEHAVIOR_TONE[behavior].badge)}
          title={BASELOAD_BEHAVIOR_LABELS[behavior]}
        >
          {count} {BEHAVIOR_SHORT_LABELS[behavior]}
        </Badge>
      ))}
    </div>
  );
}

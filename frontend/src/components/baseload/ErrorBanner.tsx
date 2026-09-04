import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { type BaseloadTaskStatus, type BaseloadWorkerBalance } from "../../api";
import { type BaseloadWorkerConfig } from "../../baseloadConfig";
import { ErrorDetail } from "./shared";

export function ErrorBanner({
  formError,
  backendError,
  configManagerError,
  workers,
  taskStatuses,
  balances,
}: {
  formError: string | null;
  backendError: string | null;
  configManagerError: string | null;
  workers: readonly BaseloadWorkerConfig[];
  taskStatuses: Record<string, BaseloadTaskStatus>;
  balances: Record<string, BaseloadWorkerBalance>;
}) {
  const workerErrors = workers.flatMap((worker) => {
    const entries: { workerId: string; walletNumber: number; source: string; message: string; updatedAt?: string }[] = [];
    const status = taskStatuses[worker.id];
    if (status && status.status === "error" && status.message) {
      entries.push({
        workerId: worker.id,
        walletNumber: worker.walletNumber,
        source: "task",
        message: status.message,
        updatedAt: status.updatedAt,
      });
    }
    const balance = balances[worker.id];
    if (balance?.error) {
      entries.push({
        workerId: worker.id,
        walletNumber: worker.walletNumber,
        source: "balance RPC",
        message: balance.error,
        updatedAt: balance.updatedAt,
      });
    }
    return entries;
  });

  if (!formError && !backendError && !configManagerError && workerErrors.length === 0) return null;

  return (
    <Card className="border-l-4 border-l-destructive" role="alert">
      <CardHeader>
        <CardTitle className="text-destructive">Errors</CardTitle>
      </CardHeader>
      <CardContent>
        <ul className="flex flex-col gap-2 text-xs">
          {formError ? (
            <li>
              <strong className="font-medium text-foreground">Form:</strong>{" "}
              <ErrorDetail message={formError} />
            </li>
          ) : null}
          {backendError ? (
            <li>
              <strong className="font-medium text-foreground">Backend:</strong>{" "}
              <ErrorDetail message={backendError} />
            </li>
          ) : null}
          {configManagerError ? (
            <li>
              <strong className="font-medium text-foreground">Saved configs:</strong>{" "}
              <ErrorDetail message={configManagerError} />
            </li>
          ) : null}
          {workerErrors.map((entry, index) => (
            <li key={`${entry.workerId}-${entry.source}-${index}`}>
              <strong className="font-medium text-foreground">Wallet {entry.walletNumber}</strong> (
              {entry.source}
              {entry.updatedAt ? ` @ ${entry.updatedAt}` : ""}):{" "}
              <ErrorDetail message={entry.message} />
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}

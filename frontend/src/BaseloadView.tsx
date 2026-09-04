import { useEffect, useMemo, useState } from "react";
import {
  BASELOAD_WORKER_BEHAVIORS,
  createBaseloadWorkerDraft,
  createBaseloadWorkerFromDraft,
  getAvailableWalletNumbers,
  moveDraftToNextAvailableWallet,
  normalizeBaseloadConfig,
  parseBaseloadConfigJson,
  removeBaseloadWorker,
  serializeBaseloadConfig,
  updateBaseloadWorker,
  type BaseloadConfig,
  type BaseloadWorkerBehavior,
  type BaseloadWorkerConfig,
  type BaseloadWorkerDraft,
} from "./baseloadConfig";
import {
  type BaseloadTaskStatus,
  type BaseloadWorkerBalance,
  type StoredBaseloadConfigSummary,
} from "./api";
import {
  readStoredStringRecord,
  writeStoredStringRecord,
} from "./localStorage";
import { Button, buttonVariants } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";
import { AddWorkerForm } from "./components/baseload/AddWorkerForm";
import { ConfigManagerBar } from "./components/baseload/ConfigManagerBar";
import { ErrorBanner } from "./components/baseload/ErrorBanner";
import { FleetSummary } from "./components/baseload/FleetSummary";
import { clearEditableStorage, WorkerCard } from "./components/baseload/WorkerCard";

interface BaseloadViewProps {
  config: BaseloadConfig;
  onConfigChange: (config: BaseloadConfig) => void | Promise<void>;
  taskStatuses: Record<string, BaseloadTaskStatus>;
  balances: Record<string, BaseloadWorkerBalance>;
  backendError: string | null;
  adminToken: string;
  onAdminTokenChange: (token: string) => void;
  savedConfigs: StoredBaseloadConfigSummary[];
  configManagerError: string | null;
  onRefreshSavedConfigs: () => Promise<void>;
  onSaveCurrentConfig: (name: string) => Promise<void>;
  onLoadSavedConfig: (name: string) => Promise<void>;
  onDeleteSavedConfig: (name: string) => Promise<void>;
  tokenSymbol: string;
}

const DRAFT_STORAGE_KEY = "baseload.workerDraft";
const DRAFT_KEYS = [
  "behavior",
  "maxGasPriceGwei",
  "opsPerMinute",
  "entitiesPerRequest",
  "singleCreatePayloadSize",
  "singleCreateStringArgumentCount",
  "singleCreateNumberArgumentCount",
  "entityPoolSize",
  "timeBombOffsetSeconds",
  "walletNumber",
  "startBlock",
  "endBlock",
  "durationSeconds",
  "ttlSeconds",
] as const;

export function BaseloadView({
  config,
  onConfigChange,
  taskStatuses,
  balances,
  backendError,
  adminToken,
  onAdminTokenChange,
  savedConfigs,
  configManagerError,
  onRefreshSavedConfigs,
  onSaveCurrentConfig,
  onLoadSavedConfig,
  onDeleteSavedConfig,
  tokenSymbol,
}: BaseloadViewProps) {
  const availableWallets = useMemo(() => getAvailableWalletNumbers(config.workers), [config.workers]);
  const [draft, setDraft] = useState<BaseloadWorkerDraft>(() =>
    readStoredStringRecord(
      DRAFT_STORAGE_KEY,
      createBaseloadWorkerDraft(availableWallets[0] ?? 0),
      DRAFT_KEYS,
    ),
  );
  const [error, setError] = useState<string | null>(null);
  const [downloadStatus, setDownloadStatus] = useState("");
  const [configName, setConfigName] = useState("");
  const [selectedConfigName, setSelectedConfigName] = useState("");
  const [managerError, setManagerError] = useState<string | null>(null);
  const [managerStatus, setManagerStatus] = useState("");
  const displayedConfigManagerError = managerError || configManagerError;
  const draftBehavior: BaseloadWorkerBehavior = (
    BASELOAD_WORKER_BEHAVIORS as readonly string[]
  ).includes(draft.behavior)
    ? (draft.behavior as BaseloadWorkerBehavior)
    : "create";

  useEffect(() => {
    if (availableWallets.length === 0) return;
    if (!availableWallets.includes(Number(draft.walletNumber))) {
      setDraft((current) => ({ ...current, walletNumber: String(availableWallets[0]) }));
    }
  }, [availableWallets, draft.walletNumber]);

  useEffect(() => {
    writeStoredStringRecord(DRAFT_STORAGE_KEY, draft, DRAFT_KEYS);
  }, [draft]);

  useEffect(() => {
    if (savedConfigs.length === 0) {
      setSelectedConfigName("");
      return;
    }
    if (!savedConfigs.some((saved) => saved.name === selectedConfigName)) {
      setSelectedConfigName(savedConfigs[0]?.name ?? "");
    }
  }, [savedConfigs, selectedConfigName]);

  const onDraftChange = (key: keyof BaseloadWorkerDraft) => (
    event: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>,
  ) => {
    setDraft((current) => ({ ...current, [key]: event.target.value }));
  };

  const addWorker = (event: React.FormEvent) => {
    event.preventDefault();
    try {
      const worker = createBaseloadWorkerFromDraft(draft);
      if (config.workers.some((existing) => existing.walletNumber === worker.walletNumber)) {
        throw new Error(`Wallet ${worker.walletNumber} is already attached to another worker`);
      }
      const nextConfig = normalizeBaseloadConfig({
        ...config,
        workers: [...config.workers, worker],
      });
      void onConfigChange(nextConfig);
      setDraft((current) => moveDraftToNextAvailableWallet(current, nextConfig.workers));
      setError(null);
      setDownloadStatus("");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const updateWorker = (worker: BaseloadWorkerConfig, patch: Partial<BaseloadWorkerConfig>) => {
    try {
      void onConfigChange(updateBaseloadWorker(config, worker.id, patch));
      setError(null);
      setDownloadStatus("");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const deleteWorker = (workerId: string) => {
    clearEditableStorage(workerId);
    void onConfigChange(removeBaseloadWorker(config, workerId));
    setError(null);
    setDownloadStatus("");
  };

  const downloadConfig = () => {
    const blob = new Blob([serializeBaseloadConfig(config)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = "baseload-workers.json";
    link.click();
    URL.revokeObjectURL(url);
    setDownloadStatus("Downloaded");
  };

  const runConfigManagerAction = async (action: () => Promise<void>, status: string) => {
    try {
      await action();
      setManagerError(null);
      setManagerStatus(status);
      setError(null);
      setDownloadStatus("");
    } catch (err) {
      setManagerError(err instanceof Error ? err.message : String(err));
      setManagerStatus("");
    }
  };

  const saveCurrentConfig = () => {
    const name = configName.trim();
    if (!name) {
      setManagerError("Config name is required");
      setManagerStatus("");
      return;
    }
    void runConfigManagerAction(async () => {
      await onSaveCurrentConfig(name);
      setSelectedConfigName(name);
    }, `Saved ${name}`);
  };

  const loadSelectedConfig = () => {
    if (!selectedConfigName) {
      setManagerError("Select a saved config to load");
      setManagerStatus("");
      return;
    }
    void runConfigManagerAction(
      () => onLoadSavedConfig(selectedConfigName),
      `Loaded ${selectedConfigName}`,
    );
  };

  const deleteSelectedConfig = () => {
    if (!selectedConfigName) {
      setManagerError("Select a saved config to delete");
      setManagerStatus("");
      return;
    }
    void runConfigManagerAction(
      () => onDeleteSavedConfig(selectedConfigName),
      `Deleted ${selectedConfigName}`,
    );
  };

  const loadConfigFile = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;

    try {
      const nextConfig = parseBaseloadConfigJson(await file.text());
      await onConfigChange(nextConfig);
      setDraft(createBaseloadWorkerDraft(getAvailableWalletNumbers(nextConfig.workers)[0] ?? 0));
      setError(null);
      setDownloadStatus("");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const summaryMessage =
    error ||
    backendError ||
    displayedConfigManagerError ||
    managerStatus ||
    downloadStatus ||
    `${config.workers.length} workers configured`;

  return (
    <section className="mx-auto flex w-full max-w-415 flex-col gap-6 px-3 py-6 md:px-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <h2 className="font-heading text-lg font-black tracking-tight">Baseload workers</h2>
        <div className="flex flex-wrap items-end gap-2">
          <div className="flex flex-col gap-1">
            <Label htmlFor="baseload-admin-token">Admin bearer token</Label>
            <Input
              id="baseload-admin-token"
              type="password"
              autoComplete="off"
              value={adminToken}
              onChange={(event) => onAdminTokenChange(event.target.value)}
              className="w-56"
            />
          </div>
          <label className={cn(buttonVariants({ variant: "outline", size: "sm" }), "cursor-pointer")}>
            Load config
            <input
              type="file"
              accept="application/json,.json"
              className="hidden"
              onChange={loadConfigFile}
            />
          </label>
          <Button type="button" variant="outline" size="sm" onClick={downloadConfig}>
            Download config
          </Button>
        </div>
      </div>

      <AddWorkerForm
        draft={draft}
        draftBehavior={draftBehavior}
        availableWallets={availableWallets}
        onDraftChange={onDraftChange}
        onSubmit={addWorker}
      />

      <p className={cn("text-xs", (error || backendError || displayedConfigManagerError) && "text-destructive")}>
        {summaryMessage}
      </p>

      <ConfigManagerBar
        savedConfigs={savedConfigs}
        selectedConfigName={selectedConfigName}
        onSelectedConfigNameChange={setSelectedConfigName}
        configName={configName}
        onConfigNameChange={setConfigName}
        onLoad={loadSelectedConfig}
        onDelete={deleteSelectedConfig}
        onSave={saveCurrentConfig}
        onRefresh={() => void runConfigManagerAction(onRefreshSavedConfigs, "Refreshed saved configs")}
      />

      <ErrorBanner
        formError={error}
        backendError={backendError}
        configManagerError={displayedConfigManagerError}
        workers={config.workers}
        taskStatuses={taskStatuses}
        balances={balances}
      />

      <FleetSummary workers={config.workers} taskStatuses={taskStatuses} />

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
        {config.workers.length === 0 ? (
          <Card className="col-span-full flex min-h-32 items-center justify-center border-dashed text-center text-xs text-muted-foreground">
            No baseload workers configured. Add one with the form above.
          </Card>
        ) : (
          config.workers.map((worker) => (
            <WorkerCard
              key={worker.id}
              worker={worker}
              status={taskStatuses[worker.id]}
              balance={balances[worker.id]}
              tokenSymbol={tokenSymbol}
              onUpdate={(patch) => updateWorker(worker, patch)}
              onDelete={() => deleteWorker(worker.id)}
            />
          ))
        )}
      </div>
    </section>
  );
}

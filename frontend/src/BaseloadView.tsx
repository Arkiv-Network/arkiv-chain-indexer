import { useEffect, useMemo, useState } from "react";
import {
  BASELOAD_BEHAVIOR_LABELS,
  BASELOAD_WORKER_BEHAVIORS,
  behaviorUsesPool,
  createBaseloadWorkerDraft,
  createBaseloadWorkerFromDraft,
  getAvailableWalletNumbers,
  MAX_BASELOAD_ENTITIES_PER_REQUEST,
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
import { fmtEth } from "./format";
import {
  readStoredString,
  readStoredStringRecord,
  removeStoredValue,
  writeStoredString,
  writeStoredStringRecord,
} from "./localStorage";

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
const EDITABLE_WORKER_KEYS = [
  "maxGasPriceGwei",
  "opsPerMinute",
  "entitiesPerRequest",
  "singleCreatePayloadSize",
  "singleCreateStringArgumentCount",
  "singleCreateNumberArgumentCount",
  "entityPoolSize",
  "timeBombOffsetSeconds",
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

  return (
    <section className="view baseload-view">
      <div className="view-heading-row">
        <h2>Baseload workers</h2>
        <div className="button-row">
          <label className="admin-token-field">
            Admin bearer token
            <input
              type="password"
              autoComplete="off"
              value={adminToken}
              onChange={(event) => onAdminTokenChange(event.target.value)}
            />
          </label>
          <label className="secondary file-button">
            Load config
            <input type="file" accept="application/json,.json" onChange={loadConfigFile} />
          </label>
          <button type="button" className="secondary" onClick={downloadConfig}>
            Download config
          </button>
        </div>
      </div>

      <form className="add-worker-panel" data-behavior={draftBehavior} onSubmit={addWorker} noValidate>
        <header className="add-worker-head">
          <h3>Add worker</h3>
          <span className="add-worker-hint">{BASELOAD_BEHAVIOR_LABELS[draftBehavior]}</span>
        </header>

        <div className="behavior-picker" role="radiogroup" aria-label="Worker behavior">
          {BASELOAD_WORKER_BEHAVIORS.map((behavior) => (
            <label
              key={behavior}
              className="behavior-option"
              data-behavior={behavior}
              title={BASELOAD_BEHAVIOR_LABELS[behavior]}
            >
              <input
                type="radio"
                name="draft-behavior"
                value={behavior}
                checked={draftBehavior === behavior}
                onChange={onDraftChange("behavior")}
              />
              <span>{BEHAVIOR_BADGES[behavior]}</span>
            </label>
          ))}
        </div>

        <div className="add-worker-fields">
          <Field label="Wallet">
            <select
              value={draft.walletNumber}
              onChange={onDraftChange("walletNumber")}
              disabled={availableWallets.length === 0}
            >
              {availableWallets.map((wallet) => (
                <option key={wallet} value={wallet}>
                  #{wallet}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Max gas gwei">
            <input
              type="number"
              min="0"
              step="0.1"
              value={draft.maxGasPriceGwei}
              onChange={onDraftChange("maxGasPriceGwei")}
            />
          </Field>
          <Field label="Ops / min">
            <input
              type="number"
              min="0"
              step="1"
              value={draft.opsPerMinute}
              onChange={onDraftChange("opsPerMinute")}
            />
          </Field>
          <Field label="Entities / req">
            <input
              type="number"
              min="1"
              max={MAX_BASELOAD_ENTITIES_PER_REQUEST}
              step="1"
              value={draft.entitiesPerRequest}
              onChange={onDraftChange("entitiesPerRequest")}
            />
          </Field>
          <Field label="Payload bytes">
            <input
              type="number"
              min="0"
              step="1"
              value={draft.singleCreatePayloadSize}
              onChange={onDraftChange("singleCreatePayloadSize")}
            />
          </Field>
          <Field label="String args">
            <input
              type="number"
              min="0"
              step="1"
              value={draft.singleCreateStringArgumentCount}
              onChange={onDraftChange("singleCreateStringArgumentCount")}
            />
          </Field>
          <Field label="Number args">
            <input
              type="number"
              min="0"
              step="1"
              value={draft.singleCreateNumberArgumentCount}
              onChange={onDraftChange("singleCreateNumberArgumentCount")}
            />
          </Field>
          {behaviorUsesPool(draftBehavior) ? (
            <Field label="Pool size">
              <input
                type="number"
                min="1"
                step="1"
                value={draft.entityPoolSize}
                onChange={onDraftChange("entityPoolSize")}
              />
            </Field>
          ) : null}
          {draftBehavior === "time-bomb" ? (
            <Field label="Bomb offset s">
              <input
                type="number"
                min="1"
                step="1"
                value={draft.timeBombOffsetSeconds}
                onChange={onDraftChange("timeBombOffsetSeconds")}
              />
            </Field>
          ) : null}
          <Field label="Start block">
            <input type="number" min="0" step="1" value={draft.startBlock} onChange={onDraftChange("startBlock")} />
          </Field>
          <Field label="End block">
            <input
              type="number"
              min="0"
              step="1"
              placeholder="Infinity"
              value={draft.endBlock}
              onChange={onDraftChange("endBlock")}
            />
          </Field>
          <Field label="Duration s">
            <input
              type="number"
              min="1"
              step="1"
              placeholder="Forever"
              value={draft.durationSeconds}
              onChange={onDraftChange("durationSeconds")}
            />
          </Field>
          {draftBehavior === "time-bomb" ? (
            <Field label="TTL s">
              <span className="wfield-static" title="TTL targets the detonation moment automatically">
                auto
              </span>
            </Field>
          ) : (
            <Field label="TTL s">
              <input
                type="number"
                min="1"
                step="1"
                value={draft.ttlSeconds}
                onChange={onDraftChange("ttlSeconds")}
              />
            </Field>
          )}
        </div>

        <div className="add-worker-actions">
          <button type="submit" className="add-worker-submit" disabled={availableWallets.length === 0}>
            ✚ Add worker{availableWallets.length === 0 ? "" : ` #${draft.walletNumber}`}
          </button>
        </div>
      </form>

      <p className={`summary${error || backendError || displayedConfigManagerError ? " error" : ""}`}>
        {error ||
          backendError ||
          displayedConfigManagerError ||
          managerStatus ||
          downloadStatus ||
          `${config.workers.length} workers configured`}
      </p>

      <div className="baseload-config-manager">
        <label>
          Saved config
          <select
            value={selectedConfigName}
            onChange={(event) => setSelectedConfigName(event.target.value)}
            disabled={savedConfigs.length === 0}
          >
            {savedConfigs.length === 0 ? (
              <option value="">No saved configs</option>
            ) : (
              savedConfigs.map((saved) => (
                <option key={saved.name} value={saved.name}>
                  {saved.name} ({saved.workerCount})
                </option>
              ))
            )}
          </select>
        </label>
        <button type="button" className="secondary" onClick={loadSelectedConfig} disabled={!selectedConfigName}>
          Load selected
        </button>
        <button type="button" className="secondary" onClick={deleteSelectedConfig} disabled={!selectedConfigName}>
          Delete saved
        </button>
        <label>
          Config name
          <input
            type="text"
            value={configName}
            onChange={(event) => setConfigName(event.target.value)}
            placeholder="mainnet low gas"
          />
        </label>
        <button type="button" className="secondary" onClick={saveCurrentConfig}>
          Save current
        </button>
        <button
          type="button"
          className="secondary"
          onClick={() =>
            void runConfigManagerAction(onRefreshSavedConfigs, "Refreshed saved configs")
          }
        >
          Refresh
        </button>
      </div>

      <ErrorBanner
        formError={error}
        backendError={backendError}
        configManagerError={displayedConfigManagerError}
        workers={config.workers}
        taskStatuses={taskStatuses}
        balances={balances}
      />

      <FleetSummary workers={config.workers} taskStatuses={taskStatuses} />

      <div className="worker-grid">
        {config.workers.length === 0 ? (
          <div className="worker-card worker-card-empty">
            No baseload workers configured. Add one with the form above.
          </div>
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

const BEHAVIOR_BADGES: Record<BaseloadWorkerBehavior, string> = {
  "create": "✚ create",
  "create-update": "↻ create + update",
  "create-ownership": "⇄ ownership",
  "time-bomb": "✸ time bomb",
  "create-update-delete": "♻ full churn",
};

function FleetSummary({
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
    <div className="fleet-summary">
      <span className="fleet-chip">
        <strong>{workers.length}</strong> workers
      </span>
      <span className="fleet-chip">
        <strong>{totalOps}</strong> ops/min
      </span>
      <span className="fleet-chip">
        <strong>{totalEntities}</strong> entities/min
      </span>
      <span className="fleet-chip">
        <strong>{activeCount}</strong> active
      </span>
      {errorCount > 0 ? (
        <span className="fleet-chip fleet-chip-error">
          <strong>{errorCount}</strong> errors
        </span>
      ) : null}
      {behaviorCounts.map(({ behavior, count }) => (
        <span
          key={behavior}
          className="fleet-chip behavior-chip"
          data-behavior={behavior}
          title={BASELOAD_BEHAVIOR_LABELS[behavior]}
        >
          <strong>{count}</strong> {BEHAVIOR_BADGES[behavior]}
        </span>
      ))}
    </div>
  );
}

function WorkerCard({
  worker,
  status,
  balance,
  tokenSymbol,
  onUpdate,
  onDelete,
}: {
  worker: BaseloadWorkerConfig;
  status: BaseloadTaskStatus | undefined;
  balance: BaseloadWorkerBalance | undefined;
  tokenSymbol: string;
  onUpdate: (patch: Partial<BaseloadWorkerConfig>) => void;
  onDelete: () => void;
}) {
  return (
    <article className="worker-card" data-behavior={worker.behavior}>
      <header className="worker-card-head">
        <span className="worker-card-wallet">
          wallet <strong>#{worker.walletNumber}</strong>
        </span>
        <span className="behavior-badge" title={BASELOAD_BEHAVIOR_LABELS[worker.behavior]}>
          {BEHAVIOR_BADGES[worker.behavior]}
        </span>
        <button type="button" className="worker-card-delete" title="Delete worker" onClick={onDelete}>
          ×
        </button>
      </header>

      <div className="worker-card-address" title={worker.walletAddress}>
        {worker.walletAddress || "address pending"}
      </div>

      <div className="worker-card-status-row">
        <StatusChip status={status} />
        <span className="worker-card-balance">
          <BalanceCell balance={balance} tokenSymbol={tokenSymbol} />
        </span>
      </div>

      <WorkerMetrics status={status} />

      {status?.detonationAt ? (
        <div className="worker-card-detonation">✸ detonation @ {status.detonationAt}</div>
      ) : null}

      {status?.status === "error" && status.message ? (
        <ErrorDetail
          className="cell-error-message"
          message={status.message}
          maxLength={CELL_ERROR_SUMMARY_MAX_LENGTH}
        />
      ) : null}

      <div className="worker-card-fields">
        <label className="wfield wfield-wide">
          <span>Behavior</span>
          <select
            value={worker.behavior}
            onChange={(event) =>
              onUpdate({ behavior: event.target.value as BaseloadWorkerBehavior })
            }
          >
            {BASELOAD_WORKER_BEHAVIORS.map((behavior) => (
              <option key={behavior} value={behavior}>
                {BASELOAD_BEHAVIOR_LABELS[behavior]}
              </option>
            ))}
          </select>
        </label>
        <Field label="Max gas gwei">
          <EditableNumber
            storageKey={editableStorageKey(worker.id, "maxGasPriceGwei")}
            value={worker.maxGasPriceGwei}
            min={0}
            step="0.1"
            onChange={(value) => {
              if (value !== null) onUpdate({ maxGasPriceGwei: value });
            }}
          />
        </Field>
        <Field label="Ops / min">
          <EditableNumber
            storageKey={editableStorageKey(worker.id, "opsPerMinute")}
            value={worker.opsPerMinute}
            min={0}
            step="1"
            onChange={(value) => {
              if (value !== null) onUpdate({ opsPerMinute: value });
            }}
          />
        </Field>
        <Field label="Entities / req">
          <EditableNumber
            storageKey={editableStorageKey(worker.id, "entitiesPerRequest")}
            value={worker.entitiesPerRequest}
            min={1}
            max={MAX_BASELOAD_ENTITIES_PER_REQUEST}
            step="1"
            integer
            onChange={(value) => {
              if (value !== null) onUpdate({ entitiesPerRequest: value });
            }}
          />
        </Field>
        <Field label="Payload bytes">
          <EditableNumber
            storageKey={editableStorageKey(worker.id, "singleCreatePayloadSize")}
            value={worker.singleCreatePayloadSize}
            min={0}
            step="1"
            integer
            onChange={(value) => {
              if (value !== null) onUpdate({ singleCreatePayloadSize: value });
            }}
          />
        </Field>
        <Field label="String args">
          <EditableNumber
            storageKey={editableStorageKey(worker.id, "singleCreateStringArgumentCount")}
            value={worker.singleCreateStringArgumentCount}
            min={0}
            step="1"
            integer
            onChange={(value) => {
              if (value !== null) onUpdate({ singleCreateStringArgumentCount: value });
            }}
          />
        </Field>
        <Field label="Number args">
          <EditableNumber
            storageKey={editableStorageKey(worker.id, "singleCreateNumberArgumentCount")}
            value={worker.singleCreateNumberArgumentCount}
            min={0}
            step="1"
            integer
            onChange={(value) => {
              if (value !== null) onUpdate({ singleCreateNumberArgumentCount: value });
            }}
          />
        </Field>
        {behaviorUsesPool(worker.behavior) ? (
          <Field label="Pool size">
            <EditableNumber
              storageKey={editableStorageKey(worker.id, "entityPoolSize")}
              value={worker.entityPoolSize}
              min={1}
              step="1"
              integer
              onChange={(value) => {
                if (value !== null) onUpdate({ entityPoolSize: value });
              }}
            />
          </Field>
        ) : null}
        {worker.behavior === "time-bomb" ? (
          <Field label="Bomb offset s">
            <EditableNumber
              storageKey={editableStorageKey(worker.id, "timeBombOffsetSeconds")}
              value={worker.timeBombOffsetSeconds}
              min={1}
              step="1"
              integer
              onChange={(value) => {
                if (value !== null) onUpdate({ timeBombOffsetSeconds: value });
              }}
            />
          </Field>
        ) : null}
        <Field label="Start block">
          <EditableNumber
            storageKey={editableStorageKey(worker.id, "startBlock")}
            value={worker.startBlock}
            min={0}
            step="1"
            integer
            onChange={(value) => {
              if (value !== null) onUpdate({ startBlock: value });
            }}
          />
        </Field>
        <Field label="End block">
          <EditableNumber
            storageKey={editableStorageKey(worker.id, "endBlock")}
            value={worker.endBlock}
            min={0}
            step="1"
            integer
            placeholder="Infinity"
            onChange={(value) => onUpdate({ endBlock: value })}
          />
        </Field>
        <Field label="Duration s">
          <EditableNumber
            storageKey={editableStorageKey(worker.id, "durationSeconds")}
            value={worker.durationSeconds}
            min={1}
            step="1"
            integer
            onChange={(value) => onUpdate({ durationSeconds: value })}
          />
        </Field>
        {worker.behavior === "time-bomb" ? (
          <Field label="TTL s">
            <span className="wfield-static" title="TTL targets the detonation moment automatically">
              auto
            </span>
          </Field>
        ) : (
          <Field label="TTL s">
            <EditableNumber
              storageKey={editableStorageKey(worker.id, "ttlSeconds")}
              value={worker.ttlSeconds}
              min={1}
              step="1"
              integer
              onChange={(value) => {
                if (value !== null) onUpdate({ ttlSeconds: value });
              }}
            />
          </Field>
        )}
      </div>
    </article>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="wfield">
      <span>{label}</span>
      {children}
    </label>
  );
}

function StatusChip({ status }: { status: BaseloadTaskStatus | undefined }) {
  const name = status?.status ?? "starting";
  const title =
    status && status.status !== "error"
      ? [status.message, status.entityKey ? `entity ${status.entityKey}` : null]
          .filter((part) => part)
          .join(" — ") || undefined
      : undefined;
  return (
    <span className="status-chip" data-status={name} title={title}>
      <span className="status-dot" aria-hidden="true" />
      {name}
    </span>
  );
}

function WorkerMetrics({ status }: { status: BaseloadTaskStatus | undefined }) {
  if (!status) return null;
  const items: { label: string; value: string }[] = [];
  if (status.createdCount) items.push({ label: "created", value: String(status.createdCount) });
  if (status.updatedCount) items.push({ label: "updated", value: String(status.updatedCount) });
  if (status.deletedCount) items.push({ label: "deleted", value: String(status.deletedCount) });
  if (status.ownershipChangedCount) {
    items.push({ label: "owned", value: String(status.ownershipChangedCount) });
  }
  if (status.attemptedCount !== undefined) {
    items.push({ label: "tries", value: String(status.attemptedCount) });
  }
  if (status.poolSize) items.push({ label: "pool", value: String(status.poolSize) });
  if (status.currentBlock !== undefined) {
    items.push({ label: "block", value: String(status.currentBlock) });
  }
  if (status.txHash) items.push({ label: "tx", value: shortHash(status.txHash) });
  if (items.length === 0) return null;
  return (
    <dl className="worker-card-metrics">
      {items.map((item) => (
        <div key={item.label} className="metric" title={item.label === "tx" ? status.txHash : undefined}>
          <dt>{item.label}</dt>
          <dd>{item.value}</dd>
        </div>
      ))}
    </dl>
  );
}

const ERROR_SUMMARY_MAX_LENGTH = 160;
const CELL_ERROR_SUMMARY_MAX_LENGTH = 80;

// Worker errors carry full describeError output (stack, cause chain, RPC
// bodies). Render only the first line by default so a failing fleet doesn't
// turn the panel into a wall of stack traces; the full text stays one click
// away.
function ErrorDetail({
  message,
  className,
  maxLength = ERROR_SUMMARY_MAX_LENGTH,
}: {
  message: string;
  className?: string;
  maxLength?: number;
}) {
  const firstLine = message.split("\n", 1)[0] ?? message;
  const summary = firstLine.length > maxLength ? `${firstLine.slice(0, maxLength)}…` : firstLine;
  if (summary === message) {
    return <span className={className ?? "error-detail"}>{message}</span>;
  }
  return (
    <details className="error-detail-expander">
      <summary className={className ?? "error-detail"}>{summary}</summary>
      <pre className="error-detail-full">{message}</pre>
    </details>
  );
}

function BalanceCell({ balance, tokenSymbol }: { balance: BaseloadWorkerBalance | undefined; tokenSymbol: string }) {
  if (!balance) return <span title="No balance reported yet">—</span>;
  const label = `${fmtEth(balance.balanceWei)} ${tokenSymbol}`;
  if (balance.error) {
    return (
      <span className="balance-error" title={`${balance.balanceWei} wei (last updated ${balance.updatedAt})`}>
        <span>{label}</span>
        <ErrorDetail
          className="cell-error-message"
          message={`RPC error: ${balance.error}`}
          maxLength={CELL_ERROR_SUMMARY_MAX_LENGTH}
        />
      </span>
    );
  }
  return (
    <span title={`${balance.balanceWei} wei (updated ${balance.updatedAt})`}>{label}</span>
  );
}

function ErrorBanner({
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
    <div className="error-banner" role="alert">
      <h3>Errors</h3>
      <ul>
        {formError ? (
          <li>
            <strong>Form:</strong> <ErrorDetail message={formError} />
          </li>
        ) : null}
        {backendError ? (
          <li>
            <strong>Backend:</strong> <ErrorDetail message={backendError} />
          </li>
        ) : null}
        {configManagerError ? (
          <li>
            <strong>Saved configs:</strong> <ErrorDetail message={configManagerError} />
          </li>
        ) : null}
        {workerErrors.map((entry, index) => (
          <li key={`${entry.workerId}-${entry.source}-${index}`}>
            <strong>Wallet {entry.walletNumber}</strong> ({entry.source}
            {entry.updatedAt ? ` @ ${entry.updatedAt}` : ""}):{" "}
            <ErrorDetail message={entry.message} />
          </li>
        ))}
      </ul>
    </div>
  );
}

function shortHash(value: string): string {
  return value.length <= 12 ? value : `${value.slice(0, 6)}...${value.slice(-4)}`;
}

function editableStorageKey(workerId: string, field: keyof BaseloadWorkerConfig): string {
  return `baseload.workerEdit.${workerId}.${field}`;
}

function clearEditableStorage(workerId: string): void {
  for (const field of EDITABLE_WORKER_KEYS) {
    removeStoredValue(editableStorageKey(workerId, field));
  }
}

function EditableNumber({
  storageKey,
  value,
  min,
  max,
  step,
  integer = false,
  placeholder,
  onChange,
}: {
  storageKey: string;
  value: number | null;
  min: number;
  max?: number;
  step: string;
  integer?: boolean;
  placeholder?: string;
  onChange: (value: number | null) => void;
}) {
  const [text, setText] = useState(() => readStoredString(storageKey, value === null ? "" : String(value)));

  useEffect(() => {
    setText(readStoredString(storageKey, value === null ? "" : String(value)));
  }, [storageKey, value]);

  const commit = () => {
    if (text.trim() === "") {
      removeStoredValue(storageKey);
      onChange(null);
      return;
    }
    const next = Number(text);
    if (
      !Number.isFinite(next) ||
      next < min ||
      (max !== undefined && next > max) ||
      (integer && !Number.isInteger(next))
    ) {
      removeStoredValue(storageKey);
      setText(value === null ? "" : String(value));
      return;
    }
    removeStoredValue(storageKey);
    onChange(next);
  };

  const updateText = (value: string) => {
    setText(value);
    writeStoredString(storageKey, value);
  };

  return (
    <input
      className="table-input"
      type="number"
      min={min}
      max={max}
      step={step}
      placeholder={placeholder}
      value={text}
      onChange={(event) => updateText(event.target.value)}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.key === "Enter") {
          event.currentTarget.blur();
        }
      }}
    />
  );
}

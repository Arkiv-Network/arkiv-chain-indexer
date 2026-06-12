import { useEffect, useMemo, useState } from "react";
import {
  BASELOAD_BEHAVIOR_LABELS,
  BASELOAD_WORKER_BEHAVIORS,
  behaviorUsesPool,
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

      <form className="baseload-form" onSubmit={addWorker} noValidate>
        <label>
          Behavior
          <select value={draftBehavior} onChange={onDraftChange("behavior")}>
            {BASELOAD_WORKER_BEHAVIORS.map((behavior) => (
              <option key={behavior} value={behavior}>
                {BASELOAD_BEHAVIOR_LABELS[behavior]}
              </option>
            ))}
          </select>
        </label>
        <label>
          Max gas price accepted gwei
          <input
            type="number"
            min="0"
            step="0.1"
            value={draft.maxGasPriceGwei}
            onChange={onDraftChange("maxGasPriceGwei")}
          />
        </label>
        <label>
          Operations per minute
          <input
            type="number"
            min="0"
            step="1"
            value={draft.opsPerMinute}
            onChange={onDraftChange("opsPerMinute")}
          />
        </label>
        <label>
          Single create payload size
          <input
            type="number"
            min="0"
            step="1"
            value={draft.singleCreatePayloadSize}
            onChange={onDraftChange("singleCreatePayloadSize")}
          />
        </label>
        <label>
          String argument number
          <input
            type="number"
            min="0"
            step="1"
            value={draft.singleCreateStringArgumentCount}
            onChange={onDraftChange("singleCreateStringArgumentCount")}
          />
        </label>
        <label>
          Number argument number
          <input
            type="number"
            min="0"
            step="1"
            value={draft.singleCreateNumberArgumentCount}
            onChange={onDraftChange("singleCreateNumberArgumentCount")}
          />
        </label>
        {behaviorUsesPool(draftBehavior) ? (
          <label>
            Entity pool size
            <input
              type="number"
              min="1"
              step="1"
              value={draft.entityPoolSize}
              onChange={onDraftChange("entityPoolSize")}
            />
          </label>
        ) : null}
        {draftBehavior === "time-bomb" ? (
          <label>
            Time bomb offset seconds
            <input
              type="number"
              min="1"
              step="1"
              value={draft.timeBombOffsetSeconds}
              onChange={onDraftChange("timeBombOffsetSeconds")}
            />
          </label>
        ) : null}
        <label>
          Wallet number
          <select
            value={draft.walletNumber}
            onChange={onDraftChange("walletNumber")}
            disabled={availableWallets.length === 0}
          >
            {availableWallets.map((wallet) => (
              <option key={wallet} value={wallet}>
                {wallet}
              </option>
            ))}
          </select>
        </label>
        <label>
          Start block
          <input type="number" min="0" step="1" value={draft.startBlock} onChange={onDraftChange("startBlock")} />
        </label>
        <label>
          End block
          <input type="number" min="0" step="1" value={draft.endBlock} onChange={onDraftChange("endBlock")} />
        </label>
        <label>
          Duration seconds
          <input
            type="number"
            min="1"
            step="1"
            value={draft.durationSeconds}
            onChange={onDraftChange("durationSeconds")}
          />
        </label>
        {draftBehavior !== "time-bomb" ? (
          <label>
            Entry TTL seconds
            <input
              type="number"
              min="1"
              step="1"
              value={draft.ttlSeconds}
              onChange={onDraftChange("ttlSeconds")}
            />
          </label>
        ) : null}
        <button type="submit" disabled={availableWallets.length === 0}>
          Add worker
        </button>
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

      <div className="table-wrap">
        <table className="data-table baseload-table">
          <thead>
            <tr>
              <th scope="col">Wallet</th>
              <th scope="col">Address</th>
              <th scope="col">Balance</th>
              <th scope="col">Behavior</th>
              <th scope="col">Max gas gwei</th>
              <th scope="col">Ops/min</th>
              <th scope="col">Payload size</th>
              <th scope="col">String args</th>
              <th scope="col">Number args</th>
              <th scope="col">Pool size</th>
              <th scope="col">Bomb offset sec</th>
              <th scope="col">Start block</th>
              <th scope="col">End block</th>
              <th scope="col">Duration sec</th>
              <th scope="col">TTL sec</th>
              <th scope="col">Task</th>
              <th scope="col">Actions</th>
            </tr>
          </thead>
          <tbody>
            {config.workers.length === 0 ? (
              <tr>
                <td colSpan={17}>No baseload workers configured.</td>
              </tr>
            ) : (
              config.workers.map((worker) => (
                <tr key={worker.id}>
                  <td className="num">{worker.walletNumber}</td>
                  <td className="wallet-address">{worker.walletAddress}</td>
                  <td className="num">
                    <BalanceCell balance={balances[worker.id]} tokenSymbol={tokenSymbol} />
                  </td>
                  <td>
                    <select
                      className="table-input"
                      value={worker.behavior}
                      onChange={(event) =>
                        updateWorker(worker, {
                          behavior: event.target.value as BaseloadWorkerBehavior,
                        })
                      }
                    >
                      {BASELOAD_WORKER_BEHAVIORS.map((behavior) => (
                        <option key={behavior} value={behavior}>
                          {BASELOAD_BEHAVIOR_LABELS[behavior]}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td>
                    <EditableNumber
                      storageKey={editableStorageKey(worker.id, "maxGasPriceGwei")}
                      value={worker.maxGasPriceGwei}
                      min={0}
                      step="0.1"
                      onChange={(value) => {
                        if (value !== null) updateWorker(worker, { maxGasPriceGwei: value });
                      }}
                    />
                  </td>
                  <td>
                    <EditableNumber
                      storageKey={editableStorageKey(worker.id, "opsPerMinute")}
                      value={worker.opsPerMinute}
                      min={0}
                      step="1"
                      onChange={(value) => {
                        if (value !== null) updateWorker(worker, { opsPerMinute: value });
                      }}
                    />
                  </td>
                  <td>
                    <EditableNumber
                      storageKey={editableStorageKey(worker.id, "singleCreatePayloadSize")}
                      value={worker.singleCreatePayloadSize}
                      min={0}
                      step="1"
                      integer
                      onChange={(value) => {
                        if (value !== null) updateWorker(worker, { singleCreatePayloadSize: value });
                      }}
                    />
                  </td>
                  <td>
                    <EditableNumber
                      storageKey={editableStorageKey(worker.id, "singleCreateStringArgumentCount")}
                      value={worker.singleCreateStringArgumentCount}
                      min={0}
                      step="1"
                      integer
                      onChange={(value) => {
                        if (value !== null) updateWorker(worker, { singleCreateStringArgumentCount: value });
                      }}
                    />
                  </td>
                  <td>
                    <EditableNumber
                      storageKey={editableStorageKey(worker.id, "singleCreateNumberArgumentCount")}
                      value={worker.singleCreateNumberArgumentCount}
                      min={0}
                      step="1"
                      integer
                      onChange={(value) => {
                        if (value !== null) updateWorker(worker, { singleCreateNumberArgumentCount: value });
                      }}
                    />
                  </td>
                  <td>
                    {behaviorUsesPool(worker.behavior) ? (
                      <EditableNumber
                        storageKey={editableStorageKey(worker.id, "entityPoolSize")}
                        value={worker.entityPoolSize}
                        min={1}
                        step="1"
                        integer
                        onChange={(value) => {
                          if (value !== null) updateWorker(worker, { entityPoolSize: value });
                        }}
                      />
                    ) : (
                      <span title="Only used by behaviors with an entity pool">—</span>
                    )}
                  </td>
                  <td>
                    {worker.behavior === "time-bomb" ? (
                      <EditableNumber
                        storageKey={editableStorageKey(worker.id, "timeBombOffsetSeconds")}
                        value={worker.timeBombOffsetSeconds}
                        min={1}
                        step="1"
                        integer
                        onChange={(value) => {
                          if (value !== null) updateWorker(worker, { timeBombOffsetSeconds: value });
                        }}
                      />
                    ) : (
                      <span title="Only used by the time bomb behavior">—</span>
                    )}
                  </td>
                  <td>
                    <EditableNumber
                      storageKey={editableStorageKey(worker.id, "startBlock")}
                      value={worker.startBlock}
                      min={0}
                      step="1"
                      integer
                      onChange={(value) => {
                        if (value !== null) updateWorker(worker, { startBlock: value });
                      }}
                    />
                  </td>
                  <td>
                    <EditableNumber
                      storageKey={editableStorageKey(worker.id, "endBlock")}
                      value={worker.endBlock}
                      min={0}
                      step="1"
                      integer
                      placeholder="Infinity"
                      onChange={(value) => updateWorker(worker, { endBlock: value })}
                    />
                  </td>
                  <td>
                    <EditableNumber
                      storageKey={editableStorageKey(worker.id, "durationSeconds")}
                      value={worker.durationSeconds}
                      min={1}
                      step="1"
                      integer
                      onChange={(value) => updateWorker(worker, { durationSeconds: value })}
                    />
                  </td>
                  <td>
                    {worker.behavior === "time-bomb" ? (
                      <span title="TTL targets the detonation moment automatically">auto</span>
                    ) : (
                      <EditableNumber
                        storageKey={editableStorageKey(worker.id, "ttlSeconds")}
                        value={worker.ttlSeconds}
                        min={1}
                        step="1"
                        integer
                        onChange={(value) => {
                          if (value !== null) updateWorker(worker, { ttlSeconds: value });
                        }}
                      />
                    )}
                  </td>
                  <td>
                    <TaskStatusCell status={taskStatuses[worker.id]} />
                  </td>
                  <td>
                    <button type="button" className="secondary" onClick={() => deleteWorker(worker.id)}>
                      Delete
                    </button>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </section>
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

function TaskStatusCell({ status }: { status: BaseloadTaskStatus | undefined }) {
  if (!status) return <span>starting</span>;
  const ops: string[] = [];
  if (status.createdCount) ops.push(`${status.createdCount} created`);
  if (status.updatedCount) ops.push(`${status.updatedCount} updated`);
  if (status.deletedCount) ops.push(`${status.deletedCount} deleted`);
  if (status.ownershipChangedCount) ops.push(`${status.ownershipChangedCount} owned`);
  const count =
    status.attemptedCount === undefined
      ? ""
      : ` ${ops.join(", ") || "0 done"} / ${status.attemptedCount} tries`;
  const poolSize = status.poolSize ? ` pool ${status.poolSize}` : "";
  const block = status.currentBlock === undefined ? "" : ` block ${status.currentBlock}`;
  const tx = status.txHash ? ` tx ${shortHash(status.txHash)}` : "";
  const label = `${status.status}${count}${poolSize}${block}${tx}`;
  const isError = status.status === "error";
  const title = [
    status.message ?? status.txHash ?? status.entityKey,
    status.detonationAt ? `Detonation at ${status.detonationAt}` : null,
  ]
    .filter((part) => part)
    .join(" — ");

  return (
    <span className={isError ? "task-status-error" : undefined} title={title || undefined}>
      <span>{label}</span>
      {status.detonationAt ? (
        <span className="cell-detail">boom @ {status.detonationAt}</span>
      ) : null}
      {isError && status.message ? (
        <ErrorDetail
          className="cell-error-message"
          message={status.message}
          maxLength={CELL_ERROR_SUMMARY_MAX_LENGTH}
        />
      ) : null}
    </span>
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
  step,
  integer = false,
  placeholder,
  onChange,
}: {
  storageKey: string;
  value: number | null;
  min: number;
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
    if (!Number.isFinite(next) || next < min || (integer && !Number.isInteger(next))) {
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

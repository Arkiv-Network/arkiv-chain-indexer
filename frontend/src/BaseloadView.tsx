import { useEffect, useMemo, useState } from "react";
import {
  BASELOAD_BEHAVIOR_LABELS,
  BASELOAD_WORKER_BEHAVIORS,
  behaviorUsesPool,
  createBaseloadWorkerDraft,
  createBaseloadWorkerDraftFromWorker,
  createBaseloadWorkerFromDraft,
  describeBaseloadWorkerName,
  getAvailableWalletNumbers,
  isSameBaseloadWorkerDraft,
  MAX_BASELOAD_ENTITIES_PER_REQUEST,
  MAX_WORKER_NAME_LENGTH,
  moveDraftToNextAvailableWallet,
  normalizeBaseloadConfig,
  parseBaseloadConfigJson,
  parseBaseloadWorkerJson,
  removeBaseloadWorker,
  serializeBaseloadConfig,
  serializeBaseloadWorker,
  updateBaseloadWorker,
  type BaseloadConfig,
  type BaseloadWorkerBehavior,
  type BaseloadWorkerConfig,
  type BaseloadWorkerDraft,
} from "./baseloadConfig";
import {
  describeBaseloadSchedule,
  normalizeDailyWindow,
  normalizeHourlyWindow,
} from "./baseloadSchedule";
import {
  type BaseloadTaskStatus,
  type BaseloadWorkerBalance,
  type StoredBaseloadConfigSummary,
} from "./api";
import { fmtBytes, fmtEth } from "./format";
import { formatCountShort, projectBaseloadMinutes, projectBaseloadTraffic } from "./baseloadProjection";
import { readStoredStringRecord, writeStoredStringRecord } from "./localStorage";

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
  "name",
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
  "dailyWindow",
  "hourlyWindow",
] as const;

/** Which operator the editor shows: a not-yet-added draft, or an existing worker. */
type EditorSelection = { kind: "new" } | { kind: "worker"; id: string };

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
  const [selection, setSelection] = useState<EditorSelection>({ kind: "new" });
  const [newDraft, setNewDraft] = useState<BaseloadWorkerDraft>(() =>
    readStoredStringRecord(
      DRAFT_STORAGE_KEY,
      createBaseloadWorkerDraft(availableWallets[0] ?? 0),
      DRAFT_KEYS,
    ),
  );
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState("");
  const [configName, setConfigName] = useState("");
  const [selectedConfigName, setSelectedConfigName] = useState("");
  const [managerError, setManagerError] = useState<string | null>(null);
  const [managerStatus, setManagerStatus] = useState("");
  const displayedConfigManagerError = managerError || configManagerError;

  const selectedWorker =
    selection.kind === "worker"
      ? config.workers.find((worker) => worker.id === selection.id) ?? null
      : null;

  useEffect(() => {
    if (selection.kind === "worker" && !selectedWorker) setSelection({ kind: "new" });
  }, [selection, selectedWorker]);

  useEffect(() => {
    if (availableWallets.length === 0) return;
    if (!availableWallets.includes(Number(newDraft.walletNumber))) {
      setNewDraft((current) => ({ ...current, walletNumber: String(availableWallets[0]) }));
    }
  }, [availableWallets, newDraft.walletNumber]);

  useEffect(() => {
    writeStoredStringRecord(DRAFT_STORAGE_KEY, newDraft, DRAFT_KEYS);
  }, [newDraft]);

  useEffect(() => {
    if (savedConfigs.length === 0) {
      setSelectedConfigName("");
      return;
    }
    if (!savedConfigs.some((saved) => saved.name === selectedConfigName)) {
      setSelectedConfigName(savedConfigs[0]?.name ?? "");
    }
  }, [savedConfigs, selectedConfigName]);

  const report = (fn: () => void | Promise<void>, doneNotice = "") => {
    void (async () => {
      try {
        await fn();
        setError(null);
        setNotice(doneNotice);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
        setNotice("");
      }
    })();
  };

  const addWorker = (draft: BaseloadWorkerDraft) =>
    report(async () => {
      const worker = createBaseloadWorkerFromDraft(draft);
      if (config.workers.some((existing) => existing.walletNumber === worker.walletNumber)) {
        throw new Error(`Wallet ${worker.walletNumber} is already attached to another worker`);
      }
      const nextConfig = normalizeBaseloadConfig({
        ...config,
        workers: [...config.workers, worker],
      });
      await onConfigChange(nextConfig);
      setNewDraft((current) => moveDraftToNextAvailableWallet(current, nextConfig.workers));
      setSelection({ kind: "worker", id: worker.id });
    }, `Added ${describeBaseloadWorkerName(createBaseloadWorkerFromDraft(draft))}`);

  const applyWorker = (worker: BaseloadWorkerConfig, draft: BaseloadWorkerDraft) =>
    report(async () => {
      const parsed = createBaseloadWorkerFromDraft(draft);
      await onConfigChange(
        updateBaseloadWorker(config, worker.id, { ...parsed, id: worker.id, walletAddress: worker.walletAddress }),
      );
    }, `Applied changes to ${describeBaseloadWorkerName(worker)}`);

  const deleteWorker = (worker: BaseloadWorkerConfig) =>
    report(async () => {
      await onConfigChange(removeBaseloadWorker(config, worker.id));
      setSelection({ kind: "new" });
    }, `Deleted ${describeBaseloadWorkerName(worker)}`);

  const downloadJson = (text: string, filename: string) => {
    const blob = new Blob([text], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    link.click();
    URL.revokeObjectURL(url);
  };

  const downloadConfig = () =>
    report(() => {
      downloadJson(serializeBaseloadConfig(config), "baseload-workers.json");
    }, "Downloaded fleet config");

  const exportWorker = (draft: BaseloadWorkerDraft) =>
    report(() => {
      const worker = createBaseloadWorkerFromDraft(draft);
      downloadJson(serializeBaseloadWorker(worker), `baseload-${workerFileStem(worker)}.json`);
    }, "Exported worker");

  const importWorkerFile = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    const text = await file.text();
    report(() => {
      const worker = parseBaseloadWorkerJson(text);
      const draft = createBaseloadWorkerDraftFromWorker(worker);
      const walletTaken = config.workers.some((existing) => existing.walletNumber === worker.walletNumber);
      setNewDraft(walletTaken ? moveDraftToNextAvailableWallet(draft, config.workers) : draft);
      setSelection({ kind: "new" });
    }, `Imported ${file.name} into the editor; review and add it`);
  };

  const loadConfigFile = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    const text = await file.text();
    report(async () => {
      const nextConfig = parseBaseloadConfigJson(text);
      await onConfigChange(nextConfig);
      setNewDraft(createBaseloadWorkerDraft(getAvailableWalletNumbers(nextConfig.workers)[0] ?? 0));
      setSelection({ kind: "new" });
    }, `Loaded ${file.name}`);
  };

  const runConfigManagerAction = async (action: () => Promise<void>, status: string) => {
    try {
      await action();
      setManagerError(null);
      setManagerStatus(status);
      setError(null);
      setNotice("");
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

      <p className={`summary${error || backendError || displayedConfigManagerError ? " error" : ""}`}>
        {error ||
          backendError ||
          displayedConfigManagerError ||
          managerStatus ||
          notice ||
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

      <TrafficProjection workers={config.workers} />

      <div className="baseload-workbench">
        <aside className="worker-list" aria-label="Workers">
          <div className="worker-list-actions">
            <button
              type="button"
              className="worker-list-new"
              data-selected={selection.kind === "new" ? "true" : undefined}
              onClick={() => setSelection({ kind: "new" })}
            >
              ✚ New worker
            </button>
            <label className="secondary file-button" title="Load one exported worker into the editor">
              Import worker
              <input type="file" accept="application/json,.json" onChange={importWorkerFile} />
            </label>
          </div>
          {config.workers.length === 0 ? (
            <div className="worker-list-empty">No workers yet. Fill in the editor and add one.</div>
          ) : (
            <ul className="worker-list-items">
              {config.workers.map((worker) => (
                <WorkerRow
                  key={worker.id}
                  worker={worker}
                  status={taskStatuses[worker.id]}
                  balance={balances[worker.id]}
                  tokenSymbol={tokenSymbol}
                  selected={selection.kind === "worker" && selection.id === worker.id}
                  onSelect={() => setSelection({ kind: "worker", id: worker.id })}
                />
              ))}
            </ul>
          )}
        </aside>

        {selectedWorker ? (
          <WorkerEditor
            key={selectedWorker.id}
            worker={selectedWorker}
            status={taskStatuses[selectedWorker.id]}
            balance={balances[selectedWorker.id]}
            tokenSymbol={tokenSymbol}
            availableWallets={availableWallets}
            onApply={(draft) => applyWorker(selectedWorker, draft)}
            onDelete={() => deleteWorker(selectedWorker)}
            onExport={exportWorker}
          />
        ) : (
          <WorkerEditor
            key="new"
            worker={null}
            draft={newDraft}
            onDraftChange={setNewDraft}
            availableWallets={availableWallets}
            onAdd={addWorker}
            onExport={exportWorker}
            onReset={() =>
              setNewDraft(createBaseloadWorkerDraft(availableWallets[0] ?? 0))
            }
            tokenSymbol={tokenSymbol}
          />
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

function workerFileStem(worker: BaseloadWorkerConfig): string {
  const slug = worker.name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug ? `${slug}-wallet-${worker.walletNumber}` : `wallet-${worker.walletNumber}`;
}

function isOutsideSchedule(status: BaseloadTaskStatus | undefined): boolean {
  return status?.status === "waiting" && (status.message?.startsWith("Outside schedule") ?? false);
}

function WorkerRow({
  worker,
  status,
  balance,
  tokenSymbol,
  selected,
  onSelect,
}: {
  worker: BaseloadWorkerConfig;
  status: BaseloadTaskStatus | undefined;
  balance: BaseloadWorkerBalance | undefined;
  tokenSymbol: string;
  selected: boolean;
  onSelect: () => void;
}) {
  const schedule = describeBaseloadSchedule(worker);
  return (
    <li>
      <button
        type="button"
        className="worker-row"
        data-behavior={worker.behavior}
        data-selected={selected ? "true" : undefined}
        onClick={onSelect}
      >
        <span className="worker-row-title">
          <strong className="worker-row-name">{describeBaseloadWorkerName(worker)}</strong>
          {worker.name ? <span className="worker-row-wallet">#{worker.walletNumber}</span> : null}
        </span>
        <span className="worker-row-meta">
          <span className="behavior-badge" title={BASELOAD_BEHAVIOR_LABELS[worker.behavior]}>
            {BEHAVIOR_BADGES[worker.behavior]}
          </span>
          <StatusChip status={status} />
          {schedule ? (
            <span
              className="worker-row-schedule"
              data-active={isOutsideSchedule(status) ? "false" : "true"}
              title={schedule}
            >
              ⏱
            </span>
          ) : null}
        </span>
        <span className="worker-row-foot">
          <span className="worker-row-rate">
            {worker.opsPerMinute} ops/min × {worker.entitiesPerRequest}
          </span>
          <span className="worker-card-balance">
            <BalanceCell balance={balance} tokenSymbol={tokenSymbol} />
          </span>
        </span>
      </button>
    </li>
  );
}

type WorkerEditorProps =
  | {
      worker: BaseloadWorkerConfig;
      status: BaseloadTaskStatus | undefined;
      balance: BaseloadWorkerBalance | undefined;
      tokenSymbol: string;
      availableWallets: number[];
      onApply: (draft: BaseloadWorkerDraft) => void;
      onDelete: () => void;
      onExport: (draft: BaseloadWorkerDraft) => void;
    }
  | {
      worker: null;
      draft: BaseloadWorkerDraft;
      onDraftChange: (draft: BaseloadWorkerDraft) => void;
      availableWallets: number[];
      onAdd: (draft: BaseloadWorkerDraft) => void;
      onExport: (draft: BaseloadWorkerDraft) => void;
      onReset: () => void;
      tokenSymbol: string;
    };

function WorkerEditor(props: WorkerEditorProps) {
  const { availableWallets } = props;
  // Existing workers edit a local copy and commit with "Apply", so a run is not
  // restarted on every keystroke; the new-worker draft lives in the parent so
  // it survives navigation.
  const [localDraft, setLocalDraft] = useState<BaseloadWorkerDraft>(() =>
    props.worker ? createBaseloadWorkerDraftFromWorker(props.worker) : props.draft,
  );
  const [base, setBase] = useState<BaseloadWorkerDraft | null>(() =>
    props.worker ? createBaseloadWorkerDraftFromWorker(props.worker) : null,
  );

  const worker = props.worker;
  useEffect(() => {
    if (!worker) return;
    const fresh = createBaseloadWorkerDraftFromWorker(worker);
    // Follow external config changes unless the user is mid-edit.
    setLocalDraft((current) => (base && isSameBaseloadWorkerDraft(current, base) ? fresh : current));
    setBase(fresh);
  }, [worker]); // eslint-disable-line react-hooks/exhaustive-deps

  const draft = props.worker ? localDraft : props.draft;
  const setDraft = (next: BaseloadWorkerDraft) => {
    if (props.worker) setLocalDraft(next);
    else props.onDraftChange(next);
  };
  const dirty = props.worker !== null && base !== null && !isSameBaseloadWorkerDraft(draft, base);

  const behavior: BaseloadWorkerBehavior = (
    BASELOAD_WORKER_BEHAVIORS as readonly string[]
  ).includes(draft.behavior)
    ? (draft.behavior as BaseloadWorkerBehavior)
    : "create";

  const onChange = (key: keyof BaseloadWorkerDraft) => (
    event: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>,
  ) => {
    setDraft({ ...draft, [key]: event.target.value });
  };

  const schedulePreview = useMemo(() => describeScheduleDraft(draft), [draft.dailyWindow, draft.hourlyWindow]); // eslint-disable-line react-hooks/exhaustive-deps

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    if (props.worker) props.onApply(draft);
    else props.onAdd(draft);
  };

  const walletOptions = props.worker
    ? [props.worker.walletNumber]
    : availableWallets;
  const title = props.worker ? describeBaseloadWorkerName(props.worker) : "New worker";

  return (
    <form className="worker-editor" data-behavior={behavior} onSubmit={submit} noValidate>
      <header className="worker-editor-head">
        <div>
          <h3>{title}</h3>
          <span className="add-worker-hint">{BASELOAD_BEHAVIOR_LABELS[behavior]}</span>
        </div>
        {props.worker ? (
          <div className="worker-editor-live">
            <StatusChip status={props.status} />
            <span className="worker-card-balance">
              <BalanceCell balance={props.balance} tokenSymbol={props.tokenSymbol} />
            </span>
          </div>
        ) : null}
      </header>

      {props.worker ? (
        <>
          <div className="worker-card-address" title={props.worker.walletAddress}>
            {props.worker.walletAddress || "address pending"}
          </div>
          <WorkerMetrics status={props.status} />
          {props.status?.detonationAt ? (
            <div className="worker-card-detonation">✸ detonation @ {props.status.detonationAt}</div>
          ) : null}
          {props.status?.status === "error" && props.status.message ? (
            <ErrorDetail
              className="cell-error-message"
              message={props.status.message}
              maxLength={CELL_ERROR_SUMMARY_MAX_LENGTH}
            />
          ) : null}
        </>
      ) : null}

      <fieldset className="editor-section">
        <legend>Identity</legend>
        <div className="add-worker-fields">
          <Field label="Name" wide>
            <input
              type="text"
              maxLength={MAX_WORKER_NAME_LENGTH}
              placeholder={`wallet #${draft.walletNumber}`}
              value={draft.name}
              onChange={onChange("name")}
            />
          </Field>
          <Field label="Wallet">
            <select
              value={draft.walletNumber}
              onChange={onChange("walletNumber")}
              disabled={props.worker !== null || walletOptions.length === 0}
              title={props.worker ? "The wallet is fixed once a worker exists; export and re-import to move it" : undefined}
            >
              {walletOptions.map((wallet) => (
                <option key={wallet} value={wallet}>
                  #{wallet}
                </option>
              ))}
            </select>
          </Field>
        </div>
        <div className="behavior-picker" role="radiogroup" aria-label="Worker behavior">
          {BASELOAD_WORKER_BEHAVIORS.map((option) => (
            <label
              key={option}
              className="behavior-option"
              data-behavior={option}
              title={BASELOAD_BEHAVIOR_LABELS[option]}
            >
              <input
                type="radio"
                name="editor-behavior"
                value={option}
                checked={behavior === option}
                onChange={onChange("behavior")}
              />
              <span>{BEHAVIOR_BADGES[option]}</span>
            </label>
          ))}
        </div>
      </fieldset>

      <fieldset className="editor-section">
        <legend>Load</legend>
        <div className="add-worker-fields">
          <Field label="Ops / min">
            <input type="number" min="0" step="1" value={draft.opsPerMinute} onChange={onChange("opsPerMinute")} />
          </Field>
          <Field label="Entities / req">
            <input
              type="number"
              min="1"
              max={MAX_BASELOAD_ENTITIES_PER_REQUEST}
              step="1"
              value={draft.entitiesPerRequest}
              onChange={onChange("entitiesPerRequest")}
            />
          </Field>
          <Field label="Max gas gwei">
            <input type="number" min="0" step="0.1" value={draft.maxGasPriceGwei} onChange={onChange("maxGasPriceGwei")} />
          </Field>
          {behaviorUsesPool(behavior) ? (
            <Field label="Pool size">
              <input type="number" min="1" step="1" value={draft.entityPoolSize} onChange={onChange("entityPoolSize")} />
            </Field>
          ) : null}
          {behavior === "time-bomb" ? (
            <Field label="Bomb offset s">
              <input
                type="number"
                min="1"
                step="1"
                value={draft.timeBombOffsetSeconds}
                onChange={onChange("timeBombOffsetSeconds")}
              />
            </Field>
          ) : null}
        </div>
      </fieldset>

      <fieldset className="editor-section">
        <legend>Entity</legend>
        <div className="add-worker-fields">
          <Field label="Payload bytes">
            <input
              type="number"
              min="0"
              step="1"
              value={draft.singleCreatePayloadSize}
              onChange={onChange("singleCreatePayloadSize")}
            />
          </Field>
          <Field label="String args">
            <input
              type="number"
              min="0"
              step="1"
              value={draft.singleCreateStringArgumentCount}
              onChange={onChange("singleCreateStringArgumentCount")}
            />
          </Field>
          <Field label="Number args">
            <input
              type="number"
              min="0"
              step="1"
              value={draft.singleCreateNumberArgumentCount}
              onChange={onChange("singleCreateNumberArgumentCount")}
            />
          </Field>
          {behavior === "time-bomb" ? (
            <Field label="TTL s">
              <span className="wfield-static" title="TTL targets the detonation moment automatically">
                auto
              </span>
            </Field>
          ) : (
            <Field label="TTL s">
              <input type="number" min="1" step="1" value={draft.ttlSeconds} onChange={onChange("ttlSeconds")} />
            </Field>
          )}
        </div>
      </fieldset>

      <fieldset className="editor-section">
        <legend>Run window</legend>
        <div className="add-worker-fields">
          <Field label="Start block">
            <input type="number" min="0" step="1" value={draft.startBlock} onChange={onChange("startBlock")} />
          </Field>
          <Field label="End block">
            <input
              type="number"
              min="0"
              step="1"
              placeholder="Infinity"
              value={draft.endBlock}
              onChange={onChange("endBlock")}
            />
          </Field>
          <Field label="Duration s">
            <input
              type="number"
              min="1"
              step="1"
              placeholder="Forever"
              value={draft.durationSeconds}
              onChange={onChange("durationSeconds")}
            />
          </Field>
        </div>
      </fieldset>

      <fieldset className="editor-section">
        <legend>Schedule</legend>
        <div className="add-worker-fields">
          <Field label="Daily (UTC)">
            <input
              type="text"
              placeholder="always"
              title="Active hours of the day in UTC, end exclusive, e.g. 04:30-18:30 (may wrap midnight)"
              value={draft.dailyWindow}
              onChange={onChange("dailyWindow")}
            />
          </Field>
          <Field label="Hourly minutes">
            <input
              type="text"
              placeholder="always"
              title="Active minutes of every hour, end exclusive, e.g. 24-58; cross the hour with an end past 60, e.g. 50-70"
              value={draft.hourlyWindow}
              onChange={onChange("hourlyWindow")}
            />
          </Field>
        </div>
        <p className="schedule-preview" data-error={schedulePreview.error ? "true" : undefined}>
          {schedulePreview.error
            ? schedulePreview.error
            : schedulePreview.text
              ? `Active ${schedulePreview.text}; both windows must hold.`
              : "Always active; set a daily window like 04:30-18:30 or hourly minutes like 24-58."}
        </p>
      </fieldset>

      <div className="editor-actions">
        {props.worker ? (
          <>
            <button type="submit" className="add-worker-submit" disabled={!dirty}>
              Apply changes
            </button>
            <button
              type="button"
              className="secondary"
              disabled={!dirty}
              onClick={() => {
                if (base) setLocalDraft(base);
              }}
            >
              Revert
            </button>
            <button type="button" className="secondary" onClick={() => props.onExport(draft)}>
              Export worker
            </button>
            <button type="button" className="secondary danger" onClick={props.onDelete}>
              Delete worker
            </button>
            {dirty ? <span className="editor-dirty">unsaved changes</span> : null}
          </>
        ) : (
          <>
            <button type="submit" className="add-worker-submit" disabled={availableWallets.length === 0}>
              ✚ Add worker{availableWallets.length === 0 ? "" : ` #${draft.walletNumber}`}
            </button>
            <button type="button" className="secondary" onClick={() => props.onExport(draft)}>
              Export worker
            </button>
            <button type="button" className="secondary" onClick={props.onReset}>
              Reset form
            </button>
          </>
        )}
      </div>
    </form>
  );
}

function describeScheduleDraft(
  draft: Pick<BaseloadWorkerDraft, "dailyWindow" | "hourlyWindow">,
): { text: string | null; error: string | null } {
  try {
    return {
      text: describeBaseloadSchedule({
        dailyWindow: normalizeDailyWindow(draft.dailyWindow),
        hourlyWindow: normalizeHourlyWindow(draft.hourlyWindow),
      }),
      error: null,
    };
  } catch (err) {
    return { text: null, error: err instanceof Error ? err.message : String(err) };
  }
}

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

/**
 * Two small-multiple bar charts, one per measure, of the fleet's expected
 * traffic across a UTC day. Separate charts rather than one dual-axis chart
 * because transactions and bytes live on unrelated scales.
 */
function TrafficProjection({ workers }: { workers: readonly BaseloadWorkerConfig[] }) {
  const projection = useMemo(() => projectBaseloadTraffic(workers), [workers]);
  const [hovered, setHovered] = useState<number | null>(null);
  const [hoveredMinute, setHoveredMinute] = useState<number | null>(null);
  const currentHour = new Date().getUTCHours();
  const currentMinute = new Date().getUTCMinutes();
  const focus = hovered ?? currentHour;
  const minutes = useMemo(() => projectBaseloadMinutes(workers, focus), [workers, focus]);
  if (workers.length === 0) return null;
  const focused = projection.hours[focus]!;
  const minuteFocus = hoveredMinute ?? (focus === currentHour ? currentMinute : null);
  const focusedMinute = minuteFocus === null ? null : minutes[minuteFocus]!;
  const peakMinuteTx = Math.max(0, ...minutes.map((entry) => entry.txCount));
  const peakMinuteBytes = Math.max(0, ...minutes.map((entry) => entry.payloadBytes));
  const hourLabels = ["00", "06", "12", "18", "24"];
  const minuteLabels = ["00", "15", "30", "45", "60"];
  const busiest = projection.hours.reduce((best, entry) => (entry.txCount > best.txCount ? entry : best));
  const quietest = projection.hours.reduce((best, entry) => (entry.txCount < best.txCount ? entry : best));

  return (
    <section className="traffic-projection" aria-label="Projected baseload traffic">
      <header className="traffic-projection-head">
        <h3>Projected traffic per UTC hour</h3>
        <span className="traffic-projection-hint">
          from schedules and rates; block and duration limits ignored, calldata overhead excluded
        </span>
      </header>
      <div className="traffic-projection-stats">
        <span className="fleet-chip">
          <strong>{formatCountShort(projection.dayTxCount)}</strong> tx / day
        </span>
        <span className="fleet-chip">
          <strong>{fmtBytes(projection.dayPayloadBytes)}</strong> payload / day
        </span>
        <span className="fleet-chip">
          <strong>{formatCountShort(busiest.txCount)}</strong> tx busiest ({pad2(busiest.hour)}:00)
        </span>
        {quietest.txCount !== busiest.txCount ? (
          <span className="fleet-chip">
            <strong>{formatCountShort(quietest.txCount)}</strong> tx quietest ({pad2(quietest.hour)}:00)
          </span>
        ) : null}
        <span className="fleet-chip traffic-projection-focus">
          <strong>{pad2(focused.hour)}:00</strong> {formatCountShort(focused.txCount)} tx ·{" "}
          {fmtBytes(focused.payloadBytes)} · {focused.activeWorkers} workers
          {hovered === null ? " (now)" : ""}
        </span>
      </div>
      <div className="traffic-projection-charts">
        <BarStrip
          title="Transactions per hour"
          values={projection.hours.map((entry) => entry.txCount)}
          format={formatCountShort}
          peak={projection.peakTxCount}
          current={currentHour}
          hovered={hovered}
          onHover={setHovered}
          labels={hourLabels}
          bucket={(index) => `${pad2(index)}:00 UTC`}
        />
        <BarStrip
          title="Payload per hour"
          values={projection.hours.map((entry) => entry.payloadBytes)}
          format={fmtBytes}
          peak={projection.peakPayloadBytes}
          current={currentHour}
          hovered={hovered}
          onHover={setHovered}
          labels={hourLabels}
          bucket={(index) => `${pad2(index)}:00 UTC`}
        />
      </div>
      <div className="traffic-projection-subhead">
        <span>
          Inside {pad2(focus)}:00{hovered === null ? " (current hour)" : ""}, minute by minute
        </span>
        {focusedMinute ? (
          <span className="traffic-projection-focus">
            {pad2(focus)}:{pad2(focusedMinute.minute)} · {formatCountShort(focusedMinute.txCount)} tx/min ·{" "}
            {fmtBytes(focusedMinute.payloadBytes)}/min · {focusedMinute.activeWorkers} workers
          </span>
        ) : null}
      </div>
      <div className="traffic-projection-charts">
        <BarStrip
          title="Transactions per minute"
          values={minutes.map((entry) => entry.txCount)}
          format={formatCountShort}
          peak={peakMinuteTx}
          current={focus === currentHour ? currentMinute : null}
          hovered={hoveredMinute}
          onHover={setHoveredMinute}
          labels={minuteLabels}
          bucket={(index) => `${pad2(focus)}:${pad2(index)} UTC`}
        />
        <BarStrip
          title="Payload per minute"
          values={minutes.map((entry) => entry.payloadBytes)}
          format={fmtBytes}
          peak={peakMinuteBytes}
          current={focus === currentHour ? currentMinute : null}
          hovered={hoveredMinute}
          onHover={setHoveredMinute}
          labels={minuteLabels}
          bucket={(index) => `${pad2(focus)}:${pad2(index)} UTC`}
        />
      </div>
      <details className="traffic-projection-table">
        <summary>Hourly table</summary>
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>UTC hour</th>
                <th>Transactions</th>
                <th>Payload</th>
                <th>Active workers</th>
              </tr>
            </thead>
            <tbody>
              {projection.hours.map((entry) => (
                <tr key={entry.hour} data-current={entry.hour === currentHour ? "true" : undefined}>
                  <td>{pad2(entry.hour)}:00</td>
                  <td>{Math.round(entry.txCount).toLocaleString()}</td>
                  <td>{fmtBytes(entry.payloadBytes)}</td>
                  <td>{entry.activeWorkers}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </section>
  );
}

function BarStrip({
  title,
  values,
  format,
  peak,
  current,
  hovered,
  onHover,
  labels,
  bucket,
}: {
  title: string;
  values: readonly number[];
  format: (value: number) => string;
  peak: number;
  current: number | null;
  hovered: number | null;
  onHover: (index: number | null) => void;
  labels: readonly string[];
  bucket: (index: number) => string;
}) {
  const height = 72;
  const width = 100 / values.length;
  const focus = hovered ?? current;
  return (
    <figure className="hour-bars" onMouseLeave={() => onHover(null)}>
      <figcaption>
        <span>{title}</span>
        <span className="hour-bars-value">{focus === null ? "" : format(values[focus] ?? 0)}</span>
      </figcaption>
      <svg viewBox={`0 0 100 ${height}`} preserveAspectRatio="none" role="img" aria-label={title}>
        {values.map((measure, index) => {
          const barHeight = peak > 0 ? Math.max(measure > 0 ? 1.5 : 0, (measure / peak) * (height - 4)) : 0;
          const x = index * width;
          return (
            <g key={index} onMouseEnter={() => onHover(index)}>
              <rect className="hour-bars-hit" x={x} y={0} width={width} height={height} />
              <rect
                className="hour-bars-bar"
                data-focus={index === focus ? "true" : undefined}
                data-current={index === current ? "true" : undefined}
                x={x + width * 0.12}
                y={height - barHeight}
                width={width * 0.76}
                height={barHeight}
              >
                <title>{`${bucket(index)} — ${format(measure)}`}</title>
              </rect>
            </g>
          );
        })}
      </svg>
      <div className="hour-bars-axis" aria-hidden="true">
        {labels.map((label) => (
          <span key={label}>{label}</span>
        ))}
      </div>
    </figure>
  );
}

function pad2(value: number): string {
  return String(value).padStart(2, "0");
}

function Field({ label, wide, children }: { label: string; wide?: boolean; children: React.ReactNode }) {
  return (
    <label className={`wfield${wide ? " wfield-wide" : ""}`}>
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
  if (status.message && status.status !== "error") items.push({ label: "state", value: status.message });
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
    const entries: { workerId: string; label: string; source: string; message: string; updatedAt?: string }[] = [];
    const label = describeBaseloadWorkerName(worker);
    const status = taskStatuses[worker.id];
    if (status && status.status === "error" && status.message) {
      entries.push({
        workerId: worker.id,
        label,
        source: "task",
        message: status.message,
        updatedAt: status.updatedAt,
      });
    }
    const balance = balances[worker.id];
    if (balance?.error) {
      entries.push({
        workerId: worker.id,
        label,
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
            <strong>{entry.label}</strong> ({entry.source}
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

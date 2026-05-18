import { useEffect, useMemo, useState } from "react";
import {
  createBaseloadWorkerDraft,
  createBaseloadWorkerFromDraft,
  getAvailableWalletNumbers,
  normalizeBaseloadConfig,
  parseBaseloadConfigJson,
  removeBaseloadWorker,
  serializeBaseloadConfig,
  updateBaseloadWorker,
  type BaseloadConfig,
  type BaseloadWorkerConfig,
  type BaseloadWorkerDraft,
} from "./baseloadConfig";
import { type BaseloadTaskStatus } from "./baseloadWorkerRuntime";

interface BaseloadViewProps {
  config: BaseloadConfig;
  onConfigChange: React.Dispatch<React.SetStateAction<BaseloadConfig>>;
  taskStatuses: Record<string, BaseloadTaskStatus>;
}

export function BaseloadView({ config, onConfigChange, taskStatuses }: BaseloadViewProps) {
  const availableWallets = useMemo(() => getAvailableWalletNumbers(config.workers), [config.workers]);
  const [draft, setDraft] = useState<BaseloadWorkerDraft>(() =>
    createBaseloadWorkerDraft(availableWallets[0] ?? 0),
  );
  const [error, setError] = useState<string | null>(null);
  const [downloadStatus, setDownloadStatus] = useState("");

  useEffect(() => {
    if (availableWallets.length === 0) return;
    if (!availableWallets.includes(Number(draft.walletNumber))) {
      setDraft((current) => ({ ...current, walletNumber: String(availableWallets[0]) }));
    }
  }, [availableWallets, draft.walletNumber]);

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
      onConfigChange(nextConfig);
      const nextWallet = getAvailableWalletNumbers(nextConfig.workers)[0] ?? 0;
      setDraft(createBaseloadWorkerDraft(nextWallet));
      setError(null);
      setDownloadStatus("");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const updateWorker = (worker: BaseloadWorkerConfig, patch: Partial<BaseloadWorkerConfig>) => {
    try {
      onConfigChange((current) => updateBaseloadWorker(current, worker.id, patch));
      setError(null);
      setDownloadStatus("");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const deleteWorker = (workerId: string) => {
    onConfigChange((current) => removeBaseloadWorker(current, workerId));
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

  const loadConfigFile = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;

    try {
      const nextConfig = parseBaseloadConfigJson(await file.text());
      onConfigChange(nextConfig);
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
          Creates per minute
          <input
            type="number"
            min="0"
            step="1"
            value={draft.createsPerMinute}
            onChange={onDraftChange("createsPerMinute")}
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
        <button type="submit" disabled={availableWallets.length === 0}>
          Add worker
        </button>
      </form>

      <p className={`summary${error ? " error" : ""}`}>
        {error ? error : downloadStatus || `${config.workers.length} workers configured`}
      </p>

      <div className="table-wrap">
        <table className="data-table baseload-table">
          <thead>
            <tr>
              <th scope="col">Wallet</th>
              <th scope="col">Address</th>
              <th scope="col">Max gas gwei</th>
              <th scope="col">Creates/min</th>
              <th scope="col">Payload size</th>
              <th scope="col">String args</th>
              <th scope="col">Number args</th>
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
                <td colSpan={13}>No baseload workers configured.</td>
              </tr>
            ) : (
              config.workers.map((worker) => (
                <tr key={worker.id}>
                  <td className="num">{worker.walletNumber}</td>
                  <td className="wallet-address">{worker.walletAddress}</td>
                  <td>
                    <EditableNumber
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
                      value={worker.createsPerMinute}
                      min={0}
                      step="1"
                      onChange={(value) => {
                        if (value !== null) updateWorker(worker, { createsPerMinute: value });
                      }}
                    />
                  </td>
                  <td>
                    <EditableNumber
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
                    <EditableNumber
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
                      value={worker.durationSeconds}
                      min={1}
                      step="1"
                      integer
                      onChange={(value) => updateWorker(worker, { durationSeconds: value })}
                    />
                  </td>
                  <td>
                    <EditableNumber
                      value={worker.ttlSeconds}
                      min={1}
                      step="1"
                      integer
                      onChange={(value) => {
                        if (value !== null) updateWorker(worker, { ttlSeconds: value });
                      }}
                    />
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

function TaskStatusCell({ status }: { status: BaseloadTaskStatus | undefined }) {
  if (!status) return "starting";
  const count =
    status.attemptedCount === undefined
      ? ""
      : ` ${status.createdCount ?? 0}/${status.attemptedCount}`;
  const block = status.currentBlock === undefined ? "" : ` block ${status.currentBlock}`;
  const tx = status.txHash ? ` tx ${shortHash(status.txHash)}` : "";
  const label = `${status.status}${count}${block}${tx}`;

  return <span title={status.message ?? status.txHash ?? status.entityKey}>{label}</span>;
}

function shortHash(value: string): string {
  return value.length <= 12 ? value : `${value.slice(0, 6)}...${value.slice(-4)}`;
}

function EditableNumber({
  value,
  min,
  step,
  integer = false,
  placeholder,
  onChange,
}: {
  value: number | null;
  min: number;
  step: string;
  integer?: boolean;
  placeholder?: string;
  onChange: (value: number | null) => void;
}) {
  const [text, setText] = useState(value === null ? "" : String(value));

  useEffect(() => {
    setText(value === null ? "" : String(value));
  }, [value]);

  const commit = () => {
    if (text.trim() === "") {
      onChange(null);
      return;
    }
    const next = Number(text);
    if (!Number.isFinite(next) || next < min || (integer && !Number.isInteger(next))) {
      setText(value === null ? "" : String(value));
      return;
    }
    onChange(next);
  };

  return (
    <input
      className="table-input"
      type="number"
      min={min}
      step={step}
      placeholder={placeholder}
      value={text}
      onChange={(event) => setText(event.target.value)}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.key === "Enter") {
          event.currentTarget.blur();
        }
      }}
    />
  );
}

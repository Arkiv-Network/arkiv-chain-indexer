import { type BaseloadConfig, type BaseloadWorkerConfig } from "./baseloadConfig";

export interface BaseloadTaskStatus {
  workerId: string;
  walletNumber: number;
  status: "starting" | "ready" | "updated" | "stopped";
  updatedAt: string;
}

interface TaskHandle {
  workerConfig: BaseloadWorkerConfig;
  task: Worker;
}

export class BaseloadWorkerRuntime {
  private readonly tasks = new Map<string, TaskHandle>();
  private readonly onStatus: (status: BaseloadTaskStatus) => void;

  constructor(onStatus: (status: BaseloadTaskStatus) => void) {
    this.onStatus = onStatus;
  }

  sync(config: BaseloadConfig) {
    const activeWorkerIds = new Set(config.workers.map((worker) => worker.id));

    for (const [workerId, handle] of this.tasks) {
      if (!activeWorkerIds.has(workerId)) {
        handle.task.postMessage({ type: "stop" });
        handle.task.terminate();
        this.tasks.delete(workerId);
        this.onStatus({
          workerId,
          walletNumber: handle.workerConfig.walletNumber,
          status: "stopped",
          updatedAt: new Date().toISOString(),
        });
      }
    }

    for (const workerConfig of config.workers) {
      const existing = this.tasks.get(workerConfig.id);
      if (!existing) {
        const task = new Worker(new URL("./baseloadTaskWorker.ts", import.meta.url), {
          type: "module",
        });
        task.onmessage = (event: MessageEvent) => {
          if (isTaskStatusMessage(event.data)) {
            this.onStatus({
              workerId: event.data.workerId ?? workerConfig.id,
              walletNumber: event.data.walletNumber ?? workerConfig.walletNumber,
              status: event.data.status,
              updatedAt: event.data.updatedAt,
            });
          }
        };
        this.tasks.set(workerConfig.id, { workerConfig, task });
        this.onStatus({
          workerId: workerConfig.id,
          walletNumber: workerConfig.walletNumber,
          status: "starting",
          updatedAt: new Date().toISOString(),
        });
        task.postMessage({ type: "start", worker: workerConfig });
      } else if (JSON.stringify(existing.workerConfig) !== JSON.stringify(workerConfig)) {
        existing.workerConfig = workerConfig;
        existing.task.postMessage({ type: "update", worker: workerConfig });
      }
    }
  }

  dispose() {
    for (const [workerId, handle] of this.tasks) {
      handle.task.postMessage({ type: "stop" });
      handle.task.terminate();
      this.onStatus({
        workerId,
        walletNumber: handle.workerConfig.walletNumber,
        status: "stopped",
        updatedAt: new Date().toISOString(),
      });
    }
    this.tasks.clear();
  }
}

function isTaskStatusMessage(value: unknown): value is {
  type: "status";
  status: BaseloadTaskStatus["status"];
  workerId: string | null;
  walletNumber: number | null;
  updatedAt: string;
} {
  if (value === null || typeof value !== "object") return false;
  const message = value as { type?: unknown; status?: unknown; updatedAt?: unknown };
  return (
    message.type === "status" &&
    (message.status === "ready" || message.status === "updated" || message.status === "stopped") &&
    typeof message.updatedAt === "string"
  );
}

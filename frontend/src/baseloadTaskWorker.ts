import { type BaseloadWorkerConfig } from "./baseloadConfig";

type BaseloadWorkerMessage =
  | { type: "start"; worker: BaseloadWorkerConfig }
  | { type: "update"; worker: BaseloadWorkerConfig }
  | { type: "stop" };

let currentWorker: BaseloadWorkerConfig | null = null;

self.onmessage = (event: MessageEvent<BaseloadWorkerMessage>) => {
  if (event.data.type === "stop") {
    currentWorker = null;
    postStatus("stopped");
    return;
  }

  currentWorker = event.data.worker;
  postStatus(event.data.type === "start" ? "ready" : "updated");
};

function postStatus(status: "ready" | "updated" | "stopped") {
  self.postMessage({
    type: "status",
    status,
    workerId: currentWorker?.id ?? null,
    walletNumber: currentWorker?.walletNumber ?? null,
    updatedAt: new Date().toISOString(),
  });
}

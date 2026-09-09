/**
 * The genesis import's progress as a document other tools can read.
 *
 * Two writers produce it: `scripts/importGenesisState.ts` while it loads a
 * `state.jsonl` dump, and the backend's projector while it walks a node or
 * refolds the imported keys. Both render the same shape, so a watcher — the
 * arkiv-prefill dashboard reads `seed-progress.json` and
 * `init-state-progress.json` in this style — can follow the whole import from
 * one file: snake_case keys, `phase`/`percent`/`elapsed_s`/`error`/`pid`/
 * `updated_at` (epoch seconds) at the top, the detail below. The importer also
 * prints the document as one JSON line per event, so `tail -1 | jq` on its
 * log is the same view.
 */

import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { GenesisImportStatus } from "./entityIndexStorage";

export type GenesisProgressWriter = "import-script" | "backend";

/**
 * Where the import is. The script moves through `starting` → `checking` →
 * `loading` → `verifying` → `indexing` and hands over at `repairing`; the
 * backend walks (`walking`) or repairs (`repairing`) and ends in `done`,
 * `waiting` (too many entities for the node walk; run the script), `failed`
 * or `unavailable` (the node serves no block-0 queries). `stopped` is a script
 * run interrupted at a batch boundary; running it again resumes there.
 */
export type GenesisProgressPhase =
  | "starting"
  | "checking"
  | "loading"
  | "verifying"
  | "indexing"
  | "walking"
  | "repairing"
  | "waiting"
  | "unavailable"
  | "stopped"
  | "done"
  | "failed";

export interface GenesisProgressEntities {
  /** Entities the source holds at block 0 (0 until known). */
  total: number;
  /** Entities in the index tables so far. */
  imported: number;
  /** Entities a resumed run skipped because an earlier run had written them. */
  skipped: number;
  /** Attribute rows written by this process. */
  attributes: number;
  /** Payload bytes seen by this process (the dump carries them; the node walk never fetches them). */
  payload_bytes: number;
  /** Entities per second over the recent window; null before the first measurement. */
  rate_per_s: number | null;
  /** Seconds to the end of the current phase at that rate; null when unknown. */
  eta_s: number | null;
}

export interface GenesisProgressDump {
  path: string;
  bytes_total: number;
  bytes_read: number;
  bytes_per_s: number | null;
  eta_s: number | null;
  /** Lines consumed so far. */
  lines: number;
  /** Entity records decoded so far (including skipped ones). */
  records: number;
  system_account: {
    /** Whether the system account's line has been consumed. */
    seen: boolean;
    /** `id2key` slots matched in id order. */
    ids: number;
    /** The `arkiv.entity_count` slot's value, once seen. */
    entity_count: number | null;
  };
  /** The record-order check against the system account's id slots. */
  verification: "pending" | "passed" | "failed";
}

export interface GenesisProgressRpc {
  /** The node URL with any credentials stripped. */
  url: string;
  pages: number;
  page_size: number;
}

export interface GenesisProgressDatabase {
  schema: string;
  batch_size: number;
  batches: number;
  last_batch_ms: number | null;
  /** What happened to the secondary indexes: left in place, dropped for the load, or rebuilt after it. */
  indexes: "kept" | "dropped" | "rebuilt";
  index_rebuild_s: number | null;
}

export interface GenesisProgressRepair {
  /** Genesis keys refolded with the operations that came after block 0. */
  keys_refolded: number;
  batches: number;
}

export interface GenesisProgressDocument {
  tool: "arkiv-chain-indexer";
  format: 1;
  writer: GenesisProgressWriter;
  /** The import's status row (`/health` → `entityQueryIndex.genesis.status`); null before it exists. */
  status: GenesisImportStatus | null;
  phase: GenesisProgressPhase;
  /** Overall progress, 0–100. */
  percent: number;
  source: "dump" | "rpc" | null;
  pid: number;
  /** Epoch seconds. */
  started_at: number;
  updated_at: number;
  finished_at: number | null;
  elapsed_s: number;
  phase_elapsed_s: number;
  /** Seconds each finished phase took. */
  phases: Record<string, number>;
  error: string | null;
  chain_id: number | null;
  genesis_hash: string | null;
  state_root: string | null;
  entities: GenesisProgressEntities;
  dump: GenesisProgressDump | null;
  rpc: GenesisProgressRpc | null;
  database: GenesisProgressDatabase | null;
  repair: GenesisProgressRepair | null;
}

/** How far into the overall import each phase reaches when it completes. */
const PHASE_CEILING: Record<GenesisProgressPhase, number> = {
  starting: 0,
  checking: 1,
  loading: 85,
  verifying: 86,
  indexing: 95,
  walking: 95,
  repairing: 99,
  waiting: 0,
  unavailable: 0,
  stopped: 85,
  done: 100,
  failed: 0,
};

const RATE_WINDOW_MS = 30_000;

interface RateSample {
  at: number;
  entities: number;
  bytes: number;
}

export interface GenesisProgressTrackerOptions {
  writer: GenesisProgressWriter;
  source?: "dump" | "rpc" | null;
  now?: () => number;
  pid?: number;
  /** When the import started (epoch ms); defaults to now. */
  startedAt?: number;
}

/**
 * Accumulates the numbers behind the document and renders it with the derived
 * fields (elapsed times, rates, ETA, percent) computed at render time.
 */
export class GenesisProgressTracker {
  private readonly now: () => number;
  private readonly startedAt: number;
  private phaseStartedAt: number;
  private readonly samples: RateSample[] = [];
  readonly doc: GenesisProgressDocument;

  constructor(options: GenesisProgressTrackerOptions) {
    this.now = options.now ?? Date.now;
    this.startedAt = options.startedAt ?? this.now();
    this.phaseStartedAt = this.now();
    this.doc = {
      tool: "arkiv-chain-indexer",
      format: 1,
      writer: options.writer,
      status: null,
      phase: "starting",
      percent: 0,
      source: options.source ?? null,
      pid: options.pid ?? process.pid,
      started_at: this.startedAt / 1000,
      updated_at: this.startedAt / 1000,
      finished_at: null,
      elapsed_s: 0,
      phase_elapsed_s: 0,
      phases: {},
      error: null,
      chain_id: null,
      genesis_hash: null,
      state_root: null,
      entities: { total: 0, imported: 0, skipped: 0, attributes: 0, payload_bytes: 0, rate_per_s: null, eta_s: null },
      dump: null,
      rpc: null,
      database: null,
      repair: null,
    };
  }

  get phase(): GenesisProgressPhase {
    return this.doc.phase;
  }

  /** Move to `phase`, booking the time the previous one took. */
  setPhase(phase: GenesisProgressPhase): void {
    if (phase === this.doc.phase) return;
    const at = this.now();
    this.doc.phases[this.doc.phase] = round((at - this.phaseStartedAt) / 1000, 1);
    this.doc.phase = phase;
    this.phaseStartedAt = at;
    this.samples.length = 0;
    if (phase === "done" || phase === "failed" || phase === "stopped") this.doc.finished_at = at / 1000;
  }

  /** Book the current counters as a rate sample (call after every batch or chunk). */
  sample(): void {
    const at = this.now();
    this.samples.push({ at, entities: this.doc.entities.imported, bytes: this.doc.dump?.bytes_read ?? 0 });
    while (this.samples.length > 2 && at - this.samples[0]!.at > RATE_WINDOW_MS) this.samples.shift();
  }

  /** The document with its derived fields brought up to date. */
  snapshot(): GenesisProgressDocument {
    const at = this.now();
    const doc = this.doc;
    doc.updated_at = at / 1000;
    doc.elapsed_s = round((at - this.startedAt) / 1000, 1);
    doc.phase_elapsed_s = round((at - this.phaseStartedAt) / 1000, 1);
    const first = this.samples[0];
    const last = this.samples[this.samples.length - 1];
    const seconds = first && last && last !== first ? (last.at - first.at) / 1000 : 0;
    const entityRate = seconds > 0 && last && first ? (last.entities - first.entities) / seconds : null;
    const byteRate = seconds > 0 && last && first ? (last.bytes - first.bytes) / seconds : null;
    doc.entities.rate_per_s = entityRate === null ? null : round(entityRate, 1);
    const remaining = Math.max(0, doc.entities.total - doc.entities.imported);
    doc.entities.eta_s = entityRate && entityRate > 0 ? round(remaining / entityRate, 0) : null;
    if (doc.dump) {
      doc.dump.bytes_per_s = byteRate === null ? null : round(byteRate, 0);
      const left = Math.max(0, doc.dump.bytes_total - doc.dump.bytes_read);
      doc.dump.eta_s = byteRate && byteRate > 0 ? round(left / byteRate, 0) : null;
    }
    doc.percent = this.percent();
    return structuredClone(doc);
  }

  private percent(): number {
    const doc = this.doc;
    const ceiling = PHASE_CEILING[doc.phase];
    const floor = previousCeiling(doc.phase);
    let fraction: number;
    switch (doc.phase) {
      case "loading":
      case "stopped":
        fraction = doc.dump && doc.dump.bytes_total > 0 ? doc.dump.bytes_read / doc.dump.bytes_total : 0;
        break;
      case "walking":
        fraction = doc.entities.total > 0 ? doc.entities.imported / doc.entities.total : 0;
        break;
      case "done":
        return 100;
      default:
        fraction = 0;
    }
    return round(floor + Math.min(1, Math.max(0, fraction)) * (ceiling - floor), 1);
  }
}

function previousCeiling(phase: GenesisProgressPhase): number {
  switch (phase) {
    case "loading":
    case "stopped":
      return PHASE_CEILING.checking;
    case "verifying":
      return PHASE_CEILING.loading;
    case "indexing":
      return PHASE_CEILING.verifying;
    case "repairing":
      return PHASE_CEILING.indexing;
    default:
      return 0;
  }
}

function round(value: number, places: number): number {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
}

/**
 * Writes the document to `path` atomically (a temporary file renamed into
 * place, so a reader never sees a torn file), creating the directory when it
 * is missing. Writes coalesce: while one is in flight the newest document
 * waits and is written next. A failing write is reported once per message
 * through `log`, never thrown — progress reporting must not stop the import.
 */
export interface GenesisProgressFileWriter {
  readonly path: string;
  write(doc: GenesisProgressDocument): Promise<void>;
  /** Wait for the in-flight write, if any. */
  flush(): Promise<void>;
}

export function createGenesisProgressFileWriter(
  path: string,
  log: (message: string) => void = () => {},
): GenesisProgressFileWriter {
  let inFlight: Promise<void> | null = null;
  let pending: GenesisProgressDocument | null = null;
  const reported = new Set<string>();
  const writeNow = async (doc: GenesisProgressDocument): Promise<void> => {
    const tmp = `${path}.tmp`;
    try {
      await mkdir(dirname(path), { recursive: true });
      await writeFile(tmp, `${JSON.stringify(doc, null, 2)}\n`);
      await rename(tmp, path);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!reported.has(message)) {
        reported.add(message);
        log(`genesis progress file ${path}: ${message}`);
      }
    }
  };
  const drain = async (): Promise<void> => {
    while (pending) {
      const next = pending;
      pending = null;
      await writeNow(next);
    }
  };
  return {
    path,
    write(doc) {
      pending = doc;
      if (!inFlight) {
        inFlight = drain().finally(() => {
          inFlight = null;
        });
      }
      return inFlight;
    },
    async flush() {
      await inFlight;
    },
  };
}

/** One human-readable line for a document, for `--log text` and the backend's log. */
export function describeGenesisProgress(doc: GenesisProgressDocument): string {
  const parts: string[] = [`${doc.phase} ${doc.percent.toFixed(1)}%`];
  if (doc.entities.total > 0 || doc.entities.imported > 0) {
    parts.push(`${doc.entities.imported.toLocaleString("en-US")}/${doc.entities.total.toLocaleString("en-US")} entities`);
  }
  if (doc.entities.rate_per_s !== null) parts.push(`${doc.entities.rate_per_s.toLocaleString("en-US")}/s`);
  if (doc.dump) {
    parts.push(`${formatBytes(doc.dump.bytes_read)} of ${formatBytes(doc.dump.bytes_total)} read`);
  }
  if (doc.repair) parts.push(`${doc.repair.keys_refolded.toLocaleString("en-US")} keys refolded`);
  if (doc.entities.eta_s !== null && doc.phase !== "done") parts.push(`eta ${formatDuration(doc.entities.eta_s)}`);
  else if (doc.dump?.eta_s != null && doc.phase === "loading") parts.push(`eta ${formatDuration(doc.dump.eta_s)}`);
  parts.push(`elapsed ${formatDuration(doc.elapsed_s)}`);
  if (doc.error) parts.push(`error: ${doc.error}`);
  return parts.join(", ");
}

export function formatBytes(bytes: number): string {
  const units = ["B", "KiB", "MiB", "GiB", "TiB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${unit === 0 ? value : value.toFixed(1)} ${units[unit]}`;
}

export function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds)) return "?";
  const total = Math.round(seconds);
  if (total < 60) return `${total}s`;
  const minutes = Math.floor(total / 60);
  if (minutes < 60) return `${minutes}m${String(total % 60).padStart(2, "0")}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h${String(minutes % 60).padStart(2, "0")}m`;
}

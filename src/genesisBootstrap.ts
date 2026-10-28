/** Private retained-dump contract and resumable, verified downloads for managed bootstrap. */
import { createHash } from "node:crypto";
import { mkdir, open, readFile, readdir, rename, rm, stat, statfs, type FileHandle } from "node:fs/promises";
import { dirname, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { AwsClient } from "aws4fetch";
import type { GenesisImportState } from "./entityIndexStorage";

export interface GenesisBootstrapReference {
  version: 1;
  s3Uri: string;
  sha256: string;
  bytes: number;
  versionId?: string;
  manifestUri: string;
  manifestSha256: string;
  manifestBytes: number;
  manifestVersionId?: string;
  chainId: number;
  stateRoot: string;
  genesisSha256: string;
  entityCount: number;
  /** Storage endpoint, supplied privately by the manager; never carries credentials. */
  endpoint: string;
}

export class BootstrapIntegrityError extends Error {
  constructor(message: string) { super(message); this.name = "BootstrapIntegrityError"; }
}

/** Completed backups/RPC imports need chain evidence, not the original dump's digest. */
export function bootstrapDisposition(reference: GenesisBootstrapReference, genesisHash: string, current: GenesisImportState | undefined):
  "import" | "repair" | "done" | "reset-required" | "identity-mismatch" {
  if (!current) return "import";
  if ((current.chainId !== null && current.chainId !== String(reference.chainId)) ||
      (current.genesisHash !== null && current.genesisHash.toLowerCase() !== genesisHash.toLowerCase())) return "identity-mismatch";
  if (current.status === "done") {
    return current.chainId === String(reference.chainId) && current.genesisHash !== null ? "done" : "identity-mismatch";
  }
  if (current.status === "failed") return "reset-required";
  if (current.status === "running") {
    if (current.chainId === null || current.genesisHash === null || current.source !== "dump" ||
        (current.phase !== "repair" && current.artifactSha256 && current.artifactSha256 !== reference.sha256)) return "identity-mismatch";
    if (current.phase === "repair") return "repair";
  }
  return "import";
}

function objectLocation(raw: unknown): { bucket: string; key: string } {
  if (typeof raw !== "string" || raw.length > 8192) throw new Error("invalid bootstrap object URI");
  const match = /^s3:\/\/([a-zA-Z0-9._-]+)\/(.+)$/.exec(raw);
  if (!match || /[?#\x00-\x20]/.test(raw)) throw new Error("invalid bootstrap object URI");
  const key = match[2]!;
  if (key.split("/").some((p) => p === "." || p === "..")) throw new Error("invalid bootstrap object key");
  return { bucket: match[1]!, key };
}

export function parseBootstrapReference(raw: unknown): GenesisBootstrapReference {
  if (!raw || typeof raw !== "object") throw new Error("invalid bootstrap reference");
  const r = raw as Record<string, unknown>;
  if (r.version !== 1) throw new Error("unsupported bootstrap reference version");
  objectLocation(r.s3Uri);
  objectLocation(r.manifestUri);
  if (r.manifestUri !== `${r.s3Uri}.manifest.json`) throw new Error("bootstrap manifest must accompany its dump");
  for (const key of ["sha256", "manifestSha256", "genesisSha256"]) {
    if (typeof r[key] !== "string" || !/^[a-f0-9]{64}$/.test(r[key] as string)) throw new Error(`invalid bootstrap ${key}`);
  }
  if (typeof r.stateRoot !== "string" || !/^0x[a-f0-9]{64}$/.test(r.stateRoot)) throw new Error("invalid bootstrap stateRoot");
  for (const key of ["bytes", "manifestBytes", "chainId", "entityCount"]) {
    if (typeof r[key] !== "number" || !Number.isSafeInteger(r[key]) || (r[key] as number) < (key === "entityCount" ? 0 : 1)) {
      throw new Error(`invalid bootstrap ${key}`);
    }
  }
  if ((r.manifestBytes as number) > 1024 * 1024) throw new Error("bootstrap manifest is too large");
  for (const key of ["versionId", "manifestVersionId"]) {
    if (r[key] !== undefined && (typeof r[key] !== "string" || !(r[key] as string).length || (r[key] as string).length > 1024)) {
      throw new Error(`invalid bootstrap ${key}`);
    }
  }
  if (typeof r.endpoint !== "string") throw new Error("bootstrap storage endpoint is absent");
  const endpoint = new URL(r.endpoint);
  if (endpoint.protocol !== "https:" || endpoint.username || endpoint.password || endpoint.search || endpoint.hash || endpoint.pathname !== "/") {
    throw new Error("bootstrap storage endpoint must be an HTTPS origin");
  }
  return {
    version: 1, s3Uri: r.s3Uri as string, sha256: r.sha256 as string, bytes: r.bytes as number,
    manifestUri: r.manifestUri as string, manifestSha256: r.manifestSha256 as string, manifestBytes: r.manifestBytes as number,
    chainId: r.chainId as number, stateRoot: r.stateRoot, genesisSha256: r.genesisSha256 as string,
    entityCount: r.entityCount as number, endpoint: endpoint.origin,
    ...(r.versionId === undefined ? {} : { versionId: r.versionId as string }),
    ...(r.manifestVersionId === undefined ? {} : { manifestVersionId: r.manifestVersionId as string }),
  };
}

/** Sign a GET, including an optional immutable S3 version and request headers. Never follow storage redirects. */
export function createBootstrapFetcher(reference: GenesisBootstrapReference, credentials: {
  accessKeyId: string; secretAccessKey: string; sessionToken?: string; region?: string;
}, fetcher: typeof fetch = fetch): BootstrapFetch {
  const client = new AwsClient({ ...credentials, region: credentials.region ?? "auto", service: "s3", retries: 0 });
  return async (uri, versionId, signal, headers) => {
    const { bucket, key } = objectLocation(uri);
    const encode = (s: string) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
    const url = new URL(`${reference.endpoint}/${encode(bucket)}/${key.split("/").map(encode).join("/")}`);
    if (versionId) url.searchParams.set("versionId", versionId);
    const request = await client.sign(url, { method: "GET", redirect: "error", ...(headers ? { headers } : {}), ...(signal ? { signal } : {}) });
    return fetcher(request);
  };
}

export interface BootstrapObject { uri: string; sha256: string; bytes: number; versionId?: string; }
export type BootstrapFetch = (uri: string, versionId?: string, signal?: AbortSignal, headers?: Record<string, string>) => Promise<Response>;

/** Free scratch space is short; the worker retries later and never records a durable failure. */
export class BootstrapScratchSpaceError extends Error {
  constructor(message: string) { super(message); this.name = "BootstrapScratchSpaceError"; }
}

export interface BootstrapDownloadOptions {
  /** Names the object in log lines; never an address. */
  label?: string;
  partBytes?: number;
  concurrency?: number;
  retryInitialMs?: number;
  retryMaxMs?: number;
  /** A request that receives no bytes for this long is aborted and retried. */
  stallTimeoutMs?: number;
  freeBytes?: (dir: string) => Promise<number>;
  log?: (message: string) => void;
}

const MiB = 1024 * 1024;
const downloadDefaults = { label: "bootstrap object", partBytes: 64 * MiB, concurrency: 8, retryInitialMs: 1_000, retryMaxMs: 60_000, stallTimeoutMs: 120_000 };
/** Failed attempts of one part (a deleted object, revoked access) before the worker loop re-reads its reference and resumes. */
const partAttempts = 8;

/** Local and manual runs tune the download; managed charts refuse these settings. */
export function bootstrapDownloadTuning(env: Record<string, string | undefined>): Pick<BootstrapDownloadOptions, "partBytes" | "concurrency"> {
  const tuning: Pick<BootstrapDownloadOptions, "partBytes" | "concurrency"> = {};
  const parse = (name: string, min: number, max: number) => {
    const raw = env[name];
    if (raw === undefined || raw === "") return undefined;
    const value = Number(raw);
    if (!/^\d+$/.test(raw) || !Number.isSafeInteger(value) || value < min || value > max) throw new Error(`invalid ${name}`);
    return value;
  };
  const partBytes = parse("GENESIS_BOOTSTRAP_PART_BYTES", MiB, 4096 * MiB);
  const concurrency = parse("GENESIS_BOOTSTRAP_CONCURRENCY", 1, 64);
  if (partBytes !== undefined) tuning.partBytes = partBytes;
  if (concurrency !== undefined) tuning.concurrency = concurrency;
  return tuning;
}

const resumeFileSuffixes = [".partial", ".parts", ".parts.tmp"];

/** A pod runs one worker. Reclaim only its named random-suffix partial files after a killed download. */
export async function prepareBootstrapScratch(scratch: string): Promise<void> {
  await mkdir(scratch, { recursive: true, mode: 0o700 });
  for (const entry of await readdir(scratch, { withFileTypes: true })) {
    if (entry.isFile() && /^state-[a-f0-9]{64}\.jsonl(?:\.manifest\.json)?\.partial-[a-f0-9-]+$/.test(entry.name)) {
      await rm(join(scratch, entry.name));
    }
  }
}

/** Release this artifact's scratch only after its matching database is durably done. */
export async function releaseBootstrapScratch(reference: GenesisBootstrapReference, scratch: string): Promise<void> {
  const dump = join(scratch, `state-${reference.sha256}.jsonl`);
  for (const base of [dump, `${dump}.manifest.json`]) {
    for (const suffix of ["", ...resumeFileSuffixes]) await rm(`${base}${suffix}`, { force: true });
  }
}

async function verifiedFile(path: string, object: BootstrapObject): Promise<boolean> {
  try {
    const info = await stat(path);
    if (!info.isFile() || info.size !== object.bytes) return false;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
  const hasher = createHash("sha256");
  for await (const chunk of Bun.file(path).stream()) hasher.update(chunk);
  return hasher.digest("hex") === object.sha256;
}

interface PartsSidecar { version: 1; etag: string; bytes: number; partBytes: number; done: number[]; }

async function readSidecar(path: string, bytes: number): Promise<PartsSidecar | undefined> {
  let raw: unknown;
  try { raw = JSON.parse(await readFile(path, "utf8")); } catch { return undefined; }
  if (!raw || typeof raw !== "object") return undefined;
  const s = raw as Record<string, unknown>;
  if (s.version !== 1 || typeof s.etag !== "string" || !s.etag || s.bytes !== bytes ||
      typeof s.partBytes !== "number" || !Number.isSafeInteger(s.partBytes) || s.partBytes < 1 || !Array.isArray(s.done)) return undefined;
  const count = Math.ceil(bytes / s.partBytes);
  const done = s.done as unknown[];
  if (!done.every((p) => typeof p === "number" && Number.isInteger(p) && p >= 0 && p < count) || new Set(done).size !== done.length) return undefined;
  return { version: 1, etag: s.etag, bytes, partBytes: s.partBytes, done: done as number[] };
}

async function writeSidecar(path: string, sidecar: PartsSidecar): Promise<void> {
  const temporary = `${path}.tmp`;
  const file = await open(temporary, "w", 0o600);
  try {
    await file.writeFile(JSON.stringify(sidecar));
    await file.sync();
  } finally {
    await file.close();
  }
  await rename(temporary, path);
}

async function freeScratchBytes(dir: string): Promise<number> {
  const info = await statfs(dir);
  return Number(info.bavail) * Number(info.bsize);
}

function parseContentRange(value: string | null): { start: number; end: number; total: number } | undefined {
  const match = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(value ?? "");
  if (!match) return undefined;
  return { start: Number(match[1]), end: Number(match[2]), total: Number(match[3]) };
}

const gb = (bytes: number) => (bytes / 1e9).toFixed(1);
const mb = (bytes: number) => (bytes / 1e6).toFixed(1);

class ObjectChanged extends Error {}
/** A response that cannot be written as the requested part; carries a log-safe reason. */
class PartRejected extends Error {}
class PartStalled extends Error {}
class ScratchWriteFailure extends Error {}

/** Names a transport failure without its message, which can carry addresses. */
function failureClass(error: unknown): string {
  if (error instanceof PartStalled) return "stalled";
  if (error instanceof PartRejected) return error.message;
  const code = (error as { code?: unknown } | undefined)?.code;
  if (code === "ECONNRESET") return "connection reset";
  if (code === "ConnectionClosed") return "connection closed";
  if (typeof code === "string" && /^[A-Za-z_]{1,40}$/.test(code)) return `transport error ${code}`;
  return "transport error";
}

async function writeAt(file: FileHandle, chunk: Uint8Array, position: number): Promise<void> {
  try {
    let offset = 0;
    while (offset < chunk.byteLength) {
      const written = await file.write(chunk, offset, chunk.byteLength - offset, position + offset);
      if (!written.bytesWritten) throw new Error("bootstrap scratch write made no progress");
      offset += written.bytesWritten;
    }
  } catch (error) {
    throw new ScratchWriteFailure("bootstrap scratch write failed", { cause: error });
  }
}

/** One bounded stream for storage without range support; nothing survives a failure. */
async function streamWholeObject(object: BootstrapObject, path: string, fetcher: BootstrapFetch, signal: AbortSignal | undefined,
  stallTimeoutMs: number, source?: { response: Response; abort: AbortController }): Promise<void> {
  const partial = `${path}.partial`;
  let response = source?.response;
  const idle = source?.abort ?? new AbortController();
  const downloadSignal = signal ? AbortSignal.any([signal, idle.signal]) : idle.signal;
  let idleTimer: ReturnType<typeof setTimeout>;
  const armIdleTimer = () => {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => idle.abort(new Error("bootstrap object download stalled")), stallTimeoutMs);
  };
  armIdleTimer();
  try {
    response ??= await fetcher(object.uri, object.versionId, downloadSignal);
    if (!response.ok || !response.body) throw new Error("bootstrap object download is unavailable");
    const file = await open(partial, "wx", 0o600);
    const hasher = createHash("sha256");
    let bytes = 0;
    try {
      for await (const chunk of response.body) {
        armIdleTimer();
        bytes += chunk.byteLength;
        if (bytes > object.bytes) throw new BootstrapIntegrityError("bootstrap object exceeds its declared byte size");
        hasher.update(chunk);
        let offset = 0;
        while (offset < chunk.byteLength) {
          const written = await file.write(chunk, offset, chunk.byteLength - offset);
          if (!written.bytesWritten) throw new Error("bootstrap scratch write made no progress");
          offset += written.bytesWritten;
        }
      }
      if (bytes !== object.bytes || hasher.digest("hex") !== object.sha256) {
        throw new BootstrapIntegrityError("bootstrap object checksum or byte size mismatch");
      }
      await file.sync();
    } finally {
      await file.close();
    }
    await rename(partial, path);
  } catch (error) {
    // Stalls are availability failures, never durable artifact-integrity failures.
    if (idle.signal.aborted && !signal?.aborted) throw new Error("bootstrap object download stalled");
    throw error;
  } finally {
    clearTimeout(idleTimer!);
    if (response?.body && !response.body.locked) await response.body.cancel().catch(() => {});
    await rm(partial, { force: true });
  }
}

type Settings = typeof downloadDefaults & Pick<BootstrapDownloadOptions, "freeBytes" | "log">;

/**
 * Parallel byte ranges into one pre-sized partial, pinned to the first response's ETag.
 * Finished parts are recorded in a sidecar so an interrupted download resumes; the whole
 * file is verified once before it replaces the final path.
 */
async function downloadRanged(object: BootstrapObject, path: string, fetcher: BootstrapFetch, signal: AbortSignal | undefined,
  o: Settings, discard: () => Promise<void>): Promise<void> {
  const partial = `${path}.partial`;
  const partsPath = `${path}.parts`;
  let sidecar = await readSidecar(partsPath, object.bytes);
  if (sidecar) {
    try { if ((await stat(partial)).size !== object.bytes) sidecar = undefined; } catch { sidecar = undefined; }
  }
  if (!sidecar) await discard();
  const partBytes = sidecar?.partBytes ?? o.partBytes;
  const count = Math.ceil(object.bytes / partBytes);
  const startOf = (part: number) => part * partBytes;
  const lengthOf = (part: number) => Math.min(partBytes, object.bytes - startOf(part));
  const done = new Set(sidecar?.done ?? []);
  let doneBytes = [...done].reduce((sum, part) => sum + lengthOf(part), 0);
  const missingBytes = object.bytes - doneBytes;
  const free = await (o.freeBytes ?? freeScratchBytes)(dirname(path));
  if (free < missingBytes) throw new BootstrapScratchSpaceError(`insufficient scratch space: need ${gb(missingBytes)} GB, have ${gb(free)} GB`);
  if (done.size) {
    o.log?.(`resuming ${o.label} download: ${done.size} of ${count} parts present (${gb(doneBytes)} of ${gb(object.bytes)} GB)`);
  }

  const run = new AbortController();
  const onStop = () => run.abort(signal?.reason);
  if (signal?.aborted) onStop();
  signal?.addEventListener("abort", onStop, { once: true });
  const file = await open(partial, sidecar ? "r+" : "w+", 0o600);
  let fileOpen = true;
  try {
    // Sparse until written: only parts still missing consume scratch space.
    if (!sidecar) await file.truncate(object.bytes);
    let etag = sidecar?.etag;
    let lastStep = Math.floor(doneBytes * 20 / object.bytes);
    let persisted: Promise<void> = Promise.resolve();
    const complete = async (part: number) => {
      await file.datasync();
      done.add(part);
      doneBytes += lengthOf(part);
      const snapshot: PartsSidecar = { version: 1, etag: etag!, bytes: object.bytes, partBytes, done: [...done].sort((a, b) => a - b) };
      persisted = persisted.catch(() => {}).then(() => writeSidecar(partsPath, snapshot));
      await persisted;
      const step = Math.floor(doneBytes * 20 / object.bytes);
      if (count > 1 && step > lastStep) {
        lastStep = step;
        o.log?.(`downloading ${o.label}: ${Math.floor(doneBytes * 100 / object.bytes)}% (${gb(doneBytes)} of ${gb(object.bytes)} GB)`);
      }
    };

    const requestPart = async (part: number, pinned: string | undefined, progress: { bytes: number }) => {
      const start = startOf(part);
      const length = lengthOf(part);
      const end = start + length - 1;
      const stall = new AbortController();
      let timer: ReturnType<typeof setTimeout> | undefined;
      const arm = () => {
        clearTimeout(timer);
        timer = setTimeout(() => stall.abort(new PartStalled("stalled")), o.stallTimeoutMs);
      };
      arm();
      let response: Response | undefined;
      let handedOver = false;
      try {
        const headers: Record<string, string> = { range: `bytes=${start}-${end}` };
        if (pinned) headers["if-match"] = pinned;
        response = await fetcher(object.uri, object.versionId, AbortSignal.any([run.signal, stall.signal]), headers);
        run.signal.throwIfAborted();
        if (pinned && response.status === 412) throw new ObjectChanged("bootstrap object changed");
        if (!pinned && response.status === 200) {
          handedOver = true;
          return { kind: "whole", response, abort: stall } as const;
        }
        if (response.status !== 206 || !response.body) throw new PartRejected(`HTTP ${response.status}`);
        const range = parseContentRange(response.headers.get("content-range"));
        if (range && range.total !== object.bytes) throw new BootstrapIntegrityError("bootstrap object byte size differs from its reference");
        const contentLength = response.headers.get("content-length");
        if (!range || range.start !== start || range.end !== end || (contentLength !== null && Number(contentLength) !== length)) {
          throw new PartRejected("range mismatch");
        }
        const tag = response.headers.get("etag");
        if (!pinned && (!tag || tag.startsWith("W/"))) return { kind: "untagged" } as const;
        for await (const chunk of response.body) {
          arm();
          if (progress.bytes + chunk.byteLength > length) throw new PartRejected("range overrun");
          await writeAt(file, chunk, start + progress.bytes);
          progress.bytes += chunk.byteLength;
        }
        if (progress.bytes !== length) throw new PartRejected("short part");
        return { kind: "part", etag: tag ?? pinned! } as const;
      } catch (error) {
        if (stall.signal.aborted && !run.signal.aborted) throw new PartStalled("stalled");
        throw error;
      } finally {
        clearTimeout(timer);
        if (!handedOver && response?.body && !response.body.locked) await response.body.cancel().catch(() => {});
      }
    };

    // Each part keeps its own backoff, so a completed part starts the next one fresh.
    const withRetry = async <T>(part: number, attempt: (progress: { bytes: number }) => Promise<T>): Promise<T> => {
      let delayMs = o.retryInitialMs;
      for (let failures = 1; ; failures++) {
        const progress = { bytes: 0 };
        try {
          return await attempt(progress);
        } catch (error) {
          if (run.signal.aborted || error instanceof BootstrapIntegrityError || error instanceof ObjectChanged ||
              error instanceof ScratchWriteFailure || failures === partAttempts) throw error;
          o.log?.(`${o.label} part ${part} interrupted at ${mb(progress.bytes)} of ${mb(lengthOf(part))} MB: ${failureClass(error)}; retrying in ${delayMs / 1000} s`);
          await sleep(delayMs, undefined, { signal: run.signal });
          delayMs = Math.min(delayMs * 2, o.retryMaxMs);
        }
      }
    };

    if (etag === undefined) {
      const first = await withRetry(0, (progress) => requestPart(0, undefined, progress));
      if (first.kind !== "part") {
        await file.close();
        fileOpen = false;
        await discard();
        o.log?.(first.kind === "whole"
          ? `object storage does not support range requests; downloading ${o.label} as one stream without resume`
          : `object storage gave no strong ETag; downloading ${o.label} as one stream without resume`);
        return await streamWholeObject(object, path, fetcher, signal, o.stallTimeoutMs, first.kind === "whole" ? first : undefined);
      }
      etag = first.etag;
      await complete(0);
    }

    const pinned = etag;
    const queue = [...Array(count).keys()].filter((part) => !done.has(part));
    let failure: unknown;
    const worker = async () => {
      for (let part = queue.shift(); part !== undefined && !run.signal.aborted; part = queue.shift()) {
        const current = part;
        try {
          await withRetry(current, (progress) => requestPart(current, pinned, progress));
          await complete(current);
        } catch (error) {
          failure ??= error;
          run.abort(error);
          return;
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(o.concurrency, queue.length) }, worker));
    if (failure !== undefined) throw failure;
    if (run.signal.aborted) throw new Error("bootstrap object download stopped");
    await file.sync();
    await file.close();
    fileOpen = false;
  } catch (error) {
    if (error instanceof BootstrapIntegrityError) await discard();
    throw error;
  } finally {
    if (fileOpen) await file.close();
    signal?.removeEventListener("abort", onStop);
  }
  if (!(await verifiedFile(partial, object))) {
    await discard();
    throw new BootstrapIntegrityError("bootstrap object checksum or byte size mismatch");
  }
  await rename(partial, path);
  await rm(partsPath, { force: true });
}

/** Resumable, verified download; consumers never see a partial or unverified file. */
export async function downloadBootstrapObject(object: BootstrapObject, path: string, fetcher: BootstrapFetch, signal?: AbortSignal,
  options: BootstrapDownloadOptions = {}): Promise<void> {
  const o: Settings = { ...downloadDefaults };
  for (const [key, value] of Object.entries(options)) if (value !== undefined) Object.assign(o, { [key]: value });
  const discard = async () => {
    for (const suffix of resumeFileSuffixes) await rm(`${path}${suffix}`, { force: true });
  };
  if (await verifiedFile(path, object)) {
    await discard();
    return;
  }
  await rm(path, { force: true });
  for (let restarts = 0; ; restarts++) {
    try {
      return await downloadRanged(object, path, fetcher, signal, o, discard);
    } catch (error) {
      if (!(error instanceof ObjectChanged)) throw error;
      // A replaced object is never spliced onto the old prefix.
      await discard();
      // Restart once here; storage that keeps refusing its own ETag waits in the worker loop instead.
      if (restarts > 0) throw error;
      o.log?.(`${o.label} changed in object storage; restarting the download`);
    }
  }
}

export async function downloadGenesisBootstrap(reference: GenesisBootstrapReference, scratch: string, fetcher: BootstrapFetch, signal?: AbortSignal,
  options: BootstrapDownloadOptions = {}): Promise<{ dump: string; manifest: string }> {
  await mkdir(scratch, { recursive: true, mode: 0o700 });
  // Resume files of any other artifact can never complete for this reference.
  for (const entry of await readdir(scratch, { withFileTypes: true })) {
    const match = /^state-([a-f0-9]{64})\.jsonl(?:\.manifest\.json)?\.(?:partial|parts|parts\.tmp)$/.exec(entry.name);
    if (entry.isFile() && match && match[1] !== reference.sha256) await rm(join(scratch, entry.name), { force: true });
  }
  const dump = join(scratch, `state-${reference.sha256}.jsonl`);
  const manifest = `${dump}.manifest.json`;
  // Small sidecar first: refuse an incompatible or corrupted artifact before downloading the large dump.
  await downloadBootstrapObject({ uri: reference.manifestUri, sha256: reference.manifestSha256, bytes: reference.manifestBytes,
    ...(reference.manifestVersionId ? { versionId: reference.manifestVersionId } : {}) }, manifest, fetcher, signal,
  { ...options, label: "genesis manifest" });
  let metadata: Record<string, unknown>;
  try {
    metadata = await Bun.file(manifest).json();
    if (!metadata || typeof metadata !== "object") throw new Error("invalid manifest");
  } catch {
    throw new BootstrapIntegrityError("bootstrap manifest is not a JSON object");
  }
  if (metadata.chainId !== reference.chainId || metadata.count !== reference.entityCount || metadata.stateRoot !== reference.stateRoot) {
    throw new BootstrapIntegrityError("bootstrap manifest identity differs from its private reference");
  }
  await downloadBootstrapObject({ uri: reference.s3Uri, sha256: reference.sha256, bytes: reference.bytes,
    ...(reference.versionId ? { versionId: reference.versionId } : {}) }, dump, fetcher, signal,
  { ...options, label: "genesis dump" });
  return { dump, manifest };
}

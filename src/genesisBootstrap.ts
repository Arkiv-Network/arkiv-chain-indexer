/** Private retained-dump contract and bounded, verified downloads for managed bootstrap. */
import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readdir, rename, rm, stat } from "node:fs/promises";
import { join } from "node:path";
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

/** Sign a GET, including an optional immutable S3 version. Never follow storage redirects. */
export function createBootstrapFetcher(reference: GenesisBootstrapReference, credentials: {
  accessKeyId: string; secretAccessKey: string; sessionToken?: string; region?: string;
}, fetcher: typeof fetch = fetch): (uri: string, versionId?: string, signal?: AbortSignal) => Promise<Response> {
  const client = new AwsClient({ ...credentials, region: credentials.region ?? "auto", service: "s3", retries: 0 });
  return async (uri, versionId, signal) => {
    const { bucket, key } = objectLocation(uri);
    const encode = (s: string) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
    const url = new URL(`${reference.endpoint}/${encode(bucket)}/${key.split("/").map(encode).join("/")}`);
    if (versionId) url.searchParams.set("versionId", versionId);
    const request = await client.sign(url, { method: "GET", redirect: "error", ...(signal ? { signal } : {}) });
    return fetcher(request);
  };
}

export interface BootstrapObject { uri: string; sha256: string; bytes: number; versionId?: string; }
export type BootstrapFetch = ReturnType<typeof createBootstrapFetcher>;

/** A pod runs one worker. Reclaim only its named partial files after a killed download. */
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
  await rm(dump, { force: true });
  await rm(`${dump}.manifest.json`, { force: true });
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

/** One bounded stream, no body buffering; consumers never see a partial or unverified file. */
export async function downloadBootstrapObject(object: BootstrapObject, path: string, fetcher: BootstrapFetch, signal?: AbortSignal, idleTimeoutMs = 120_000): Promise<void> {
  if (await verifiedFile(path, object)) return;
  await rm(path, { force: true });
  const partial = `${path}.partial-${randomUUID()}`;
  let response: Response | undefined;
  const idle = new AbortController();
  const downloadSignal = signal ? AbortSignal.any([signal, idle.signal]) : idle.signal;
  let idleTimer: ReturnType<typeof setTimeout>;
  const armIdleTimer = () => {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => idle.abort(new Error("bootstrap object download stalled")), idleTimeoutMs);
  };
  armIdleTimer();
  try {
    response = await fetcher(object.uri, object.versionId, downloadSignal);
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
    if (idle.signal.aborted) throw new Error("bootstrap object download stalled");
    throw error;
  } finally {
    clearTimeout(idleTimer!);
    if (response?.body && !response.body.locked) await response.body.cancel().catch(() => {});
    await rm(partial, { force: true });
  }
}

export async function downloadGenesisBootstrap(reference: GenesisBootstrapReference, scratch: string, fetcher: BootstrapFetch, signal?: AbortSignal): Promise<{ dump: string; manifest: string }> {
  await mkdir(scratch, { recursive: true, mode: 0o700 });
  const dump = join(scratch, `state-${reference.sha256}.jsonl`);
  const manifest = `${dump}.manifest.json`;
  // Small sidecar first: refuse an incompatible or corrupted artifact before downloading the large dump.
  await downloadBootstrapObject({ uri: reference.manifestUri, sha256: reference.manifestSha256, bytes: reference.manifestBytes,
    ...(reference.manifestVersionId ? { versionId: reference.manifestVersionId } : {}) }, manifest, fetcher, signal);
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
    ...(reference.versionId ? { versionId: reference.versionId } : {}) }, dump, fetcher, signal);
  return { dump, manifest };
}

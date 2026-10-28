import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { BootstrapIntegrityError, BootstrapScratchSpaceError, bootstrapDisposition, bootstrapDownloadTuning, createBootstrapFetcher, downloadBootstrapObject, downloadGenesisBootstrap, parseBootstrapReference, prepareBootstrapScratch, releaseBootstrapScratch } from "./genesisBootstrap";
import type { BootstrapDownloadOptions, BootstrapFetch } from "./genesisBootstrap";

import type { GenesisImportState } from "./entityIndexStorage";

const digest = (text: string) => createHash("sha256").update(text).digest("hex");
const fixture = () => ({ version: 1, s3Uri: "s3://private/network/state.jsonl", sha256: "a".repeat(64), bytes: 19,
  manifestUri: "s3://private/network/state.jsonl.manifest.json", manifestSha256: "b".repeat(64), manifestBytes: 100,
  chainId: 42, entityCount: 3, stateRoot: "0x" + "c".repeat(64), genesisSha256: "d".repeat(64), endpoint: "https://storage.example" });

describe("managed genesis bootstrap artifacts", () => {
  test("rejects incomplete, unsafe and incompatible references before requesting objects", () => {
    expect(parseBootstrapReference(fixture()).entityCount).toBe(3);
    for (const override of [{ version: 2 }, { bytes: 0 }, { chainId: 2 ** 53 }, { manifestBytes: 2 ** 30 },
      { endpoint: "https://user:password@storage.example" }, { endpoint: "http://storage.example" },
      { sha256: "not-a-hash" }, { manifestUri: "s3://other/wrong.json" }, { s3Uri: "s3://private/../escape" }]) {
      expect(() => parseBootstrapReference({ ...fixture(), ...override })).toThrow();
    }
  });

  test("completed database reuse does not depend on the original artifact but resume does", () => {
    const reference = parseBootstrapReference(fixture());
    const genesisHash = "0x" + "e".repeat(64);
    const state: GenesisImportState = { status: "done", phase: null, source: "rpc", chainId: "42", genesisHash,
      total: 3, imported: 3, cursor: null, repairAfterKey: null, startedAt: "now", finishedAt: "now", error: null,
      artifactSha256: "f".repeat(64) };
    expect(bootstrapDisposition(reference, genesisHash, state)).toBe("done");
    expect(bootstrapDisposition(reference, genesisHash, { ...state, genesisHash: null })).toBe("identity-mismatch");
    expect(bootstrapDisposition(reference, genesisHash, { ...state, chainId: "43" })).toBe("identity-mismatch");
    expect(bootstrapDisposition(reference, genesisHash, { ...state, status: "running", phase: "walk", source: "dump" })).toBe("identity-mismatch");
    expect(bootstrapDisposition(reference, genesisHash, { ...state, status: "running", phase: "repair", source: "dump" })).toBe("repair");
    expect(bootstrapDisposition(reference, genesisHash, { ...state, status: "failed" })).toBe("reset-required");
  });

  test("signs the exact object version and refuses redirects", async () => {
    let request: Request | undefined;
    const fetcher = createBootstrapFetcher(parseBootstrapReference(fixture()), { accessKeyId: "example", secretAccessKey: "secret" },
      (async (input: Request) => { request = input; return new Response("data"); }) as typeof fetch);
    await fetcher("s3://private/a+b%20.json", "version+/?=");
    expect(request!.url).toBe("https://storage.example/private/a%2Bb%2520.json?versionId=version%2B%2F%3F%3D");
    expect(request!.headers.get("authorization")).toContain("AWS4-HMAC-SHA256");
    expect(request!.redirect).toBe("error");
  });

  test("streams, verifies, reuses valid files and removes truncated/oversized/corrupted partials", async () => {
    const dir = await mkdtemp(join(tmpdir(), "genesis-bootstrap-"));
    try {
      const path = join(dir, "state");
      const body = "metadata without persistence of payload";
      const object = { uri: "s3://bucket/state", sha256: digest(body), bytes: body.length };
      let calls = 0;
      const fetcher = async () => { calls++; return new Response(body); };
      await downloadBootstrapObject(object, path, fetcher);
      await downloadBootstrapObject(object, path, fetcher);
      expect(calls).toBe(1);
      expect(await readFile(path, "utf8")).toBe(body);
      await rm(path);
      for (const invalid of [body.slice(1), body + "x", "x".repeat(body.length)]) {
        await expect(downloadBootstrapObject(object, path, async () => new Response(invalid))).rejects.toBeInstanceOf(BootstrapIntegrityError);
        expect(await readdir(dir)).toEqual([]);
      }
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  test("a stalled response aborts and removes scratch without becoming an integrity failure", async () => {
    const dir = await mkdtemp(join(tmpdir(), "genesis-bootstrap-"));
    let observedSignal: AbortSignal | undefined;
    try {
      const object = { uri: "s3://bucket/state", sha256: digest("data"), bytes: 4 };
      const stalled = downloadBootstrapObject(object, join(dir, "state"), async (_uri, _version, signal) => {
        observedSignal = signal;
        return new Response(new ReadableStream({ start(controller) {
          controller.enqueue(new TextEncoder().encode("d"));
          signal!.addEventListener("abort", () => controller.error(signal!.reason), { once: true });
        } }));
      }, undefined, { stallTimeoutMs: 10 });
      let failure: unknown;
      try { await stalled; } catch (error) { failure = error; }
      expect(observedSignal?.aborted).toBe(true);
      expect(failure).toBeInstanceOf(Error);
      expect(failure).not.toBeInstanceOf(BootstrapIntegrityError);
      expect((failure as Error).message).toContain("stalled");
      expect(await readdir(dir)).toEqual([]);
      await downloadBootstrapObject(object, join(dir, "state"), async () => new Response("data"));
      expect(await readFile(join(dir, "state"), "utf8")).toBe("data");
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  test("restart reclaims only worker partials and preserves verified files", async () => {
    const dir = await mkdtemp(join(tmpdir(), "genesis-bootstrap-"));
    const name = `state-${"a".repeat(64)}.jsonl`;
    try {
      await writeFile(join(dir, name + ".partial-1234"), "partial");
      await writeFile(join(dir, name), "complete");
      await writeFile(join(dir, "unrelated.partial-1234"), "other");
      await prepareBootstrapScratch(dir);
      expect((await readdir(dir)).sort()).toEqual([name, "unrelated.partial-1234"].sort());
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  test("completion releases only the matching artifact scratch and is repeatable", async () => {
    const dir = await mkdtemp(join(tmpdir(), "genesis-bootstrap-"));
    const reference = parseBootstrapReference(fixture());
    const name = `state-${reference.sha256}.jsonl`;
    try {
      for (const file of [name, name + ".manifest.json", "other-import.jsonl"]) await writeFile(join(dir, file), "fixture");
      await releaseBootstrapScratch(reference, dir);
      await releaseBootstrapScratch(reference, dir);
      expect(await readdir(dir)).toEqual(["other-import.jsonl"]);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  test("rejects a validly hashed manifest for another chain before fetching the dump", async () => {
    const dir = await mkdtemp(join(tmpdir(), "genesis-bootstrap-"));
    const manifest = JSON.stringify({ chainId: 99, count: 3, stateRoot: fixture().stateRoot });
    const ref = parseBootstrapReference({ ...fixture(), manifestSha256: digest(manifest), manifestBytes: manifest.length });
    let calls = 0;
    try {
      await expect(downloadGenesisBootstrap(ref, dir, async () => { calls++; return new Response(manifest); })).rejects.toBeInstanceOf(BootstrapIntegrityError);
      expect(calls).toBe(1);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  test("signs range and pinning headers", async () => {
    let request: Request | undefined;
    const fetcher = createBootstrapFetcher(parseBootstrapReference(fixture()), { accessKeyId: "example", secretAccessKey: "secret" },
      (async (input: Request) => { request = input; return new Response("data"); }) as typeof fetch);
    await fetcher("s3://private/state.jsonl", undefined, undefined, { range: "bytes=0-9", "if-match": "\"tag\"" });
    expect(request!.headers.get("range")).toBe("bytes=0-9");
    expect(request!.headers.get("if-match")).toBe("\"tag\"");
    expect(request!.headers.get("authorization")).toMatch(/SignedHeaders=[^,]*if-match/);
  });

  test("download tuning accepts bounded overrides only", () => {
    expect(bootstrapDownloadTuning({})).toEqual({});
    expect(bootstrapDownloadTuning({ GENESIS_BOOTSTRAP_PART_BYTES: String(8 * 1024 * 1024), GENESIS_BOOTSTRAP_CONCURRENCY: "4" }))
      .toEqual({ partBytes: 8 * 1024 * 1024, concurrency: 4 });
    for (const env of [{ GENESIS_BOOTSTRAP_PART_BYTES: "10" }, { GENESIS_BOOTSTRAP_CONCURRENCY: "0" }, { GENESIS_BOOTSTRAP_CONCURRENCY: "2.5" }]) {
      expect(() => bootstrapDownloadTuning(env)).toThrow();
    }
  });
});

type Fault = "drop" | "stall" | "shifted" | "overrun" | "whole" | "changed" | "wrong-total" | undefined;

/** In-memory object store answering signed-GET semantics: ranges, ETag pinning and injected faults. */
function rangedStore(data: Uint8Array, options: { etag?: string; fault?: (start: number, attempt: number) => Fault; onRequest?: (start: number) => void } = {}) {
  const etag = options.etag ?? "\"v1\"";
  const requests: { start: number; end: number; ifMatch: string | null }[] = [];
  const attempts = new Map<number, number>();
  const served = new Map<number, number>();
  const fetcher: BootstrapFetch = async (_uri, _versionId, signal, headers) => {
    const match = /^bytes=(\d+)-(\d+)$/.exec(headers?.range ?? "");
    if (!match) return new Response(data.slice());
    const start = Number(match[1]);
    const end = Math.min(Number(match[2]), data.length - 1);
    const ifMatch = headers?.["if-match"] ?? null;
    requests.push({ start, end, ifMatch });
    options.onRequest?.(start);
    const attempt = (attempts.get(start) ?? 0) + 1;
    attempts.set(start, attempt);
    const fault = options.fault?.(start, attempt);
    if (fault === "whole") return new Response(data.slice());
    if (fault === "changed" || (ifMatch !== null && ifMatch !== etag)) return new Response(null, { status: 412 });
    const body = data.slice(start, end + 1);
    const total = fault === "wrong-total" ? data.length + 1 : data.length;
    const contentRange = fault === "shifted" ? `bytes ${start + 1}-${end + 1}/${total}` : `bytes ${start}-${end}/${total}`;
    const payload = fault === "overrun" ? new Uint8Array([...body, 0x78]) : fault === "shifted" ? body.map(() => 0x78) : body;
    const count = (n: number) => served.set(start, (served.get(start) ?? 0) + n);
    const stream = new ReadableStream<Uint8Array>({ start(controller) {
      if (fault === "drop" || fault === "stall") {
        const half = payload.slice(0, Math.floor(payload.length / 2));
        controller.enqueue(half);
        count(half.length);
        if (fault === "drop") controller.error(Object.assign(new Error("socket closed"), { code: "ECONNRESET" }));
        else if (signal?.aborted) controller.error(signal.reason);
        else signal?.addEventListener("abort", () => controller.error(signal.reason), { once: true });
        return;
      }
      controller.enqueue(payload);
      count(payload.length);
      controller.close();
    } });
    return new Response(stream, { status: 206, headers: { "content-range": contentRange, etag } });
  };
  return { fetcher, requests, attempts, served };
}

const randomBytes = (length: number) => Uint8Array.from({ length }, (_, i) => (i * 7919 + 13) % 251);
const sha = (data: Uint8Array) => createHash("sha256").update(data).digest("hex");
const fast = (log: string[], extra: BootstrapDownloadOptions = {}): BootstrapDownloadOptions => ({
  partBytes: 1000, concurrency: 3, retryInitialMs: 1, retryMaxMs: 4, stallTimeoutMs: 1_000,
  freeBytes: async () => Number.MAX_SAFE_INTEGER, log: (message) => log.push(message), ...extra });
async function withScratch(run: (dir: string) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), "genesis-bootstrap-"));
  try { await run(dir); } finally { await rm(dir, { recursive: true, force: true }); }
}

describe("resumable ranged genesis bootstrap download", () => {
  const data = randomBytes(5500);
  const object = { uri: "s3://bucket/state", sha256: sha(data), bytes: data.length };

  test("repeated mid-part failures complete with a correct file and fetch each byte once apart from retried parts", () => withScratch(async (dir) => {
    const path = join(dir, "state");
    const log: string[] = [];
    const store = rangedStore(data, { fault: (start, attempt) => (start === 1000 || start === 4000) && attempt <= 2 ? "drop" : undefined });
    await downloadBootstrapObject(object, path, store.fetcher, undefined, fast(log));
    expect(new Uint8Array(await readFile(path))).toEqual(data);
    expect((await readdir(dir)).sort()).toEqual(["state"]);
    for (let start = 0; start < data.length; start += 1000) {
      const retried = start === 1000 || start === 4000;
      const length = Math.min(1000, data.length - start);
      expect(store.attempts.get(start)).toBe(retried ? 3 : 1);
      expect(store.served.get(start)).toBe(retried ? length + 2 * Math.floor(length / 2) : length);
    }
    expect(store.requests.filter((r) => r.start > 0).every((r) => r.ifMatch === "\"v1\"")).toBe(true);
    expect(log.some((line) => /^bootstrap object part 1 interrupted at 0\.0 of 0\.0 MB: connection reset; retrying in 0\.001 s$/.test(line))).toBe(true);
    expect(log.some((line) => line.startsWith("downloading bootstrap object: 100% (0.0 of 0.0 GB)"))).toBe(true);
  }));

  test("a restart resumes from the sidecar and fetches only missing parts", () => withScratch(async (dir) => {
    const path = join(dir, "state");
    const stop = new AbortController();
    const first = rangedStore(data, { onRequest: (start) => { if (start === 3000) stop.abort(); },
      fault: (start) => start === 3000 ? "stall" : undefined });
    await expect(downloadBootstrapObject(object, path, first.fetcher, stop.signal, fast([], { concurrency: 1 }))).rejects.toBeDefined();
    const sidecar = JSON.parse(await readFile(`${path}.parts`, "utf8"));
    expect(sidecar).toEqual({ version: 1, etag: "\"v1\"", bytes: data.length, partBytes: 1000, done: [0, 1, 2] });
    expect((await stat(`${path}.partial`)).size).toBe(data.length);

    // A changed part-size setting does not reshape an existing sidecar.
    const log: string[] = [];
    const second = rangedStore(data);
    await downloadBootstrapObject(object, path, second.fetcher, undefined, fast(log, { partBytes: 4096 }));
    expect(new Uint8Array(await readFile(path))).toEqual(data);
    expect(second.requests.map((r) => [r.start, r.end, r.ifMatch]).sort()).toEqual([[3000, 3999, "\"v1\""], [4000, 4999, "\"v1\""], [5000, 5499, "\"v1\""]]);
    expect(log).toContain("resuming bootstrap object download: 3 of 6 parts present (0.0 of 0.0 GB)");
    expect(await readdir(dir)).toEqual(["state"]);
  }));

  test("an unreadable or foreign sidecar is discarded with its partial", () => withScratch(async (dir) => {
    const path = join(dir, "state");
    for (const sidecar of ["not json", JSON.stringify({ version: 1, etag: "\"v1\"", bytes: 9, partBytes: 1000, done: [0] })]) {
      await writeFile(`${path}.partial`, new Uint8Array(data.length));
      await writeFile(`${path}.parts`, sidecar);
      const store = rangedStore(data);
      await downloadBootstrapObject(object, path, store.fetcher, undefined, fast([]));
      expect(new Uint8Array(await readFile(path))).toEqual(data);
      expect(store.requests[0]).toEqual({ start: 0, end: 999, ifMatch: null });
      await rm(path);
    }
  }));

  test("a 412 restarts the download from a fresh first request", () => withScratch(async (dir) => {
    const path = join(dir, "state");
    await writeFile(`${path}.partial`, new Uint8Array(data.length).fill(0x78));
    await writeFile(`${path}.parts`, JSON.stringify({ version: 1, etag: "\"v0\"", bytes: data.length, partBytes: 1000, done: [0, 1] }));
    const log: string[] = [];
    const store = rangedStore(data, { etag: "\"v2\"" });
    await downloadBootstrapObject(object, path, store.fetcher, undefined, fast(log, { concurrency: 1 }));
    expect(new Uint8Array(await readFile(path))).toEqual(data);
    expect(store.requests[0]).toEqual({ start: 2000, end: 2999, ifMatch: "\"v0\"" });
    expect(store.requests[1]).toEqual({ start: 0, end: 999, ifMatch: null });
    expect(store.requests.slice(2).every((r) => r.ifMatch === "\"v2\"")).toBe(true);
    expect(log).toContain("bootstrap object changed in object storage; restarting the download");
    expect(await readdir(dir)).toEqual(["state"]);
  }));

  test("storage that refuses its own ETag restarts once, then returns to the worker loop", () => withScratch(async (dir) => {
    const log: string[] = [];
    const store = rangedStore(data, { fault: (start) => start > 0 ? "changed" : undefined });
    const failure = await downloadBootstrapObject(object, join(dir, "state"), store.fetcher, undefined, fast(log))
      .then(() => undefined, (error: unknown) => error);
    expect(failure).toBeInstanceOf(Error);
    expect(failure).not.toBeInstanceOf(BootstrapIntegrityError);
    expect(store.attempts.get(0)).toBe(2);
    expect(log.filter((line) => line === "bootstrap object changed in object storage; restarting the download")).toHaveLength(1);
    expect(await readdir(dir)).toEqual([]);
  }));

  test("a 200 to a range request falls back to one stream", () => withScratch(async (dir) => {
    const path = join(dir, "state");
    const log: string[] = [];
    const store = rangedStore(data, { fault: () => "whole" });
    await downloadBootstrapObject(object, path, store.fetcher, undefined, fast(log));
    expect(new Uint8Array(await readFile(path))).toEqual(data);
    expect(store.requests.length).toBe(1);
    expect(log).toEqual(["object storage does not support range requests; downloading bootstrap object as one stream without resume"]);
    expect(await readdir(dir)).toEqual(["state"]);
  }));

  test("a range response with a mismatched Content-Range or extra bytes is rejected before writing", () => withScratch(async (dir) => {
    const path = join(dir, "state");
    const log: string[] = [];
    const store = rangedStore(data, { fault: (start, attempt) => attempt === 1 && start === 2000 ? "shifted" : attempt === 1 && start === 3000 ? "overrun" : undefined });
    await downloadBootstrapObject(object, path, store.fetcher, undefined, fast(log));
    expect(new Uint8Array(await readFile(path))).toEqual(data);
    expect(log.some((line) => line.startsWith("bootstrap object part 2 interrupted at 0.0 of 0.0 MB: range mismatch"))).toBe(true);
    expect(log.some((line) => line.startsWith("bootstrap object part 3 interrupted at 0.0 of 0.0 MB: range overrun"))).toBe(true);
  }));

  test("a total size different from the reference is an integrity error", () => withScratch(async (dir) => {
    const store = rangedStore(data, { fault: () => "wrong-total" });
    await expect(downloadBootstrapObject(object, join(dir, "state"), store.fetcher, undefined, fast([]))).rejects.toBeInstanceOf(BootstrapIntegrityError);
    expect(await readdir(dir)).toEqual([]);
  }));

  test("corrupted parts fail the whole-file check as an integrity error", () => withScratch(async (dir) => {
    const store = rangedStore(data);
    const wrong = { ...object, sha256: "0".repeat(64) };
    await expect(downloadBootstrapObject(wrong, join(dir, "state"), store.fetcher, undefined, fast([]))).rejects.toBeInstanceOf(BootstrapIntegrityError);
    expect(await readdir(dir)).toEqual([]);
  }));

  test("low free space reports and retries without a durable failure", () => withScratch(async (dir) => {
    const path = join(dir, "state");
    await writeFile(`${path}.partial`, data);
    await writeFile(`${path}.parts`, JSON.stringify({ version: 1, etag: "\"v1\"", bytes: data.length, partBytes: 1000, done: [0, 1, 2, 3] }));
    const store = rangedStore(data);
    let needed = 0;
    const failure = await downloadBootstrapObject(object, path, store.fetcher, undefined, fast([], { freeBytes: async () => 1_499 }))
      .then(() => undefined, (error: unknown) => error);
    expect(failure).toBeInstanceOf(BootstrapScratchSpaceError);
    expect(failure).not.toBeInstanceOf(BootstrapIntegrityError);
    expect((failure as Error).message).toBe("insufficient scratch space: need 0.0 GB, have 0.0 GB");
    expect(store.requests).toEqual([]);
    expect((await readdir(dir)).sort()).toEqual(["state.partial", "state.parts"]);
    await downloadBootstrapObject(object, path, store.fetcher, undefined, fast([], { freeBytes: async (target) => { needed++; expect(target).toBe(dir); return 1_500; } }));
    expect(needed).toBe(1);
    expect(store.requests.map((r) => r.start).sort()).toEqual([4000, 5000]);
    expect(new Uint8Array(await readFile(path))).toEqual(data);
  }));

  test("a stalled part retries without failing the download", () => withScratch(async (dir) => {
    const path = join(dir, "state");
    const log: string[] = [];
    const store = rangedStore(data, { fault: (start, attempt) => start === 2000 && attempt === 1 ? "stall" : undefined });
    await downloadBootstrapObject(object, path, store.fetcher, undefined, fast(log, { stallTimeoutMs: 20 }));
    expect(new Uint8Array(await readFile(path))).toEqual(data);
    expect(store.attempts.get(2000)).toBe(2);
    expect(log.some((line) => line.startsWith("bootstrap object part 2 interrupted at 0.0 of 0.0 MB: stalled; retrying in"))).toBe(true);
  }));

  test("a part that keeps failing returns to the worker loop and keeps finished parts", () => withScratch(async (dir) => {
    const path = join(dir, "state");
    await writeFile(`${path}.partial`, data);
    await writeFile(`${path}.parts`, JSON.stringify({ version: 1, etag: "\"v1\"", bytes: data.length, partBytes: 1000, done: [0, 1, 2, 3] }));
    const log: string[] = [];
    let refused = 0;
    const failure = await downloadBootstrapObject(object, path, async () => { refused++; return new Response(null, { status: 404 }); },
      undefined, fast(log, { concurrency: 1 })).then(() => undefined, (error: unknown) => error);
    expect(failure).toBeInstanceOf(Error);
    expect(failure).not.toBeInstanceOf(BootstrapIntegrityError);
    expect(refused).toBe(8);
    expect(log.filter((line) => line.startsWith("bootstrap object part 4 interrupted at 0.0 of 0.0 MB: HTTP 404; retrying in"))).toHaveLength(7);
    expect((await readdir(dir)).sort()).toEqual(["state.partial", "state.parts"]);
    const store = rangedStore(data);
    await downloadBootstrapObject(object, path, store.fetcher, undefined, fast([]));
    expect(store.requests.map((r) => r.start).sort()).toEqual([4000, 5000]);
    expect(new Uint8Array(await readFile(path))).toEqual(data);
  }));

  test("download start removes other artifacts' resume files; release removes its own", () => withScratch(async (dir) => {
    const manifestText = JSON.stringify({ chainId: 42, count: 3, stateRoot: fixture().stateRoot });
    const manifestData = new TextEncoder().encode(manifestText);
    const reference = parseBootstrapReference({ ...fixture(), sha256: sha(data), bytes: data.length,
      manifestSha256: sha(manifestData), manifestBytes: manifestData.length });
    const own = `state-${reference.sha256}.jsonl`;
    const other = `state-${"e".repeat(64)}.jsonl`;
    const legacy = `${own}.partial-0123abcd`;
    for (const name of [`${other}.partial`, `${other}.parts`, `${other}.manifest.json.partial`, `${other}.manifest.json.parts`, `${other}.parts.tmp`, legacy, "unrelated.partial"]) {
      await writeFile(join(dir, name), "fixture");
    }
    await prepareBootstrapScratch(dir);
    expect(await readdir(dir)).not.toContain(legacy);
    const dumpStore = rangedStore(data);
    const manifestStore = rangedStore(manifestData);
    const fetcher: BootstrapFetch = (uri, ...rest) => (uri === reference.manifestUri ? manifestStore : dumpStore).fetcher(uri, ...rest);
    const files = await downloadGenesisBootstrap(reference, dir, fetcher, undefined, fast([]));
    expect(new Uint8Array(await readFile(files.dump))).toEqual(data);
    expect((await readdir(dir)).sort()).toEqual([own, `${own}.manifest.json`, "unrelated.partial"].sort());

    for (const suffix of [".partial", ".parts", ".parts.tmp", ".manifest.json.partial", ".manifest.json.parts"]) await writeFile(join(dir, own + suffix), "fixture");
    await releaseBootstrapScratch(reference, dir);
    expect(await readdir(dir)).toEqual(["unrelated.partial"]);
  }));
});

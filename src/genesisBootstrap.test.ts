import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { BootstrapIntegrityError, bootstrapDisposition, createBootstrapFetcher, downloadBootstrapObject, downloadGenesisBootstrap, parseBootstrapReference, prepareBootstrapScratch, releaseBootstrapScratch } from "./genesisBootstrap";

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
      }, undefined, 10);
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
});

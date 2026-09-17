import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GenesisProgressTracker, createGenesisProgressFileWriter, describeGenesisProgress, formatBytes, formatDuration } from "./genesisProgress";

describe("GenesisProgressTracker", () => {
  const clock = (start = 1_000_000) => {
    let at = start;
    return { now: () => at, tick: (ms: number) => (at += ms) };
  };

  test("books phases, elapsed times, rates and an ETA", () => {
    const time = clock();
    const tracker = new GenesisProgressTracker({ writer: "import-script", source: "dump", now: time.now, pid: 42 });
    tracker.doc.entities.total = 1000;
    tracker.doc.dump = { path: "/seed/state.jsonl", bytes_total: 10_000, bytes_read: 0, bytes_per_s: null, eta_s: null, lines: 0, records: 0, system_account: { seen: false, ids: 0, entity_count: null }, verification: "pending" };
    time.tick(500);
    tracker.setPhase("checking");
    time.tick(1500);
    tracker.setPhase("loading");
    tracker.sample();
    time.tick(10_000);
    tracker.doc.entities.imported = 250;
    tracker.doc.dump.bytes_read = 2500;
    tracker.sample();
    const doc = tracker.snapshot();
    expect(doc).toMatchObject({
      tool: "arkiv-chain-indexer",
      format: 1,
      writer: "import-script",
      phase: "loading",
      pid: 42,
      started_at: 1000,
      updated_at: 1012,
      elapsed_s: 12,
      phase_elapsed_s: 10,
      phases: { starting: 0.5, checking: 1.5 },
      entities: { total: 1000, imported: 250, rate_per_s: 25, eta_s: 30 },
    });
    expect(doc.dump).toMatchObject({ bytes_per_s: 250, eta_s: 30 });
    // 1 % after checking, 85 % after loading; a quarter of the bytes read.
    expect(doc.percent).toBe(22);
    expect(doc.finished_at).toBeNull();
    tracker.setPhase("done");
    expect(tracker.snapshot()).toMatchObject({ percent: 100, finished_at: 1012, phases: { loading: 10 } });
  });

  test("the snapshot is a copy", () => {
    const tracker = new GenesisProgressTracker({ writer: "backend" });
    const snapshot = tracker.snapshot();
    snapshot.entities.imported = 5;
    expect(tracker.doc.entities.imported).toBe(0);
  });

  test("the backend's walk reports percent by entities and a caller-supplied start", () => {
    const time = clock(50_000);
    const tracker = new GenesisProgressTracker({ writer: "backend", source: "rpc", now: time.now, startedAt: 20_000 });
    tracker.setPhase("walking");
    tracker.doc.entities.total = 200;
    tracker.doc.entities.imported = 100;
    const doc = tracker.snapshot();
    expect(doc.percent).toBe(47.5);
    expect(doc.elapsed_s).toBe(30);
    expect(doc.started_at).toBe(20);
    tracker.setPhase("repairing");
    expect(tracker.snapshot().percent).toBe(95);
  });

  test("describes itself in one line", () => {
    const tracker = new GenesisProgressTracker({ writer: "import-script", now: () => 0 });
    tracker.doc.entities.total = 28_825;
    tracker.doc.entities.imported = 12_000;
    tracker.setPhase("loading");
    expect(describeGenesisProgress(tracker.snapshot())).toBe("loading 1.0%, 12,000/28,825 entities, elapsed 0s");
    tracker.doc.error = "boom";
    tracker.setPhase("failed");
    expect(describeGenesisProgress(tracker.snapshot())).toContain("error: boom");
  });

  test("formats sizes and durations", () => {
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(529_266_475)).toBe("504.7 MiB");
    expect(formatDuration(59)).toBe("59s");
    expect(formatDuration(61)).toBe("1m01s");
    expect(formatDuration(3_700)).toBe("1h01m");
  });
});

describe("createGenesisProgressFileWriter", () => {
  test("writes atomically into a directory it creates, coalescing bursts", async () => {
    const dir = await mkdtemp(join(tmpdir(), "genesis-progress-"));
    const path = join(dir, "index", "progress.json");
    const writer = createGenesisProgressFileWriter(path);
    const tracker = new GenesisProgressTracker({ writer: "import-script" });
    const writes: Promise<void>[] = [];
    for (let i = 1; i <= 5; i++) {
      tracker.doc.entities.imported = i;
      writes.push(writer.write(tracker.snapshot()));
    }
    await Promise.all(writes);
    await writer.flush();
    const written = JSON.parse(await readFile(path, "utf8")) as { entities: { imported: number } };
    expect(written.entities.imported).toBe(5);
    expect(await readdir(join(dir, "index"))).toEqual(["progress.json"]); // no temporary file left behind
  });

  test("reports a failing write once and keeps going", async () => {
    const lines: string[] = [];
    const writer = createGenesisProgressFileWriter("/proc/genesis-progress/impossible.json", (line) => lines.push(line));
    const tracker = new GenesisProgressTracker({ writer: "backend" });
    await writer.write(tracker.snapshot());
    await writer.write(tracker.snapshot());
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("/proc/genesis-progress/impossible.json");
  });
});

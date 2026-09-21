import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { IndexerStatistics, StatisticsResponse } from "./indexerStatisticsTypes";

/** Atomic replacement lets the backend keep serving while a sweep writes its result. */
export async function writeStatisticsFile(path: string, snapshot: IndexerStatistics): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${crypto.randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(snapshot)}\n`);
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}

/** File reads coalesce and are capped at one per second; requests never query PostgreSQL. */
export class StatisticsFileReader {
  private snapshot: IndexerStatistics | null = null;
  private nextReadAt = 0;
  private reading: Promise<void> | undefined;

  constructor(private readonly path: string, private readonly now: () => number = Date.now) {}

  async get(): Promise<StatisticsResponse | null> {
    if (!this.reading && this.now() >= this.nextReadAt) {
      this.reading = this.read().finally(() => {
        this.nextReadAt = this.now() + 1000;
        this.reading = undefined;
      });
    }
    await this.reading;
    if (!this.snapshot) return null;
    const ageMs = Math.max(0, this.now() - Date.parse(this.snapshot.gatheredAtUtc));
    return {
      ...this.snapshot,
      ageSeconds: ageMs / 1000,
      stale: ageMs > this.snapshot.refreshIntervalMs * 2 + this.snapshot.durationMs,
    };
  }

  private async read(): Promise<void> {
    try {
      const candidate = JSON.parse(await readFile(this.path, "utf8")) as IndexerStatistics;
      if (candidate.version !== 1 || !Number.isFinite(Date.parse(candidate.gatheredAtUtc)) ||
          !Number.isFinite(candidate.refreshIntervalMs) || candidate.refreshIntervalMs <= 0 ||
          !Number.isFinite(candidate.durationMs) || candidate.durationMs < 0 ||
          !candidate.chain || !candidate.blocks || !candidate.transactions || !candidate.operations || !candidate.entities ||
          !Array.isArray(candidate.limitations)) return;
      this.snapshot = candidate;
    } catch {
      // Missing/invalid file: retain the last good snapshot, whose age continues increasing.
    }
  }
}

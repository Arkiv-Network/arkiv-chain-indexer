import { SimulatorError, fail } from "./common";
import type { SimulatorSource } from "./source";
import type { SimulatorStorage } from "./storage";
/** One bounded block at a time; storage owns the atomic projection/progress boundary. */
export async function scanTick(
  source: SimulatorSource,
  storage: SimulatorStorage,
  maxBlocks = 64,
): Promise<number> {
  const status = await source.status();
  await storage.observe(status);
  const progress = await storage.progress();
  let next = progress.height === null ? 0n : BigInt(progress.height) + 1n,
    count = 0;
  while (next <= BigInt(status.head.height) && count < maxBlocks) {
    const block = await source.block(next.toString());
    if (Number.parseInt(block.header.headerBytes.slice(2, 10), 16) !== status.protocolVersion)
      return fail("UnsupportedVersion");
    if (
      block.header.height === status.head.height &&
      (block.header.hash !== status.head.hash ||
        block.header.stateRoot !== status.head.stateRoot)
    )
      return fail("ChainConflict", 409);
    await storage.ingest(block);
    count++;
    next++;
  }
  await storage.health("running");
  return count;
}
export async function runNativeScanner(
  source: SimulatorSource,
  storage: SimulatorStorage,
  pollMs = 1000,
  signal?: AbortSignal,
): Promise<void> {
  // Container restarts must not erase a permanent identity/protocol/conflict fence.
  // Only known availability failures may resume automatically; operator recovery
  // uses a reviewed new projection schema/run, never a public clear-fence endpoint.
  const { health } = await storage.progress();
  if (
    ![
      "initializing",
      "running",
      "StorageUnavailable",
      "StorageCorrupt",
      "SourceBehind",
      "Transport",
      "HistoryUnavailable",
      "UpstreamUnavailable",
    ].includes(health)
  )
    return fail(health, 409);
  let failures = 0;
  while (!signal?.aborted) {
    try {
      const n = await scanTick(source, storage);
      failures = 0;
      if (n === 64) continue;
    } catch (error) {
      const code =
        error instanceof SimulatorError ? error.code : "StorageUnavailable";
      await storage.health(code).catch(() => {});
      // Never log bodies, attributes, upstream URLs, database statements or parameters.
      console.warn("Simulator scanner stopped at current block", { code });
      if (
        error instanceof SimulatorError &&
        error.status < 500 &&
        error.status !== 429
      )
        throw error;
      failures++;
    }
    await new Promise<void>((resolve) => {
      const done = () => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", done);
        resolve();
      };
      const timer = setTimeout(
        done,
        failures ? Math.min(5000, 250 * 2 ** Math.min(failures, 5)) : pollMs,
      );
      signal?.addEventListener("abort", done, { once: true });
    });
  }
}

import { parseServerConfig, ServerHelpRequested } from "./serverConfig";
import { buildSyncStatusResponse, createBlockServer } from "./server";
import { ScannerStorage } from "./storage";
import { RedisGuzzlerStore } from "./guzzlerStore";
import { parseBaseloadRuntimeConfig, readBaseloadConfigFile } from "./baseloadConfig";
import { BaseloadRuntime } from "./baseloadRuntime";
import { PrecomputedResponse } from "./precomputedResponse";
import { ResponseCache } from "./responseCache";
import { PayloadProviderPaymentResolver } from "./payloadProviderPayments";
import type { GuzzlerStore } from "./guzzlers";

async function main(): Promise<void> {
  let storage: ScannerStorage | undefined;
  let guzzlerStore: GuzzlerStore | undefined;
  let baseloadRuntime: BaseloadRuntime | undefined;
  let stopEntityInvalidationListener: (() => Promise<void>) | undefined;
  let stopStoredBlockListener: (() => Promise<void>) | undefined;
  let syncPrecomputer: PrecomputedResponse | undefined;

  try {
    const config = parseServerConfig(process.argv.slice(2));
    storage = await ScannerStorage.open(config.databaseUrl);
    if (config.redisUrl) {
      guzzlerStore = await RedisGuzzlerStore.open(config.redisUrl);
    }
    const entityHistoryCache = new ResponseCache({
      maxEntries: config.entityCacheMaxEntries,
      maxBytes: config.entityCacheMaxBytes,
      ttlMs: config.entityCacheTtlMs,
    });
    if (entityHistoryCache.enabled) {
      // Evict a key's cached history the moment any writer (scanner, gap
      // filler, backfill) commits operations for it. If the LISTEN
      // subscription cannot be established the cache still self-heals via
      // its TTL, so this is a warning rather than a startup failure.
      try {
        stopEntityInvalidationListener = await storage.listenForEntityOperationChanges(
          (entityKey) => entityHistoryCache.invalidate(entityKey),
        );
      } catch (error) {
        console.warn(
          `Entity cache invalidation listener failed to start; relying on the ${config.entityCacheTtlMs}ms TTL only:`,
          error,
        );
      }
    }

    // /sync is served from an actively precomputed body: recomputed right
    // after every stored-block notification (bursts coalesced) and on a
    // periodic refresh so lag keeps growing when the scanner stalls.
    const storageForSync = storage;
    if (config.syncRefreshMs > 0) {
      syncPrecomputer = new PrecomputedResponse(() => buildSyncStatusResponse(storageForSync), {
        refreshIntervalMs: config.syncRefreshMs,
        onError: (error) => console.warn("Precomputed /sync refresh failed:", error),
      });
      await syncPrecomputer.start();
    }
    // /blocks and /ranges responses (plain and zstd variants) are cached per
    // query string and dropped the moment a block lands; the TTL backstops
    // missed notifications and aggregator writes to block_ranges.
    const listCache = new ResponseCache({
      maxEntries: config.listCacheMaxEntries,
      maxBytes: config.listCacheMaxBytes,
      ttlMs: config.listCacheTtlMs,
    });
    if (syncPrecomputer || listCache.enabled) {
      const precomputer = syncPrecomputer;
      try {
        stopStoredBlockListener = await storage.listenForStoredBlocks(() => {
          precomputer?.markDirty();
          listCache.clear();
        });
      } catch (error) {
        console.warn(
          "Stored-block listener failed to start; /sync falls back to its periodic refresh and the list cache to its TTL:",
          error,
        );
      }
    }
    const baseloadRuntimeConfig = parseBaseloadRuntimeConfig();
    baseloadRuntime = new BaseloadRuntime(baseloadRuntimeConfig);
    if (config.baseloadInitialConfigPath) {
      const initialBaseloadConfig = await readBaseloadConfigFile(
        config.baseloadInitialConfigPath,
        baseloadRuntimeConfig.mnemonic,
      );
      baseloadRuntime.updateConfig(initialBaseloadConfig);
      console.log(
        `Loaded initial Baseload config from ${config.baseloadInitialConfigPath} ` +
          `(${initialBaseloadConfig.workers.length} workers)`,
      );
    }
    const payloadProviderPaymentResolver =
      config.protocolScheduleUrl ||
      config.protocolSchedulePath ||
      config.payloadProviderPaymentShareBps !== undefined
        ? new PayloadProviderPaymentResolver({
            ...(config.protocolScheduleUrl ? { scheduleUrl: config.protocolScheduleUrl } : {}),
            ...(config.protocolSchedulePath ? { schedulePath: config.protocolSchedulePath } : {}),
            ...(config.payloadProviderPaymentShareBps !== undefined
              ? { providerShareBps: config.payloadProviderPaymentShareBps }
              : {}),
          })
        : undefined;
    const server = createBlockServer(storage, {
      port: config.port,
      ...(config.hostname !== undefined ? { hostname: config.hostname } : {}),
      transactionDataEnabled: config.transactionDataEnabled,
      baseloadRuntime,
      ...(config.baseloadAdminBearerToken !== undefined
        ? { baseloadAdminBearerToken: config.baseloadAdminBearerToken }
        : {}),
      ...(guzzlerStore ? { guzzlerStore } : {}),
      ...(payloadProviderPaymentResolver ? { payloadProviderPaymentResolver } : {}),
      entityHistoryCache,
      entityHistoryLimit: config.entityHistoryLimit,
      listCache,
      ...(syncPrecomputer ? { syncStatusProvider: syncPrecomputer } : {}),
    });
    console.log(`Block server listening on http://${server.hostname}:${server.port}`);
    console.log(`Guzzler statistics: ${guzzlerStore ? "enabled" : "disabled"}`);
    console.log(
      entityHistoryCache.enabled
        ? `Entity history cache: up to ${config.entityCacheMaxEntries} entries / ` +
            `${config.entityCacheMaxBytes} bytes, TTL ${config.entityCacheTtlMs}ms, ` +
            `invalidation ${stopEntityInvalidationListener ? "via NOTIFY" : "by TTL only"}; ` +
            `history limit ${config.entityHistoryLimit} operations`
        : `Entity history cache: disabled; history limit ${config.entityHistoryLimit} operations`,
    );
    console.log(
      syncPrecomputer
        ? `Precomputed /sync: refresh every ${config.syncRefreshMs}ms, ` +
            `block-driven recompute ${stopStoredBlockListener ? "via NOTIFY" : "unavailable"}`
        : "Precomputed /sync: disabled (computed per request)",
    );
    console.log(
      listCache.enabled
        ? `Blocks/ranges cache: up to ${config.listCacheMaxEntries} entries / ` +
            `${config.listCacheMaxBytes} bytes, TTL ${config.listCacheTtlMs}ms, ` +
            `cleared ${stopStoredBlockListener ? "on stored-block NOTIFY" : "by TTL only"}`
        : "Blocks/ranges cache: disabled",
    );

    const shutdown = async () => {
      baseloadRuntime?.stop();
      syncPrecomputer?.stop();
      await server.stop();
      await stopEntityInvalidationListener?.();
      await stopStoredBlockListener?.();
      await guzzlerStore?.close();
      await storage?.close();
      process.exit(0);
    };

    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
  } catch (error) {
    if (error instanceof ServerHelpRequested) {
      console.log(error.message);
      return;
    }

    console.error(error);
    baseloadRuntime?.stop();
    syncPrecomputer?.stop();
    await stopEntityInvalidationListener?.();
    await stopStoredBlockListener?.();
    await guzzlerStore?.close();
    await storage?.close();
    process.exitCode = 1;
  }
}

await main();

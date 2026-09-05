import { parseServerConfig, ServerHelpRequested } from "./serverConfig";
import { buildSyncStatusResponse, createBlockServer } from "./server";
import { ScannerStorage } from "./storage";
import { RedisGuzzlerStore } from "./guzzlerStore";
import { parseBaseloadRuntimeConfig, readBaseloadConfigFile } from "./baseloadConfig";
import { BaseloadRuntime } from "./baseloadRuntime";
import { PrecomputedResponse } from "./precomputedResponse";
import { ResponseCache } from "./responseCache";
import { ValueCache } from "./valueCache";
import { PayloadProviderPaymentResolver } from "./payloadProviderPayments";
import { JsonRpcPassthrough } from "./jsonRpcPassthrough";
import { EntityIndexStorage } from "./entityIndexStorage";
import { EntityProjector } from "./entityProjector";
import type { GuzzlerStore } from "./guzzlers";
import { collectIndexerProgress, collectResponseCache, collectValueCache } from "./serverMetrics";

async function main(): Promise<void> {
  let storage: ScannerStorage | undefined;
  let guzzlerStore: GuzzlerStore | undefined;
  let baseloadRuntime: BaseloadRuntime | undefined;
  let stopEntityInvalidationListener: (() => Promise<void>) | undefined;
  let stopStoredBlockListener: (() => Promise<void>) | undefined;
  let syncPrecomputer: PrecomputedResponse | undefined;
  let entityIndex: EntityIndexStorage | undefined;
  let entityProjector: EntityProjector | undefined;

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
    // /transactions pagination totals, keyed by filter. An unfiltered COUNT(*)
    // scans every transaction row, so without this the endpoint re-counts the
    // whole table per request and starves every other query on the pool. The
    // totals only change when new transactions land, so this is cleared by the
    // same stored-block notification as the list cache.
    const transactionCountCache = new ValueCache<number>({
      maxEntries: config.transactionCountCacheMaxEntries,
      ttlMs: config.transactionCountCacheTtlMs,
    });
    if (syncPrecomputer || listCache.enabled || transactionCountCache.enabled) {
      const precomputer = syncPrecomputer;
      try {
        stopStoredBlockListener = await storage.listenForStoredBlocks(() => {
          precomputer?.markDirty();
          listCache.clear();
          transactionCountCache.clear();
        });
      } catch (error) {
        console.warn(
          "Stored-block listener failed to start; /sync falls back to its periodic refresh and the list cache to its TTL:",
          error,
        );
      }
    }
    const baseloadRuntimeConfig = parseBaseloadRuntimeConfig();
    const storageForBaseload = storage;
    baseloadRuntime = new BaseloadRuntime(baseloadRuntimeConfig, {
      persistConfig: (liveConfig) => storageForBaseload.saveBaseloadLiveConfig(liveConfig),
    });
    // The fleet that was running before the restart wins over the startup
    // file; the file only seeds a database that has never seen a fleet.
    const storedBaseloadConfig = await storage.loadBaseloadLiveConfig();
    let restoredBaseload = false;
    if (storedBaseloadConfig !== undefined) {
      try {
        const restored = baseloadRuntime.updateConfig(storedBaseloadConfig);
        console.log(`Restored the live Baseload config from the database (${restored.config.workers.length} workers)`);
        restoredBaseload = true;
      } catch (error) {
        console.warn("Stored live Baseload config could not be applied; starting without it:", error);
      }
    }
    if (!restoredBaseload && config.baseloadInitialConfigPath) {
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
    // The only path from /shadow-rpc to a real node. Without an upstream URL
    // the endpoint stays what its name promises: an index, not a node.
    const jsonRpcPassthrough = config.jsonRpcPassthrough
      ? new JsonRpcPassthrough({
          url: config.jsonRpcPassthrough.url,
          ...(config.jsonRpcPassthrough.apiKey ? { apiKey: config.jsonRpcPassthrough.apiKey } : {}),
          methods: config.jsonRpcPassthrough.methods,
          timeoutMs: config.jsonRpcPassthrough.timeoutMs,
          rateLimitPerMinute: config.jsonRpcPassthrough.rateLimitPerMinute,
        })
      : undefined;
    // Experimental: the entity index behind /shadow-rpc/experimental. Its own
    // small pool, so a long initial fold never starves the API's connections.
    if (config.entityQueryIndex) {
      entityIndex = await EntityIndexStorage.open(config.databaseUrl, { max: 4 });
      entityProjector = new EntityProjector(entityIndex, {
        ...(config.entityIndexFloorBlock !== undefined ? { floorBlock: config.entityIndexFloorBlock } : {}),
      });
      entityProjector.start();
    }
    // Prometheus collectors: refreshed at scrape time from the caches' own
    // counters and the scanner progress row.
    const storageForMetrics = storage;
    collectResponseCache("entity_history", () => entityHistoryCache.stats());
    collectResponseCache("list", () => listCache.stats());
    collectValueCache("transaction_count", () => transactionCountCache.stats());
    collectIndexerProgress(() => storageForMetrics.getScannerProgress());
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
      transactionCountCache,
      ...(syncPrecomputer ? { syncStatusProvider: syncPrecomputer } : {}),
      ...(jsonRpcPassthrough ? { jsonRpcPassthrough } : {}),
      ...(entityIndex ? { entityIndex } : {}),
      metricsEnabled: config.metricsEnabled,
      ...(config.metricsBearerToken !== undefined
        ? { metricsBearerToken: config.metricsBearerToken }
        : {}),
    });
    console.log(`Block server listening on http://${server.hostname}:${server.port}`);
    console.log(`Guzzler statistics: ${guzzlerStore ? "enabled" : "disabled"}`);
    console.log(
      config.metricsEnabled
        ? `Prometheus metrics: GET /metrics (${config.metricsBearerToken ? "bearer token required" : "open"})`
        : "Prometheus metrics: disabled",
    );
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
    console.log(
      jsonRpcPassthrough
        ? `JSON-RPC passthrough: forwarding ${jsonRpcPassthrough.describe()}`
        : "JSON-RPC passthrough: disabled (/shadow-rpc answers from stored data only)",
    );
    console.log(
      entityIndex
        ? "Entity index (experimental): projector running; arkiv_* reads answered from the index at /shadow-rpc/experimental"
        : "Entity index (experimental): disabled (set ENTITY_QUERY_INDEX=true to build it)",
    );
    console.log(
      transactionCountCache.enabled
        ? `Transaction count cache: up to ${config.transactionCountCacheMaxEntries} filters, ` +
            `TTL ${config.transactionCountCacheTtlMs}ms, ` +
            `cleared ${stopStoredBlockListener ? "on stored-block NOTIFY" : "by TTL only"}`
        : "Transaction count cache: disabled",
    );

    const shutdown = async () => {
      baseloadRuntime?.stop();
      syncPrecomputer?.stop();
      await entityProjector?.stop();
      await server.stop();
      await entityIndex?.close();
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
    await entityProjector?.stop();
    await entityIndex?.close();
    await stopEntityInvalidationListener?.();
    await stopStoredBlockListener?.();
    await guzzlerStore?.close();
    await storage?.close();
    process.exitCode = 1;
  }
}

await main();

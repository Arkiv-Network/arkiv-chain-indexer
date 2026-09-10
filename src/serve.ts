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
import { createRpcGenesisSource } from "./entityGenesis";
import { OmniSearch } from "./omniSearch";
import type { GuzzlerStore } from "./guzzlers";
import { collectEntityIndex, collectIndexerProgress, collectResponseCache, collectValueCache } from "./serverMetrics";

async function main(): Promise<void> {
  let storage: ScannerStorage | undefined;
  let guzzlerStore: GuzzlerStore | undefined;
  let baseloadRuntime: BaseloadRuntime | undefined;
  let stopEntityInvalidationListener: (() => Promise<void>) | undefined;
  let stopStoredBlockListener: (() => Promise<void>) | undefined;
  let syncPrecomputer: PrecomputedResponse | undefined;
  let entityIndex: EntityIndexStorage | undefined;
  let entityProjector: EntityProjector | undefined;
  let search: OmniSearch | undefined;

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
    // The only path from /shadow-rpc to a real node: the configured upstream,
    // or the node the scanner recorded for itself.
    const passthroughStorage = storage;
    const jsonRpcPassthrough = new JsonRpcPassthrough({
      url: config.jsonRpcPassthrough.url ?? (() => passthroughStorage.getScannerRpcUrl()),
      ...(config.jsonRpcPassthrough.apiKey ? { apiKey: config.jsonRpcPassthrough.apiKey } : {}),
      methods: config.jsonRpcPassthrough.methods,
      timeoutMs: config.jsonRpcPassthrough.timeoutMs,
      rateLimitPerMinute: config.jsonRpcPassthrough.rateLimitPerMinute,
    });
    // Experimental: the entity index behind /shadow-rpc/experimental. Its own
    // small pool, so a long initial fold never starves the API's connections.
    let genesisImportDescription = "off";
    if (config.entityQueryIndex) {
      entityIndex = await EntityIndexStorage.open(config.databaseUrl, { max: 4 });
      // The entities a seeded chain was born with come from the node, since
      // no operation ever created them; without a node only an offline
      // import (scripts/importGenesisState.ts) can bring them in.
      const genesisSource =
        config.entityIndexGenesis === "auto" && config.entityIndexGenesisRpc
          ? createRpcGenesisSource({
              url: config.entityIndexGenesisRpc.url,
              ...(config.entityIndexGenesisRpc.apiKey ? { apiKey: config.entityIndexGenesisRpc.apiKey } : {}),
              log: (message) => console.log(message),
            })
          : undefined;
      genesisImportDescription =
        config.entityIndexGenesis === "off"
          ? "off (ENTITY_INDEX_GENESIS=off; an offline import is still finished)"
          : genesisSource
            ? `auto, from the node at ${config.entityIndexGenesisRpc?.url.replace(/\/\/[^/]*@/, "//")} ` +
              `(up to ${config.entityIndexGenesisRpcLimit} entities over RPC)`
            : "auto, but no node is configured (set SHADOW_RPC_UPSTREAM or ENTITY_INDEX_GENESIS_RPC); only an offline import is finished";
      if (config.entityIndexGenesisProgressFile) genesisImportDescription += `; progress file ${config.entityIndexGenesisProgressFile}`;
      entityProjector = new EntityProjector(entityIndex, {
        ...(config.entityIndexFloorBlock !== undefined ? { floorBlock: config.entityIndexFloorBlock } : {}),
        genesis: {
          ...(genesisSource ? { source: genesisSource } : {}),
          mode: config.entityIndexGenesis,
          rpcLimit: config.entityIndexGenesisRpcLimit,
          ...(config.entityIndexGenesisProgressFile ? { progressFile: config.entityIndexGenesisProgressFile } : {}),
        },
      });
      entityProjector.start();
      const entityIndexForMetrics = entityIndex;
      collectEntityIndex(
        () => entityIndexForMetrics.getProgress(),
        () => entityIndexForMetrics.getStats(),
      );
    }
    // Prometheus collectors: refreshed at scrape time from the caches' own
    // counters and the scanner progress row.
    const storageForMetrics = storage;
    collectResponseCache("entity_history", () => entityHistoryCache.stats());
    collectResponseCache("list", () => listCache.stats());
    collectValueCache("transaction_count", () => transactionCountCache.stats());
    collectIndexerProgress(() => storageForMetrics.getScannerProgress());
    search = OmniSearch.open(config.databaseUrl, config.entityQueryIndex);
    const server = createBlockServer(storage, {
      search,
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
        ? `Prometheus metrics: GET /metrics (${config.metricsBearerToken ? "bearer token required" : "open"}), ` +
            `GET /admin/metrics (${
              config.baseloadAdminBearerToken ? "admin bearer token required" : "503, no admin token configured"
            })`
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
      `JSON-RPC passthrough: forwarding ${jsonRpcPassthrough.describe()} to ${
        config.jsonRpcPassthrough.url ? "SHADOW_RPC_UPSTREAM" : "the node the scanner recorded"
      }`,
    );
    console.log(
      entityIndex
        ? "Entity index: projector running; arkiv_* reads answered from the index at /shadow-rpc/experimental"
        : "Entity index: disabled (ENTITY_QUERY_INDEX=false)",
    );
    if (entityIndex) console.log(`Entity index genesis import: ${genesisImportDescription}`);
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
      await search?.close();
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
    await search?.close();
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

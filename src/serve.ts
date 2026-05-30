import { parseServerConfig, ServerHelpRequested } from "./serverConfig";
import { createBlockServer } from "./server";
import { ScannerStorage } from "./storage";
import { RedisGuzzlerStore } from "./guzzlerStore";
import { parseBaseloadRuntimeConfig } from "./baseloadConfig";
import { BaseloadRuntime } from "./baseloadRuntime";
import type { GuzzlerStore } from "./guzzlers";

async function main(): Promise<void> {
  let storage: ScannerStorage | undefined;
  let guzzlerStore: GuzzlerStore | undefined;

  try {
    const config = parseServerConfig(process.argv.slice(2));
    storage = await ScannerStorage.open(config.databaseUrl);
    if (config.redisUrl) {
      guzzlerStore = await RedisGuzzlerStore.open(config.redisUrl);
    }
    const baseloadRuntime = new BaseloadRuntime(parseBaseloadRuntimeConfig());
    const server = createBlockServer(storage, {
      port: config.port,
      ...(config.hostname !== undefined ? { hostname: config.hostname } : {}),
      transactionDataEnabled: config.transactionDataEnabled,
      baseloadRuntime,
      ...(config.baseloadAdminBearerToken !== undefined
        ? { baseloadAdminBearerToken: config.baseloadAdminBearerToken }
        : {}),
      ...(guzzlerStore ? { guzzlerStore } : {}),
    });
    console.log(`Block server listening on http://${server.hostname}:${server.port}`);
    console.log(`Guzzler statistics: ${guzzlerStore ? "enabled" : "disabled"}`);

    const shutdown = async () => {
      baseloadRuntime.stop();
      await server.stop();
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
    await guzzlerStore?.close();
    await storage?.close();
    process.exitCode = 1;
  }
}

await main();

import { parseServerConfig, ServerHelpRequested } from "./serverConfig";
import { createBlockServer } from "./server";
import { ScannerStorage } from "./storage";
import { parseBaseloadRuntimeConfig } from "./baseloadConfig";
import { BaseloadRuntime } from "./baseloadRuntime";

async function main(): Promise<void> {
  let storage: ScannerStorage | undefined;

  try {
    const config = parseServerConfig(process.argv.slice(2));
    storage = await ScannerStorage.open(config.databaseUrl);
    const baseloadRuntime = new BaseloadRuntime(parseBaseloadRuntimeConfig());
    const server = createBlockServer(storage, {
      port: config.port,
      ...(config.hostname !== undefined ? { hostname: config.hostname } : {}),
      transactionDataEnabled: config.transactionDataEnabled,
      baseloadRuntime,
      ...(config.baseloadAdminBearerToken !== undefined
        ? { baseloadAdminBearerToken: config.baseloadAdminBearerToken }
        : {}),
    });
    console.log(`Block server listening on http://${server.hostname}:${server.port}`);

    const shutdown = async () => {
      baseloadRuntime.stop();
      await server.stop();
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
    await storage?.close();
    process.exitCode = 1;
  }
}

await main();

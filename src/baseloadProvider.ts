import { parseBaseloadRuntimeConfig, readBaseloadConfigFile } from "./baseloadConfig";
import { BaseloadRuntime } from "./baseloadRuntime";
import { BaseloadSqliteStorage } from "./baseloadSqliteStorage";
import { createBlockServer } from "./server";
import { coercePort } from "./cli";

const DEFAULT_PORT = 3000;
const DEFAULT_SQLITE_PATH = "/app/baseload-config/baseload-provider.sqlite";

async function main(): Promise<void> {
  let baseloadRuntime: BaseloadRuntime | undefined;
  let storage: BaseloadSqliteStorage | undefined;

  try {
    const port = coercePort("SERVER_PORT", process.env.SERVER_PORT ?? String(DEFAULT_PORT));
    const hostname = process.env.SERVER_HOSTNAME?.trim() || undefined;
    const sqlitePath = process.env.BASELOAD_SQLITE_PATH?.trim() || DEFAULT_SQLITE_PATH;
    const baseloadAdminBearerToken = process.env.BASELOAD_ADMIN_BEARER_TOKEN?.trim() || undefined;
    const initialConfigPath = process.env.BASELOAD_INITIAL_CONFIG_PATH?.trim() || undefined;

    storage = await BaseloadSqliteStorage.open(sqlitePath);
    const baseloadRuntimeConfig = parseBaseloadRuntimeConfig();
    baseloadRuntime = new BaseloadRuntime(baseloadRuntimeConfig);

    if (initialConfigPath) {
      const initialBaseloadConfig = await readBaseloadConfigFile(
        initialConfigPath,
        baseloadRuntimeConfig.mnemonic,
      );
      baseloadRuntime.updateConfig(initialBaseloadConfig);
      console.log(
        `Loaded initial Baseload config from ${initialConfigPath} ` +
          `(${initialBaseloadConfig.workers.length} workers)`,
      );
    }

    const server = createBlockServer(null, {
      port,
      ...(hostname !== undefined ? { hostname } : {}),
      transactionDataEnabled: false,
      baseloadRuntime,
      baseloadConfigStorage: storage,
      ...(baseloadAdminBearerToken !== undefined ? { baseloadAdminBearerToken } : {}),
    });

    console.log(`Baseload provider listening on http://${server.hostname}:${server.port}`);
    console.log(`Baseload config SQLite: ${sqlitePath}`);

    const shutdown = async () => {
      baseloadRuntime?.stop();
      await server.stop();
      await storage?.close();
      process.exit(0);
    };

    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
  } catch (error) {
    console.error(error);
    baseloadRuntime?.stop();
    await storage?.close();
    process.exitCode = 1;
  }
}

await main();

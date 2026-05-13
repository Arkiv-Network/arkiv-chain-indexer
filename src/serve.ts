import { parseServerConfig, ServerHelpRequested } from "./serverConfig";
import { createBlockServer } from "./server";
import { ScannerStorage } from "./storage";

async function main(): Promise<void> {
  let storage: ScannerStorage | undefined;

  try {
    const config = parseServerConfig(process.argv.slice(2));
    storage = ScannerStorage.open(config.dbPath);
    const server = createBlockServer(storage, {
      port: config.port,
      ...(config.hostname !== undefined ? { hostname: config.hostname } : {}),
    });
    console.log(`Block server listening on http://${server.hostname}:${server.port}`);
    console.log(`Reading blocks from ${config.dbPath}`);

    const shutdown = async () => {
      await server.stop();
      storage?.close();
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
    storage?.close();
    process.exitCode = 1;
  }
}

await main();

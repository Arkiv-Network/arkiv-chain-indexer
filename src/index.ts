import { parseConfig, HelpRequested } from "./config";
import { HttpBatcherCollector } from "./batcher";
import { GuzzlerService } from "./guzzlerService";
import { RedisGuzzlerStore } from "./guzzlerStore";
import { EthereumRpcClient } from "./rpc";
import { runScanner } from "./scanner";
import { ScannerStorage } from "./storage";

async function main(): Promise<void> {
  let storage: ScannerStorage | undefined;
  let guzzlerService: GuzzlerService | undefined;

  try {
    const config = parseConfig(process.argv.slice(2));
    const rpc = new EthereumRpcClient(config.rpcUrl);
    const batcherCollector = config.batcherCollectorUrl
      ? new HttpBatcherCollector(config.batcherCollectorUrl)
      : undefined;
    storage = await ScannerStorage.open(config.databaseUrl);

    if (config.redisUrl) {
      const store = await RedisGuzzlerStore.open(config.redisUrl);
      guzzlerService = new GuzzlerService(store, { log: (message) => console.log(message) });
      await guzzlerService.start();
    }

    await runScanner(config, rpc, storage, undefined, batcherCollector, guzzlerService);
  } catch (error) {
    if (error instanceof HelpRequested) {
      console.log(error.message);
      return;
    }

    console.error(error);
    process.exitCode = 1;
  } finally {
    await guzzlerService?.stop();
    await storage?.close();
  }
}

await main();

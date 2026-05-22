import { parseConfig, HelpRequested } from "./config";
import { HttpBatcherCollector } from "./batcher";
import { EthereumRpcClient } from "./rpc";
import { runScanner } from "./scanner";
import { ScannerStorage } from "./storage";

async function main(): Promise<void> {
  let storage: ScannerStorage | undefined;

  try {
    const config = parseConfig(process.argv.slice(2));
    const rpc = new EthereumRpcClient(config.rpcUrl);
    const batcherCollector = config.batcherCollectorUrl
      ? new HttpBatcherCollector(config.batcherCollectorUrl)
      : undefined;
    storage = await ScannerStorage.open(config.databaseUrl);
    await runScanner(config, rpc, storage, undefined, batcherCollector);
  } catch (error) {
    if (error instanceof HelpRequested) {
      console.log(error.message);
      return;
    }

    console.error(error);
    process.exitCode = 1;
  } finally {
    await storage?.close();
  }
}

await main();

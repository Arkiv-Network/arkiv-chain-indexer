import { parseConfig, HelpRequested } from "./config";
import { EthereumRpcClient } from "./rpc";
import { runScanner } from "./scanner";
import { ScannerStorage } from "./storage";

async function main(): Promise<void> {
  let storage: ScannerStorage | undefined;

  try {
    const config = parseConfig(process.argv.slice(2));
    const rpc = new EthereumRpcClient(config.rpcUrl);
    storage = await ScannerStorage.open(config.databaseUrl);
    await runScanner(config, rpc, storage);
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

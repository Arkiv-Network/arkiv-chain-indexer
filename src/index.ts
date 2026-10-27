import { parseConfig, HelpRequested } from "./config";
import { ArkivDecoderClient } from "./arkivOperations";
import { HttpBatcherCollector } from "./batcher";
import { GuzzlerService } from "./guzzlerService";
import { RedisGuzzlerStore } from "./guzzlerStore";
import { EthereumRpcClient, readGenesisHashWithRetry } from "./rpc";
import { attachRpcKeyRing } from "./rpcKeyRing";
import { runScanner } from "./scanner";
import { ScannerStorage } from "./storage";

async function main(): Promise<void> {
  let storage: ScannerStorage | undefined;
  let guzzlerService: GuzzlerService | undefined;

  try {
    const config = parseConfig(process.argv.slice(2));
    const rpc = new EthereumRpcClient(config.rpcUrl);
    await attachRpcKeyRing(rpc, "scanner");
    const batcherCollector = config.batcherCollectorUrl
      ? new HttpBatcherCollector(config.batcherCollectorUrl)
      : undefined;
    // Probe the chain id once: the HTTP backend's JSON-RPC endpoint answers
    // eth_chainId from the persisted copy (it never talks to a node). On
    // failure the backend keeps whatever chain id was stored before.
    const chainId = await rpc.getChainId().catch((error) => {
      console.warn(
        `Could not determine chain id; eth_chainId keeps the stored value: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return undefined;
    });
    const decoderClient = config.decoderUrl ? new ArkivDecoderClient(config.decoderUrl) : undefined;
    storage = await ScannerStorage.open(config.databaseUrl);
    // Bind the database to this chain's block 0 before writing anything: a
    // restarted chain keeps its chain id, so the id alone cannot tell an old
    // chain's database from this one's.
    await storage.bindGenesisHash((await readGenesisHashWithRetry(rpc, config.retryMs))!);
    if (chainId !== undefined) {
      await storage.saveChainId(BigInt(chainId));
    }
    // The backend's /shadow-rpc relay follows the scanner to the same node
    // unless SHADOW_RPC_UPSTREAM names another.
    await storage.saveScannerRpcUrl(config.rpcUrl);

    if (config.redisUrl) {
      const store = await RedisGuzzlerStore.open(config.redisUrl);
      guzzlerService = new GuzzlerService(store, { log: (message) => console.log(message) });
      await guzzlerService.start();
    }

    await runScanner(config, rpc, storage, undefined, batcherCollector, guzzlerService, decoderClient);
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

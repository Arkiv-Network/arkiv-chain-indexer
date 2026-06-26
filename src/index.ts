import { parseConfig, HelpRequested } from "./config";
import { ArkivDecoderClient } from "./arkivOperations";
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
    // Probe the chain id once so the decoder verifies payload references against
    // the right trusted-signer allowlist. On failure fall back to the decoder's
    // own default chain id (degrades verification trust off the dev chain, so
    // make it visible). Only probed when decoding is enabled.
    const decoderChainId = config.decoderUrl
      ? await rpc.getChainId().catch((error) => {
          console.warn(
            `Could not determine chain id for the Arkiv decoder; reference verification will use the decoder default: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
          return undefined;
        })
      : undefined;
    const decoderClient = config.decoderUrl
      ? new ArkivDecoderClient(config.decoderUrl, decoderChainId)
      : undefined;
    storage = await ScannerStorage.open(config.databaseUrl);

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

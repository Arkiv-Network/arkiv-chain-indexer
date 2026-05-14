import { AggregateHelpRequested, parseAggregateConfig } from "./aggregateConfig";
import { aggregateRanges } from "./aggregator";
import { ScannerStorage } from "./storage";

async function main(): Promise<void> {
  let storage: ScannerStorage | undefined;

  try {
    const config = parseAggregateConfig(process.argv.slice(2));
    storage = await ScannerStorage.open(config.databaseUrl);

    console.log(
      `Aggregating ranges of size ${config.rangeSize.toString()}`,
    );

    const result = await aggregateRanges(storage, {
      rangeSize: config.rangeSize,
      ...(config.fromBlock !== undefined ? { fromBlock: config.fromBlock } : {}),
      ...(config.toBlock !== undefined ? { toBlock: config.toBlock } : {}),
      onWindow: (rangeStart, status) => {
        const rangeEnd = rangeStart + config.rangeSize - 1n;
        if (status === "written") {
          console.log(
            `  wrote range ${rangeStart.toString()}-${rangeEnd.toString()}`,
          );
        } else {
          console.log(
            `  skipped incomplete range ${rangeStart.toString()}-${rangeEnd.toString()}`,
          );
        }
      },
    });

    if (result.firstRangeStart === undefined) {
      console.log("No stored blocks found; nothing to aggregate.");
    } else {
      console.log(
        `Done: ${result.written} written, ${result.incomplete} incomplete (range_size=${config.rangeSize.toString()}, windows ${result.firstRangeStart.toString()}..${result.lastRangeStart?.toString()})`,
      );
    }
  } catch (error) {
    if (error instanceof AggregateHelpRequested) {
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

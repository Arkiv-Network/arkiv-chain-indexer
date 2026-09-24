import { boundedJson, decimal, fail, SimulatorError } from "./common";
import { sameIdentity, type SimulatorIdentity } from "./config";
import {
  FEED_CAP,
  parseFeedBlock,
  parseStatus,
  type FeedBlock,
  type SourceStatus,
} from "./wire";
export type Fetcher = (request: Request) => Promise<Response>;
export interface SimulatorSource {
  status(): Promise<SourceStatus>;
  block(height: string): Promise<FeedBlock>;
}
export class HttpSimulatorSource implements SimulatorSource {
  constructor(
    private readonly origin: string,
    private readonly identity: SimulatorIdentity,
    private readonly fetcher: Fetcher = fetch,
  ) {}
  private async read(path: string, cap: number): Promise<unknown> {
    try {
      const response = await this.fetcher(
        new Request(this.origin + path, {
          redirect: "error",
          signal: AbortSignal.timeout(5000),
          headers: { Accept: "application/json" },
        }),
      );
      if (!response.ok)
        return fail(
          response.status === 404
            ? "HistoryUnavailable"
            : "UpstreamUnavailable",
          503,
        );
      return await boundedJson(response, cap);
    } catch (error) {
      if (error instanceof SimulatorError) {
        if (error.code === "ReadTimeout") return fail("Transport", 503);
        throw error;
      }
      return fail("Transport", 503);
    }
  }
  async status(): Promise<SourceStatus> {
    const status = parseStatus(await this.read("/sim/v1/status", 65536));
    if (status.role === "light") return fail("UnsupportedSource", 422);
    if (!sameIdentity(status, this.identity))
      return fail("IdentityMismatch", 409);
    return status;
  }
  async block(height: string): Promise<FeedBlock> {
    const block = parseFeedBlock(
      await this.read(`/sim/v1/feed/blocks/${decimal(height)}`, FEED_CAP),
    );
    if (!sameIdentity(block, this.identity))
      return fail("IdentityMismatch", 409);
    if (block.header.height !== height) return fail("InvalidHeader");
    return block;
  }
}

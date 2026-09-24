/** Live topology probe: one bounded status read per configured node, cached briefly.
 * Every failure is a fixed code; upstream bodies, URLs and messages never leave this module.
 */
import { boundedJson, SimulatorError } from "./common";
import { sameIdentity, type SimulatorIdentity } from "./config";
import { parseStatus, type SourceStatus } from "./wire";
export type Fetcher = (request: Request) => Promise<Response>;
export type NodeRole = "producer" | "full" | "light";
export const NODE_ROLES: readonly NodeRole[] = ["producer", "full", "light"];
export interface NodeReport {
  role: NodeRole;
  /** False when the deployment has no such node; then nothing else is known. */
  configured: boolean;
  available: boolean;
  /** Bounded failure code when unavailable; null when available or unconfigured. */
  error: string | null;
  /** Round trip of the last probe, whether it succeeded or failed; null when unconfigured. */
  latencyMs: number | null;
  status: SourceStatus | null;
}
export type NodeReports = Record<NodeRole, NodeReport>;
export interface NodeUrls {
  producer?: string;
  full?: string;
  light?: string;
}
const unconfigured = (role: NodeRole): NodeReport => ({
  role,
  configured: false,
  available: false,
  error: null,
  latencyMs: null,
  status: null,
});
export class NodeProbe {
  private cached: { at: number; value: Promise<NodeReports> } | undefined;
  constructor(
    private readonly urls: NodeUrls,
    private readonly identity: SimulatorIdentity,
    private readonly fetcher: Fetcher = fetch,
    private readonly ttlMs = 1000,
    private readonly timeoutMs = 3000,
    private readonly now: () => number = Date.now,
  ) {}
  /** Probes every configured node concurrently; concurrent callers share one probe per TTL. */
  probe(): Promise<NodeReports> {
    const at = this.now();
    if (!this.cached || at - this.cached.at >= this.ttlMs) {
      const value = Promise.all(NODE_ROLES.map((role) => this.one(role))).then(
        ([producer, full, light]) => ({ producer: producer!, full: full!, light: light! }),
      );
      this.cached = { at, value };
      value.catch(() => {
        this.cached = undefined;
      });
    }
    return this.cached.value;
  }
  private async one(role: NodeRole): Promise<NodeReport> {
    const url = this.urls[role];
    if (!url) return unconfigured(role);
    const started = performance.now();
    const latency = () => Math.max(0, Math.round(performance.now() - started));
    const failure = (error: string): NodeReport => ({
      role,
      configured: true,
      available: false,
      error,
      latencyMs: latency(),
      status: null,
    });
    try {
      let response: Response;
      for (let attempt = 0; ; attempt++) {
        response = await this.fetcher(
          new Request(url + "/sim/v1/status", {
            redirect: "error",
            signal: AbortSignal.timeout(this.timeoutMs),
            headers: { Accept: "application/json" },
          }),
        );
        // The node bounds concurrent reads; one brief retry absorbs a momentary ServerBusy.
        if (response.status !== 429 || attempt >= 1) break;
        await new Promise((resolve) => setTimeout(resolve, 150));
      }
      if (!response.ok)
        return failure(response.status === 429 ? "ServerBusy" : "UpstreamUnavailable");
      const status = parseStatus(await boundedJson(response, 65536));
      if (status.role !== role) return failure("UnexpectedRole");
      if (!sameIdentity(status, this.identity)) return failure("IdentityMismatch");
      return {
        role,
        configured: true,
        available: true,
        error: null,
        latencyMs: latency(),
        status,
      };
    } catch (error) {
      return failure(
        error instanceof SimulatorError && error.code !== "ReadTimeout"
          ? error.code
          : "Transport",
      );
    }
  }
}

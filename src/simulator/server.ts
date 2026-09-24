import {
  anonymousSession,
  authError,
  privateResponse,
  requireAdmin,
  type AuthService,
} from "../auth";
import {
  metricsRegistry,
  observeHttpRequest,
  PROMETHEUS_CONTENT_TYPE,
  recordResponseBytes,
} from "../serverMetrics";
import {
  boundedJson,
  choice,
  decimal,
  fail,
  hex,
  integer,
  nullable,
  object,
  SimulatorError,
  text,
} from "./common";
import { NODE_ROLES, type NodeProbe, type NodeReports } from "./nodes";
import { parsePredicate } from "./query";
import type { PageOptions, SimulatorStorage } from "./storage";

export interface ControlCommand {
  commandId: string;
  runId: string;
  expectedRevision: string;
  expectedHeight: string | null;
  action: "pause" | "resume" | "step" | "configure";
  config: {
    version: 1;
    seed: string;
    blockPeriodMs: string;
    payloadBytes: number;
    extraRowsPerBlock: number;
  } | null;
}
export function parseControl(value: unknown, runId: string): ControlCommand {
  const v = object(value, [
    "commandId",
    "runId",
    "expectedRevision",
    "expectedHeight",
    "action",
    "config",
  ]);
  if (v.runId !== runId) return fail("IdentityMismatch", 409);
  const commandId = hex(v.commandId, 32),
    action = choice(v.action, ["pause", "resume", "step", "configure"]);
  const result: ControlCommand = {
    commandId,
    runId,
    expectedRevision: decimal(v.expectedRevision),
    expectedHeight: nullable(v.expectedHeight, decimal),
    action,
    config: null,
  };
  if (action === "configure") {
    const c = object(v.config, [
      "version",
      "seed",
      "blockPeriodMs",
      "payloadBytes",
      "extraRowsPerBlock",
    ]);
    if (c.version !== 1) return fail("UnsupportedVersion");
    result.config = {
      version: 1,
      seed: decimal(c.seed),
      blockPeriodMs: decimal(c.blockPeriodMs, true),
      payloadBytes: integer(c.payloadBytes, 1024),
      extraRowsPerBlock: integer(c.extraRowsPerBlock, 4),
    };
  } else if (v.config !== null) return fail();
  return result;
}
export type Fetcher = (request: Request) => Promise<Response>;
export interface NativeServerOptions {
  storage: SimulatorStorage;
  auth?: AuthService;
  controlUrl?: string;
  controlToken?: string;
  fetcher?: Fetcher;
  /** Live producer/full/light status for the topology view; absent means unconfigured nodes. */
  nodes?: NodeProbe;
  /** Cache lifetime of the PostgreSQL relation-size catalog read. */
  relationBytesTtlMs?: number;
}
function json(value: unknown, status = 200): Response {
  const body = JSON.stringify(value);
  if (Buffer.byteLength(body) > 8 * 1024 * 1024)
    return fail("ResponseLimitExceeded", 413);
  return recordResponseBytes(
    new Response(body, {
      status,
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "no-store",
        "Access-Control-Allow-Origin": "*",
      },
    }),
    Buffer.byteLength(body),
  );
}
function pageOptions(params: URLSearchParams, allowed: string[]): PageOptions {
  const v: Record<string, string> = {};
  for (const [key, value] of params) {
    if (!allowed.includes(key) || key in v) return fail();
    v[key] = value;
  }
  const result: PageOptions = {};
  if (v.atHeight !== undefined)
    result.atHeight = v.atHeight === "latest" ? "latest" : decimal(v.atHeight);
  if (v.cursor !== undefined) result.cursor = text(v.cursor, 4096, 1);
  if (v.limit !== undefined) {
    decimal(v.limit, true);
    result.limit = integer(Number(v.limit), 256);
  }
  if (v.namespaceId !== undefined)
    result.namespaceId = decimal(v.namespaceId, true);
  if (v.actor !== undefined) result.actor = hex(v.actor, 20);
  if (v.status !== undefined)
    result.status = choice(v.status, ["committed", "failed"]);
  if (v.digest !== undefined) result.digest = hex(v.digest, 32);
  if (v.recordKey !== undefined) result.recordKey = hex(v.recordKey, 32, 1);
  if (v.recordId !== undefined) result.recordId = decimal(v.recordId, true);
  return result;
}
const COMMON = ["atHeight", "cursor", "limit"];
const LISTS = {
  blocks: COMMON,
  transactions: [...COMMON, "actor", "status", "digest"],
  operations: [...COMMON, "namespaceId", "recordKey", "recordId"],
  namespaces: COMMON,
  records: [...COMMON, "namespaceId", "recordKey", "recordId"],
  raw: [...COMMON, "namespaceId"],
  "record-history": [...COMMON, "namespaceId", "recordKey", "recordId"],
} as const;
export function createNativeHandler(
  options: NativeServerOptions,
): (request: Request) => Promise<Response> {
  const { storage, auth } = options;
  let controlInFlight = false;
  let requestsInFlight = 0;
  // The catalog size read is cheap but not free; the topology view polls it.
  let relationBytes: { at: number; value: Promise<string> } | undefined;
  const relationBytesCached = (): Promise<string> => {
    const ttl = options.relationBytesTtlMs ?? 10000;
    if (!relationBytes || Date.now() - relationBytes.at >= ttl) {
      const value = storage.relationBytes();
      relationBytes = { at: Date.now(), value };
      value.catch(() => {
        relationBytes = undefined;
      });
    }
    return relationBytes.value;
  };
  const unconfiguredNodes = (): NodeReports =>
    Object.fromEntries(
      NODE_ROLES.map((role) => [
        role,
        {
          role,
          configured: false,
          available: false,
          error: null,
          latencyMs: null,
          status: null,
        },
      ]),
    ) as NodeReports;
  async function control(request: Request): Promise<Response> {
    const denied = await requireAdmin(request, auth);
    if (denied) return denied;
    if (request.method !== "POST") return authError(405, "MethodNotAllowed");
    if (!options.controlUrl || !options.controlToken)
      return authError(503, "ControlUnavailable");
    if (controlInFlight) return authError(429, "ControlBusy");
    const command = parseControl(
      await boundedJson(request, 4096),
      storage.identity.runId,
    );
    // Another admitted request may have finished reading its body first.
    if (controlInFlight) return authError(429, "ControlBusy");
    controlInFlight = true;
    try {
      const upstream = await (options.fetcher ?? fetch)(
        new Request(options.controlUrl + "/sim/v1/control", {
          method: "POST",
          redirect: "error",
          signal: AbortSignal.timeout(5000),
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${options.controlToken}`,
          },
          body: JSON.stringify(command),
        }),
      );
      if (!upstream.ok) {
        // Fixed statuses are sufficient to reconcile via status/command ID; never reflect upstream error text.
        const codes: Record<number, string> = {
          400: "InvalidControl",
          401: "ControlUnavailable",
          403: "ControlUnavailable",
          409: "ControlConflict",
          413: "LimitExceeded",
          429: "ControlBusy",
          503: "ProducerUnavailable",
        };
        return authError(
          upstream.status === 401 || upstream.status === 403
            ? 503
            : codes[upstream.status]
              ? upstream.status
              : 502,
          codes[upstream.status] ?? "ControlUnavailable",
        );
      }
      const v = object(await boundedJson(upstream, 4096), [
          "commandId",
          "runId",
          "configRevision",
          "head",
          "paused",
          "health",
          "status",
          "resultHeight",
        ]),
        head = object(v.head, ["height", "hash", "stateRoot"]);
      if (
        v.commandId !== command.commandId ||
        v.runId !== command.runId ||
        typeof v.paused !== "boolean"
      )
        return fail("InvalidControlResponse", 502);
      return privateResponse(
        json({
          commandId: command.commandId,
          runId: command.runId,
          configRevision: decimal(v.configRevision),
          head: {
            height: decimal(head.height),
            hash: hex(head.hash, 32),
            stateRoot: hex(head.stateRoot, 32),
          },
          paused: v.paused,
          health: choice(v.health, [
            "ready",
            "running",
            "paused",
            "storage-fenced",
            "following",
            "stalled",
            "chain-conflict",
          ]),
          status: choice(v.status, ["volatile", "pending", "committed"]),
          resultHeight: nullable(v.resultHeight, decimal),
        }),
      );
    } catch {
      return authError(503, "ControlOutcomeUnknown");
    } finally {
      controlInFlight = false;
    }
  }
  async function route(request: Request): Promise<Response> {
    const url = new URL(request.url),
      path = url.pathname;
    if (request.method === "OPTIONS" && path.startsWith("/sim/v1/"))
      return new Response(null, {
        status: 204,
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type",
          "Access-Control-Max-Age": "600",
        },
      });
    if (path.startsWith("/auth/"))
      return auth
        ? ((await auth.handle(request)) ?? authError(404, "NotFound"))
        : path === "/auth/session" && request.method === "GET"
          ? anonymousSession()
          : authError(503, "Authentication is not configured");
    if (path === "/admin/sim/v1/control")
      return privateResponse(await control(request));
    if (path === "/admin/metrics") {
      const denied = await requireAdmin(request, auth);
      if (denied) return denied;
      if (request.method !== "GET") return authError(405, "MethodNotAllowed");
      return privateResponse(
        new Response(await metricsRegistry.render(), {
          headers: { "Content-Type": PROMETHEUS_CONTENT_TYPE },
        }),
      );
    }
    if (path === "/metrics" && request.method === "GET")
      return new Response(await metricsRegistry.render(), {
        headers: { "Content-Type": PROMETHEUS_CONTENT_TYPE },
      });
    if (path === "/health" && request.method === "GET") {
      await storage.progress();
      return json({
        status: "ok",
        sourceKind: "arkiv-native-simulator",
        authentication: "unsigned-simulator-v1",
        features: {
          nativeSimulator: true,
          ethereum: false,
          proofs: "local-light-only",
          controls: !!options.controlUrl && !!options.controlToken,
          nodes: !!options.nodes,
        },
      });
    }
    if (path === "/sim/v1/nodes" && request.method === "GET") {
      // Live topology: each node is probed separately and reported as configured,
      // available or failed with a bounded code. Missing data stays null.
      if (url.search) return fail();
      const [nodes, p, bytes] = await Promise.all([
        options.nodes ? options.nodes.probe() : unconfiguredNodes(),
        storage.progress(),
        relationBytesCached().then(
          (value) => ({ relationBytes: value }),
          () => ({ relationBytes: null }),
        ),
      ]);
      const header = p.height === null ? null : await storage.header(p.height);
      if (p.height !== null && !header) return fail("StorageCorrupt", 503);
      return json({
        sourceKind: "arkiv-native-simulator",
        identity: storage.identity,
        authentication: "unsigned-simulator-v1",
        verification: "unverified-projection",
        nodes,
        explorer: {
          health: p.health,
          indexed: header
            ? { height: header.height, hash: header.hash, stateRoot: header.stateRoot }
            : null,
          observed: p.observed,
          counters: {
            blocks: p.blocks,
            transactions: p.transactions,
            operations: p.operations,
            spentUnits: p.spentUnits,
            liveRecords: p.liveRecords,
            namespaces: p.namespaces,
            rawRecords: p.rawRecords,
          },
          schema: storage.schema,
          storage: bytes,
        },
        controlAvailable: !!options.controlUrl && !!options.controlToken,
      });
    }
    if (path === "/sim/v1/query" && request.method === "POST") {
      if (url.search) return fail();
      const v = object(
        await boundedJson(request, 16384),
        ["namespaceId", "predicate"],
        ["atHeight", "cursor", "limit"],
      );
      const params = new URLSearchParams();
      for (const key of ["namespaceId", "atHeight", "cursor"])
        if (v[key] !== undefined) params.set(key, text(v[key], 4096));
      if (v.limit !== undefined)
        params.set("limit", String(integer(v.limit, 256)));
      const opts = pageOptions(params, [...COMMON, "namespaceId"]);
      opts.predicate = parsePredicate(v.predicate);
      return json(await storage.page("records", opts));
    }
    if (request.method !== "GET") return fail("MethodNotAllowed", 405);
    if (path === "/sim/v1/status" || path === "/sim/v1/statistics") {
      if (url.search) return fail();
      const p = await storage.progress();
      const header = p.height === null ? null : await storage.header(p.height);
      if (p.height !== null && !header) return fail("StorageCorrupt", 503);
      const base = {
        sourceKind: "arkiv-native-simulator",
        identity: storage.identity,
        authentication: "unsigned-simulator-v1",
        verification: "unverified-projection",
        producer: p.observed,
        indexed: header
          ? {
              height: header.height,
              hash: header.hash,
              stateRoot: header.stateRoot,
            }
          : null,
        coverage: { from: "0", through: p.height, complete: p.height !== null },
        health: p.health,
        controlAvailable: !!options.controlUrl && !!options.controlToken,
      };
      return json(
        path.endsWith("statistics")
          ? {
              ...base,
              counters: {
                blocks: p.blocks,
                transactions: p.transactions,
                operations: p.operations,
                spentUnits: p.spentUnits,
                liveRecords: p.liveRecords,
                namespaces: p.namespaces,
                rawRecords: p.rawRecords,
              },
            }
          : base,
      );
    }
    const match = /^\/sim\/v1\/blocks\/([0-9]+)$/.exec(path);
    if (match) {
      if (url.search) return fail();
      return json(await storage.block(decimal(match[1])));
    }
    const kind = path.slice("/sim/v1/".length) as keyof typeof LISTS;
    if (path.startsWith("/sim/v1/") && Object.hasOwn(LISTS, kind))
      return json(
        await storage.page(
          kind,
          pageOptions(url.searchParams, [...LISTS[kind]]),
        ),
      );
    return fail("NotFound", 404);
  }
  return (request) =>
    observeHttpRequest(request, async () => {
      const path = new URL(request.url).pathname,
        isPrivate = path.startsWith("/admin/") || path.startsWith("/auth/");
      if (requestsInFlight >= 16) {
        const response = json({ error: "Busy" }, 429);
        return isPrivate ? privateResponse(response) : response;
      }
      requestsInFlight++;
      try {
        return await route(request);
      } catch (error) {
        const response = json(
          {
            error:
              error instanceof SimulatorError
                ? error.code
                : "StorageUnavailable",
          },
          error instanceof SimulatorError ? error.status : 503,
        );
        return isPrivate ? privateResponse(response) : response;
      } finally {
        requestsInFlight--;
      }
    });
}

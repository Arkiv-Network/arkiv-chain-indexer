import { decimal, fail, hex, integer } from "./common";
export function sourceKind(
  env: NodeJS.ProcessEnv = process.env,
): "ethereum" | "native-simulator" {
  const value = env.SOURCE_KIND || "ethereum";
  if (value !== "ethereum" && value !== "native-simulator")
    return fail("InvalidSourceKind");
  return value;
}
export interface SimulatorIdentity {
  sourceId: string;
  runId: string;
  genesisHash: string;
  chainId: string;
}
export function parseIdentity(value: SimulatorIdentity): SimulatorIdentity {
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(
      value.sourceId,
    )
  )
    return fail("InvalidIdentity");
  if (!/^[0-9a-f]{32}$/.test(value.runId)) return fail("InvalidIdentity");
  return {
    sourceId: value.sourceId,
    runId: value.runId,
    genesisHash: hex(value.genesisHash, 32),
    chainId: decimal(value.chainId),
  };
}
export function sameIdentity(
  a: SimulatorIdentity,
  b: SimulatorIdentity,
): boolean {
  return (
    a.sourceId === b.sourceId &&
    a.runId === b.runId &&
    a.genesisHash === b.genesisHash &&
    a.chainId === b.chainId
  );
}
export interface SimulatorConfig {
  identity: SimulatorIdentity;
  databaseUrl: string;
  schema: string;
  feedUrl: string;
  /** Optional independently executing full follower, probed for the topology view only. */
  fullUrl?: string;
  /** Optional light follower (the server-side verifier), probed for the topology view only. */
  lightUrl?: string;
  controlUrl?: string;
  controlToken?: string;
  host: string;
  port: number;
  pollMs: number;
}
function origin(value: string, allowPrivateHttp: boolean): string {
  let u: URL;
  try {
    u = new URL(value);
  } catch {
    return fail("InvalidSimulatorUrl");
  }
  if (
    !["http:", "https:"].includes(u.protocol) ||
    u.username ||
    u.password ||
    u.hash ||
    u.search ||
    u.pathname !== "/"
  )
    return fail("InvalidSimulatorUrl");
  if (
    u.protocol === "http:" &&
    !["localhost", "127.0.0.1", "[::1]"].includes(u.hostname) &&
    !allowPrivateHttp
  )
    return fail("SimulatorHttpsRequired");
  return u.origin;
}
export function parseSimulatorConfig(
  env: NodeJS.ProcessEnv = process.env,
): SimulatorConfig {
  if (!env.DATABASE_URL) return fail("DatabaseUrlRequired");
  const privateHttp = env.SIMULATOR_ALLOW_PRIVATE_HTTP || "false";
  if (privateHttp !== "true" && privateHttp !== "false")
    return fail("InvalidSimulatorConfig");
  const schema = env.SIMULATOR_SCHEMA || "sim_v1";
  if (!/^sim_[a-z0-9_]{1,44}$/.test(schema)) return fail("InvalidSchema");
  return {
    identity: parseIdentity({
      sourceId: env.SIMULATOR_SOURCE_ID || "",
      runId: env.SIMULATOR_RUN_ID || "",
      genesisHash: env.SIMULATOR_GENESIS_HASH || "",
      chainId: env.SIMULATOR_CHAIN_ID || "",
    }),
    databaseUrl: env.DATABASE_URL,
    schema,
    feedUrl: origin(env.SIMULATOR_URL || "", privateHttp === "true"),
    ...(env.SIMULATOR_FULL_URL
      ? { fullUrl: origin(env.SIMULATOR_FULL_URL, privateHttp === "true") }
      : {}),
    ...(env.SIMULATOR_LIGHT_URL
      ? { lightUrl: origin(env.SIMULATOR_LIGHT_URL, privateHttp === "true") }
      : {}),
    ...(env.SIMULATOR_CONTROL_URL
      ? {
          controlUrl: origin(env.SIMULATOR_CONTROL_URL, privateHttp === "true"),
        }
      : {}),
    ...(env.SIMULATOR_CONTROL_TOKEN
      ? { controlToken: env.SIMULATOR_CONTROL_TOKEN }
      : {}),
    host: env.SERVER_HOST || "127.0.0.1",
    port: integer(Number(env.PORT || env.SERVER_PORT || "3000"), 65535),
    pollMs: Math.max(
      100,
      integer(Number(env.SIMULATOR_POLL_MS || "1000"), 60000),
    ),
  };
}

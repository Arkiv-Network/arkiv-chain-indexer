import { AuthService } from "../auth";
import { parseAuthConfig } from "../authConfig";
import { AuthStorage } from "../authStorage";
import { SimulatorError } from "./common";
import { parseSimulatorConfig } from "./config";
import { runNativeScanner } from "./scanner";
import { createNativeHandler } from "./server";
import { HttpSimulatorSource } from "./source";
import { SimulatorStorage } from "./storage";
function report(error: unknown): void {
  console.error("Native simulator service stopped", {
    code: error instanceof SimulatorError ? error.code : "ServiceUnavailable",
  });
  process.exitCode = 1;
}
export async function nativeScanMain(): Promise<void> {
  let storage: SimulatorStorage | undefined;
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  try {
    const config = parseSimulatorConfig();
    storage = await SimulatorStorage.open(
      config.databaseUrl,
      config.identity,
      config.schema,
    );
    await runNativeScanner(
      new HttpSimulatorSource(config.feedUrl, config.identity),
      storage,
      config.pollMs,
      controller.signal,
    );
  } catch (error) {
    report(error);
  } finally {
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
    await storage?.close();
  }
}
export async function nativeServeMain(): Promise<void> {
  let storage: SimulatorStorage | undefined,
    authStorage: AuthStorage | undefined,
    timer: ReturnType<typeof setInterval> | undefined;
  try {
    const config = parseSimulatorConfig(),
      authConfig = parseAuthConfig(process.env);
    storage = await SimulatorStorage.open(
      config.databaseUrl,
      config.identity,
      config.schema,
    );
    let auth: AuthService | undefined;
    if (authConfig) {
      authStorage = await AuthStorage.open(config.databaseUrl);
      auth = new AuthService(authConfig, authStorage);
      const store = authStorage;
      timer = setInterval(() => {
        void store
          .cleanup(Date.now())
          .catch(() => console.warn("Auth expiry cleanup failed"));
      }, 60000);
      timer.unref();
    }
    const server = Bun.serve({
      hostname: config.host,
      port: config.port,
      maxRequestBodySize: 16384,
      fetch: createNativeHandler({
        storage,
        ...(auth ? { auth } : {}),
        ...(config.controlUrl ? { controlUrl: config.controlUrl } : {}),
        ...(config.controlToken ? { controlToken: config.controlToken } : {}),
      }),
    });
    console.info("Native simulator API ready", {
      host: config.host,
      port: server.port,
    });
    await new Promise<void>((resolve) => {
      const stop = () => {
        process.off("SIGINT", stop);
        process.off("SIGTERM", stop);
        void server.stop().then(resolve);
      };
      process.once("SIGINT", stop);
      process.once("SIGTERM", stop);
    });
  } catch (error) {
    report(error);
  } finally {
    if (timer) clearInterval(timer);
    await authStorage?.close();
    await storage?.close();
  }
}

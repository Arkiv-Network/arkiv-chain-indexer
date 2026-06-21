export type RuntimeConfig = Record<string, string | undefined>;

declare global {
  interface Window {
    __ARKIV_CONFIG__?: RuntimeConfig;
  }
}

function buildEnvValues(): RuntimeConfig {
  return ((import.meta as ImportMeta & { env?: RuntimeConfig }).env ?? {});
}

function runtimeEnvValues(): RuntimeConfig {
  if (typeof window === "undefined") {
    return {};
  }

  return window.__ARKIV_CONFIG__ ?? {};
}

export function envValues(): RuntimeConfig {
  return {
    ...buildEnvValues(),
    ...runtimeEnvValues(),
  };
}

export interface BuildInfo {
  commit: string | null;
  builtAtUtc: string | null;
}

export function readBuildInfo(env: NodeJS.ProcessEnv = process.env): BuildInfo {
  return {
    commit: firstNonEmpty(env.BUILD_COMMIT, env.GIT_COMMIT, env.VITE_BUILD_COMMIT),
    builtAtUtc: firstNonEmpty(env.BUILD_DATE, env.BUILD_DATE_UTC, env.VITE_BUILD_DATE_UTC),
  };
}

function firstNonEmpty(...values: Array<string | undefined>): string | null {
  for (const value of values) {
    const trimmed = value?.trim();
    if (trimmed) return trimmed;
  }
  return null;
}

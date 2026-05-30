import { Command, Option } from "commander";

/**
 * Shared command-line plumbing for the backend tasks.
 *
 * Every entry point used to ship its own copy of the same argv tokenizer plus
 * a grab-bag of `parseXxxOption` coercion helpers. This module centralises that
 * work on top of {@link https://github.com/tj/commander.js commander}: commander
 * handles argv tokenization and `--help` text generation, while this wrapper
 * keeps the behaviour the tasks rely on — values are resolved with the
 * precedence **CLI flag > environment variable(s) > default**, the environment
 * is injected (so it stays unit-testable), and typed coercion produces stable,
 * human-readable error messages.
 */

/** A single option understood by a task. */
export interface CliOption {
  /**
   * Commander flag definition, e.g. `"--database-url <url>"` for a value option
   * or `"--once"` for a boolean flag. The placeholder (`<url>`, `<number>`,
   * `<bool>`, `<n>`, …) is preserved verbatim in the generated help text.
   */
  flags: string;
  /** Help description for this option. */
  description: string;
  /**
   * Environment variable names, in priority order, used as a fallback when the
   * flag is absent from the command line.
   */
  env?: string[];
  /** Raw default value applied when neither the CLI nor the environment set it. */
  default?: string;
  /** Hide this option from the generated help (used for legacy aliases). */
  hidden?: boolean;
}

/** Declarative description of a task's command-line interface. */
export interface CliSpec {
  /** Program name shown in the usage line. */
  name: string;
  /** Summary paragraph rendered above the option list. */
  summary: string;
  options: CliOption[];
}

/** Resolved view over the parsed command line and its environment fallbacks. */
export interface ParsedCli {
  /** True when `--help` was passed. */
  helpRequested: boolean;
  /** Rendered `--help` text. */
  helpText: string;
  /** Resolved value for a value option: CLI flag, then env, then default. */
  value(key: string): string | undefined;
  /** Whether a boolean flag was present on the command line. */
  flag(key: string): boolean;
}

interface ResolvedOption {
  key: string;
  attributeName: string;
  env: string[];
  default: string | undefined;
}

/** Thrown when a task is invoked with `--help`. Carries the rendered usage text. */
export class CliHelpRequested extends Error {}

const HELP_FLAG = "--help";

function longNameOf(flags: string): string {
  const match = flags.match(/--([^\s,]+)/);
  if (!match) {
    throw new Error(`Option "${flags}" must declare a long flag`);
  }
  return match[1]!;
}

/**
 * Parse `args` against `spec`, resolving each option against the injected `env`.
 *
 * Commander tokenizes the arguments and renders the help text; this function
 * layers environment fallbacks and defaults on top. It never exits the process
 * or writes to stdio — unknown options surface as thrown `Error`s and `--help`
 * is reported via {@link ParsedCli.helpRequested}.
 */
export function parseCli(
  spec: CliSpec,
  args: string[],
  env: NodeJS.ProcessEnv,
): ParsedCli {
  const program = new Command()
    .name(spec.name)
    .description(spec.summary)
    .helpOption(false)
    .allowExcessArguments(false)
    .configureOutput({ writeErr: () => {}, writeOut: () => {} })
    .exitOverride();

  const resolved: ResolvedOption[] = [];
  for (const option of spec.options) {
    const commanderOption = new Option(option.flags, option.description);
    if (option.hidden) {
      commanderOption.hideHelp();
    }
    program.addOption(commanderOption);
    resolved.push({
      key: longNameOf(option.flags),
      attributeName: commanderOption.attributeName(),
      env: option.env ?? [],
      default: option.default,
    });
  }
  program.addOption(new Option(HELP_FLAG, "Show this message."));

  try {
    program.parse(args, { from: "user" });
  } catch (error) {
    throw new Error(cleanCommanderMessage(error));
  }

  const opts = program.opts();
  const byKey = new Map(resolved.map((option) => [option.key, option]));

  return {
    helpRequested: opts.help === true,
    helpText: program.helpInformation().trimEnd(),
    value(key: string): string | undefined {
      const option = byKey.get(key);
      if (!option) {
        throw new Error(`Unknown CLI option requested: ${key}`);
      }
      const cliValue = opts[option.attributeName];
      if (typeof cliValue === "string") {
        return cliValue;
      }
      for (const name of option.env) {
        const envValue = env[name];
        if (envValue !== undefined) {
          return envValue;
        }
      }
      return option.default;
    },
    flag(key: string): boolean {
      const option = byKey.get(key);
      if (!option) {
        throw new Error(`Unknown CLI flag requested: ${key}`);
      }
      return opts[option.attributeName] === true;
    },
  };
}

function cleanCommanderMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/^error:\s*/i, "");
}

export function coerceBigInt(flag: string, value: string): bigint {
  if (!/^\d+$/.test(value)) {
    throw new Error(`${flag} must be a non-negative integer`);
  }
  return BigInt(value);
}

export function coerceInt(flag: string, value: string): number {
  if (!/^\d+$/.test(value)) {
    throw new Error(`${flag} must be a non-negative integer`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new Error(`${flag} is too large`);
  }
  return parsed;
}

export function coercePositiveInt(flag: string, value: string): number {
  const parsed = coerceInt(flag, value);
  if (parsed === 0) {
    throw new Error(`${flag} must be greater than zero`);
  }
  return parsed;
}

export function coercePort(flag: string, value: string): number {
  const parsed = coerceInt(flag, value);
  if (parsed > 65_535) {
    throw new Error(`${flag} must be between 0 and 65535`);
  }
  return parsed;
}

export function coerceBoolean(flag: string, value: string): boolean {
  const normalized = value.toLowerCase();
  if (["true", "1", "yes", "on"].includes(normalized)) return true;
  if (["false", "0", "no", "off"].includes(normalized)) return false;
  throw new Error(`${flag} must be a boolean`);
}

import { parseEther } from "viem";

/** Runtime settings for the internal faucet that keeps Baseload wallets funded. */
export interface BaseloadFaucetRuntimeConfig {
  url: string;
  password: string;
  /**
   * Drip once a wallet drops below this balance. Drips repeat until the wallet is
   * back above the floor, so this is what sets the resting balance: a wallet comes
   * to rest in [minBalance, minBalance + dripAmount).
   */
  minBalanceWei: bigint;
  /**
   * Never drip when the resulting balance would reach this ceiling. It is a safety
   * net rather than the resting point — the floor is reached first — so it must be
   * at least minBalance + dripAmount (see parseBaseloadFaucetRuntimeConfig).
   */
  maxBalanceWei: bigint;
  /** Expected size of a single drip, used to project the post-drip balance. */
  dripAmountWei: bigint;
  /** Minimum gap between two drips for the same wallet. */
  cooldownMs: number;
}

export const DEFAULT_FAUCET_MIN_BALANCE_ETHER = "100";
export const DEFAULT_FAUCET_MAX_BALANCE_ETHER = "200";
export const DEFAULT_FAUCET_DRIP_AMOUNT_ETHER = "100";
export const DEFAULT_FAUCET_COOLDOWN_SECONDS = 60;

export function parseBaseloadFaucetRuntimeConfig(
  env: NodeJS.ProcessEnv = process.env,
): BaseloadFaucetRuntimeConfig | null {
  const url = env.BASELOAD_FAUCET_URL?.trim();
  const password = env.BASELOAD_FAUCET_PASSWORD?.trim();
  if (!url) return null;
  if (!password) {
    throw new Error("BASELOAD_FAUCET_PASSWORD is required when BASELOAD_FAUCET_URL is set");
  }

  const minBalanceWei = parseEtherEnv(
    env.BASELOAD_FAUCET_MIN_BALANCE,
    DEFAULT_FAUCET_MIN_BALANCE_ETHER,
    "BASELOAD_FAUCET_MIN_BALANCE",
  );
  const maxBalanceWei = parseEtherEnv(
    env.BASELOAD_FAUCET_MAX_BALANCE,
    DEFAULT_FAUCET_MAX_BALANCE_ETHER,
    "BASELOAD_FAUCET_MAX_BALANCE",
  );
  const dripAmountWei = parseEtherEnv(
    env.BASELOAD_FAUCET_DRIP_AMOUNT,
    DEFAULT_FAUCET_DRIP_AMOUNT_ETHER,
    "BASELOAD_FAUCET_DRIP_AMOUNT",
  );

  // A ceiling below floor + drip leaves a band where a wallet is under the floor
  // yet every drip is refused for overshooting: it would stall there until it
  // burned back down. Reject that instead of starving wallets at runtime.
  if (maxBalanceWei < minBalanceWei + dripAmountWei) {
    throw new Error(
      "BASELOAD_FAUCET_MAX_BALANCE must be at least BASELOAD_FAUCET_MIN_BALANCE plus " +
        "BASELOAD_FAUCET_DRIP_AMOUNT, otherwise wallets below the floor are refused a drip",
    );
  }

  const cooldownSeconds = parseNumberEnv(
    env.BASELOAD_FAUCET_COOLDOWN_SECONDS,
    DEFAULT_FAUCET_COOLDOWN_SECONDS,
    "BASELOAD_FAUCET_COOLDOWN_SECONDS",
  );

  return {
    url: url.replace(/\/+$/, ""),
    password,
    minBalanceWei,
    maxBalanceWei,
    dripAmountWei,
    cooldownMs: cooldownSeconds * 1000,
  };
}

function parseEtherEnv(value: string | undefined, fallback: string, name: string): bigint {
  const raw = value?.trim() || fallback;
  let parsed: bigint;
  try {
    parsed = parseEther(raw as `${number}`);
  } catch {
    throw new Error(`${name} must be a decimal amount in ether`);
  }
  if (parsed <= 0n) throw new Error(`${name} must be greater than zero`);
  return parsed;
}

function parseNumberEnv(value: string | undefined, fallback: number, name: string): number {
  const raw = value?.trim();
  if (!raw) return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`${name} must be a non-negative number`);
  }
  return parsed;
}

export type FaucetDripDecision =
  | { drip: true }
  | { drip: false; reason: "funded" | "would-exceed-max" | "cooldown" };

/**
 * Decides whether a wallet should be dripped. The ceiling is checked against the
 * *projected* post-drip balance so a top-up can never push a wallet to maxBalanceWei.
 *
 * Drips repeat while the wallet is under the floor, so it is minBalanceWei — not
 * the ceiling — that determines where a wallet comes to rest: an empty wallet is
 * dripped until it first clears the floor, landing in [min, min + dripAmount).
 */
export function decideDrip(
  balanceWei: bigint,
  config: Pick<BaseloadFaucetRuntimeConfig, "minBalanceWei" | "maxBalanceWei" | "dripAmountWei">,
  msSinceLastDrip: number | null,
  cooldownMs: number,
): FaucetDripDecision {
  if (balanceWei >= config.minBalanceWei) return { drip: false, reason: "funded" };
  if (balanceWei + config.dripAmountWei >= config.maxBalanceWei) {
    return { drip: false, reason: "would-exceed-max" };
  }
  if (msSinceLastDrip !== null && msSinceLastDrip < cooldownMs) {
    return { drip: false, reason: "cooldown" };
  }
  return { drip: true };
}

export interface FaucetDripResult {
  address: string;
  requested: boolean;
  reason?: string;
}

/**
 * Client for the password-gated internal faucet: `POST /login` establishes a
 * session cookie, `POST /drip` funds one address. The session is reused until the
 * faucet rejects it, then re-established once.
 */
export class BaseloadFaucetClient {
  private cookie: string | null = null;
  private readonly lastDripAtMs = new Map<string, number>();
  private readonly inFlight = new Set<string>();

  constructor(
    private readonly config: BaseloadFaucetRuntimeConfig,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly now: () => number = Date.now,
  ) {}

  /** Drips `address` when the balance is below the floor and the ceiling allows it. */
  async maybeTopUp(address: string, balanceWei: bigint): Promise<FaucetDripResult> {
    const key = address.toLowerCase();
    if (this.inFlight.has(key)) return { address, requested: false, reason: "in-flight" };

    const last = this.lastDripAtMs.get(key);
    const decision = decideDrip(
      balanceWei,
      this.config,
      last === undefined ? null : this.now() - last,
      this.config.cooldownMs,
    );
    if (!decision.drip) return { address, requested: false, reason: decision.reason };

    this.inFlight.add(key);
    try {
      await this.drip(address);
      this.lastDripAtMs.set(key, this.now());
      return { address, requested: true };
    } finally {
      this.inFlight.delete(key);
    }
  }

  private async drip(address: string): Promise<void> {
    let response = await this.postDrip(address);
    if (response.status === 401 || response.status === 403) {
      this.cookie = null;
      response = await this.postDrip(address);
    }
    if (!response.ok) {
      const body = (await response.text().catch(() => "")).slice(0, 200);
      throw new Error(`faucet drip failed with HTTP ${response.status}${body ? `: ${body}` : ""}`);
    }
  }

  private async postDrip(address: string): Promise<Response> {
    await this.ensureSession();
    return this.fetchImpl(`${this.config.url}/drip`, {
      method: "POST",
      redirect: "manual",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        ...(this.cookie ? { Cookie: this.cookie } : {}),
      },
      body: new URLSearchParams({ address }).toString(),
    });
  }

  private async ensureSession(): Promise<void> {
    if (this.cookie) return;
    const response = await this.fetchImpl(`${this.config.url}/login`, {
      method: "POST",
      redirect: "manual",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ password: this.config.password }).toString(),
    });
    // A successful login answers with a redirect plus Set-Cookie; a bad password
    // re-renders the form with 401.
    if (response.status === 401 || response.status === 403) {
      throw new Error("faucet login rejected the configured password");
    }
    const setCookie = response.headers.get("set-cookie");
    if (!setCookie) {
      throw new Error(`faucet login returned no session cookie (HTTP ${response.status})`);
    }
    this.cookie = setCookie.split(";")[0] ?? null;
  }
}

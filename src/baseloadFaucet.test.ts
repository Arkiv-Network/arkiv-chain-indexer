import { describe, expect, test } from "bun:test";
import { parseEther } from "viem";
import {
  BaseloadFaucetClient,
  decideDrip,
  parseBaseloadFaucetRuntimeConfig,
  type BaseloadFaucetRuntimeConfig,
} from "./baseloadFaucet";

const LIMITS = {
  minBalanceWei: parseEther("100"),
  maxBalanceWei: parseEther("200"),
  dripAmountWei: parseEther("100"),
};

describe("decideDrip", () => {
  test("skips a wallet at or above the floor", () => {
    expect(decideDrip(parseEther("100"), LIMITS, null, 0)).toEqual({ drip: false, reason: "funded" });
    expect(decideDrip(parseEther("150"), LIMITS, null, 0)).toEqual({ drip: false, reason: "funded" });
  });

  test("drips a wallet below the floor", () => {
    expect(decideDrip(parseEther("99.9"), LIMITS, null, 0)).toEqual({ drip: true });
    expect(decideDrip(0n, LIMITS, null, 0)).toEqual({ drip: true });
  });

  test("never lets a drip reach the ceiling", () => {
    // 99.9 + 100 = 199.9 -> allowed; 100 would land exactly on 200 -> refused.
    expect(decideDrip(parseEther("99.9"), LIMITS, null, 0)).toEqual({ drip: true });
    expect(decideDrip(parseEther("100"), { ...LIMITS, minBalanceWei: parseEther("150") }, null, 0)).toEqual({
      drip: false,
      reason: "would-exceed-max",
    });
  });

  test("comes to rest just under the floor plus one drip", () => {
    // An empty wallet is dripped until it first clears the floor; with a 100 floor
    // and 100 drips that is 0 -> 100 and no further. The floor, not the ceiling,
    // is what caps a wallet: raising the floor raises the resting balance.
    let balance = 0n;
    let drips = 0;
    while (decideDrip(balance, LIMITS, null, 0).drip) {
      balance += LIMITS.dripAmountWei;
      drips += 1;
      expect(balance).toBeLessThan(LIMITS.maxBalanceWei);
    }
    expect(drips).toBe(1);
    expect(balance).toBe(parseEther("100"));
  });

  test("holds off during the cooldown", () => {
    expect(decideDrip(0n, LIMITS, 5_000, 60_000)).toEqual({ drip: false, reason: "cooldown" });
    expect(decideDrip(0n, LIMITS, 61_000, 60_000)).toEqual({ drip: true });
  });
});

describe("parseBaseloadFaucetRuntimeConfig", () => {
  test("returns null when no faucet url is configured", () => {
    expect(parseBaseloadFaucetRuntimeConfig({})).toBeNull();
  });

  test("requires a password alongside the url", () => {
    expect(() => parseBaseloadFaucetRuntimeConfig({ BASELOAD_FAUCET_URL: "https://f" })).toThrow(
      /BASELOAD_FAUCET_PASSWORD is required/,
    );
  });

  test("applies the documented defaults and trims the url", () => {
    const config = parseBaseloadFaucetRuntimeConfig({
      BASELOAD_FAUCET_URL: "https://faucet.example/",
      BASELOAD_FAUCET_PASSWORD: "hunter2",
    });
    expect(config).toMatchObject({
      url: "https://faucet.example",
      minBalanceWei: parseEther("100"),
      maxBalanceWei: parseEther("200"),
      dripAmountWei: parseEther("100"),
      cooldownMs: 60_000,
    });
  });

  test("rejects a ceiling that would refuse drips to a wallet under the floor", () => {
    // At or below the floor, and in the band where floor + drip overshoots the
    // ceiling: both leave low wallets permanently un-drippable.
    for (const max of ["100", "150"]) {
      expect(() =>
        parseBaseloadFaucetRuntimeConfig({
          BASELOAD_FAUCET_URL: "https://f",
          BASELOAD_FAUCET_PASSWORD: "p",
          BASELOAD_FAUCET_MIN_BALANCE: "100",
          BASELOAD_FAUCET_MAX_BALANCE: max,
        }),
      ).toThrow(/must be at least/);
    }
  });

  test("accepts a ceiling exactly one drip above the floor", () => {
    expect(
      parseBaseloadFaucetRuntimeConfig({
        BASELOAD_FAUCET_URL: "https://f",
        BASELOAD_FAUCET_PASSWORD: "p",
        BASELOAD_FAUCET_MIN_BALANCE: "250",
        BASELOAD_FAUCET_MAX_BALANCE: "350",
      }),
    ).toMatchObject({ minBalanceWei: parseEther("250"), maxBalanceWei: parseEther("350") });
  });
});

function testConfig(overrides: Partial<BaseloadFaucetRuntimeConfig> = {}): BaseloadFaucetRuntimeConfig {
  return {
    url: "https://faucet.example",
    password: "hunter2",
    ...LIMITS,
    cooldownMs: 60_000,
    ...overrides,
  };
}

describe("BaseloadFaucetClient", () => {
  test("logs in once and reuses the session cookie", async () => {
    const calls: string[] = [];
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      const href = String(url);
      calls.push(href);
      if (href.endsWith("/login")) {
        expect(String(init?.body)).toContain("password=hunter2");
        return new Response(null, { status: 302, headers: { "set-cookie": "sid=abc; Path=/" } });
      }
      expect(init?.headers).toMatchObject({ Cookie: "sid=abc" });
      expect(String(init?.body)).toContain("address=0xwallet");
      return new Response("ok", { status: 200 });
    }) as unknown as typeof fetch;

    let now = 0;
    const client = new BaseloadFaucetClient(testConfig(), fetchImpl, () => now);

    expect(await client.maybeTopUp("0xwallet", 0n)).toMatchObject({ requested: true });
    now += 120_000;
    expect(await client.maybeTopUp("0xwallet", 0n)).toMatchObject({ requested: true });

    expect(calls.filter((c) => c.endsWith("/login"))).toHaveLength(1);
    expect(calls.filter((c) => c.endsWith("/drip"))).toHaveLength(2);
  });

  test("re-logs in once when the session is rejected", async () => {
    let logins = 0;
    let drips = 0;
    const fetchImpl = (async (url: string | URL | Request) => {
      const href = String(url);
      if (href.endsWith("/login")) {
        logins += 1;
        return new Response(null, { status: 302, headers: { "set-cookie": "sid=fresh; Path=/" } });
      }
      drips += 1;
      return drips === 1 ? new Response("expired", { status: 401 }) : new Response("ok", { status: 200 });
    }) as unknown as typeof fetch;

    const client = new BaseloadFaucetClient(testConfig(), fetchImpl, () => 0);
    expect(await client.maybeTopUp("0xwallet", 0n)).toMatchObject({ requested: true });
    expect(logins).toBe(2);
    expect(drips).toBe(2);
  });

  test("surfaces a bad password instead of retrying forever", async () => {
    const fetchImpl = (async () => new Response("nope", { status: 401 })) as unknown as typeof fetch;
    const client = new BaseloadFaucetClient(testConfig(), fetchImpl, () => 0);
    await expect(client.maybeTopUp("0xwallet", 0n)).rejects.toThrow(/rejected the configured password/);
  });

  test("does not call the faucet for a funded wallet", async () => {
    const fetchImpl = (async () => {
      throw new Error("should not be called");
    }) as unknown as typeof fetch;
    const client = new BaseloadFaucetClient(testConfig(), fetchImpl, () => 0);
    expect(await client.maybeTopUp("0xwallet", parseEther("120"))).toMatchObject({
      requested: false,
      reason: "funded",
    });
  });
});

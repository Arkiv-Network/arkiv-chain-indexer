import { describe, expect, test } from "bun:test";
import {
  buildPayloadProviderPaymentBreakdown,
  parsePaymentSchedule,
  selectPaymentParams,
} from "./payloadProviderPayments";
import type { ArkivOperation } from "./arkivOperations";

describe("payload provider payments", () => {
  test("selects the latest active payment params", () => {
    const schedule = parsePaymentSchedule({
      schedule: [
        {
          activationBlock: 0,
          payloadProviderPayment: { enabled: false, providerShareBps: 0, minimumPayment: "0" },
        },
        {
          activationBlock: 100,
          payloadProviderPayment: {
            enabled: true,
            providerShareBps: 7000,
            minimumPayment: "100000",
          },
        },
      ],
    });

    expect(selectPaymentParams(schedule, 99n)?.enabled).toBe(false);
    expect(selectPaymentParams(schedule, 100n)?.providerShareBps).toBe(7000);
  });

  test("aggregates multiple rewarded providers and burned amounts", () => {
    const breakdown = buildPayloadProviderPaymentBreakdown(
      [
        referenceOperation(0, "provider-a", "0x1111111111111111111111111111111111111111", 1000),
        referenceOperation(1, "provider-a", "0x1111111111111111111111111111111111111111", 500),
        referenceOperation(2, "provider-b", "0x2222222222222222222222222222222222222222", 400),
      ],
      { enabled: true, providerShareBps: 7000, minimumPayment: "100" },
      "protocolSchedule",
    );

    expect(breakdown).toMatchObject({
      enabled: true,
      providerShareBps: 7000,
      totalPaymentWei: "1900",
      totalProviderEarnedWei: "1330",
      totalBurnedWei: "570",
      minimumPaymentWei: "100",
      source: "protocolSchedule",
    });
    expect(breakdown?.providers).toEqual([
      {
        provider: "provider-a",
        signer: "0x1111111111111111111111111111111111111111",
        paymentCount: 2,
        paymentWei: "1500",
        providerEarnedWei: "1050",
        burnedWei: "450",
      },
      {
        provider: "provider-b",
        signer: "0x2222222222222222222222222222222222222222",
        paymentCount: 1,
        paymentWei: "400",
        providerEarnedWei: "280",
        burnedWei: "120",
      },
    ]);
  });
});

function referenceOperation(
  opIndex: number,
  provider: string,
  signer: string,
  payment: number,
): ArkivOperation {
  return {
    opIndex,
    operationType: 1,
    operation: "create",
    entityKey: `0x${"11".repeat(32)}`,
    contentType: "application/vnd.atlas.payload-reference+json",
    payloadSizeBytes: 42,
    attributes: [],
    expiresAtBlocks: 0,
    newOwner: null,
    isReference: true,
    payloadReference: {
      kind: "atlas.payloadReference",
      version: 1,
      provider,
      id: `${opIndex}`.padStart(64, "a"),
      namespace: "atlas.test",
      checksum: `sha256:${"b".repeat(64)}`,
      sizeBytes: 42,
      submittedAt: "2026-06-24T15:24:30Z",
      nonce: `0x${"00".repeat(31)}01`,
      payment,
      signature: {
        scheme: "eip191",
        signer,
        receipt: {},
        messageHash: `0x${"cd".repeat(32)}`,
        signature: `0x${"ef".repeat(65)}`,
        r: `0x${"11".repeat(32)}`,
        s: `0x${"22".repeat(32)}`,
        v: 27,
      },
    },
    referenceVerification: {
      valid: true,
      signerTrusted: true,
      chainId: 42069,
      claimedSigner: signer,
      recoveredSigner: signer,
      messageHash: `0x${"cd".repeat(32)}`,
      errors: [],
    },
    referenceError: null,
  };
}

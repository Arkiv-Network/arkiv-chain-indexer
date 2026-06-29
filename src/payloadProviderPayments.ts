import { readFile } from "node:fs/promises";
import type { ArkivOperation } from "./arkivOperations";

const BPS_DENOMINATOR = 10_000n;

export interface PayloadProviderPaymentParams {
  enabled: boolean;
  providerShareBps: number;
  minimumPayment: string;
}

export interface PayloadProviderPaymentEntry {
  opIndex: number;
  provider: string;
  signer: string | null;
  payloadId: string;
  paymentGasUnits: string;
  paymentWei: string;
  providerEarnedWei: string;
  burnedWei: string;
}

export interface PayloadProviderPaymentProviderTotal {
  provider: string;
  signer: string | null;
  paymentCount: number;
  paymentGasUnits: string;
  paymentWei: string;
  providerEarnedWei: string;
  burnedWei: string;
}

export interface PayloadProviderPaymentBreakdown {
  enabled: boolean;
  providerShareBps: number | null;
  minimumPaymentGasUnits: string | null;
  minimumPaymentWei: string | null;
  totalPaymentGasUnits: string;
  totalPaymentWei: string;
  totalProviderEarnedWei: string;
  totalBurnedWei: string;
  entries: PayloadProviderPaymentEntry[];
  providers: PayloadProviderPaymentProviderTotal[];
  source: "protocolSchedule" | "configuredShareBps" | "unconfigured";
}

export interface PayloadProviderPaymentScheduleEntry {
  activationBlock: number;
  payloadProviderPayment: PayloadProviderPaymentParams;
}

export interface PayloadProviderPaymentSchedule {
  schedule: PayloadProviderPaymentScheduleEntry[];
}

export interface PayloadProviderPaymentResolverOptions {
  scheduleUrl?: string;
  schedulePath?: string;
  providerShareBps?: number;
  cacheTtlMs?: number;
}

export class PayloadProviderPaymentResolver {
  private cachedSchedule: PayloadProviderPaymentSchedule | null = null;
  private cachedAtMs = 0;

  constructor(private readonly options: PayloadProviderPaymentResolverOptions = {}) {}

  async resolve(blockNumber: string | number | bigint): Promise<{
    params: PayloadProviderPaymentParams | null;
    source: PayloadProviderPaymentBreakdown["source"];
  }> {
    const schedule = await this.readSchedule();
    if (schedule) {
      return {
        params: selectPaymentParams(schedule, BigInt(blockNumber)),
        source: "protocolSchedule",
      };
    }
    if (this.options.providerShareBps !== undefined) {
      return {
        params: {
          enabled: true,
          providerShareBps: this.options.providerShareBps,
          minimumPayment: "0",
        },
        source: "configuredShareBps",
      };
    }
    return { params: null, source: "unconfigured" };
  }

  private async readSchedule(): Promise<PayloadProviderPaymentSchedule | null> {
    const cacheTtlMs = this.options.cacheTtlMs ?? 15_000;
    const now = Date.now();
    if (this.cachedSchedule && now - this.cachedAtMs < cacheTtlMs) return this.cachedSchedule;

    let raw: string | null;
    try {
      raw = await this.readRawSchedule();
    } catch {
      return this.cachedSchedule;
    }
    if (!raw) return null;
    let parsed: PayloadProviderPaymentSchedule;
    try {
      parsed = parsePaymentSchedule(JSON.parse(raw));
    } catch {
      return this.cachedSchedule;
    }
    this.cachedSchedule = parsed;
    this.cachedAtMs = now;
    return parsed;
  }

  private async readRawSchedule(): Promise<string | null> {
    if (this.options.schedulePath) {
      return readFile(this.options.schedulePath, "utf8");
    }
    if (this.options.scheduleUrl) {
      const response = await fetch(this.options.scheduleUrl);
      if (!response.ok) {
        throw new Error(`Protocol schedule HTTP ${response.status}`);
      }
      return response.text();
    }
    return null;
  }
}

export function buildPayloadProviderPaymentBreakdown(
  operations: readonly ArkivOperation[],
  params: PayloadProviderPaymentParams | null,
  source: PayloadProviderPaymentBreakdown["source"],
  baseFeeWei: string | number | bigint,
): PayloadProviderPaymentBreakdown | null {
  const referenceOperations = operations.filter(
    (operation) => operation.payloadReference && operation.referenceVerification?.valid,
  );
  if (referenceOperations.length === 0) return null;

  const providerShareBps = params?.enabled ? params.providerShareBps : null;
  const baseFee = BigInt(baseFeeWei);
  const entries = referenceOperations.map((operation) => {
    const reference = operation.payloadReference!;
    const paymentGasUnits = BigInt(reference.payment);
    const payment = paymentGasUnits * baseFee;
    const providerEarned =
      providerShareBps === null
        ? 0n
        : (payment * BigInt(providerShareBps)) / BPS_DENOMINATOR;
    const burned = providerShareBps === null ? 0n : payment - providerEarned;
    return {
      opIndex: operation.opIndex,
      provider: reference.provider,
      signer:
        operation.referenceVerification?.recoveredSigner ??
        operation.referenceVerification?.claimedSigner ??
        reference.signature.signer ??
        null,
      payloadId: reference.id,
      paymentGasUnits: paymentGasUnits.toString(),
      paymentWei: payment.toString(),
      providerEarnedWei: providerEarned.toString(),
      burnedWei: burned.toString(),
    };
  });

  const providersByKey = new Map<string, PayloadProviderPaymentProviderTotal>();
  let totalPaymentGasUnits = 0n;
  let totalPayment = 0n;
  let totalProviderEarned = 0n;
  let totalBurned = 0n;
  for (const entry of entries) {
    totalPaymentGasUnits += BigInt(entry.paymentGasUnits);
    totalPayment += BigInt(entry.paymentWei);
    totalProviderEarned += BigInt(entry.providerEarnedWei);
    totalBurned += BigInt(entry.burnedWei);
    const key = `${entry.provider.toLowerCase()}:${entry.signer?.toLowerCase() ?? ""}`;
    const existing =
      providersByKey.get(key) ??
      {
        provider: entry.provider,
        signer: entry.signer,
        paymentCount: 0,
        paymentGasUnits: "0",
        paymentWei: "0",
        providerEarnedWei: "0",
        burnedWei: "0",
      };
    existing.paymentCount += 1;
    existing.paymentGasUnits = (
      BigInt(existing.paymentGasUnits) + BigInt(entry.paymentGasUnits)
    ).toString();
    existing.paymentWei = (BigInt(existing.paymentWei) + BigInt(entry.paymentWei)).toString();
    existing.providerEarnedWei = (
      BigInt(existing.providerEarnedWei) + BigInt(entry.providerEarnedWei)
    ).toString();
    existing.burnedWei = (BigInt(existing.burnedWei) + BigInt(entry.burnedWei)).toString();
    providersByKey.set(key, existing);
  }

  return {
    enabled: params?.enabled === true,
    providerShareBps,
    minimumPaymentGasUnits: params?.minimumPayment ?? null,
    minimumPaymentWei:
      params?.minimumPayment !== undefined ? (BigInt(params.minimumPayment) * baseFee).toString() : null,
    totalPaymentGasUnits: totalPaymentGasUnits.toString(),
    totalPaymentWei: totalPayment.toString(),
    totalProviderEarnedWei: totalProviderEarned.toString(),
    totalBurnedWei: totalBurned.toString(),
    entries,
    providers: Array.from(providersByKey.values()),
    source,
  };
}

export function selectPaymentParams(
  schedule: PayloadProviderPaymentSchedule,
  blockNumber: bigint,
): PayloadProviderPaymentParams | null {
  let selected: PayloadProviderPaymentScheduleEntry | null = null;
  for (const entry of schedule.schedule) {
    if (BigInt(entry.activationBlock) <= blockNumber) selected = entry;
  }
  return selected?.payloadProviderPayment ?? null;
}

export function parsePaymentSchedule(value: unknown): PayloadProviderPaymentSchedule {
  if (!isRecord(value) || !Array.isArray(value.schedule)) {
    throw new Error("Protocol schedule must contain a schedule array");
  }
  const schedule = value.schedule.map((entry, index) => {
    if (!isRecord(entry) || typeof entry.activationBlock !== "number") {
      throw new Error(`Protocol schedule entry ${index} is invalid`);
    }
    const payment = entry.payloadProviderPayment;
    if (
      !isRecord(payment) ||
      typeof payment.enabled !== "boolean" ||
      typeof payment.providerShareBps !== "number" ||
      typeof payment.minimumPayment !== "string"
    ) {
      throw new Error(`Protocol schedule entry ${index} has invalid payloadProviderPayment`);
    }
    if (!Number.isInteger(payment.providerShareBps) || payment.providerShareBps < 0 || payment.providerShareBps > 10_000) {
      throw new Error(`Protocol schedule entry ${index} providerShareBps is invalid`);
    }
    return {
      activationBlock: entry.activationBlock,
      payloadProviderPayment: {
        enabled: payment.enabled,
        providerShareBps: payment.providerShareBps,
        minimumPayment: payment.minimumPayment,
      },
    };
  });
  return { schedule };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

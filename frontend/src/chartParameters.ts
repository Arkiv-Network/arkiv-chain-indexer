const GWEI_IN_WEI = 1_000_000_000;
const ETH_IN_WEI = 1_000_000_000_000_000_000;

const AXIS_GAS_PRICE = "gas-price";
const AXIS_BLOCK_GAS_LIMIT = "block-gas-limit";
const AXIS_BATCHER = "batcher";

export interface BandDef {
  minKey: string;
  maxKey: string;
}

export interface ParameterDef {
  key: string;
  label: string;
  axis: string;
  axisLabel: string;
  unit: string;
  color: string;
  toNumber: (value: string | number | undefined | null) => number | null;
  /**
   * When set, this parameter renders as a min/max band (filled area) with `key`
   * as the average line on top, mirroring the home view's MinAvgMaxPanel.
   * `minKey`/`maxKey` reference the lower/upper value keys in ChartPoint.values.
   */
  band?: BandDef;
}

const weiToGwei = (value: string | number | undefined | null): number | null => {
  if (value === undefined || value === null) return null;
  try {
    const wei = typeof value === "string" ? BigInt(value) : BigInt(Math.round(value));
    const whole = Number(wei / BigInt(GWEI_IN_WEI));
    const rem = Number(wei % BigInt(GWEI_IN_WEI)) / GWEI_IN_WEI;
    return whole + rem;
  } catch {
    return null;
  }
};

const weiToEth = (value: string | number | undefined | null): number | null => {
  if (value === undefined || value === null) return null;
  try {
    const wei = typeof value === "string" ? BigInt(value) : BigInt(Math.round(value));
    const whole = Number(wei / BigInt(ETH_IN_WEI));
    const rem = Number(wei % BigInt(ETH_IN_WEI)) / ETH_IN_WEI;
    return whole + rem;
  } catch {
    return null;
  }
};

const plainNumber = (value: string | number | undefined | null): number | null => {
  if (value === undefined || value === null) return null;
  try {
    if (typeof value === "number") return value;
    return Number(BigInt(value));
  } catch {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }
};

export const PARAMETERS: ParameterDef[] = [
  {
    key: "averageBaseFeeWei",
    label: "Base fee",
    axis: AXIS_GAS_PRICE,
    axisLabel: "Gas price (gwei)",
    unit: "gwei",
    color: "#2e63d8",
    toNumber: weiToGwei,
    band: { minKey: "minBaseFeeWei", maxKey: "maxBaseFeeWei" },
  },
  {
    key: "averageFeePriceWei",
    label: "Avg fee price",
    axis: AXIS_GAS_PRICE,
    axisLabel: "Gas price (gwei)",
    unit: "gwei",
    color: "#16a085",
    toNumber: weiToGwei,
  },
  {
    key: "averagePriorityFeeWei",
    label: "Avg priority fee",
    axis: AXIS_GAS_PRICE,
    axisLabel: "Gas price (gwei)",
    unit: "gwei",
    color: "#e67e22",
    toNumber: weiToGwei,
  },
  {
    key: "averagePriorityFeeWeightedWei",
    label: "Gas-weighted priority",
    axis: AXIS_GAS_PRICE,
    axisLabel: "Gas price (gwei)",
    unit: "gwei",
    color: "#d35400",
    toNumber: weiToGwei,
  },
  {
    key: "minMaxGasInBlock",
    label: "Min block gas limit",
    axis: AXIS_BLOCK_GAS_LIMIT,
    axisLabel: "Block gas limit",
    unit: "gas",
    color: "#7f8c8d",
    toNumber: plainNumber,
  },
  {
    key: "maxMaxGasInBlock",
    label: "Max block gas limit",
    axis: AXIS_BLOCK_GAS_LIMIT,
    axisLabel: "Block gas limit",
    unit: "gas",
    color: "#2c3e50",
    toNumber: plainNumber,
  },
  {
    key: "totalGasUsed",
    label: "Total gas used",
    axis: "total-gas",
    axisLabel: "Total gas used",
    unit: "gas",
    color: "#9b59b6",
    toNumber: plainNumber,
  },
  {
    key: "totalBlockRewardWei",
    label: "Total reward",
    axis: "total-reward-eth",
    axisLabel: "Total reward (ETH)",
    unit: "ETH",
    color: "#27ae60",
    toNumber: weiToEth,
  },
  {
    key: "averageBlockRewardWei",
    label: "Avg reward / block",
    axis: "avg-reward-eth",
    axisLabel: "Avg reward / block (ETH)",
    unit: "ETH",
    color: "#16a085",
    toNumber: weiToEth,
  },
  {
    key: "totalBurntFeesWei",
    label: "Total burnt",
    axis: "total-burnt-eth",
    axisLabel: "Total burnt (ETH)",
    unit: "ETH",
    color: "#c0392b",
    toNumber: weiToEth,
  },
  {
    key: "averageBurntFeesWei",
    label: "Avg burnt / block",
    axis: "avg-burnt-eth",
    axisLabel: "Avg burnt / block (ETH)",
    unit: "ETH",
    color: "#e74c3c",
    toNumber: weiToEth,
  },
  {
    key: "transactionCount",
    label: "Tx count",
    axis: "tx-count",
    axisLabel: "Tx count",
    unit: "count",
    color: "#8e44ad",
    toNumber: plainNumber,
  },
  {
    key: "averageTransactionGasUsed",
    label: "Avg tx gas",
    axis: "avg-tx-gas",
    axisLabel: "Avg tx gas",
    unit: "gas",
    color: "#34495e",
    toNumber: plainNumber,
  },
  {
    key: "averageBatcherQueueSize",
    label: "Batcher queue",
    axis: AXIS_BATCHER,
    axisLabel: "Batcher value",
    unit: "count",
    color: "#b83280",
    toNumber: plainNumber,
    band: { minKey: "minBatcherQueueSize", maxKey: "maxBatcherQueueSize" },
  },
  {
    key: "averageBatcherIntensity",
    label: "Batcher intensity",
    axis: AXIS_BATCHER,
    axisLabel: "Batcher value",
    unit: "count",
    color: "#6f42c1",
    toNumber: plainNumber,
  },
  {
    key: "averageBatcherLowerThreshold",
    label: "Batcher lower",
    axis: AXIS_BATCHER,
    axisLabel: "Batcher value",
    unit: "count",
    color: "#0f766e",
    toNumber: plainNumber,
  },
  {
    key: "averageBatcherUpperThreshold",
    label: "Batcher upper",
    axis: AXIS_BATCHER,
    axisLabel: "Batcher value",
    unit: "count",
    color: "#be123c",
    toNumber: plainNumber,
  },
  {
    key: "averageBatcherMaxBlockSize",
    label: "Batcher max block",
    axis: AXIS_BATCHER,
    axisLabel: "Batcher value",
    unit: "gas",
    color: "#ca8a04",
    toNumber: plainNumber,
  },
  {
    key: "averageBatcherMaxTxSize",
    label: "Batcher max tx",
    axis: AXIS_BATCHER,
    axisLabel: "Batcher value",
    unit: "gas",
    color: "#475569",
    toNumber: plainNumber,
  },
];

export const DEFAULT_PARAMETERS = ["averageBaseFeeWei", "averagePriorityFeeWei"];

export function getAvailableParameters(noBatcher: boolean): ParameterDef[] {
  return noBatcher ? PARAMETERS.filter((parameter) => parameter.axis !== AXIS_BATCHER) : PARAMETERS;
}

export function parseSelectedParameters(value: string, availableParameters: readonly ParameterDef[]): string[] {
  const parameterKeys = new Set(availableParameters.map((parameter) => parameter.key));
  const defaults = DEFAULT_PARAMETERS.filter((key) => parameterKeys.has(key));
  if (!value) return defaults;
  const selected = value
    .split(",")
    .map((s) => s.trim())
    .filter((s) => parameterKeys.has(s));
  return selected.length > 0 ? selected : defaults;
}

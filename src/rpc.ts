import { blockNumberToHex } from "./math";
import type { RpcKeyRing } from "./rpcKeyRing";
import type { Hex, RpcBlock, RpcReceipt } from "./types";

interface JsonRpcSuccess<T> {
  jsonrpc: "2.0";
  id: number;
  result: T;
}

interface JsonRpcFailure {
  jsonrpc: "2.0";
  id: number;
  error: {
    code: number;
    message: string;
  };
}

type JsonRpcResponse<T> = JsonRpcSuccess<T> | JsonRpcFailure;

export interface RpcStats {
  calls: number;
  requestBytes: number;
  responseBytes: number;
}

const textEncoder = new TextEncoder();

export class EthereumRpcClient {
  private nextId = 1;
  private stats: RpcStats = {
    calls: 0,
    requestBytes: 0,
    responseBytes: 0,
  };

  /**
   * Rotates over a pool of keys when one is configured. Quota is metered per key
   * and a burnt key answers every later call with QUOTA_EXCEEDED, so the ring is
   * what keeps the scanner alive once a single key's month runs out.
   */
  private keyRing: RpcKeyRing | null = null;

  constructor(
    readonly rpcUrl: string,
    private readonly apiKey: string | undefined = process.env.SCANNER_RPC_API_KEY,
  ) {}

  /** Swaps the single key for a rotating pool. See `loadRpcKeyPool`. */
  setKeyRing(keyRing: RpcKeyRing | null) {
    this.keyRing = keyRing;
  }

  getStatsSnapshot(): RpcStats {
    return { ...this.stats };
  }

  getStatsSince(snapshot: RpcStats): RpcStats {
    return {
      calls: this.stats.calls - snapshot.calls,
      requestBytes: this.stats.requestBytes - snapshot.requestBytes,
      responseBytes: this.stats.responseBytes - snapshot.responseBytes,
    };
  }

  async getLatestBlockNumber(): Promise<bigint> {
    const result = await this.request<Hex>("eth_blockNumber", []);
    return BigInt(result);
  }

  async getChainId(): Promise<number> {
    const result = await this.request<Hex>("eth_chainId", []);
    return Number(BigInt(result));
  }

  async getBlockWithTransactions(blockNumber: bigint): Promise<RpcBlock> {
    const result = await this.request<RpcBlock | null>("eth_getBlockByNumber", [
      blockNumberToHex(blockNumber),
      true,
    ]);

    if (result === null) {
      throw new Error(`Block ${blockNumber.toString()} was not found`);
    }

    return result;
  }

  /**
   * Balances of several accounts at the end of one block, in a single JSON-RPC
   * batch.
   *
   * The scanner snapshots every address a block touched, so this runs once per
   * block over a handful of addresses. Sending them one at a time would
   * multiply the scanner's request count — and so its share of the RPC key's
   * quota, which is what actually caps throughput — by that handful.
   *
   * Keyed by lowercased address. An address the node declines to answer for is
   * absent rather than zero: a missing balance must never be mistaken for an
   * empty account.
   */
  async getBalances(
    addresses: readonly string[],
    blockNumber: bigint,
  ): Promise<Map<string, bigint>> {
    const balances = new Map<string, bigint>();
    const unique = [...new Set(addresses.map((address) => address.toLowerCase()))];
    if (unique.length === 0) return balances;

    const blockTag = blockNumberToHex(blockNumber);
    const results = await this.batchRequest<Hex>(
      unique.map((address) => ({ method: "eth_getBalance", params: [address, blockTag] })),
    );
    for (const [index, address] of unique.entries()) {
      const result = results[index];
      if (result !== undefined) balances.set(address, BigInt(result));
    }
    return balances;
  }

  async getTransactionReceipt(transactionHash: Hex): Promise<RpcReceipt> {
    const result = await this.request<RpcReceipt | null>("eth_getTransactionReceipt", [transactionHash]);

    if (result === null) {
      throw new Error(`Receipt ${transactionHash} was not found`);
    }

    return result;
  }

  /**
   * Send several calls as one JSON-RPC batch. Results come back positionally,
   * matched by id because a node may answer a batch in any order. A failure of
   * any single call fails the whole batch: the scanner's callers retry blocks
   * wholesale, so a partially applied batch has nowhere useful to go.
   */
  private async batchRequest<T>(
    calls: ReadonlyArray<{ method: string; params: unknown[] }>,
  ): Promise<T[]> {
    if (calls.length === 0) return [];
    const ids = calls.map(() => this.nextId++);
    const body = JSON.stringify(
      calls.map((call, index) => ({
        jsonrpc: "2.0",
        id: ids[index],
        method: call.method,
        params: call.params,
      })),
    );

    const responseText = await this.post(body, calls[0]!.method, calls.length);
    const payload = JSON.parse(responseText) as Array<JsonRpcResponse<T>>;
    if (!Array.isArray(payload)) {
      throw new Error(`RPC batch of ${calls.length} calls did not answer with an array`);
    }

    const byId = new Map<number, JsonRpcResponse<T>>();
    for (const entry of payload) byId.set(entry.id, entry);
    return calls.map((call, index) => {
      const entry = byId.get(ids[index]!);
      if (!entry) {
        throw new Error(`RPC ${call.method} was missing from the batch response`);
      }
      if ("error" in entry) {
        throw new Error(`RPC ${call.method} failed: ${entry.error.code} ${entry.error.message}`);
      }
      return entry.result;
    });
  }

  private async request<T>(method: string, params: unknown[]): Promise<T> {
    const id = this.nextId++;
    const body = JSON.stringify({
      jsonrpc: "2.0",
      id,
      method,
      params,
    });

    const responseText = await this.post(body, method, 1);

    const payload = JSON.parse(responseText) as JsonRpcResponse<T>;
    if ("error" in payload) {
      throw new Error(`RPC ${method} failed: ${payload.error.code} ${payload.error.message}`);
    }

    return payload.result;
  }

  /** Transport shared by the single and batch paths: key rotation and accounting. */
  private async post(body: string, method: string, callCount: number): Promise<string> {
    this.stats.calls += callCount;
    this.stats.requestBytes += textEncoder.encode(body).byteLength;

    const key = this.keyRing ? this.keyRing.next() : this.apiKey;

    const response = await fetch(this.rpcUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(key ? { "x-api-key": key } : {}),
      },
      body,
    });
    const responseText = await response.text();
    this.stats.responseBytes += textEncoder.encode(responseText).byteLength;

    // Feed the edge's verdict back so an exhausted key leaves the rotation
    // instead of being handed out again every Nth call.
    if (this.keyRing && key) {
      this.keyRing.noteResponse(key, response.status, response.headers, responseText);
    }

    if (!response.ok) {
      throw new Error(`RPC ${method} failed with HTTP ${response.status}`);
    }
    return responseText;
  }
}

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

  async getTransactionReceipt(transactionHash: Hex): Promise<RpcReceipt> {
    const result = await this.request<RpcReceipt | null>("eth_getTransactionReceipt", [transactionHash]);

    if (result === null) {
      throw new Error(`Receipt ${transactionHash} was not found`);
    }

    return result;
  }

  private async request<T>(method: string, params: unknown[]): Promise<T> {
    const id = this.nextId++;
    const body = JSON.stringify({
      jsonrpc: "2.0",
      id,
      method,
      params,
    });

    this.stats.calls += 1;
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

    const payload = JSON.parse(responseText) as JsonRpcResponse<T>;
    if ("error" in payload) {
      throw new Error(`RPC ${method} failed: ${payload.error.code} ${payload.error.message}`);
    }

    return payload.result;
  }
}

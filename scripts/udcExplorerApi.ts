/**
 * The explorer's backend API as verifyUdcExplorer.ts sees it.
 *
 * This is the only place the e2e harness knows the backend's REST shapes, so
 * it is the one module to update when WP2/WP3 reshape them. Everything it
 * returns is normalized: block numbers as numbers, wei and gas as decimal
 * strings. A field the API does not expose yet is `undefined` (the verifier
 * reports it as missing); a field it exposes as null stays null.
 *
 * The shadow RPC paths are Ethereum/Arkiv JSON-RPC, compared against the node
 * as-is, so the adapter only names them.
 */
import type { Hex } from "viem";

export interface ExplorerHead {
  /** Highest block the forward scanner stored. */
  scannerHead: number | null;
  /** Highest block the entity index projected; null when the index is off. */
  entityIndexHead: number | null;
  entityIndexReady: boolean | null;
  /** The raw /health body, for the report. */
  raw: unknown;
}

export interface ExplorerTx {
  hash: Hex;
  block: number;
  position: number;
  from: Hex | null;
  to: Hex | null;
  /** 1 success, 0 reverted, null unknown. */
  status: 0 | 1 | null;
  gasUsed: string;
  gasLimit: string | null;
  effectiveGasPrice: string | null;
  /** Gas fee only (gasUsed × effective price). */
  gasFee: string | null;
  /** The receipt's rentFee; undefined until the API exposes rent (WP2a). */
  rentFee: string | null | undefined;
  /** Decoded operations stored for the tx; undefined when not exposed. */
  operationCount: number | undefined;
}

export interface ExplorerBlock {
  number: number;
  txCount: number;
  gasUsed: string;
  /** Sum of the block's receipts' rentFee; undefined until the API exposes it. */
  rentSum: string | null | undefined;
}

/** One bytes attribute as the index holds it: its size and keccak256, never the content. */
export interface ExplorerBytes {
  size: number;
  keccak256: string;
  /** The REST `value`; null unless the API leaks the content. */
  value: unknown;
}

export interface ExplorerApi {
  base: string;
  /** Ethereum JSON-RPC answered from the index (arkiv_* relayed to the node); admin only. */
  shadowRpcUrl: string;
  /** Headers for /shadow-rpc: a token-login admin session (cookie, origin, CSRF token). */
  shadowRpcHeaders(): Promise<Record<string, string>>;
  /** arkiv_* answered from the entity index. */
  experimentalRpcUrl: string;
  head(): Promise<ExplorerHead>;
  /** null when the explorer has no such transaction. */
  transaction(hash: Hex): Promise<ExplorerTx | null>;
  /** Every stored block in [from, to], keyed by number. */
  blocks(from: number, to: number): Promise<Map<number, ExplorerBlock>>;
  /**
   * The bytes attributes of an entity's current state in the index (`GET
   * /entity/<key>`, `state`), by name. null when the explorer does not know
   * the entity; undefined when it exposes no state.
   */
  entityBytes(key: Hex): Promise<Map<string, ExplorerBytes> | null | undefined>;
}

const num = (value: unknown): number | null =>
  value === null || value === undefined || value === "" ? null : Number(value);
const text = (value: unknown): string | null =>
  value === null || value === undefined ? null : BigInt(value as string).toString();
const hex = (value: unknown): Hex | null => (typeof value === "string" ? (value.toLowerCase() as Hex) : null);

export interface ExplorerAuth {
  /** The backend's AUTH_TOKEN_LOGIN_TOKEN; without it /shadow-rpc answers 401/503. */
  adminToken?: string | undefined;
  /** An email in the backend's AUTH_ADMIN_EMAILS. */
  adminEmail: string;
}

export function explorerApi(base: string, auth?: ExplorerAuth): ExplorerApi {
  const root = base.replace(/\/+$/, "");
  const origin = new URL(root).origin;
  let session: Promise<Record<string, string>> | undefined;
  // Token login (AUTH_PUBLIC_ORIGIN must be this origin): the session cookie,
  // then the CSRF token every non-GET admin request carries.
  const login = async (): Promise<Record<string, string>> => {
    if (!auth?.adminToken) return {};
    const response = await fetch(`${root}/auth/token-login`, {
      method: "POST",
      headers: { "content-type": "application/json", origin },
      body: JSON.stringify({ email: auth.adminEmail, token: auth.adminToken }),
      signal: AbortSignal.timeout(10_000),
    });
    if (response.status !== 204) throw new Error(`/auth/token-login: HTTP ${response.status} ${(await response.text()).slice(0, 200)}`);
    const cookie = (response.headers.get("set-cookie") ?? "").split(";")[0]!;
    const who = await fetch(`${root}/auth/session`, { headers: { cookie, origin }, signal: AbortSignal.timeout(10_000) });
    const body: any = await who.json();
    if (body?.role !== "admin" || !body.csrfToken) throw new Error(`token login is not an admin session (role ${body?.role})`);
    return { cookie, origin, "x-csrf-token": body.csrfToken };
  };
  const get = async (path: string): Promise<{ status: number; body: any }> => {
    const response = await fetch(root + path, { signal: AbortSignal.timeout(30_000) });
    const raw = await response.text();
    let body: any = raw;
    try {
      body = JSON.parse(raw);
    } catch {
      // keep the text
    }
    return { status: response.status, body };
  };

  return {
    base: root,
    shadowRpcUrl: `${root}/shadow-rpc`,
    shadowRpcHeaders: () => (session ??= login()),
    experimentalRpcUrl: `${root}/shadow-rpc/experimental`,

    async head() {
      const { status, body } = await get("/health");
      if (status !== 200) throw new Error(`/health: HTTP ${status}: ${JSON.stringify(body).slice(0, 300)}`);
      const index = body?.features?.entityQueryIndex;
      return {
        scannerHead: num(body?.scanner?.lastSuccessfulBlock),
        entityIndexHead: index ? num(index.projectedThroughBlock) : null,
        entityIndexReady: index ? index.ready === true : null,
        raw: body,
      };
    },

    async transaction(hash) {
      const { status, body } = await get(`/transaction/${hash}`);
      if (status === 404) return null;
      if (status !== 200) throw new Error(`/transaction/${hash}: HTTP ${status}: ${JSON.stringify(body).slice(0, 300)}`);
      const t = body.transaction;
      const statusText = t.status === null || t.status === undefined ? null : BigInt(t.status).toString();
      return {
        hash: hex(t.hash)!,
        block: Number(t.blockNumber),
        position: Number(t.position),
        from: hex(t.from),
        to: hex(t.to),
        status: statusText === "1" ? 1 : statusText === "0" ? 0 : null,
        gasUsed: text(t.gasUsed) ?? "",
        gasLimit: text(t.gasLimit),
        effectiveGasPrice: text(t.effectiveGasPriceWei),
        gasFee: text(t.transactionFeeWei),
        // WP2a names it rentFeeWei; absent before that.
        rentFee: "rentFeeWei" in t ? text(t.rentFeeWei) : undefined,
        operationCount: Array.isArray(t.operations) ? t.operations.length : undefined,
      };
    },

    async blocks(from, to) {
      const out = new Map<number, ExplorerBlock>();
      // GET /blocks is newest-first with an exclusive blockLt; walk down.
      let below = to + 1;
      while (below > from) {
        const { status, body } = await get(`/blocks?blockLt=${below}&limit=10000`);
        if (status !== 200) throw new Error(`/blocks: HTTP ${status}: ${JSON.stringify(body).slice(0, 300)}`);
        const names: string[] = body.names;
        const at = (name: string) => names.indexOf(name);
        const [iNumber, iCount, iGas, iRent] = [at("blockNumber"), at("transactionCount"), at("totalGasUsed"), at("totalRentFeeWei")];
        const rows: unknown[][] = body.blocks;
        if (rows.length === 0) break;
        let lowest = below;
        for (const row of rows) {
          const number = Number(row[iNumber]);
          lowest = Math.min(lowest, number);
          if (number < from) continue;
          out.set(number, {
            number,
            txCount: Number(row[iCount] ?? 0),
            gasUsed: text(row[iGas]) ?? "0",
            rentSum: iRent < 0 ? undefined : text(row[iRent]),
          });
        }
        if (lowest >= below) break;
        below = lowest;
      }
      return out;
    },

    async entityBytes(key) {
      const { status, body } = await get(`/entity/${key}`);
      if (status === 404) return null;
      if (status !== 200) throw new Error(`/entity/${key}: HTTP ${status}: ${JSON.stringify(body).slice(0, 300)}`);
      const attributes = body?.state?.attributes;
      if (!Array.isArray(attributes)) return undefined;
      return new Map(
        attributes
          .filter((a: any) => a?.type === "bytes")
          .map((a: any) => [
            String(a.name),
            { size: Number(a.size), keccak256: String(a.keccak256 ?? "").toLowerCase(), value: a.value === undefined ? null : a.value },
          ]),
      );
    },
  };
}

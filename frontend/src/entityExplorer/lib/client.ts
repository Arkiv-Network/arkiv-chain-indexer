// The client the entity explorer queries the network with, through the Arkiv SDK.
// No live node speaks the user-defined column format yet, so the network is a
// mock node that runs in the browser. The SDK sends it the same JSON-RPC calls
// it would send a node; pointing the page at a real one only means giving the
// client an http transport instead.

import { createPublicClient, ENTITY_EVENTS_ABI } from "@arkiv-network/sdk";
import { defineChain, type Hex } from "viem";
import { MOCK_CHAIN_ID } from "../mock/dataset";
import { mockTransport } from "../mock/transport";

const mockChain = defineChain({
  id: MOCK_CHAIN_ID,
  name: "Arkiv Mock",
  nativeCurrency: { name: "GLM", symbol: "GLM", decimals: 18 },
  rpcUrls: { default: { http: [] } },
});

export const explorerClient = createPublicClient({ chain: mockChain, transport: mockTransport() });

export type DataClient = typeof explorerClient;
export type BlockTiming = Awaited<ReturnType<DataClient["getBlockTiming"]>>;

/** The Arkiv storage contract. The SDK keeps this in consts.ts but does not export it. */
const ARKIV_ADDRESS = "0x4400000000000000000000000000000000000044";

/**
 * A query result does not carry the creating transaction, but the contract
 * emits EntityCreated with the key as an indexed topic, so one getLogs call on
 * the creation block finds it.
 */
export async function getCreationTxHash(entityKey: Hex, createdAt: bigint): Promise<Hex | null> {
  const logs = await explorerClient.getLogs({
    address: ARKIV_ADDRESS,
    event: ENTITY_EVENTS_ABI[0],
    args: { entityKey },
    fromBlock: createdAt,
    toBlock: createdAt,
  });
  return logs[0]?.transactionHash ?? null;
}

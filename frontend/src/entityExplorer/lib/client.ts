// The client the entity explorer queries the network with, through the Arkiv SDK.
// It talks to the backend's relay rather than to a node: the relay forwards the
// explorer's reads to the node the indexer scans, so the explorer always shows
// the indexed chain. Which chain that is is backend config, so none is pinned here.

import { createPublicClient } from "@arkiv-network/sdk";
import { http } from "viem";
import { NODE_RELAY_PATH } from "@/nodeRpc";

/** `POST /entity-explorer/rpc` on the backend, behind the frontend's `/api` prefix (shared with nodeBytes.ts). */
export const EXPLORER_RPC_PATH = NODE_RELAY_PATH;

export const explorerClient = createPublicClient({ transport: http(EXPLORER_RPC_PATH) });

export type DataClient = typeof explorerClient;
export type BlockTiming = Awaited<ReturnType<DataClient["getBlockTiming"]>>;


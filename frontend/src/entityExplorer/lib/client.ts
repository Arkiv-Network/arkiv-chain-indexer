// The client the entity explorer queries the network with, through the Arkiv SDK.
// It talks to the backend's relay rather than to a node: the relay forwards the
// explorer's reads to a public RPC (Jalebi by default) and adds the API key, so
// the key never reaches the browser. Which node that is is backend config
// (ENTITY_EXPLORER_RPC), so no chain is pinned here.

import { createPublicClient } from "@arkiv-network/sdk";
import { http } from "viem";

/** `POST /entity-explorer/rpc` on the backend, behind the frontend's `/api` prefix. */
export const EXPLORER_RPC_PATH = "/api/entity-explorer/rpc";

export const explorerClient = createPublicClient({ transport: http(EXPLORER_RPC_PATH) });

export type DataClient = typeof explorerClient;
export type BlockTiming = Awaited<ReturnType<DataClient["getBlockTiming"]>>;


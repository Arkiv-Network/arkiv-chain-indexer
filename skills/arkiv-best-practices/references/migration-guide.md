# Kaolin to Braga Migration Guide

Use this guide when the user already has an Arkiv project that targets Kaolin and needs to move it to Braga.

## What Changes

- The SDK API stays the same.
- The `braga` chain export requires `@arkiv-network/sdk` version `0.6.5` or higher.
- The chain target changes from `kaolin` to `braga`.
- The active RPC, WebSocket, faucet, explorer, and chain ID all change.
- Braga uses `GLM` as the native gas token instead of test ETH.
- Testnet state does not migrate: entities written to Kaolin stay on Kaolin.

## Sunset Window

- Kaolin and Braga can run in parallel until `15 May 2026`.
- After that date, Kaolin endpoints stop responding.

## Migration Checklist

### 1. Update SDK chain imports

Before changing imports, verify that the project is already on `@arkiv-network/sdk` `0.6.5` or newer. Do not pin a replacement install command by default; tell the user to check the current SDK version and upgrade only if the project is below the minimum needed for `braga`.

```diff
- import { kaolin } from "@arkiv-network/sdk/chains";
+ import { braga } from "@arkiv-network/sdk/chains";

  const client = createClient({
-   chain: kaolin,
+   chain: braga,
    account,
  });
```

Apply the same swap for `createWalletClient`, `createPublicClient`, wagmi-derived Arkiv clients, and any custom chain constants that still point to Kaolin.

### 2. Replace network constants and wallet settings

Use these Braga values everywhere the project configures the network:

| Property | Braga value |
| -------- | ----------- |
| Chain ID | `60138453102` / `0xe0087f86e` |
| HTTP RPC | `https://braga.hoodi.arkiv.network/rpc` |
| WebSocket RPC | `wss://braga.hoodi.arkiv.network/rpc/ws` |
| Explorer | `https://explorer.braga.hoodi.arkiv.network` |
| Faucet | `https://braga.hoodi.arkiv.network/faucet/` |
| Native gas token | `GLM` |

If the project adds the network to MetaMask or viem manually, update:

- `chainId`
- `chainName`
- `rpcUrls`
- `blockExplorers`
- `nativeCurrency` so the symbol is `GLM`

### 3. Rename env vars and config keys

Do not leave mixed Kaolin and Braga names in active codepaths. Rename env vars so the environment clearly reflects the current target network:

```diff
- KAOLIN_RPC_URL=https://kaolin.hoodi.arkiv.network/rpc
+ BRAGA_RPC_URL=https://braga.hoodi.arkiv.network/rpc
```

Check these places for stale Kaolin references:

- `.env*` files
- deployment configs
- Docker or container env wiring
- shell scripts and seed scripts
- README setup steps
- frontend wallet config

### 4. Refresh funding and bridge configuration

- Request fresh test `GLM` from the Braga faucet.
- If the app bridges programmatically, update the Standard Bridge address to `0xB52b417A79c9dE21ffe221dF9a3821B7EaC60813`.
- Funds already bridged into Kaolin stay there; withdraw them before the sunset if needed.

### 5. Re-create entities and seed data

Kaolin entities do not migrate to Braga. If the app depends on seed data, startup entities, cached indexes, or demo content, run the seed/migration script against Braga before switching traffic.

Pay special attention to:

- entities loaded at app startup
- admin-created demo data
- test fixtures used by integration tests
- dashboards that assume existing rows are already present

### 6. Verify both read and write paths

After updating the network target:

- run one write flow end-to-end
- verify queries return the newly written entity
- confirm wallet prompts show Braga, not Kaolin
- confirm gas is charged in `GLM`

## Migration Notes for Agents

- Prefer narrow replacements: change active codepaths to Braga, then remove or isolate Kaolin-only compatibility code.
- Keep Kaolin references only in migration docs, temporary fallback configs, or explicit legacy support blocks.
- If the codebase uses direct viem or wagmi chain definitions instead of the Arkiv exported chain, update `id`, `rpcUrls`, `blockExplorers`, and `nativeCurrency` consistently.
- If an app must run both networks during the overlap period, keep the network selection explicit and label data sources clearly to avoid mixing Kaolin and Braga entities.

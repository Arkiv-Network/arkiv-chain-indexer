# Arkiv SDK Reference

## TypeScript SDK

### Installation

```bash
# npm
npm install @arkiv-network/sdk

# Bun
bun add @arkiv-network/sdk
```

The `braga` chain export is available in `@arkiv-network/sdk` version `0.6.5` or higher. Before suggesting `import { braga } from "@arkiv-network/sdk/chains"`, verify the user's installed SDK version meets that minimum. Do not pin install commands unless the user explicitly asks for a specific version.

### Imports

```typescript
// Core client factories
import { createWalletClient, createPublicClient, http, custom } from "@arkiv-network/sdk"

// Account management
import { privateKeyToAccount } from "@arkiv-network/sdk/accounts"

// Chain configuration
import { braga } from "@arkiv-network/sdk/chains"

// Utilities
import { ExpirationTime, jsonToPayload, stringToPayload, payloadToString } from "@arkiv-network/sdk/utils"

// Query operators
import { eq, gt, lt, gte, lte, and } from "@arkiv-network/sdk/query"
```

### WalletClient Methods (Write Operations)

#### createEntity

```typescript
const { entityKey, txHash } = await walletClient.createEntity({
  payload: jsonToPayload({ message: 'Hello' }),
  contentType: 'application/json',
  attributes: [
    { key: 'type', value: 'greeting' },
    { key: 'priority', value: 5 }
  ],
  expiresIn: ExpirationTime.fromHours(12),
})
```

#### updateEntity

```typescript
const { txHash } = await walletClient.updateEntity({
  entityKey: entityKey,
  payload: jsonToPayload({ message: 'Updated' }),
  contentType: 'application/json',
  attributes: [
    { key: 'type', value: 'greeting' },
    { key: 'updated', value: Date.now() }
  ],
  expiresIn: ExpirationTime.fromHours(24),
})
```

#### deleteEntity

```typescript
const { txHash } = await walletClient.deleteEntity({
  entityKey: entityKey
})
```

#### extendEntity

```typescript
const { txHash } = await walletClient.extendEntity({
  entityKey: entityKey,
  expiresIn: ExpirationTime.fromHours(1), // always use the helper for readability
})
```

#### mutateEntities (Batch Operations)

```typescript
await walletClient.mutateEntities({
  creates: [
    {
      payload: stringToPayload('item 1'),
      contentType: 'text/plain',
      attributes: [{ key: 'type', value: 'item' }],
      expiresIn: ExpirationTime.fromMinutes(30),
    },
    {
      payload: stringToPayload('item 2'),
      contentType: 'text/plain',
      attributes: [{ key: 'type', value: 'item' }],
      expiresIn: ExpirationTime.fromMinutes(30),
    }
  ]
})
```

### PublicClient Methods (Read Operations)

#### buildQuery + fetch

```typescript
const query = publicClient.buildQuery()
const results = await query
  .where(eq('type', 'note'))
  .where(gt('created', 1672531200))
  .withPayload(true)
  .withAttributes(true)
  .fetch()
```

Query builder methods:

- `.where(condition)` — Add a filter condition (can chain multiple)
- `.withPayload(true)` — Include entity payload in results
- `.withAttributes(true)` — Include attributes in results
- `.withMetadata(true)` — Include metadata like ownership and TTL in the results
- `.ownedBy(address)` — Filter by current owner address (can change over time)
- `.createdBy(address)` — Filter by original creator address (immutable)
- `.fetch()` — Execute the query

#### getEntity

```typescript
const entity = await publicClient.getEntity(entityKey)
const data = entity.toJson()   // Parse JSON payload
const text = entity.toText()   // Get text payload
```

### ExpirationTime Helpers

Expiration is expressed in **seconds**. Always use these helpers to convert human-readable durations:

```typescript
ExpirationTime.fromMinutes(30)  // 1800 seconds
ExpirationTime.fromHours(1)     // 3600 seconds
ExpirationTime.fromHours(12)    // 43200 seconds
ExpirationTime.fromHours(24)    // 86400 seconds
ExpirationTime.fromDays(7)      // 604800 seconds
```

**Always prefer the helpers over raw numbers for `expiresIn`** — they're more readable and less error-prone. If a raw number is passed, it is treated as seconds (e.g., `expiresIn: 3600` means 1 hour).

### Payload Helpers

```typescript
import { jsonToPayload, stringToPayload, payloadToString } from "@arkiv-network/sdk/utils"

// JSON data
const jsonPayload = jsonToPayload({ key: "value" })

// Plain text
const textPayload = stringToPayload("Hello Arkiv!")

// Reading back
const text = payloadToString(entity.payload)
const data = JSON.parse(payloadToString(entity.payload))
// or use entity helper
const data = entity.toJson()
```

### Query Operators

```typescript
import { eq, gt, lt, gte, lte } from "@arkiv-network/sdk/query"

eq('type', 'note')        // type = "note"
gt('priority', 3)          // priority > 3
lt('price', 1000)          // price < 1000
gte('created', timestamp)  // created >= timestamp
lte('expiration', limit)   // expiration <= limit
```

### Browser Usage with MetaMask

```typescript
import { createWalletClient, createPublicClient, custom, http } from "@arkiv-network/sdk"
import { braga } from "@arkiv-network/sdk/chains"

// Request wallet connection
await window.ethereum.request({ method: 'eth_requestAccounts' })

// Use MetaMask as transport (no private key needed)
const walletClient = createWalletClient({
  chain: braga,
  transport: custom(window.ethereum),
})

// Public client for queries
const publicClient = createPublicClient({
  chain: braga,
  transport: http(),
})
```

**Adding Arkiv Network to MetaMask:**

```typescript
await window.ethereum.request({
  method: 'wallet_addEthereumChain',
  params: [{
    chainId: '0xe0087f86e',
    chainName: 'Arkiv Braga Testnet',
    nativeCurrency: { name: 'GLM', symbol: 'GLM', decimals: 18 },
    rpcUrls: ['https://braga.hoodi.arkiv.network/rpc'],
    blockExplorerUrls: ['https://explorer.braga.hoodi.arkiv.network']
  }]
})
```

### Browser CDN Imports

For static HTML/JS pages without a bundler:

```javascript
import { createPublicClient, http } from 'https://esm.sh/@arkiv-network/sdk?target=es2022&bundle-deps'
import { eq } from 'https://esm.sh/@arkiv-network/sdk/query?target=es2022&bundle-deps'
import { braga } from 'https://esm.sh/@arkiv-network/sdk/chains?target=es2022&bundle-deps'
```

If the user is working with a versioned CDN URL instead of the unpinned form above, make sure the selected SDK version is `0.6.5` or newer before using the `braga` import.

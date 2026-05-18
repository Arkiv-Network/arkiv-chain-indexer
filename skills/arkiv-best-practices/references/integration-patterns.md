# Arkiv Integration Patterns

The three most common integration scenarios for Arkiv applications.

All Braga-based examples in this file assume `@arkiv-network/sdk` version `0.6.5` or higher. Before suggesting `import { braga } from "@arkiv-network/sdk/chains"`, have the agent check the user's installed SDK version and only recommend an upgrade if the project is below that minimum.

## Table of Contents

1. [Backend Read/Write](#backend-readwrite)
2. [Client-Side Reading (React Hook)](#client-side-reading)
3. [Client-Side Writing (Wallet Integration)](#client-side-writing)

---

## Backend Read/Write

For server-side applications (Next.js API routes, Express, any Node.js backend). The private key lives in environment variables — never in client code.

```typescript
// lib/arkiv-server.ts
import { createWalletClient, createPublicClient, http } from "@arkiv-network/sdk"
import { privateKeyToAccount } from "@arkiv-network/sdk/accounts"
import { braga } from "@arkiv-network/sdk/chains"
import { ExpirationTime, jsonToPayload } from "@arkiv-network/sdk/utils"
import { eq } from "@arkiv-network/sdk/query"
import { PROJECT_ATTRIBUTE } from "./arkiv" // your project attribute

// Initialize clients ONCE at module level
const walletClient = createWalletClient({
  chain: braga,
  transport: http(),
  account: privateKeyToAccount(process.env.PRIVATE_KEY as `0x${string}`),
})

const publicClient = createPublicClient({
  chain: braga,
  transport: http(),
})

// Write example
export async function createPost(title: string, content: string) {
  const { entityKey, txHash } = await walletClient.createEntity({
    payload: jsonToPayload({ title, content }),
    contentType: "application/json",
    attributes: [
      PROJECT_ATTRIBUTE,
      { key: "entityType", value: "post" },
      { key: "created", value: Date.now() },
    ],
    expiresIn: ExpirationTime.fromDays(30),
  })
  return { entityKey, txHash }
}

// Read example
export async function getPosts() {
  const query = publicClient.buildQuery()
  const result = await query
    .where([
      eq(PROJECT_ATTRIBUTE.key, PROJECT_ATTRIBUTE.value),
      eq("entityType", "post"),
    ])
    .withPayload(true)
    .withMetadata(true)
    .limit(50)
    .fetch()
  return result
}
```

Use in a Next.js API route:

```typescript
// app/api/posts/route.ts
import { createPost, getPosts } from "@/lib/arkiv-server"

export async function GET() {
  const posts = await getPosts()
  return Response.json(posts)
}

export async function POST(request: Request) {
  const { title, content } = await request.json()
  const result = await createPost(title, content)
  return Response.json(result)
}
```

Or in Express:

```typescript
import express from "express"
import { createPost, getPosts } from "./lib/arkiv-server"

const app = express()
app.use(express.json())

app.get("/posts", async (req, res) => {
  const posts = await getPosts()
  res.json(posts)
})

app.post("/posts", async (req, res) => {
  const { title, content } = req.body
  const result = await createPost(title, content)
  res.json(result)
})

app.listen(3000)
```

---

## Client-Side Reading

For frontend applications that only need to query data. Uses a public client — no private key, safe to run in the browser.

First, define the fetcher functions separately from hooks — these are reusable and testable:

```typescript
// lib/arkiv-queries.ts
import { createPublicClient, http } from "@arkiv-network/sdk"
import { braga } from "@arkiv-network/sdk/chains"
import { eq } from "@arkiv-network/sdk/query"
import { PROJECT_ATTRIBUTE } from "@/lib/arkiv"

// Single public client instance — reuse across all queries
export const publicClient = createPublicClient({
  chain: braga,
  transport: http(),
})

export async function fetchEntitiesByType<T>(entityType: string): Promise<(T & { arkivEntityKey: string })[]> {
  const query = publicClient.buildQuery()
  const result = await query
    .where([
      eq(PROJECT_ATTRIBUTE.key, PROJECT_ATTRIBUTE.value),
      eq("entityType", entityType),
    ])
    .withPayload(true)
    .withMetadata(true)
    .limit(50)
    .fetch()

  // Combine entity key with payload — gives each item a stable unique identifier
  return result.entities
    .map((entity: any) => {
      try {
        return { arkivEntityKey: entity.key, ...entity.toJson() }
      } catch {
        return null
      }
    })
    .filter((item): item is T & { arkivEntityKey: string } => item !== null)
}

export async function fetchEntityByKey<T>(entityKey: string): Promise<T> {
  const entity = await publicClient.getEntity(entityKey)
  return entity.toJson()
}
```

Then wrap them in hooks. Use TanStack Query (`@tanstack/react-query`) for caching, deduplication, and background refetching. **If the project already has a data-fetching library (SWR, Apollo, etc.), use that instead.** If nothing is set up yet, suggest installing TanStack Query:

```bash
npm install @tanstack/react-query
```

```typescript
// hooks/useArkivQuery.ts
import { useQuery } from "@tanstack/react-query"
import { fetchEntitiesByType, fetchEntityByKey } from "@/lib/arkiv-queries"

/**
 * Fetch a list of entities by type.
 * Uses TanStack Query for caching and automatic refetching.
 */
export function useArkivQuery<T>(entityType: string) {
  return useQuery<T[]>({
    queryKey: ["arkiv", "entities", entityType],
    queryFn: () => fetchEntitiesByType<T>(entityType),
  })
}

/**
 * Fetch a single entity by key.
 * Only runs when entityKey is truthy.
 */
export function useArkivEntity<T>(entityKey: string | null) {
  return useQuery<T>({
    queryKey: ["arkiv", "entity", entityKey],
    queryFn: () => fetchEntityByKey<T>(entityKey!),
    enabled: !!entityKey,
  })
}
```

Usage in components:

```tsx
// components/PostList.tsx
import { useArkivQuery } from "@/hooks/useArkivQuery"

interface Post {
  title: string
  content: string
}

function PostList() {
  const { data: posts, isLoading, error } = useArkivQuery<Post>("post")

  if (isLoading) return <p>Loading...</p>
  if (error) return <p>Error: {error.message}</p>

  return (
    <ul>
      {posts?.map((post) => (
        <li key={post.arkivEntityKey}>{post.title}</li>
      ))}
    </ul>
  )
}
```

> **Tip:** Every Arkiv entity has a unique `entity.key`. The fetcher merges it as `arkivEntityKey` into each item — use this as your React key instead of array indices.
> **Note:** `useEffect` + `useState` for data fetching is an anti-pattern — it doesn't handle caching, race conditions, deduplication, or background refetching. Always use a data-fetching library.

---

## Client-Side Writing

For dApps where the user's own wallet signs transactions. Two approaches depending on your stack.

### Option A: Manual MetaMask integration

Use this if you're not using wagmi or a wallet framework. You need to handle network switching yourself.

**Adding the Arkiv network to MetaMask:**

```typescript
async function addArkivNetwork() {
  await window.ethereum.request({
    method: "wallet_addEthereumChain",
    params: [{
      chainId: "0xe0087f86e",
      chainName: "Arkiv Braga Testnet",
      nativeCurrency: { name: "GLM", symbol: "GLM", decimals: 18 },
      rpcUrls: ["https://braga.hoodi.arkiv.network/rpc"],
      blockExplorerUrls: ["https://explorer.braga.hoodi.arkiv.network"],
    }],
  })
}
```

**Creating a wallet client from MetaMask:**

```typescript
import { createWalletClient, custom } from "@arkiv-network/sdk"
import { braga } from "@arkiv-network/sdk/chains"

await addArkivNetwork()
const [address] = await window.ethereum.request({ method: "eth_requestAccounts" })

const walletClient = createWalletClient({
  chain: braga,
  transport: custom(window.ethereum),
})
```

### Option B: Wagmi / RainbowKit integration (recommended for dApps)

If your project already uses wagmi (or a wagmi-powered framework like RainbowKit, ConnectKit, etc.), you can derive an Arkiv wallet client directly from the wagmi wallet client. This avoids duplicate wallet connection logic.

```tsx
import { useAccount, useWalletClient } from "wagmi";
import {
  createWalletClient as createArkivWalletClient,
  custom,
} from "@arkiv-network/sdk";
import { braga } from "@arkiv-network/sdk/chains";

// Inside your component:
const { address } = useAccount();
const { data: wagmiWalletClient } = useWalletClient();

if (!wagmiWalletClient) {
  // throw or return loading UI
}

const arkivWalletClient = createArkivWalletClient({
  chain: braga,
  transport: custom(wagmiWalletClient.transport),
  account: address,
});
```

Then use `arkivWalletClient` the same way as any other wallet client:

```typescript
import { jsonToPayload, ExpirationTime } from "@arkiv-network/sdk/utils"
import { PROJECT_ATTRIBUTE } from "@/lib/arkiv"

const { entityKey, txHash } = await arkivWalletClient.createEntity({
  payload: jsonToPayload({ title: "My Post", content: "Hello!" }),
  contentType: "application/json",
  attributes: [
    PROJECT_ATTRIBUTE,
    { key: "entityType", value: "post" },
    { key: "author", value: address },
  ],
  expiresIn: ExpirationTime.fromDays(30),
})
```

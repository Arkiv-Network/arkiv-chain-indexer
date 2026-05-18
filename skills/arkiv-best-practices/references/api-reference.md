# Arkiv JSON-RPC API Reference

Arkiv exposes a JSON-RPC 2.0 API over HTTP. Use this when you need raw HTTP access without the SDK, or for advanced query options.

## Endpoint

| Property  | Value                                         |
| --------- | --------------------------------------------- |
| Chain ID  | `60138453102`                                 |
| HTTP RPC  | `https://braga.hoodi.arkiv.network/rpc`       |
| WebSocket | `wss://braga.hoodi.arkiv.network/rpc/ws`      |
| Explorer  | `https://explorer.braga.hoodi.arkiv.network`  |
| Faucet    | `https://braga.hoodi.arkiv.network/faucet`    |

## Request Format

All methods use standard JSON-RPC 2.0.

```bash
curl https://braga.hoodi.arkiv.network/rpc \
  -H "content-type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"METHOD_NAME","params":[]}'
```

## Methods

### arkiv_query

Query entities from the bitmap-backed SQLite store.

**Parameters:**

| Index | Type        | Required | Description      |
| ----- | ----------- | -------- | ---------------- |
| 0     | string      | Yes      | Query expression |
| 1     | object/null | No       | Query options    |

**Query Syntax — Operators:**

- Logical: `&&`, `||`
- Negation: `!`
- Comparisons: `=`, `!=`, `<`, `>`, `<=`, `>=`
- Glob matching: `~` (match), `!~` (negated match)

**Synthetic Attributes (use with `$` prefix):**

- `$owner` — Entity owner address
- `$creator` — Entity creator address
- `$key` — Entity key
- `$expiration` — Expiration block
- `$createdAtBlock` — Block at creation
- `$sequence`, `$txIndex`, `$opIndex` — Ordering attributes
- `$all` — Match all entities

**Options:**

| Field          | Type       | Description                               |
| -------------- | ---------- | ----------------------------------------- |
| atBlock        | hex string | Query at specific block (e.g., `"0x1bc"`) |
| includeData    | object     | Controls which fields are returned        |
| resultsPerPage | hex string | Page size, max 200                        |
| cursor         | string     | Pagination cursor from previous response  |

**includeData defaults (all true when omitted):**

- key, contentType, payload, creator, owner, attributes, expiration

**Example — query active NFTs:**

```bash
curl https://braga.hoodi.arkiv.network/rpc \
  -H "content-type: application/json" \
  -d '{
    "jsonrpc":"2.0","id":1,
    "method":"arkiv_query",
    "params":[
      "type = \"nft\" && status = \"active\"",
      {"resultsPerPage":"0xa"}
    ]
  }'
```

**Example — query by owner:**

```bash
curl https://braga.hoodi.arkiv.network/rpc \
  -H "content-type: application/json" \
  -d '{
    "jsonrpc":"2.0","id":10,
    "method":"arkiv_query",
    "params":[
      "$owner = \"0x2222222222222222222222222222222222222222\"",
      null
    ]
  }'
```

**Example — numeric range:**

```bash
curl https://braga.hoodi.arkiv.network/rpc \
  -H "content-type: application/json" \
  -d '{
    "jsonrpc":"2.0","id":12,
    "method":"arkiv_query",
    "params":["price >= 100 && price <= 1000", null]
  }'
```

**Example — glob match with negation:**

```bash
curl https://braga.hoodi.arkiv.network/rpc \
  -H "content-type: application/json" \
  -d '{
    "jsonrpc":"2.0","id":13,
    "method":"arkiv_query",
    "params":["name ~ \"test*\" && !(status = \"deleted\")", null]
  }'
```

**Example — metadata only (omit payload):**

```bash
curl https://braga.hoodi.arkiv.network/rpc \
  -H "content-type: application/json" \
  -d '{
    "jsonrpc":"2.0","id":14,
    "method":"arkiv_query",
    "params":[
      "$all",
      {
        "resultsPerPage":"0xa",
        "includeData":{
          "key":true,"attributes":true,"payload":false,
          "contentType":true,"expiration":true,
          "creator":true,"owner":true
        }
      }
    ]
  }'
```

**Response structure:**

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "result": {
    "data": [
      {
        "key": "0x...",
        "value": "0x...",
        "contentType": "application/json",
        "expiresAt": 1200000,
        "creator": "0x...",
        "owner": "0x...",
        "createdAtBlock": 401,
        "lastModifiedAtBlock": 443,
        "stringAttributes": [{ "key": "status", "value": "active" }],
        "numericAttributes": [{ "key": "rarity", "value": 5 }]
      }
    ],
    "blockNumber": "0x1bc",
    "cursor": "0x2a"
  }
}
```

**Notes:**

- `value` is hex-encoded bytes (decode to get payload)
- `cursor` is omitted when no more pages remain
- `blockNumber` is a hex string

**Pagination:**
Use the returned `cursor` in the next request:

```json
{"method":"arkiv_query","params":["type = \"nft\"",{"cursor":"0x2a","resultsPerPage":"0x2"}]}
```

### arkiv_getEntityCount

Returns total number of entities currently stored. No parameters.

```bash
curl https://braga.hoodi.arkiv.network/rpc \
  -H "content-type: application/json" \
  -d '{"jsonrpc":"2.0","id":3,"method":"arkiv_getEntityCount","params":[]}'
```

Result: plain JSON number (e.g., `18427`).

### arkiv_getNumberOfUsedSlots

Returns used storage-accounting slots. No parameters. Result is a hex string.

### arkiv_getBlockTiming

Returns timing for the current head block. No parameters.

Response:

```json
{
  "result": {
    "current_block": 582143,
    "current_block_time": 1742721127,
    "duration": 2
  }
}
```

- `current_block_time` — Unix timestamp in seconds
- `duration` — seconds since previous block

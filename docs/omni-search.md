# Omni search without a duplicate index

The explorer search bar and `/search?q=…` page use `GET /api/search` and
`GET /api/search/suggest` (the backend paths omit `/api`). Both accept `q`
(maximum 256 characters) and `limit` (1–30). Suggestions default to 8 results;
search defaults to 20. There is no full-text search table, dictionary table,
backfill, new disk index, or additional scanner write. Opening the search
service performs no DDL. It never calls a node or payload provider.

## Search coverage

| Input | Data searched | Access path |
| --- | --- | --- |
| Decimal block number | All stored blocks | `blocks` primary key |
| Hex identifier, with or without `0x` | Stored block/transaction hashes, entity keys, sender and balance addresses, plus projected owners/creators when enabled | Existing hash/entity/address B-trees |
| `status=active` | Latest projected attribute versions, if the existing entity index is enabled and ready | `(name, type_id, value_text)` index, per type |
| `name=Ali*` | Literal, case-sensitive value prefix under the named key | Existing `text_pattern_ops` index |
| `name="literal*"` | Exact value containing a trailing `*` | Same attribute index |
| Words or an unknown key/value | At most the newest 64 operations, 64 transactions, and 64 logs | Backward primary-key scans, then matching in memory |

Hex suggestions start at six hex digits. Sender/entity/balance suggestions
use recursive loose index scans: one seek per distinct identifier, skipping
the intervening duplicate rows. They do not run `SELECT DISTINCT`. Bounds
are padded to the full identifier width and compared with the same collation
as the existing index. Identifier storage is lowercase, as in existing hash
lookups; pasted mixed-case identifiers are normalized.

The recent sample includes operation names, content types, entity keys,
attribute keys/values, new owners, selected payload-reference metadata,
transaction sender/recipient/contract addresses, nonces, transferred values,
log addresses, and topics. Raw receipt ABI data and payload bytes are not
searched. Metadata fields are shortened; a row's attribute JSON over 8,192 characters
is omitted from the sample rather than parsed partially. The query uses no
unbounded JSON predicate. Multiple words must all match within one sampled
record. General text matching and discovery of recent keys/values ignore case;
explicit key=value queries and their value suggestions follow the attribute
index's case-sensitive semantics.

There is deliberately no chain-wide value-only/substring/fuzzy search, recipient
address index, log-topic index, popularity count, or total match count. A
full address can still be opened directly from the results page. Free text
does **not** prove that an older value or a recipient-only address is absent.
Use `key=value` for an indexed attribute lookup, an identifier for history,
or the Data page for more structured entity queries.

The attribute index is reused only when `ENTITY_QUERY_INDEX=true`. Search
does not enable or build that optional projection itself. Attribute matches
are from its latest undeleted versions and may include expired entities;
`coverage.attributeHead` reports its projection head, which can trail the
scanner. Old attribute versions are not searched. Recent operation matches
describe recorded requests, including reverted transactions, and are linked
to the transaction where their status can be inspected.

## Resource bounds and consistency

- A separate pool allows at most two distinct searches at once. Excess
  requests receive HTTP 429 with `Retry-After: 1`; identical in-flight
  requests coalesce. Browser suggestions debounce for 220 ms and abort
  obsolete requests. No request queue grows with traffic.
- Every database transaction is read-only, disables parallel query workers
  and JIT, and has a 200 ms statement timeout and a 50 ms lock timeout.
  An 800 ms request budget is checked between queries; an in-flight statement
  can overrun it by at most its timeout. Pool acquisition, transaction setup,
  and network failure are governed by the database client's connection limits.
- All candidate queries have explicit limits. Attribute queries constrain
  both leading index columns and split the nine non-payload types into
  separate seeks. Prefix bounds use pattern operators, so `%`, `_`, and `\`
  are literal. Value suggestions skip duplicate runs using the same pattern
  order as the index. No global sort, aggregate, offset, or count is needed.
- Results are capped at 30; hitting a candidate/result budget sets
  `truncated`. There is no deep pagination. Refine the query for more specific
  results. Timeouts return available results with `partial=true` and a note,
  never a claim of exhaustive absence. Other database failures return a
  generic HTTP 503.
- Successful responses use an LRU cache capped at 128 entries / 2 MiB for
  two seconds. A shared recent sample is cached for five seconds. Rescans,
  deletes and new rows become visible after those TTLs; there is no durable
  search state to repair or rebuild. Partial results are not cached.
- The transaction-data gate covers all address/entity/transaction/metadata
  branches. With transaction data disabled, search returns only blocks.
- `/search` and `/search/suggest` have fixed Prometheus route labels, so
  request latency, query latency, failures and egress use the existing metrics.

## Validation

`bun test src/omniSearch.test.ts frontend/omniSearch.test.ts` runs input,
HTTP, cancellation plumbing and admission tests without a database. Set
`TEST_DATABASE_URL` to add PostgreSQL tests in an isolated schema, including
12,000 duplicate addresses/values, prefix punctuation and Unicode, large
integer values, capability gates, concurrent cache misses, and query plans.

After `cd frontend && bun run build`, run
`bun run scripts/checkOmniSearchBrowser.ts` from the repository root for the
browser regression checks (requires Node and the installed Playwright browser).
It uses mocked API responses and an ephemeral local frontend process.

Initial `EXPLAIN (ANALYZE, BUFFERS)` checks on the existing deployment
(roughly 1.3 million transactions and 6.5 million attribute rows at the time)
used the existing address and attribute indexes and a backward operation
primary-key scan. The individual checked queries executed below 1 ms.
These checks establish the access paths, not a terabyte-scale latency claim.
Keep normal PostgreSQL statistics/autovacuum healthy and monitor real
`/search` query latency as data and traffic grow.

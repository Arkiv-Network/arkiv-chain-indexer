# Search using existing identifier indexes

The explorer search bar and `/search?q=…` page use `GET /api/search` and
`GET /api/search/suggest` (the backend paths omit `/api`). Both accept `q`
(maximum 256 characters) and `limit` (1–30). Suggestions default to 8 results;
search defaults to 20, and the frontend requests up to 30.

Search only looks up block numbers and hexadecimal identifiers. Attribute
names, attribute values, payloads, operation metadata, log topics, and general
text are not searched. Unsupported inputs such as `status=active`, `name=`,
or `Alice Smith` receive HTTP 400 with guidance on supported identifiers;
the browser does not request suggestions for them. A hex-shaped attribute
value or log topic is interpreted only as an identifier: it can match only
if that identifier is also present in one of the indexed columns below.

## Search coverage

| Input | Data searched | Access path |
| --- | --- | --- |
| Decimal block number | All stored blocks | `blocks` primary key |
| Hex identifier, with or without `0x` | Stored block/transaction hashes, entity keys, sender and balance addresses | Existing hash/entity/address B-trees |
| Hex identifier with the optional entity projection enabled | Also projected entity keys, owners and creators | Existing entity/address B-trees |

Block numbers, including single-digit values and zero, support suggestions.
Hex identifiers and prefixes need at least six hex digits. Mixed-case hex is
normalized to lowercase. Numeric input can match both a decimal block number
and an unprefixed hex identifier. No recipient-address, log-topic, attribute,
value-only, substring, fuzzy, or payload lookup is performed. A full address
can still be opened directly from the results page when no indexed match is
found. Owner matches may include historical ownership.

Sender/entity/balance suggestions use recursive loose index scans: one seek
per distinct identifier, skipping intervening duplicate rows. They do not use
`SELECT DISTINCT`. Bounds are padded to the full identifier width and compared
with the same collation as the existing index.

No search table, dictionary, recent metadata sample, backfill, new disk index,
or scanner write is needed. Opening the search service performs no DDL. Search
never calls a node or payload provider. Enabling the entity projection adds
only its identifier columns to search; it does not enable attribute search.

## Resource bounds and consistency

- A separate pool allows at most two distinct searches at once. Excess
  requests receive HTTP 429 with `Retry-After: 1`; identical in-flight
  requests coalesce. Browser suggestions debounce for 220 ms and abort
  obsolete requests. No request queue grows with traffic.
- Database transactions are read-only, disable parallel query workers and JIT,
  and use a 200 ms statement timeout and a 50 ms lock timeout. An 800 ms
  request budget is checked between queries; an in-flight statement can
  overrun it by at most its timeout. Connection acquisition and transport
  failures are governed by the database client's connection limits.
- Candidate queries have explicit limits and use existing identifier indexes.
  No global sort, aggregate, offset, count, attribute query, or metadata scan
  is needed.
- Results are capped at 30; hitting a candidate/result budget sets `truncated`.
  There is no deep pagination. Timeouts return available results with
  `partial=true`; other database failures return a generic HTTP 503.
- Successful responses use an LRU cache capped at 128 entries / 2 MiB for two
  seconds. Partial results are not cached. There is no durable search state.
- The transaction-data gate covers all address/entity/transaction branches.
  With transaction data disabled, search returns only blocks.
- `/search` and `/search/suggest` keep fixed Prometheus route labels.
- The legacy response `coverage` fields remain for older clients:
  `attributeIndex=false`, `attributeHead=null`, and all recent row counts are
  zero. All results have `scope="indexed"` and all suggestions link directly
  to a block, transaction, entity, or address.

## Validation

`bun test src/omniSearch.test.ts frontend/omniSearch.test.ts` checks input,
HTTP rejection before database access, metadata-query exclusion, cancellation
plumbing, and admission without a database. Set `TEST_DATABASE_URL` for
PostgreSQL tests in an isolated schema, including 12,000 duplicate identifiers,
large block numbers, capability gates, excluded attribute values and log topics,
concurrent cache misses, and an identifier query plan.

After `cd frontend && bun run build`, run
`bun run scripts/checkOmniSearchBrowser.ts` from the repository root. It checks
identifier-only suggestions, block-number suggestions, direct navigation,
permalinks, cancellation, retry and mobile layout using mocked API responses
and an ephemeral local frontend process.

Historical query-plan checks on the deployment established the existing
identifier access paths; they are not a concurrency or large-scale latency
claim. Monitor real `/search` query latency as data and traffic grow.

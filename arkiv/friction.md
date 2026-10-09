# Friction report: building SiteLog on Arkiv

Kept while building, newest findings appended at the end of each section. Every entry is something we actually ran.
Environment: Windows 10, Node.js 24.19.0, npm 11.17.0, `@arkiv-network/sdk` 0.8.1, `viem` 2.57.4, Tiramisu testnet (chain ID 7738577), public RPC `https://rpc.tiramisu.db-chain.testnet.arkiv.network`. Dates are 2026, UTC.

## Issues

### F1. The faucet has no path for a headless agent or CI (Hub faucet, 9 Oct)

- **Surface:** Faucet (hub.arkiv.network/faucet, footer "production · aa56041").
- **Expected:** a way to fund a fresh test wallet from a script (an HTTP endpoint with a rate limit, or a CLI), since the challenge explicitly welcomes AI coding agents and the SDK README tells you to generate a key and fund it.
- **Actual:** the faucet needs Sign-In with Ethereum in a browser and then a "Verify you're human" check (Cap widget), 10 GLM per claim, 1-hour cooldown per wallet. Our build runs headless, so the first write had to wait for a human to click through the faucet.
- **Steps:** open the faucet in headless Chromium with an injected EIP-1193 wallet → "Sign in with Ethereum" succeeds → "Send testnet $GLM" stays disabled until the human check is solved.
- **What would fix it:** a rate-limited faucet endpoint keyed by an Arkiv access key (the Hub already issues them per wallet), so the human step happens once when the key is created, not for every test wallet.

### F2. The SDK README inside the 0.8.1 package shows an old version and a risky key workflow (npm package, 9 Oct)

- **Surface:** TypeScript SDK docs (`node_modules/@arkiv-network/sdk/README.md`, version 0.8.1).
- **Expected:** the tutorial matches the installed version and generates keys locally.
- **Actual:** the sample `package.json` shows `"@arkiv-network/sdk": "^0.6.0"`; the tutorial suggests generating a private key on a third-party website (vanity-eth.tk) and prints a shared example private key "for quick testing".
- **Steps:** `npm i @arkiv-network/sdk@0.8.1`, open the package README, section "Installation" and "Wallet Client Example".
- **What would fix it:** bump the snippet to `^0.8.1`; replace the website with `generatePrivateKey()` from `viem/accounts` (one line, offline); drop the shared key or label it read-only.

### F3. Raw JSON-RPC: a double-quoted string gives a bare "unexpected character" (arkiv_query, 9 Oct)

- **Surface:** Direct JSON-RPC, `arkiv_query`.
- **Expected:** writing `kind = "x"` (the way most query languages quote strings) either works or says how to write a string.
- **Actual:** `{"code":-32001,"message":"unexpected character","position":7}`. By contrast `kind = 'x'` returns a helpful `-32002 untagged strings are only valid for system attributes — write str('…')`.
- **Steps:**
  ```
  curl -s https://rpc.tiramisu.db-chain.testnet.arkiv.network -H 'content-type: application/json' \
    --data '{"jsonrpc":"2.0","id":1,"method":"arkiv_query","params":["kind = \"x\"",{}]}'
  ```
- **What would fix it:** give the double-quote case the same hint as the single-quote case.

### F4. Cursor pagination breaks after one block unless the walk is pinned with `atBlock()` (TypeScript SDK 0.8.1 + `arkiv_query`, 9 Oct)

- **Surface:** TypeScript SDK, `QueryResult.next()`; Direct JSON-RPC cursor.
- **Expected:** `page = await builder.fetch(); while (page.hasNextPage()) page = await page.next()` walks all results, as the SDK docs show.
- **Actual:** on 160 matching entities the walk fails as soon as a new block lands (blocks are 2 s): `QueryError: Query rejected (cursor, -32005): Request exceeds defined limit.` with `data.message: "cursor belongs to a different query, block or select — start a new page-through"`. With `limit(10)` and 6 s between pages it fails on page 2; with `limit(20)` and no delay, on page 3; with `limit(10)` and no delay, after 5 pages. `limit(50)` and more happened to finish inside one block. Adding `.atBlock(await client.getBlockNumber())` to the builder makes the same walk finish: 160 entities in 16 pages.
- **Why:** the node binds the cursor to the block of the first page, but `next()` re-sends the original request without `atBlock`, so page 2 is evaluated at the new head with a cursor from the old one.
- **Steps:**
  ```js
  const q = client.select({ key: true }).where(eq("app", "sitelog"), eq("project", "load-1"), eq("kind", "remark")).limit(10)
  let p = await q.fetch()
  await new Promise((r) => setTimeout(r, 6000))
  p = await p.next() // -32005 cursor belongs to a different query, block or select
  ```
- **What would fix it:** in `QueryResult.next()`, pin follow-up pages to the first page's `blockNumber` (the response already carries it). Until then, pin with `atBlock()` yourself. SiteLog does this in `fetchAll` and `loadJournalPage` (`src/lib/sitelog.js`).

### F5. The SDK exports `ne()`, but the node rejects the `!=` it renders (TypeScript SDK 0.8.1, 9 Oct)

- **Surface:** TypeScript SDK query builder (`ne` from `@arkiv-network/sdk/query`); `arkiv_query`.
- **Expected:** `ne("$creator", addr(a))` works like `eq`, since the SDK exports it and its `ComparisonOperator` type lists `"!="`.
- **Actual:** the SDK renders `$creator != addr(0x6BEa…)` and the node answers `-32002` with `"!= is not part of the query language — write NOT (attr = value) for the complement"`. `not(eq("$creator", addr(a)))`, rendered as `NOT $creator = addr(…)`, works.
- **Steps:** `client.select({ key: true }).where(eq("app", "sitelog"), ne("$creator", addr("0x6BEa8012E15605564cc67Bad1F8941262cC68f69"))).fetch()`.
- **What would fix it:** render `ne(a, v)` as `NOT (a = v)`, or drop `ne` from the exports.

### F6. SDK errors replace the node's helpful message with a generic JSON-RPC text (TypeScript SDK 0.8.1, 9 Oct)

- **Surface:** TypeScript SDK `QueryError` messages.
- **Expected:** the error message says what the node said.
- **Actual:** the node's explanation is only in `error.data.message`; `shortMessage` and `message` carry viem's generic text for the error code:

  | Query | SDK message | Node's `data.message` |
  |---|---|---|
  | with `!=` (F5) | `Query rejected (type, -32002): Requested resource not available.` | `!= is not part of the query language — write NOT (attr = value) for the complement` |
  | 80 OR'ed predicates | `Query rejected (limits, -32004): Method "arkiv_query" is not supported.` | `query has too many predicates` |
  | 100 OR'ed predicates (8.4 KB) | same | `query is too long` |
  | page 2 of an unpinned walk (F4) | `Query rejected (cursor, -32005): Request exceeds defined limit.` | `cursor belongs to a different query, block or select — start a new page-through` |

  "Method arkiv_query is not supported" sent us looking at the transport before we read `data`. 60 OR'ed `key` predicates (5 KB) still pass, so the limit sits between 60 and 80 predicates.
- **Steps:** any of the queries above through `builder.fetch()`; print `e.message` and `e.data.message`.
- **What would fix it:** put `data.message` into `QueryError.message`, and document the predicate and length limits next to the query language.

### F7. The public RPC has an hourly cost quota per caller that a public dApp can use up (Tiramisu RPC, 9 Oct)

- **Surface:** public RPC `https://rpc.tiramisu.db-chain.testnet.arkiv.network`, response headers.
- **Expected:** a read-only public page can be reloaded by its visitors without hitting a limit, or the limit is documented next to "read without a backend".
- **Actual:** after a burst of test queries from one address (pagination probes and CLI runs), the page stayed on "Querying Arkiv…" and the browser console showed HTTP 429. The headers explain it: `RateLimit: limit=600, remaining=586, reset=31` on a normal call, and after the burst `RateLimit: limit=10000, remaining=0, reset=2837`, with `Arkiv-Cost: 100` on an `arkiv_query`. So an `arkiv_query` costs 100 units of a 10 000-unit window that resets after about an hour: about 100 queries an hour per caller. One SiteLog page load runs 4 queries (roster, a page of verified remarks, their fixes and closures, unverified records), so a visitor can reload about 25 times an hour. Our first live feed, which looked up every new entity on the chain, would have spent a visitor's quota on other apps' writes.
- **Steps:** send any `arkiv_query` with `curl -s -D - -o /dev/null` and read the `RateLimit` and `Arkiv-Cost` headers; repeat until 429.
- **What would fix it:** document the quota and the cost per method on the "query the RPC directly" page; let a static page raise its quota with a public, origin-restricted read key; put `$creator` (or the attributes) into `EntityCreated` events, so a live feed can filter without one lookup per event. What we changed: the live feed now filters events by owner wallet with no extra calls, the page fails fast on 429 and says why, and HTTP retries are cut to one.

## Tested paths that worked as documented

### T1. Reads against the public RPC with no key (9 Oct)

`createPublicClient({ chain: tiramisu, transport: http() })` → `getChainId()` returned 7738577, `getEntityCount()` 1123, `getBlockNumber()` live. A query with no filter throws `InvalidPredicateError` client-side with a clear message ("A query needs at least one filter"), as documented. Expected and got.

### T2. Compound predicates with `or()` over `$creator` (9 Oct)

`where(and([... , or(eq("$creator", addr(a)), eq("$creator", addr(b)))]))` renders to `(... OR ...)` and the node accepts it. A single-element `or()` collapses to the bare predicate. `createdBy()` renders `$creator = addr(0x…)`. Expected and got.

### T3. The query the SDK sends is reproducible with curl (9 Oct)

The string from `builder.toString()` plus `toRpcSelect(...)` as the `select` option, POSTed as `arkiv_query`, returns the same page as the SDK. The `select` object can be partial (`{"key":true}`) or omitted. This is what makes SiteLog's "read it without SiteLog" panel possible.

### T4. Untagged numbers in range predicates (9 Oct)

The open question from the first day, tested on the demo entities: `severity >= 3` and `severity >= i32(3)` return the same three remarks (keys `0xdbdc…`, `0x82bf…`, `0xbc7c…`, at block `0x54f2f`), so an untagged number matches an attribute written as `i32`. Expected and got.

### T5. Creation flags and lease rules (9 Oct)

[`scripts/probe-extension.mjs`](../scripts/probe-extension.mjs) on the live demo: a non-owner extends a `permissionlessExtension` remark (accepted); a non-owner tries to shorten one (rejected with a clear message, "would shorten its life"); a non-owner extends an entity without the flag (rejected, "is owned by …"); a non-owner deletes (rejected). The rejections fail in gas estimation, so the wallet's nonce does not move. All four behave as the SDK's `CreationFlags` and `extendEntity` comments say. One documented detail we nearly missed: `readonly` blocks edits, not deletion by the owner (see schema.md).

### T6. Batches of 40 creates, and fix claims or closures with extensions (9 Oct)

`executeBatch({ creates: [40 remarks] })` four times, then one batch of 27 fix claims plus 27 extensions and one batch of 27 closures plus 27 extensions ([`scripts/seed-load.mjs`](../scripts/seed-load.mjs)). All six landed, and `createdEntities` returned the keys in order. The whole seed (1 roster, 160 remarks, 54 linked records, 54 extensions) cost 0.0221 GLM from the inspector, 0.0033 from the contractor and 0.0001 from the client. Expected and got.

### T7. Creation transaction from `EntityCreated` logs (9 Oct)

Entities carry `createdAt` (a block) but no tx hash. `getLogs({ address: 0x4400…0044, event: EntityCreated, args: { entityKey: [keys] }, fromBlock, toBlock })` returns the creation tx of every key in one call; for the demo roster it returned `0xb005…b742`, the hash the SDK printed at creation. The operations address is not exported by the SDK (`ARKIV_ADDRESS` is internal), so we copied it.

### T8. Writing through a browser wallet (EIP-1193) with `custom(window.ethereum)` (9 Oct)

`createWalletClient({ chain: tiramisu, transport: custom(window.ethereum), account: address })`, then `createEntity` from the production build, in headless Chromium with an injected EIP-1193 provider that starts on chain 1: the page asked `wallet_switchEthereumChain`, got 4902, called `wallet_addEthereumChain` with chain ID `0x7614d1`, and then `createEntity` went out as one `eth_sendTransaction` to the operations address; the SDK then waited with `eth_getTransactionReceipt` through the same provider. The remark landed (tx `0x4d9b…3601`) and appeared in the `load-1` journal as verified, because the wallet is the roster's inspector. Expected and got. Not tested: a real MetaMask extension (headless browsers do not run it).

## Open questions we are testing next

- `watchEntityEvents` events carry no attributes, so an app must call `getEntity` per `EntityCreated` to know whether the entity is its own. Is there a server-side filter for subscriptions?

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

## Tested paths that worked as documented

### T1. Reads against the public RPC with no key (9 Oct)

`createPublicClient({ chain: tiramisu, transport: http() })` → `getChainId()` returned 7738577, `getEntityCount()` 1123, `getBlockNumber()` live. A query with no filter throws `InvalidPredicateError` client-side with a clear message ("A query needs at least one filter"), as documented. Expected and got.

### T2. Compound predicates with `or()` over `$creator` (9 Oct)

`where(and([... , or(eq("$creator", addr(a)), eq("$creator", addr(b)))]))` renders to `(... OR ...)` and the node accepts it. A single-element `or()` collapses to the bare predicate. `createdBy()` renders `$creator = addr(0x…)`. Expected and got.

### T3. The query the SDK sends is reproducible with curl (9 Oct)

The string from `builder.toString()` plus `toRpcSelect(...)` as the `select` option, POSTed as `arkiv_query`, returns the same page as the SDK. The `select` object can be partial (`{"key":true}`) or omitted. This is what makes SiteLog's "read it without SiteLog" panel possible.

## Open questions we are testing next

- Untagged numbers: `severity >= 3` is accepted by the node, like `severity >= i32(3)`. Does it match attributes written as `i32`? (Will test once entities exist.)
- `watchEntityEvents` events carry no attributes, so an app must call `getEntity` per `EntityCreated` to know whether the entity is its own. Is there a server-side filter for subscriptions?

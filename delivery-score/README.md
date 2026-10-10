# Delivery Score

Check an x402 seller before your agent pays it.

x402 lets an agent pay for an HTTP resource with stablecoins: the server answers `402 Payment Required` with a payment challenge, the agent signs a payment and retries. Nothing in the protocol tells the agent whether the endpoint is alive, whether the challenge is well-formed, whether the address it is about to pay is the one the catalogue lists, or whether anything comes back after the money moves.

Delivery Score is a neutral third party that answers those questions with evidence:

1. **Probe** every endpoint of the public x402 catalogue without paying: does it answer, does it answer 402, is the challenge well-formed (scheme, network, asset, payTo, amount), what does it cost, does it match its catalogue entry.
2. **Mystery shopper**: buy from the cheapest endpoints with real USDC on Base and record whether a result came back, how fast, and whether it has the shape the listing advertises.
3. **Score** each endpoint with a short public formula. Every fact behind a score points to a signed, hash-chained [AgentLog](https://github.com/ttimesai-star/agentlog) entry, so anyone can check that the record was not edited afterwards.
4. **`check_before_pay(url)`**: an MCP tool in [agentlog-mcp](https://github.com/ttimesai-star/agentlog-mcp) that runs a live check, compares the offer with the caller's limits and with this index, and returns facts plus a proceed flag.

The project publishes facts ("paid 0.01 USDC at 12:03 UTC, tx 0x…, no response within 30 s"), never labels.

## Results

Run of 10 October 2026 (UTC), from one location. Full numbers: [`data/summary.json`](data/summary.json); per endpoint: [`data/index.json`](data/index.json).

| | |
|---|---|
| Catalogue (Coinbase CDP Bazaar) | 32 764 listed items, 32 585 unique `(resource, method)`, 2 185 hosts |
| Probed (cap 100 per host) | 15 498 endpoints on all 2 185 hosts |
| Answered at all within 20 s | 15 330 (98.9 %) |
| Answered 402 | 14 952 |
| Valid x402 challenge | 14 946 (96.4 %) |
| 402 with a malformed challenge | 6 |
| 2xx without any payment | 70 (33 hosts) |
| Network errors / timeouts | 168 / 44 |
| Other statuses | 400: 152, 404: 87, 403: 23, 502: 22, 405: 7, 500: 6, others 11 |
| Live payTo differs from the listing | 200 endpoints on 31 hosts |
| Live price differs from the listing | 393 |
| Challenge also offers a testnet | 733 |
| Accept entries with a decimal `amount` ("0.01" instead of base units) | 194 (other accepts of the same challenge were valid) |
| Valid offers by network | Base 14 266, Solana 484, Base Sepolia 146, others 64 |
| Price (USDC offers) | min 0.001, median 0.01, p75 0.02, max 5 000; 9 820 at 0.01 or less (14 899 offers priced in USDC) |
| Median time to a 402 | 2.3 s |
| Hosts with no valid 402 on any probed endpoint | 86 of 2 185 |
| Paid purchases | 0: the buyer wallet had no USDC on Base, the balance guard stopped the run (logged, see below) |
| AgentLog | 2 186 runs, 19 871 signed entries, all verify `intact` |

**What this does and does not show.** The Bazaar catalogue is fed by facilitator activity: 32 511 of 32 585 entries had paid calls in the last 30 days. It is therefore a list of endpoints that recently worked, and almost all of them still answer a correct 402. The figure of "about 70 % of x402 endpoints are dead, malformed or fraudulent", quoted by scanner projects, refers to broader indexes that list every endpoint ever seen; it does not describe the Bazaar catalogue, where 98.9 % answered and 96.4 % returned a valid 402 on this run. The findings that do stand out here: 70 endpoints served a 2xx result without any payment, 200 endpoints (31 hosts) asked for payment to a different payTo than their Bazaar listing, and 393 asked a different price than listed. Whether these endpoints deliver after payment is the open question, and the mystery shopper is built for it; in this run it did not spend.

Examples (each line is the signed record's content; `run#step` is its AgentLog reference):

- `GET https://base-gas-x402-production.up.railway.app/gas/cheapest-window`: 402 in 569 ms, valid x402 v2 challenge, 0.02 USDC on Base to `0x0D08…5B44`, payTo and price as listed. Score 70 (the maximum without a purchase). `probe-202610100733-5f7891476afe#1`
- `GET https://keyring-agent.blockchhub.link/api/swap-token`: 402 in 2 638 ms, `accepts[0].amount` is `"0"`; price differs from the listing. Score 33.2. `probe-202610100733-85959921d2f3#2`
- `GET https://stormstation247.com/api/station`: 200 without any payment. Score 25.6. `probe-202610100733-3fa830de20e8#1`
- `GET https://intel.rallylive.ca/watch/domain-score`: 402 in 5 475 ms, valid challenge, live payTo differs from the listing, challenge also offers a testnet. Score 60. `probe-202610100733-b514b69fe118#1`
- `POST https://x402.agentutility.ai/hacker-news-search`: no answer within 20 s. Score 0. `probe-202610100733-17154c0a2226#1`
- Buyer: `buy-202610100747-guard#1`, wallet balance 0 USDC on Base, "stop: purchases not attempted". Export: [`data/export/buy-202610100747-guard.json`](data/export/buy-202610100747-guard.json).

The signed log is [`data/agentlog.db.gz`](data/agentlog.db.gz) (SQLite, gzip). `gunzip -k data/agentlog.db.gz && DS_AGENT_ADDRESS=0x9884b617AA10fA05159FfC3A148AF69d3788c4BC node src/verify.mjs` re-verifies every run; the address is the Delivery Score agent key, which holds no funds.

## Neutrality rules

A score is only worth something if neither side can buy it.

- **Who it is for.** The first users are on the buyer's side: agent marketplaces, teams that run paying agents, and arbiters of disputes. They need to know before paying; sellers are the ones being checked.
- **Sellers.** A seller may run a private test of its own endpoint (same probe, same checks) to fix problems. A private test never enters, changes or removes anything in the public index.
- **Nothing is for sale.** Removing a record or raising a score cannot be bought. A score changes only when a new probe or purchase produces new facts; the old records stay in the signed log.
- **Facts only.** The index publishes what was sent and what came back, with a time, a transaction id for payments, and the AgentLog record behind it. No labels: never "scam", "fraud" or similar.
- **Corrections.** A seller who disputes a fact gets the signed record and its evidence; if a probe was wrong (for example, our input was invalid), the next probe's result is published next to it, not instead of it.

## Legal checks

Before any purchase, the terms of the facilitator that settles the buyer's payment are checked for: Belarus, sanction, embargo, "arms embargo", HM Treasury, OFAC, restricted territory. If a facilitator excludes the buyer's jurisdiction, purchases go only through facilitators that do not, or are not made. Quotes are verbatim; status as of 10 October 2026.

| Facilitator / source | Status | Verbatim |
|---|---|---|
| Coinbase CDP facilitator, x402 FAQ (docs.cdp.coinbase.com/x402/support/faq) | read | "Every payment is screened against OFAC sanctions lists and Know Your Transaction (KYT) risk signals before it settles. A declined payment fails with kyt_risk_detected, so the buyer never loses funds and the seller never delivers the resource. Screening runs at both verification and settlement, and checks the payer and the recipient." |
| Coinbase Developer Platform Terms of Service (coinbase.com/legal/developer-platform/terms-of-service) | **not read**: HTTP 403 (Cloudflare challenge) to both a plain request and a headless browser | none yet |
| Other facilitators named in challenges (by `extra.feePayer` / facilitator URL) | not checked yet | none yet |

Until the CDP terms and the facilitator of each target are read and quoted here, the buyer is not run. In this run, nothing was bought.

## Method

### Source

The free Coinbase CDP Bazaar discovery API (`/platform/v2/x402/discovery/resources`), every page. A record is one `(resource, method)` pair. x402scan's index is behind its own x402 paywall and was not used for this run.

### Probe (`src/probe.mjs`)

- At most 100 endpoints per host, sampled evenly across the host's list (one catalogue host lists over 9 000 routes; probing all of them would be load, not measurement). Results for a host are a sample, its full count is kept as `host_listed`.
- One unpaid request per endpoint with the method from the listing; POST bodies and GET query parameters are the listing's own example input. No payment header is ever sent. At most 2 concurrent requests per host, 48 overall, 20 s timeout. User agent `delivery-score-probe/0.1 (+repo URL)`.
- A 402 challenge is read from the v2 `PAYMENT-REQUIRED` header (base64 JSON) or, for v1, from the JSON body.
- Validation (`src/lib.mjs`): `x402Version` is 1 or 2; `accepts` is a non-empty array; per accept: known scheme; recognised network (CAIP-2, or a v1 name mapped to CAIP-2); `payTo` and `asset` are valid addresses for the network family (EVM: 20-byte hex, not zero; Solana: base58); `amount` (v2) or `maxAmountRequired` (v1) is a positive integer; for EVM USDC under `exact`, the EIP-712 domain name is present. A challenge is valid if at least one accept passes.
- Price in USD only when the asset is the USDC contract of that network (6 decimals). Other assets are reported in base units.
- The live payTo and price are compared with the catalogue entry.
- Every probe is an AgentLog `tool.call` entry (`x402.probe`) signed by the Delivery Score agent key; the raw request and response summary are the store's evidence and their SHA-256 hashes are in the signed entry. Each host's run is sealed at the end.

### Mystery shopper (`src/buyer.mjs`)

- Targets: endpoints whose live challenge offers `exact` USDC on the chosen mainnet (`--chain solana`, default, or `--chain base`) at or below 0.01 USDC, cheapest first, one per host; paths that suggest side effects (send, transfer, swap, order, email, buy, auth, pay and similar) are skipped. On Solana the facilitator must be the fee payer.
- Limits written in code, not flags: at most 0.05 USDC per purchase and 2 USDC in total across all runs (summed from the spend log). A payment policy registered in the x402 client drops every other offer the seller makes.
- Uses the official `@x402/core` and `@x402/evm` clients. For each purchase, signed AgentLog entries: the challenge, the payment (chosen requirement, amount), the paid response (status, latency, size, body hash, preview, `PAYMENT-RESPONSE`), and the on-chain receipt (Base: the USDC `Transfer` from our wallet to `payTo` in the receipt; Solana: the USDC token-balance deltas of our wallet and `payTo` in the confirmed transaction; never the seller's word).
- Spend log: one CSV row per attempt with the tx id.

### Score (`src/score.mjs`)

```
score = 100 * (0.20*live + 0.30*challenge + 0.10*catalog + 0.10*speed + 0.30*delivery)
```

| Component | Value |
|---|---|
| live | 1 if the endpoint answered at all within the timeout |
| challenge | 1 if it answered 402 with a valid challenge |
| catalog | 0.5 if the live payTo matches the listing, plus 0.5 if the price matches |
| speed | 1 at 1 s or less, linear to 0 at 10 s |
| delivery | share of our paid purchases that returned 2xx with a non-empty body; 0 if never bought |

An endpoint whose delivery has not been tested cannot score above 70. Host and payTo aggregates are means over their probed endpoints. The output `data/index.json` maps `"METHOD url"` to score, components, facts and evidence references `{run_id, step, entry_hash}`.

### Verify (`src/verify.mjs`)

`node src/verify.mjs` re-verifies every run in `data/agentlog.db` against the agent address; `--export RUN_ID` writes an `agentlog-export/v1` bundle with the raw evidence, which verifies offline with the agentlog library.

## Use

```bash
npm install
node src/collect.mjs           # data/catalog.json
node src/probe.mjs             # data/probe.json + signed entries in data/agentlog.db
node src/buyer.mjs --dry-run   # show targets and the wallet balance, sign nothing
node src/buyer.mjs --n 15      # buy (needs USDC on Base; hard limits above)
node src/score.mjs             # data/scores.json, data/index.json, data/summary.json
node src/verify.mjs
npm test
```

Keys: `DS_AGENT_KEY` signs log entries and holds no funds. The buyer wallet is read from a local secrets file outside the repository.

In an MCP client, with agentlog-mcp: set `DELIVERY_SCORE_INDEX` to a local `index.json` or its raw URL and call `check_before_pay { url, method?, body?, max_price_usdc?, expected_pay_to?, network? }`.

## Limits

- **One vantage point, one moment.** One request per endpoint from one network location on one day. An endpoint that was down for a minute scores as down. Scores are a snapshot, dated in the index.
- **Sampling.** Hosts with more than 100 routes are sampled; their other routes inherit nothing but the host aggregate.
- **Catalogue bias.** Only what Bazaar lists. Endpoints that are not listed are not seen; listing does not imply anything about the seller.
- **Example inputs.** Many POST endpoints validate the body before answering 402. A 400 to the listing's own example input is recorded as such; a better input might have produced a 402.
- **Delivery is narrow.** "Delivered" means 2xx with a non-empty body, plus the share of the advertised example's top-level keys present. It does not judge whether the content is correct or useful.
- **Small sample of purchases.** A handful of paid calls per run, one per host. One failure is a fact about that call, not a property of the seller.
- **Self-signed evidence.** The log proves that our records were not changed after they were written and that they were signed by our key. It does not prove that the probe saw what it says it saw; the on-chain receipt is the only part a third party can check without trusting us. Seller-signed receipts are the next step.
- **No labels.** The project does not call any endpoint a scam or fraud and does not contact sellers.

## License

MIT

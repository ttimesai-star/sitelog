# SiteLog

**A construction site inspection log the contractor cannot rewrite.** The site inspector's remarks live on [Arkiv](https://arkiv.network), the Web3 database, and the app decides who wrote each record from its on-chain creator, never from a field anyone can type.

- Live app: https://ttimesai-star.github.io/sitelog/ (Tiramisu testnet, no login, read-only without a wallet)
  - `?project=demo-1`: the story, 4 remarks, a fix claim, a closure and two contractor forgeries
  - `?project=load-1`: 160 remarks, 27 fix claims, 27 closures, to show cursor pagination ("Load 25 more")
- Tracks: **Security** (trust from `$creator`) and **Censorship Resistance** (anyone can read and query the log from the public RPC, without SiteLog)
- Arkiv docs for this repo: [`arkiv/schema.md`](arkiv/schema.md) · [`arkiv/friction.md`](arkiv/friction.md)
- Status: work in progress during Arkiv: Global Tour Stop, 9 to 18 October 2026

## The problem

I direct a construction and real estate development company. On a building site the technical supervisor (the inspector who works for the client, not for the builder) walks the site and writes remarks: formwork props too far apart, honeycombing at a column base, spacers missing under the rebar. Those remarks are the evidence when the client and the contractor later argue about acceptance, payment and warranty claims.

Today that evidence usually sits where one side controls it: a paper journal kept in the contractor's site office, a spreadsheet, or the database of whoever runs the project software. Whoever holds the file can lose a page, edit a line or "close" a defect before acceptance, and the other side has no way to prove what was written and when. Even when nobody cheats, the argument becomes whose copy is right.

Who is harmed: the client who pays for hidden defects, the inspector whose signature can be disputed, and in the end the people who buy the flats. What changes from day one with SiteLog: a remark, once written by an inspector's wallet, cannot be edited or deleted by the contractor, a "closed" status written by the contractor is visibly ignored, and the whole log can be read by anyone with the public RPC, even if SiteLog's own site disappears.

## How it works

1. The **client** publishes a roster entity: which wallets are inspectors and which are contractors. The app trusts a roster only if its `$creator` is the client wallet (the trust root).
2. The **inspector** writes **remarks**: readonly entities (nobody can change the text, the inspector included) with permissionless extension (anyone can keep the evidence alive). Severity 1 to 5 and the creation time are numeric attributes, so the journal can be filtered by ranges.
3. The **contractor** answers with a **fix claim**. In the same atomic batch the remark's lease is renewed for 90 days.
4. The **inspector** accepts with a **closure**. One atomic batch writes the closure and extends the remark to 365 days, the evidence period.
5. Anything written by a wallet outside the roster still exists on chain, and SiteLog shows it under **Unverified records**: a fake "all remarks resolved" note or a contractor's own "closure" never changes a remark's status.

Photos stay off Arkiv: only their SHA-256 is stored, and the page checks any photo against it in the browser.

## Why Arkiv

- **Postgres or our own API:** the operator can delete or edit a row, and the "author" column is whatever the server wrote. SiteLog's trust rule (`$creator` in the client's roster) is enforced by the chain, not by our code.
- **IPFS:** the content is immutable but there is no query by project, severity range or date range, and no verifiable author of a CID.
- **A subgraph:** someone has to run the indexer; if we stop, the log is gone for everyone who relied on our endpoint.
- **What only Arkiv gives us here:** `$creator` filters run on the node; readonly plus permissionless extension lets a record be kept alive by the party that needs the evidence without letting anyone change it; Entity Expiration lets each record type live as long as its business purpose; batches make "close + extend" atomic.

What stays off Arkiv on purpose: photos and drawings, any real names or contacts (not even hashed), prices. The demo uses synthetic data only.

## Read the log without SiteLog

Any HTTP client can query the public RPC directly. Verified remarks of the demo project with severity 3 or higher:

```bash
curl -s https://rpc.tiramisu.db-chain.testnet.arkiv.network -H 'content-type: application/json' --data '{
  "jsonrpc":"2.0","id":1,"method":"arkiv_query",
  "params":["app = str('"'"'sitelog'"'"') AND kind = str('"'"'remark'"'"') AND project = str('"'"'demo-1'"'"') AND severity >= i32(3) AND $creator = addr(0x6BEa8012E15605564cc67Bad1F8941262cC68f69)",
            {"select":{"key":true,"creator":true,"expiresAt":true,"attributes":true,"payload":true}}]}'
```

The live page shows the exact query it just ran for the current filters, with a copy button.

## Try it in five minutes (for judges)

1. Open https://ttimesai-star.github.io/sitelog/. The first screen says the problem, how SiteLog works, and shows the live journal of `demo-1`, read from the public Tiramisu RPC.
2. Each remark card has a green **verified** badge: its on-chain `$creator` is the inspector in the client's roster. The card links to the entity and to its creation transaction on the explorer.
3. Scroll to **Forged and unverified records**: the contractor wallet wrote "All inspection remarks on Block A resolved. Signed: site inspector." It is on chain, and it is shown with a red **forged** badge, because its `$creator` is the contractor.
4. On the stop-work remark (sev 5) the contractor's own "closure" is listed as **ignored**: the remark stays open.
5. Switch to `load-1` and press **Load 25 more** until the end: a cursor walk over 160 remarks, pinned to one block.
6. Copy the curl command under **Read it without SiteLog** and run it: the same verified remarks, with no SiteLog code.
7. Optional: **Connect wallet** (MetaMask or any EIP-1193 wallet; the page adds the Tiramisu network) and write a remark. It lands on chain and shows as forged, because your wallet is not in the roster. Test GLM: https://hub.arkiv.network/faucet.

The public RPC allows about 100 queries per hour per caller (friction F7) and one page load uses 4, so reloading the page some 25 times within an hour shows a quota message until the hour resets.

## Run it locally

Requirements: Node.js 22 or newer.

```bash
git clone https://github.com/ttimesai-star/sitelog
cd sitelog
npm install
npm run dev          # web app on http://localhost:5173/sitelog/
```

CLI (reads need nothing; writes need a funded Tiramisu key in an environment variable, never on the command line):

```bash
node scripts/sitelog.mjs journal --min 3                      # print the verified journal
export SITELOG_PRIVATE_KEY=0x...                              # test key, funded at https://hub.arkiv.network/faucet
node scripts/sitelog.mjs whoami
node scripts/sitelog.mjs remark --severity 4 --section concrete --text "Synthetic test remark" --photo photo.jpg
node scripts/sitelog.mjs fix    --remark 0xREMARK_KEY --text "Fixed, ready for re-inspection"
node scripts/sitelog.mjs close  --remark 0xREMARK_KEY --text "Accepted"
node scripts/sitelog.mjs keepalive --remark 0xREMARK_KEY --days 120
```

Scripts that produced the demo data (synthetic wallets from a local JSON file, never committed): `scripts/seed-demo.mjs` (the `demo-1` story), `scripts/seed-load.mjs` (`load-1`, 160 remarks in batches of 40), `scripts/probe-extension.mjs` (who can extend, shorten or delete a remark; results in [`arkiv/schema.md`](arkiv/schema.md)).

A remark you write from your own wallet is real and public, but it shows as unverified on the demo project, because your wallet is not in the client's roster. To run your own project, publish a roster from your wallet (`node scripts/sitelog.mjs roles --project my-site --inspectors 0x... --contractors 0x...`) and open the page with `?project=my-site&client=<your wallet>`.

## Wallets that create the demo entities (Tiramisu)

| Role | Address |
|---|---|
| Client (trust root, roster) | `0xBDe3eD9ecD0E7078d010B220cDEcA3Af3F7AC6f0` |
| Site inspector (remarks, closures) | `0x6BEa8012E15605564cc67Bad1F8941262cC68f69` |
| Contractor (fix claims, and the forgery attempts) | `0x0757a42040C19A8C686c9D3A36336203C889d29B` |

All three are synthetic test wallets created for this demo.

## Licence

MIT. Built during Arkiv: Global Tour Stop (9 to 18 October 2026) with an AI coding assistant (Claude).

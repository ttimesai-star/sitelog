# SiteLog: Arkiv schema

Network: Tiramisu testnet (chain ID 7738577). SDK: `@arkiv-network/sdk` 0.8.1.
Source of truth for the code below: [`src/lib/sitelog.js`](../src/lib/sitelog.js).

Every SiteLog entity carries the same base attributes, so one app on a shared chain can find its own data:

| Attribute | Type | Why it is an attribute |
|---|---|---|
| `app` | str, always `sitelog` | namespace filter on a shared network |
| `v` | i32, schema version (1) | lets a reader skip entities from a future schema |
| `kind` | str: `roles`, `remark`, `fix`, `closure` | entity type |
| `project` | str, e.g. `demo-1` | every query is per project |
| `created_ts` | u64, Unix seconds | numeric, so "since date X" is a range query; there is no server-side ordering, so the client sorts on it |

Trust is never read from an attribute or the payload. It comes from `$creator`, which the chain sets and nobody can change.

## Entity types

### `roles`: the project roster

Created by the **client** (the party paying for the building). The app trusts a roster only if its `$creator` equals the client wallet the user chose as the trust root (`DEMO_CLIENT` for the demo).

| | |
|---|---|
| Extra attributes | none |
| Payload (JSON) | `{ title, inspectors: [address], contractors: [address] }` |
| Expiration | 365 days: the roster lives as long as the build stage; the client publishes a new roster when people change, and the newest one by `created_ts` wins |
| Flags | none (the client may publish a newer roster) |

Inspector and contractor addresses sit in the payload, not in attributes, because no query filters on them: the app reads the one roster and then uses the addresses in `$creator` predicates.

### `remark`: a defect recorded by the site inspector

| | |
|---|---|
| Extra attributes | `severity` i32 1..5 (1 note, 2 minor, 3 major, 4 critical, 5 stop-work), numeric for range filters; `section` str (formwork, concrete, rebar...) |
| Payload (JSON) | `{ text, location, photo_sha256, norm_ref }` |
| Expiration | 90 days. An open defect must be acted on. Any fix claim renews the lease to 90 days from now; closing the remark extends it to 365 days |
| Flags | `readonly`: after creation nobody, the inspector included, can change the text or severity. `permissionlessExtension`: the client, the contractor or anyone can keep the record alive, but cannot change it |
| Owner | the inspector. A contractor cannot delete it (not the owner), cannot edit it (readonly) and cannot make it expire sooner (see "Lifetime extension" below) |

The photo itself stays off Arkiv. Only its SHA-256 goes into the payload, so anyone holding the photo can prove it is the one the inspector referenced (the app checks it in the browser).

### `fix`: a contractor's claim that a defect is fixed

| | |
|---|---|
| Extra attributes | `remark` key: the remark it answers |
| Payload (JSON) | `{ text, photo_sha256 }` |
| Expiration | 30 days. A claim is a request for re-inspection, not a fact; if nobody acts on it, it lapses |
| Flags | `readonly` |
| Written in a batch | create `fix` + `extendEntity` of the remark to 90 days from now (skipped if the remark already lives longer, because an extension that does not move the expiry later reverts) |

### `closure`: the inspector accepts the fix

| | |
|---|---|
| Extra attributes | `remark` key; optional `fix` key |
| Payload (JSON) | `{ text }` |
| Expiration | 365 days: accepted work is evidence for the warranty period |
| Flags | `readonly` |
| Written in a batch | create `closure` + extend the remark to 365 days, atomically, so a remark never shows as closed while about to expire |

A closure counts only if its `$creator` is an inspector in the roster. A "closure" created by any other wallet is shown as ignored.

## Status is derived, not stored

`open` → no fix and no valid closure; `fix-claimed` → at least one `fix`; `closed` → a `closure` created by an inspector. A remark is readonly, so a status attribute on it could not change; storing status in separate, separately authored entities is what makes a forged "closed" detectable.

## Queries the app runs

The exact strings below are what the SDK sends as the first parameter of `arkiv_query` (the web page shows the live one with a copy button).

1. **Roster**, trusted by creator:
   `app = str('sitelog') AND kind = str('roles') AND project = str('demo-1') AND $creator = addr(0xBDe3eD9ecD0E7078d010B220cDEcA3Af3F7AC6f0)`
2. **Verified remarks** with a severity range and an optional date range; the inspector set from the roster becomes an OR of `$creator` predicates evaluated on the node:
   `app = str('sitelog') AND kind = str('remark') AND project = str('demo-1') AND severity >= i32(3) AND severity <= i32(5) AND created_ts >= u64(1791500000) AND $creator = addr(0x6BEa8012E15605564cc67Bad1F8941262cC68f69)`

   With two inspectors the last predicate becomes `($creator = addr(0x6BEa...) OR $creator = addr(0x...))`.
3. **Forged and unverified remarks**: everything that claims to be a remark for the project but was not created by any inspector. The exclusion runs on the node:
   `app = str('sitelog') AND kind = str('remark') AND project = str('demo-1') AND NOT ($creator = addr(0x6BEa8012E15605564cc67Bad1F8941262cC68f69))`
4. **Fixes and closures of the remarks on the current page**, one compound query per page of 25 remark keys:
   `app = str('sitelog') AND project = str('demo-1') AND (kind = str('fix') OR kind = str('closure')) AND (remark = key(0xbc7c…) OR remark = key(0x82bf…) OR …)`
   The node rejects a query with too many predicates (somewhere between 60 and 80), so keys go in chunks of 25.

### Pagination

The web page loads the journal 25 verified remarks at a time with the query cursor ("Load 25 more"). Every page of one walk is pinned to the block of the first page with `atBlock()`: the cursor is bound to that block, and without the pin the second or third page fails once a new block lands (friction F4). The pinned walk is also a consistent snapshot: remarks written while you page do not shift the list. The CLI walks all pages the same way (`limit` 100, pinned).

Arkiv has no server-side ordering, so each page is sorted by `created_ts` on the client; across pages the order is the node's. The `load-1` project (160 synthetic remarks, 27 fix claims, 27 closures, written in atomic batches of 40 by [`scripts/seed-load.mjs`](../scripts/seed-load.mjs)) exists to exercise this: open the app with `?project=load-1`.

### Creation transactions

An entity carries its creation block (`createdAt`) but not its transaction hash. To link every card to its creation transaction on the explorer, the page reads the `EntityCreated(bytes32 indexed entityKey, …)` logs of the Arkiv operations address (`0x4400…0044`) with one `eth_getLogs` per page, filtered by the page's entity keys and the block range of their `createdAt`. Entity pages link to `https://tiramisu.explorer.arkiv.network/entity/<key>`.

### Live updates

`watchEntityEvents` over a WebSocket transport, without `fromBlock`. Events carry no attributes, and looking up every new entity on a shared chain would burn the public RPC quota (friction F7). So an event counts as SiteLog's when its entity key is already on the page, or when a new entity's owner is a wallet the page watches: the roster, the client, or the visitor's connected wallet. On the first page the journal reloads by itself; deeper in a cursor walk the page offers a refresh instead of dropping the loaded pages.

## Lifetime extension: anyone can extend, nobody can shorten

Remarks are created with `permissionlessExtension`, so any wallet, not only the inspector who owns the remark, can call `extendEntity` on it. We checked each rule on Tiramisu with [`scripts/probe-extension.mjs`](../scripts/probe-extension.mjs) against the demo entities (9 October):

| Attempt | Result |
|---|---|
| The client, which does not own the remark, extends the sev 2 remark to 120 days | accepted, [tx 0x12a5…9ac1](https://tiramisu.explorer.arkiv.network/tx/0x12a504450f587f75471a5ca84e6eb2a8881827f488cf25a4708dcfe07ef89ac1); expiry moved from 89.9 to 120.0 days |
| The contractor "shortens" the sev 5 remark to 1 day | rejected: "already expires at block 16110109, so extending it to 391140 would shorten its life" |
| The contractor extends the inspector's closure (closures have no permissionless flag) | rejected: "is owned by 0x6BEa…, not 0x0757…" |
| The contractor deletes a remark | rejected: not the owner |

Rejected attempts fail at gas estimation and cost nothing. The same thing happened by accident in the demo seed: the contractor's forged "closure" batch extended the open sev 5 remark to 365 days. The remark stayed open, because the closure was not written by an inspector, and it now lives longer.

Why this is safe for an inspection log:

- **An extension cannot change the record.** Remarks are `readonly`, so the text, severity and attributes stay as the inspector wrote them. The only field a stranger can touch is the expiry, and only to push it later.
- **Nobody can make a remark expire sooner.** `extendEntity` sets a new expiry and the engine rejects any value that is not later than the current one. A contractor cannot "extend" a remark to tomorrow so that it disappears before acceptance.
- **Extending gives no authority.** Status is derived only from `closure` entities whose `$creator` is an inspector in the roster. A wallet that extends a remark does not become its owner and does not change its status.
- **The party that needs the evidence can keep it.** The client, a buyer of a flat or a court-appointed expert can keep a defect record alive past its 90-day lease without asking the inspector or SiteLog, and pays the gas for it.
- **The worst case is a remark that lives longer than planned.** That costs the extender gas and costs the inspector nothing. A longer-lived defect record is the safe direction for evidence.

What it does not protect, stated plainly:

- **The owner can still delete.** `readonly` blocks edits, not deletion: the inspector who owns a remark can delete it. The deletion is visible (an `EntityDeleted` event) and the creation transaction stays on the explorer, so the record's existence and content can still be proven from chain history. A production version would transfer each remark's ownership to the client in the same batch, so that neither the inspector nor the contractor alone can remove it; the demo keeps the inspector as owner.
- **The roster is a single point of trust.** If the client lets the roster expire or deletes it, no remark on the project shows as verified any more. The roster lives 365 days and the client re-publishes it when people change.
- **An open remark that nobody renews expires.** After 90 days without activity it disappears from queries, and its fix claims or closures point at a key that no longer exists. The page marks open remarks with less than 14 days left ("expires in N days", with a keep-alive shortcut), and `node scripts/sitelog.mjs journal --orphans` lists linked records whose remark is gone. The creation transaction stays on the explorer either way.
- **Fix claims and closures are not permissionless.** Only their owners can extend them. A closure lives 365 days from the moment it is written, which covers the warranty period of the demo.

## What stays off Arkiv on purpose

- Photos and drawings: too large and they may show people or plates. Only their SHA-256 is stored.
- Real names, phone numbers, e-mails of inspectors or workers: never, not even hashed. A wallet address stands for a role.
- Contract prices and commercial terms: not needed for any query.
- The demo uses synthetic data only.

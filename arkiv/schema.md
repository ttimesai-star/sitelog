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
| Owner | the inspector. A contractor cannot delete it (not the owner), cannot edit it (readonly) and cannot let it lapse quietly while anyone else extends it |

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
3. **Every entity claiming to be a remark** for the project, whoever wrote it, to list the unverified ones:
   `app = str('sitelog') AND kind = str('remark') AND project = str('demo-1')`
4. **Fixes and closures** of the project:
   `app = str('sitelog') AND project = str('demo-1') AND (kind = str('fix') OR kind = str('closure'))`

All list queries page with the cursor (`limit` 100 or 200, then `next()`), since a project can hold more remarks than one page.

Live updates: `watchEntityEvents` over a WebSocket transport, without `fromBlock`. Events carry no attributes, so for each `EntityCreated` the page reads the entity once and reloads only if it belongs to the open project.

## What stays off Arkiv on purpose

- Photos and drawings: too large and they may show people or plates. Only their SHA-256 is stored.
- Real names, phone numbers, e-mails of inspectors or workers: never, not even hashed. A wallet address stands for a role.
- Contract prices and commercial terms: not needed for any query.
- The demo uses synthetic data only.

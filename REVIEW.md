# SiteLog Codebase & Hackathon Review

This document contains a comprehensive review of **SiteLog** for the Arkiv "Global Tour Stop" challenge (Devfolio, Security and Censorship Resistance tracks).

---

## 1. Findings Table

| ID | Severity | File:Line | Description | Concrete Fix |
|---|---|---|---|---|
| **SEC-01** | **High** | `src/main.js:8` | Unescaped wallet addresses in `addrLink` helper allow HTML/attribute injection if an address or wallet parameter contains malicious HTML/JS payloads. | Wrap all address string interpolations in `addrLink` with `esc(...)`. |
| **SEC-02** | **Medium** | `src/lib/sitelog.js:140` | `verifiedRemarksQuery` and query builders do not sanitize string inputs (e.g. `project`). String inputs containing quotes could cause syntax errors or query formatting issues in `arkiv_query`. | Ensure query inputs are checked or sanitized before constructing SDK predicates. |
| **SEC-03** | **Low** | `src/lib/sitelog.js:167` | `loadJournal` picks the first valid inspector closure using `myClosures.find()`. If multiple inspector closures exist for one remark, subsequent closures are ignored without warning. | Display a notice or select the latest valid closure by `created_ts`. |
| **SEC-04** | **Low** | `src/lib/sitelog.js:63` | `payloadJson` returns `{}` on parse error. UI handles missing payload fields gracefully, but unexpected non-string types in JSON fields could produce `undefined` rendering. | Validate payload schema structure or fallback to default empty strings. |
| **RENT-01** | **Medium** | `src/lib/sitelog.js:109` | `fixBatch` compares `renewTo` (calculated in blocks) with `remarkExpiresAtBlock`, while passing `ExpirationTime.fromDays(LIFETIME_DAYS.remark)` (relative seconds in SDK 0.8.1). This block-vs-time mismatch can lead to incorrect extension decisions. | Standardize block calculation or pass block counts directly using `ExpirationTime.fromBlocks`. |
| **RENT-02** | **Info** | `src/lib/sitelog.js:98` | Anyone can submit a closure batch or call `extendEntity` on a remark due to `permissionlessExtension`. A contractor calling `closeBatch` extends the remark lease at their own gas cost, but the fake closure is properly ignored by the UI. | Expected design behavior; document permissionless extension rent mechanics clearly in `arkiv/schema.md`. |
| **RENT-03** | **Medium** | `src/lib/sitelog.js:164` | If an open remark expires before a fix or closure, linked entities will refer to a non-existent remark key (`remarkKey`). `loadJournal` does not recover or highlight expired remarks. | Add visual indicator or filtering option for orphaned fixes/closures whose parent remark has expired. |
| **QUERY-01** | **Medium** | `src/lib/sitelog.js:145` | `verifiedRemarksQuery` and `anyRemarksQuery` use `.limit(100)` without pagination in `fetchAll` for certain subqueries, capping remarks at 100 items per query. | Wrap query execution with `fetchAll` across all list queries to ensure full pagination beyond 100 entries. |
| **QUERY-02** | **Low** | `src/lib/sitelog.js:140` | Numeric filters (`severity`, `created_ts`) use explicit `i32`/`u64` wrappers, but unparsed string inputs passed into `loadJournal` could cause type mismatch errors. | Coerce `minSeverity`, `maxSeverity`, and timestamps to numbers explicitly before building predicates. |
| **BATCH-01** | **Low** | `src/lib/sitelog.js:106` | If `headBlock` or `remarkExpiresAtBlock` is omitted when calling `fixBatch`, the function defaults to appending an extension step, which may revert on-chain if expiry is unchanged. | Require block numbers or fetch them inside client helper wrappers before executing batch operations. |
| **BATCH-02** | **Medium** | `src/main.js:164` | WebSocket event listener in `watchEntityEvents` updates UI on error but does not attempt reconnection after network disconnects or socket dropouts. | Add an exponential backoff reconnection timer in `onError` for the WebSocket listener. |
| **BATCH-03** | **Low** | `src/main.js:192` | Wallet connection prompts for network switch to Tiramisu (`0x7614d1`), but user rejection leaves write buttons visible in an inconsistent state. | Disable write controls or display an explicit warning if chain ID switch fails. |
| **JUDGE-01** | **High** | `package.json` | Project lacks automated unit or integration tests (`npm test` missing), risking low judge scoring on code quality and testing rigor. | Add `node --test` test suite covering schema, query builders, trust rules, and payload parsing. |
| **JUDGE-02** | **Medium** | `scripts/seed-demo.mjs` | Seeding requires manual faucet interaction due to captcha protection on Tiramisu faucet, making automated CI test setup challenging. | Document synthetic seeding requirements and key generation steps in `README.md`. |
| **JUDGE-03** | **Low** | `arkiv/friction.md` | Friction report lists initial findings but omits details on `ExpirationTime` helper behavior and WebSocket payload structure. | Update `arkiv/friction.md` with additional SDK insights. |
| **README-01** | **Low** | `README.md:58` | Copy-paste `curl` command in `README.md` uses nested single quotes (`'...'`) that cause syntax errors in bash environments. | Correct escaping in the `curl` example command. |
| **README-02** | **Low** | `README.md:68` | `README.md` missing instructions for running tests locally. | Add `npm test` instructions under "Run it locally". |

---

## 2. Weak Points a Hackathon Judge Will Notice

1. **"SDK installed but not really used" Risk:**
   - Judges checking if Arkiv is central to the project will verify if trust logic depends on on-chain features.
   - *Strengths in SiteLog:* SiteLog relies heavily on `$creator` on-chain attribute filtering, `readonly` and `permissionlessExtension` entity creation flags, and atomic batch transactions (`executeBatch`) for close + extend operations.
   - *Weakness:* Without explicit automated unit tests demonstrating how `$creator` filtering enforces role separation, judges might doubt whether filtering actually occurs on the Arkiv node vs client-side.

2. **Censorship-Resistance Claim Verification:**
   - The claim that anyone can read the journal without SiteLog depends on raw `arkiv_query` RPC calls working via `curl`. The current `curl` snippet in `README.md` contains bash quoting syntax errors, which would prevent a judge from testing raw RPC queries directly.

3. **Missing Automated Testing:**
   - `package.json` had no `test` script, meaning `npm test` failed out of the box. Adding unit tests for core trust rules (`creatorRole`, `loadRoles`, `verifiedRemarksQuery`) significantly improves judge confidence in code quality.

---

## 3. README Improvements

1. **Fix `curl` Syntax in Readme:**
   - Correct nested single-quote escaping in `curl` command string so it runs cleanly in standard Linux/macOS bash shells.

2. **Add `npm test` Section:**
   - Include instructions for running unit tests locally via `npm test` (using Node's native test runner).

3. **Clarify Permissionless Extension & Expiration:**
   - Highlight why permissionless extension is used for remarks (allows client or any party to maintain evidence longevity without ability to tamper with payload).

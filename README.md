# AgentLeash (BCH)

A spending leash for AI agents on Bitcoin Cash. The agent signs its own payments, but the
**network** (not a server, not the agent's code) enforces how much it can spend, to whom, and how
fast. The owner can take everything back at any time without the agent's key.

Built for BCH BLAZE 2026. License: MIT.

## Status (honest)

| Part | State |
|---|---|
| `contracts/AgentLeash.cash` (CashScript 0.14) | v0, written 10.10.2026. Two automated review passes (Jules, see `REVIEW.md`: no critical/high/medium findings; two low SDK findings fixed), not a professional audit. **Not frozen; do not put real money in it.** |
| TypeScript SDK (`src/`) | genesis, pay, top-up, withdraw, receipt + request-hash helpers |
| Tests (MockNetworkProvider, vitest) | 94 tests: happy paths, 29 attack cases, owner path, genesis, 6-seed property test, plus 39 tests from two external review passes (`REVIEW.md`) |
| Chipnet | full scenario run with real transactions, see below |
| x402 server (`exact` + `leash` schemes), agent, web UI (WizardConnect) | not started (stage 2) |
| Mainnet | not deployed (planned after security review and code freeze) |

## How it works

Funds sit in a P2SH32 covenant. Its state is a single **mutable NFT** whose commitment is
`elapsed (8 bytes LE) | spent (8 bytes LE)`.

`pay(agentPk, agentSig, elapsedAdd)` — the only way the agent can move money. The transaction shape is fixed:

| | |
|---|---|
| `in[0]` | the contract UTXO carrying the state NFT (exactly one input) |
| `out[0]` | back to the contract: state NFT with the new commitment + change (>= 1000 sats) |
| `out[1]` | payment to one of 3 allow-listed locking bytecodes, no tokens, >= 546 sats |
| `out[2]` | receipt `OP_RETURN "LSH1" <32-byte request hash>`, 0 sats |

Checked by the contract: agent key and signature; category **and** capability of the NFT
(exactly `mutable`, no fungible amount); fee `<= maxFee`; and the window:

```
outflow = in[0].value - out[0].value                 // payment + miner fee
require(outflow - amount <= maxFee)
require(elapsedAdd >= 0 && elapsedAdd < 65536 && this.age >= elapsedAdd)   // CSV / BIP68
e' = elapsed + elapsedAdd ; s' = spent + outflow
if e' >= period: (e', s') = (0, outflow)             // window rolls over
require(s' <= limit) ; out[0].commitment == e' | s'
```

The limit counts **everything that leaves the contract**, fees included. A first draft counted only
the payment; then an agent could make many 546-sat payments with `maxFee` each and burn several times
the limit in fees per window. Test `fee burn: fees count against the limit` covers it.

The clock only advances by `elapsedAdd`, which the network proves through the input's relative
locktime (the UTXO really is that many blocks old). So the agent can never make time run faster than
the chain. An alternative design that stores `periodStart = tx.locktime` lets the agent backdate
locktime and claim k windows at once after k idle periods; this design avoids it.

`owner(ownerInputIndex)` — valid whenever the transaction also spends an input whose locking
bytecode is the owner's P2PKH. The owner's wallet signs that input (SIGHASH_ALL), so the owner
can withdraw, top up, reset, migrate to new rules, or absorb stray UTXOs. No agent key needed.

Rules (`limit`, `period`, `maxFee`, allow-list) are constructor parameters, i.e. part of the address.
Changing them = owner migrates the NFT and funds to a new address.

### Known properties and limits

- **Fixed window**: worst case is `limit` at the end of a window plus `limit` right after the reset,
  i.e. `2 x limit` within a short span. The property test asserts exactly this bound.
- Unused allowance is not carried over; the new window starts at the first payment after expiry
  (the clock is conservative: it never runs ahead of real time).
- The owner path trusts the owner's wallet: the owner input must be signed with `SIGHASH_ALL`
  (the default in CashScript and in common BCH wallets). A `NONE`/`SINGLE`/`ANYONECANPAY` signature
  on that input would let others rewrite the withdrawal outputs (review AL-08).
- The allow-list is the owner's trust decision: if an allow-listed script forwards funds to the agent,
  the contract cannot see it (review AL-09). Use plain P2PKH payees you control or trust.
- One state UTXO = payments are strictly sequential (unconfirmed chains are fine, `elapsedAdd = 0`).
- `elapsedAdd` must be < 65536: CSV ignores bits above 16 and treats bit 22 as "time units", so
  without that bound an agent could claim 65536 or `2^22 + 1` "blocks" with a zero-age UTXO. Tests cover both.
- `stateCategory` is passed to the contract in VM byte order (reverse of the displayed category hex);
  the SDK does this (`categoryToVmBytes`), and a test shows that the wrong order makes the leash unusable.
- Off-chain: the receipt hash binds a payment to an HTTP request
  (`sha256(nonce | method | url | sha256(body))`, length-prefixed). Replay protection of the nonce is the
  402 server's job (stage 2).

## Attack matrix (each is a test in `test/leash.test.ts`)

| Attack | Result |
|---|---|
| pay a non-allow-listed address / the agent itself | `pay: recipient not allow-listed` |
| exceed the limit (single or cumulative) | `pay: limit exceeded` |
| burn the balance through fees on many tiny payments | `pay: limit exceeded` (fees count) |
| write a fake "reset" state early | `pay: limit exceeded` |
| under-report `spent` | `pay: wrong new state` |
| drain through the miner fee | `pay: fee above maxFee` |
| send change/NFT elsewhere, or drop the NFT | `pay: change must return to contract` / `pay: state NFT must return` |
| own mutable NFT of another category on the contract address | `pay: input lacks state NFT` |
| right category with capability `none` / `minting` | `pay: input lacks state NFT` |
| fungible tokens on the state input | `pay: input carries fungible tokens` |
| 4th output, missing receipt | `pay: exactly three outputs` |
| 2 inputs (state + stray), stray bare UTXO alone | `pay: exactly one input` / `pay: input lacks state NFT` |
| malformed receipt (length, prefix, used as a payment) | `pay: bad receipt length` / `pay: bad receipt prefix` |
| claim more age than proven | `pay: elapsedAdd exceeds proven UTXO age` |
| CSV masking (`65536`, bit 22) | `pay: elapsedAdd out of range` |
| negative `elapsedAdd` | `pay: negative elapsedAdd` |
| someone else signs (griefing) / agent pubkey + foreign signature | `not the agent key` / signature failure |
| agent tries `owner()` with its own input, or points at the contract input | `owner: no owner input` |

## Chipnet run (real transactions, 10.10.2026)

Rules: `limit` 6000 sats, `period` 3 blocks, `maxFee` 2000 sats. Owner, agent and payee are
separate chipnet keys. Log of every broadcast, including verbatim node errors:
[`scripts/chipnet-log.jsonl`](scripts/chipnet-log.jsonl).

Leash address `bchtest:rwkq7xj93eh0ewxhq77ldel2a03cr5qhwpnj5uxz7ugrch8xnpwg6qp5qsqjm`,
state NFT category `77bb874f49fa2fafd16b09a6385b7ef8573f9e1bb7c54fd301f3be1c358c4f69`.

| Step | Result | txid / node response |
|---|---|---|
| genesis (owner): 1 mutable NFT, state (0,0), 40 000 sats | accepted | `fcc6a0dc29fb80167cbeb51e8398ffe22028f4ec162b3ce8c90ce03cb1493a90` |
| agent pays 1500 (+705 fee) | accepted, state (0, 2205) | `d7c63eb0c49bf21e1f51ffdbdd94a6a21b744ba27ce103399f7bc899060a98f4` |
| agent pays 1000 (+705 fee) | accepted, state (0, 3910) | `b1b94befe0ad74a36f5cda5a033f5ebc14a022ad30a234e6a5a703ccfd141265` |
| attack: pay the agent's own address | **rejected by node** | `mandatory-script-verify-flag-failed (Script failed an OP_VERIFY operation)`; local: `pay: recipient not allow-listed` |
| attack: fee 2001 > maxFee | **rejected by node** | same; local: `pay: fee above maxFee` |
| attack: claim 3 blocks of age on a 0-conf UTXO | **rejected by node** | `non-BIP68-final (code 64)` |
| attack: write a reset state without proven age | **rejected by node** | `... finished with a false/empty top stack element`; local: `pay: wrong new state` |
| attack: 1 sat over the limit | **rejected by node** | `... OP_VERIFY ...`; local: `pay: limit exceeded` |
| agent asks SDK for 2500 more | refused before signing | `limit exceeded: 3910 of 6000 sats spent in this window, 3205 requested (payment + fee), 2090 left` |
| 3 blocks later: agent pays 3000 with `elapsedAdd = 3` | accepted, window reset, state (0, 3705) | `a21e3018093ca5d1818911019c2b6f417d4a3c799479829b163d407c12c37f5e` |
| owner withdraws everything (one owner input, NFT burned) | accepted | `e81d18abfa92a636c3e455608c06b2dd8f9b8751e841e8d472dbcc82e8c4d253` |

An earlier draft of the contract (fees not counted in the limit, see above) was also run on chipnet:
genesis `14d06b91374a76aee15d725a21e1a7d2ff63da233c3e936062aa2574cd06f363`, owner withdraw
`77bb874f49fa2fafd16b09a6385b7ef8573f9e1bb7c54fd301f3be1c358c4f69`
([`scripts/chipnet-log.v0a.jsonl`](scripts/chipnet-log.v0a.jsonl)).

A pay transaction is 700 bytes (fee 705 sats at 1 sat/byte); owner withdraw of one UTXO 598 bytes.

Note: on a chain node the contract-level rejections all surface as
`mandatory-script-verify-flag-failed (Script failed an OP_VERIFY operation)`; the clock attack is
rejected one layer earlier by consensus (`non-BIP68-final`). The `localReason` field in the log is the
failing `require` from CashScript's local debugger for the same transaction hex.

## Usage

```bash
npm install
npm test            # vitest, MockNetworkProvider
npm run compile     # cashc -> artifacts/
npx tsx scripts/chipnet.ts status|genesis|pay <sats>|attack <kind>|withdraw
```

```ts
import { AgentLeash, buildGenesis, computeRequestHash } from 'agentleash-bch';

const { leash, builder } = buildGenesis({ provider, ownerUtxo /* vout 0 */, ownerUnlocker, ownerAddress,
  params: { agentPkh, ownerLock, allow: [serverLock], limit: 20_000n, period: 144n, maxFee: 2_000n }, fund: 100_000n });
await builder.send();

const { state } = await leash.getUtxos();
const tx = leash.buildPay({ stateUtxo: state!, agentPrivateKey, payTo: serverAddress, amount: 1_000n,
  requestHash: computeRequestHash({ challengeNonce, method: 'GET', url }), elapsedAdd /* <= real age */ });
await tx.send();
```

`buildPay` mirrors the contract off-chain and throws `LimitExceededError` with "N left, resets in ~M blocks"
before anything is signed, so an agent gets a readable reason instead of a node error.

## Roadmap

- x402 v2 server offering both `exact` (standard P2PKH, compatible with `@x402/bch`, x402-foundation/x402 PR #3632 at `b297bc3`) and a `leash` scheme for covenant payments (receipt + request hash, mempool settlement).
- LLM agent with three paid tools; web UI over WizardConnect (create, fund, withdraw, journal, "try to break it").
- Security review and code freeze before any mainnet deployment.

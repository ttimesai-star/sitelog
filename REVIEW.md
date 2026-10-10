# Security and Correctness Review: AgentLeash v0

This review evaluates `contracts/AgentLeash.cash` and the associated TypeScript SDK (`src/leash.ts`, `src/state.ts`, `src/receipt.ts`) on branch `review/agentleash-bch`.

---

## Executive Summary

No critical, high, or medium severity vulnerabilities were found that allow an agent holding **only** the agent key (not the owner key) to bypass the on-chain financial boundaries or corrupt contract state. The contract design strictly enforces input/output structural constraints, recipient lockings, miner fee caps, state NFT capability preservation, and BIP68 relative locktimes.

Several low and informational findings were identified in SDK edge cases and transaction building semantics.

---

## Findings Summary Table

| Finding ID | Title | Severity | Evidence (Test Name) | Status / Impact |
|---|---|---|---|---|
| **AL-01** | Fixed-Window Reset Boundary (2x Limit) | Info | `documents fixed-window boundary: 2x limit across window reset (intended behavior)` | Verified as documented design limit |
| **AL-02** | Prohibited Token Outputs on Recipient & Receipt Slots | Info / Defense | `token outputs prohibited on payment output (out[1]) and receipt output (out[2])` | Defended by contract checks (`tokenCategory == 0x`) |
| **AL-03** | 0-Conf Clock Interaction & Unconfirmed Chains | Info / Defense | `interaction of unconfirmed chains (0-conf) with the clock` | Defended by contract CSV age checks (`this.age >= elapsedAdd`) |
| **AL-04** | Potential Dust Output Shift in `withAutoFee` Probe Pass | Low | `documents withAutoFee edge case: change output dust boundary shift between probe and final pass` | SDK fee estimation edge case if change sits near dust threshold (546 sat) |
| **AL-05** | Parameter Collision Resistance in Receipt Request Hashing | Info / Defense | `prevents parameter collision between different nonce/method/url combinations` | Defended by length-prefixed domain separation in `computeRequestHash` |
| **AL-06** | Stray Token Sweeping Requirement for Contract Usability | Low | `stray tokens on contract do not lock out the owner` | Requires `owner()` path to include appropriate token output when sweeping stray tokens |

---

## Detailed Findings

### AL-01: Fixed-Window Reset Boundary (2x Limit)
- **Severity**: Info
- **Evidence**: `documents fixed-window boundary: 2x limit across window reset (intended behavior)`
- **Analysis**: As documented in `README.md`, if the agent spends `limit` satoshis near the end of a window and `limit` satoshis immediately after the clock advances by `period` blocks, up to `2 * limit` satoshis can be spent within a short real-time span.
- **Contract Mechanics**: The contract requires `newElapsed >= period` before resetting `newElapsed = 0` and `newSpent = outflow`. The clock cannot be advanced faster than real block time due to `this.age >= elapsedAdd`.
- **Suggested Fix / Recommendation**: None required for contract; callers/applications should be aware of fixed-window dynamics versus sliding-window dynamics.

---

### AL-02: Prohibited Token Outputs on Recipient & Receipt Slots
- **Severity**: Info / Defense
- **Evidence**: `token outputs prohibited on payment output (out[1]) and receipt output (out[2])`
- **Analysis**: Checked whether an agent could attach fungible tokens or unexpected NFTs to output 1 (payment) or output 2 (receipt) to bypass token tracking or burn token assets.
- **Contract Mechanics**:
  - Output 1 enforces `require(tx.outputs[1].tokenCategory == 0x, "pay: payment output carries tokens")`.
  - Output 2 enforces `require(tx.outputs[2].tokenCategory == 0x, "pay: receipt carries tokens")`.
- **Suggested Fix / Recommendation**: No change needed. On-chain rules strictly prohibit tokens on outputs 1 and 2.

---

### AL-03: 0-Conf Clock Interaction & Unconfirmed Chains
- **Severity**: Info / Defense
- **Evidence**: `interaction of unconfirmed chains (0-conf) with the clock`
- **Analysis**: Evaluated whether unconfirmed transactions in mempool chains could allow an agent to manipulate `elapsedAdd` or reset the clock prematurely.
- **Contract Mechanics**:
  - `elapsedAdd = 0` is valid on 0-conf state UTXOs and leaves `elapsed` unchanged.
  - Any `elapsedAdd > 0` requires `this.age >= elapsedAdd`, which requires relative locktime confirmation in a block. Unconfirmed UTXOs have age 0, so any transaction attempting `elapsedAdd > 0` on 0-conf UTXOs fails script verification.
- **Suggested Fix / Recommendation**: No change needed.

---

### AL-04: Dust Boundary Shift in `withAutoFee` Probe Pass
- **Severity**: Low
- **Evidence**: `documents withAutoFee edge case: change output dust boundary shift between probe and final pass`
- **Analysis**: `withAutoFee` in `src/leash.ts` builds a transaction with a probe fee (2000 sat), measures the serialized byte size, calculates `fee = ceil(size * feeRate) + margin`, and rebuilds with the calculated fee.
- **Edge Case**: If the owner change output value is slightly above the dust threshold (546 sat) during the 2000 sat probe pass, but drops below 546 sat after subtracting the final recalculated fee, `TransactionBuilder` or `buildTopUp` / `buildGenesis` may throw or produce an unexpected output layout difference.
- **Suggested Fix / Recommendation**: In `src/leash.ts`, re-check change dust boundaries explicitly after fee calculation or adjust probe fee estimation to account for change output presence changes.

---

### AL-05: Parameter Collision Resistance in Receipt Request Hashing
- **Severity**: Info / Defense
- **Evidence**: `prevents parameter collision between different nonce/method/url combinations`
- **Analysis**: Evaluated `computeRequestHash` in `src/receipt.ts` for collision resistance when concatenating fields (`challengeNonce`, `method`, `url`, `body`).
- **SDK Mechanics**: Each string/byte field is length-prefixed (1 byte for nonce length, 1 byte for method length, 2 bytes BE for URL length) before hashing.
- **Suggested Fix / Recommendation**: No change needed. Length prefixes guarantee unique byte representations across distinct parameter tuples.

---

### AL-06: Stray Token Sweeping Requirement for Contract Usability
- **Severity**: Low
- **Evidence**: `stray tokens on contract do not lock out the owner`
- **Analysis**: If a third party sends stray tokens to the leash contract address, `pay()` rejects the state input if extra token inputs/outputs are present. The owner can spend stray token UTXOs via `owner()`.
- **SDK Mechanics**: When building a custom transaction for stray token UTXOs, the output must carry the token details (`token: { category, amount }`) to satisfy consensus token preservation rules. `getUtxos()` correctly classifies these as `invalid`.
- **Suggested Fix / Recommendation**: Consider adding a helper method in `AgentLeash` SDK specifically for owner stray token sweeping.

---

## Area Checklists & Verification Log

### Contract Analysis (`contracts/AgentLeash.cash`)
- [x] **Limit enforcement**: Verified single and cumulative spending limits; fees strictly included in outflow calculation.
- [x] **Allow-listed recipients**: Verified recipient matching against `allowA`, `allowB`, or `allowC`.
- [x] **Max miner fee**: Verified `outflow - amount <= maxFee`.
- [x] **State NFT integrity**: Verified state category matching, `0x01` mutable capability byte, no fungible token amount, and exact 16-byte commitment format (`elapsed (8B LE) | spent (8B LE)`).
- [x] **Owner escape hatch**: Verified `owner()` index lookup `tx.inputs[ownerInputIndex].lockingBytecode == ownerLock`.
- [x] **Third-party anti-griefing**: Verified agent signature check, single-input constraint (`tx.inputs.length == 1`), and active input index (`this.activeInputIndex == 0`).
- [x] **CSV semantics**: Verified `elapsedAdd >= 0`, `elapsedAdd < 65536` (preventing bit 31 sequence disable and bit 22 time-type flags), and `this.age >= elapsedAdd`.
- [x] **Byte order**: Verified `stateCategory` VM reverse byte order requirement.
- [x] **Integer decoding**: Verified 8-byte LE slicing and CashScript int conversion.
- [x] **Output structure**: Verified exactly 3 outputs for `pay()`, receipt prefix `0x6a044c53483120` (39 bytes), and dust thresholds.

### SDK Analysis (`src/leash.ts`, `src/state.ts`, `src/receipt.ts`)
- [x] **`withAutoFee`**: Verified probing logic and transaction size scaling.
- [x] **`nextState` mirror**: Verified exact parity between TypeScript state calculation and CashScript contract logic.
- [x] **Genesis rules**: Verified `vout === 0` constraint and single mutable NFT minting.
- [x] **Withdraw / Top-up builders**: Verified input index mapping for owner unlocker and change calculations.
- [x] **`computeRequestHash`**: Verified domain-separated hashing and length prefixing.

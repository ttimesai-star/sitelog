# agentlog

Tamper-evident audit trail for AI agents, in TypeScript. Every step of an agent run (tool call, model call, error, end of run) becomes an entry that is hashed, signed by the agent's key (EIP-191) and linked to the previous one. A verifier that runs the same in Node, in the browser and offline finds any edited, deleted, reordered, forked or re-signed step and says which one. MIT.

- **Core** (`agentlog/core`): canonical JSON, hashing, entry building and signing, `verifyRun`, signed export bundles, salted commitments for details kept off the record.
- **Stores**: one interface, three implementations: `MemoryStore`, `SqliteStore` (Node's built-in `node:sqlite`, `agentlog/sqlite`), `ArkivStore` (readonly entities on the [Arkiv](https://arkiv.network) network, `$creator` set by the chain).
- **Recorder**: an append-only writer over any store; serializes concurrent writes to one run, continues a run across processes, starts runs automatically, seals them.
- **Explanations**: `explain(report)` turns a verification report into the first break (`edited`, `deleted`, `forked`, `foreign_signer`, `bad_signature`, `relinked`, `after_seal`) and a sentence fit to be spoken.
- **Dispute replay**: two parties bring their own raw copies of a run; `replayDispute` says, step by step, whose version is what the agent signed.

Used by [agentlog-mcp](https://github.com/ttimesai-star/agentlog-mcp), an MCP server that answers "what did my agent do yesterday, and was the log changed?" by voice.

## Install

Requires Node.js 22.18 or newer.

```bash
npm install github:ttimesai-star/agentlog
```

## Use

```ts
import { Recorder, verifyStored } from "agentlog"
import { SqliteStore } from "agentlog/sqlite"
import { privateKeyToAccount } from "viem/accounts"

const store = new SqliteStore("./agent-log.db")
const key = privateKeyToAccount(process.env.AGENT_KEY as `0x${string}`)
const rec = new Recorder({ store, signerFor: async () => key })

const { run_id } = await rec.log({ agent_id: "release-checker", action: "run.start", note: "Check release v1.4.4" })
await rec.log({ agent_id: "release-checker", run_id, action: "tool.call", tool: "http_get", input: { url: "https://staging.example/health" }, output: { status: 200 } })
await rec.log({ agent_id: "release-checker", run_id, action: "run.end", output: { result: "approved" } })

const { report, explain } = await verifyStored(store, "release-checker", run_id, key.address)
console.log(report.verdict, explain.sentence)
// intact The log is intact: all 3 steps are signed by the agent, linked, and sealed.
```

If someone edits the file afterwards:

```
broken The log was tampered with. Step 1 cannot be trusted: its content was edited after the agent signed it. Every other step checks out.
```

Raw inputs and outputs never enter the entry, only their SHA-256 hashes; the store keeps them as the operator's private evidence (`store.evidence()`). With `detailsOffChain: true` every step gets a random salt, the tool name is replaced by a commitment and the public note is dropped.

## What it protects, and what it does not

Protected: editing, deleting, reordering or back-dating a step; inserting a step from another key; passing a cut-off run as complete (no seal: `open`). With `ArkivStore` also an operator who holds the agent's key: entities are readonly and the chain sets `$creator`.

Not protected: an agent that lies at the moment it writes; with a local store, whoever holds both the agent's key and the file rewriting a whole run consistently; the agent's clock.

## Tests

```bash
npm test
```

55 tests: hashes, signatures, gaps, forks, foreign signers, seals, exports, dispute replay, salted commitments, the recorder, SQLite persistence and tampering, the Arkiv store.

## History

The core, the Arkiv writer and the dispute replay come from the [SiteLog](https://github.com/ttimesai-star/sitelog) project (9 October 2026). Extracted into this library on 10 October 2026, with the store interface, the SQLite and memory stores, the recorder, the Arkiv store, explanations, and their tests.

## License

MIT

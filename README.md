# SiteLog: Agent Action Log on Arkiv

**A tamper-evident, censorship-resistant audit trail for AI agents.** Every LLM call and every tool call of an agent becomes a signed, hash-chained, readonly entity on [Arkiv](https://arkiv.network), the Web3 database. Anyone can verify a run in the browser, from the public RPC, with no server of ours. The same trust rules also power a construction site log, the project's first use case.

- Live app: https://ttimesai-star.github.io/sitelog/ (Tiramisu testnet, read-only, no login)
  - Agent Action Log: a real run of an LLM agent, 9 steps, verified in your tab, plus two forgeries an attacker wrote into the same run
  - Construction use case: https://ttimesai-star.github.io/sitelog/site.html?project=demo-1 (old `?project=` links still work)
- SDK and CLI (TypeScript): [`agentlog/`](agentlog/) · example agent: [`agentlog/examples/release-agent.ts`](agentlog/examples/release-agent.ts)
- Arkiv docs for this repo: [`arkiv/schema.md`](arkiv/schema.md) · friction report: [`arkiv/friction.md`](arkiv/friction.md)
- Tracks: **Security**, **Censorship Resistance**, **Privacy**, **Open Source** (MIT)
- Status: built during Arkiv: Global Tour Stop, 9 to 18 October 2026

## The problem

AI agents now call tools that matter: they read customer data, open pull requests, send payments, approve releases. What an agent did is recorded in a log on the operator's server. After an incident, that log is the only evidence, and it is held by the party with the most reason to change it. The operator, the agent itself, or an attacker who stole its credentials can delete a step, edit what a tool returned, or add a check that never ran. A customer, an auditor or a regulator has to take the operator's word for it.

What changes with the Agent Action Log: each step lands on Arkiv while the agent runs, signed by the agent's wallet and linked to the previous step by its hash. Once written, nobody can patch it. With a custodian set, the agent does not even own its entries, so it cannot delete them. Anything removed or edited later breaks the chain, and anyone with the public RPC can see where.

## Try it in three minutes (for judges)

1. Open https://ttimesai-star.github.io/sitelog/. The page reads run `run-20261009T152956` of the agent `release-checker` from the public Tiramisu RPC and verifies it in the tab: **INTACT**, 9/9 entries, sealed, 2 forged records ignored.
2. The table shows each step: `run.start`, four `llm.call` (model `openai/gpt-oss-20b`), three `tool.call` (two `http_get`, one `arkiv_status`), `run.end`. Each row links to its entity and creation transaction on the explorer. The owner of every entry is the custodian wallet, not the agent.
3. **Forged records**: an attacker wallet wrote a fake step "all checks passed, approved for release" and a byte-for-byte copy of a genuine step into the same run. Both are on chain. Both are ignored because their `$creator` is not the agent wallet. The copy even carries the agent's valid signature.
4. Press **Tamper with a copy in your browser**: the page edits a tool output, deletes a step, cuts off the seal and re-signs a step with another key, and re-verifies each copy. Every edit is caught, and the page says how.
5. Press **Check raw inputs and outputs**: the page loads the run's evidence file (the raw LLM requests, replies and tool results, kept off chain) and checks every one against the hashes on Arkiv.
6. **Download export**, then drop the file into **Verify an export, offline**: the same verdict, computed with no network.
7. Copy the curl command under **Read it without this page** and run it: the same entities, with no SiteLog code.

The run selector also lists the agent's other runs from the same afternoon. Three of them stop early and show **OPEN** (not sealed): two died on the LLM provider's quota after `run.start`, one died on a malformed tool call from the model. Their trail shows exactly how far each run got.

## How it works

One entry is one action of the agent:

```json
{ "v": 1, "agent_id": "release-checker", "run_id": "run-20261009T152956", "step": 2,
  "action": "tool.call", "tool": "http_get", "note": "GET https://api.github.com/repos/ttimesai-star/sitelog/commits/main",
  "input_hash": "0x371d…", "output_hash": "0x7864…", "prev_entry_hash": "0x4557…",
  "timestamp": 1791559811222, "signer": "0x3ad7…c546",
  "entry_hash": "0x7580…", "sig": "0x9cc9…" }
```

- `input_hash` and `output_hash` are SHA-256 of the canonical JSON (sorted keys) of the tool's arguments and result, or of the LLM request and reply. The raw content stays with the operator.
- `prev_entry_hash` is the previous step's `entry_hash` (zero for step 0). Removing, reordering or editing a step breaks every link after it.
- `entry_hash` is SHA-256 of the canonical JSON of all fields above it. `sig` is the agent wallet's EIP-191 signature of `agentlog:v1:<entry_hash>`. The signature keeps an exported run verifiable after its Arkiv entities expire.
- `run.end` seals the run: its input is the step count and the head hash. A run without a seal shows as **OPEN**, so a truncated run cannot pass as a finished one.

On Arkiv each entry is one entity:

| | |
|---|---|
| Attributes | `app`=`agentlog`, `kind` (`step`/`seal`), `agent`, `run`, `step` (u64), `action`, `tool`, `ts` (u64), `entry` and `prev` (bytes32) |
| Payload | the entry JSON above |
| Flags | `readonly` (nobody can patch it) and `permissionlessExtension` (an auditor can keep it alive, not change it) |
| Lifetime | 14 days while the run is live; the seal moves every entry of the run to 180 days in the same transaction |
| Custody (optional) | the batch that creates the entries also hands their ownership to a custodian wallet, using keys predicted with `predictEntityKeys`. `$creator` stays the agent. From the first block the agent can neither delete nor patch its own steps (tested, [`arkiv/friction.md`](arkiv/friction.md) T9) |

The verifier ([`agentlog/src/core.ts`](agentlog/src/core.ts), the same code in Node and in the browser) recomputes every hash, recovers every signature, follows the links from step 0, and reports gaps (a step deleted or expired), forks (two signed entries for one step), edits, foreign signers and entries after the seal. Records whose `$creator` is not the agent wallet are listed as forged and never enter the chain.

Full schema and queries: [`arkiv/schema.md`](arkiv/schema.md#agent-action-log).

## Use it from your agent

Requirements: Node.js 22.18 or newer (the SDK and CLI run from TypeScript source with Node's built-in type stripping).

```ts
import { createPublicClient, createWalletClient } from "@arkiv-network/sdk"
import { tiramisu } from "@arkiv-network/sdk/chains"
import { http } from "viem"
import { privateKeyToAccount } from "viem/accounts"
import { AgentLog } from "./agentlog/src/index.ts"

const account = privateKeyToAccount(process.env.AGENTLOG_PRIVATE_KEY)
const log = new AgentLog({
  wallet: createWalletClient({ chain: tiramisu, transport: http(), account }),
  publicClient: createPublicClient({ chain: tiramisu, transport: http() }), // needed for custody
  account, agentId: "my-agent", runId: `run-${Date.now()}`,
  custodian: "0xAUDITOR", // optional: the auditor owns every entry from the block it lands in
})

await log.start({ task })
const search = log.wrap("web_search", webSearch)        // each call: hash in, hash out, signed, on Arkiv
await log.record({ action: "llm.call", tool: model, input: request, output: reply })
await log.seal({ result })                               // run.end + 180-day retention, atomically
```

`wrap()` logs failures too (`tool.error`), and steps are recorded in call order even when the agent runs tools in parallel. `batchSize` trades latency for fewer transactions.

The example agent [`agentlog/examples/release-agent.ts`](agentlog/examples/release-agent.ts) is a real tool-calling loop against any OpenAI-compatible API: it checks this repository's latest commit, the live page and the Arkiv network, then writes a status report. The demo run used the free NVIDIA NIM endpoint with `openai/gpt-oss-20b`. [`agentlog/examples/forge.ts`](agentlog/examples/forge.ts) is the attacker.

CLI, for agents written in any language (each call extends the same chain through a small state file):

```bash
export AGENTLOG_PRIVATE_KEY=0x...    # funded Tiramisu test key: https://hub.arkiv.network/faucet
node agentlog/cli.ts start --agent my-agent --run r1 --input '{"task":"..."}'
node agentlog/cli.ts step  --agent my-agent --run r1 --tool http_get --input '{"url":"..."}' --output-file response.json
node agentlog/cli.ts seal  --agent my-agent --run r1 --output '{"result":"ok"}'
node agentlog/cli.ts verify --agent release-checker --run run-20261009T152956 --signer 0x3ad7cD724fF2c472aC5Ca5a0F0edbd6880d2c546 --out run.json
node agentlog/cli.ts verify-file run.json      # offline
node agentlog/cli.ts retain --agent my-agent --run r1 --signer 0x... --days 365   # any wallet can keep a run alive
```

Reads need no key. `verify` exits with code 2 when a run is broken, so it can gate a CI job.

## Why Arkiv

| Alternative | What goes wrong for an agent audit trail |
|---|---|
| The operator's own database or log service | The party under audit holds the delete button, and the "author" column is whatever the server wrote. |
| Cloud write-once storage (object lock) | Immutable, but the operator owns the account, decides what gets written, and is the only one who can read or query it. |
| A transparency log run by a third party | Built for artifact signatures, run by someone else, with no query by agent, run or tool, and no expiry. |
| Events or storage in an EVM contract | Every step costs real gas, there is no query layer without an indexer, and the data stays forever. |
| IPFS | Content-addressed, but no query, no verifiable author of a CID, and someone has to keep pinning. |

What Arkiv gives us, and the code uses:

- **`$creator` is set by the chain.** Anyone may write into a run, and the attacker in the demo did. Only the agent wallet's steps count, and the `$creator` filter runs on the node.
- **Readonly entities.** Nobody can patch a step, the agent included.
- **Ownership transfer in the creating batch.** With `predictEntityKeys`, the batch that creates a step also hands it to a custodian. There is no moment when the agent alone could delete it.
- **Entity Expiration with permissionless extension.** Logs do not pile up forever: a live run's steps lease 14 days. Evidence does not vanish early: the seal moves the run to 180 days, and an auditor can extend it further without being able to change it. After expiry, the signed export still verifies offline.
- **Attributes are the index.** Agent, run, step, tool, action, time and both hashes are typed attributes, so "every `http_get` of this agent", "the runs of this wallet" or "which entries point at this hash" (fork detection) is one query, with no indexer of ours.
- **Batches.** The seal, the retention of every step and the custody transfer are atomic.
- **No backend.** The page and the CLI talk to the public RPC. If this site and repository disappeared, every run would still be readable with the curl command the page prints.

## What it protects, and what it does not

- **Protected:** deleting, editing, reordering or back-dating a step after it lands (gap, hash or link failure); forging steps from another wallet (ignored by `$creator`); replaying a genuine step from another wallet (same); passing a truncated run as complete (no seal: **OPEN**); the agent deleting its own trail when a custodian is set (rejected by the chain).
- **Not protected:** an agent that lies at the moment of writing (it can hash a fake output), a stolen agent key used to write a second history (shows as a fork only if both histories reach the chain), the agent's clock (timestamps are the agent's; the block number of each entity is the chain's), and a custodian that deletes entries (choose one you trust, or a multisig). Before the seal, steps live 14 days unless someone extends them.
- **Privacy:** only hashes, tool names and a short public note go on chain. Raw prompts, replies and tool results stay with the operator and are shown to an auditor privately; the auditor checks them against the on-chain hashes (the page does this for the demo run with its public evidence file). Do not put secrets or personal data in `note`, `agent_id` or `run_id`.

## Use case: a construction site log

The project started as a site inspection log for construction, where the same problem exists with paper journals: the inspector's defect remarks are evidence in disputes over acceptance and payment, and they sit in the contractor's office. SiteLog stores each remark as a readonly entity written by the inspector's wallet, trusts a record only if its `$creator` is in a roster published by the client's wallet, derives status from separately signed fix claims and closures, and shows forged closures as ignored.

- Live: https://ttimesai-star.github.io/sitelog/site.html?project=demo-1 (4 remarks, a fix claim, a closure, two contractor forgeries) and `?project=load-1` (160 remarks, cursor pagination)
- CLI: `node scripts/sitelog.mjs journal --min 3`; schema and lease rules: [`arkiv/schema.md`](arkiv/schema.md)
- Read it without SiteLog (verified remarks of `demo-1` with severity 3 or higher):

```bash
curl -s https://rpc.tiramisu.db-chain.testnet.arkiv.network -H 'content-type: application/json' --data '{
  "jsonrpc":"2.0","id":1,"method":"arkiv_query",
  "params":["app = str('"'"'sitelog'"'"') AND kind = str('"'"'remark'"'"') AND project = str('"'"'demo-1'"'"') AND severity >= i32(3) AND $creator = addr(0x6BEa8012E15605564cc67Bad1F8941262cC68f69)",
            {"select":{"key":true,"creator":true,"expiresAt":true,"attributes":true,"payload":true}}]}'
```

(The `'"'"'` sequences put single quotes inside the single-quoted JSON; the query language only accepts single-quoted strings, friction F3.)

## Friction report

[`arkiv/friction.md`](arkiv/friction.md) lists what we ran into, with the exact steps. The ones that cost us the most:

- **F4:** cursor pagination breaks after one block unless the walk is pinned with `atBlock()`.
- **F7:** the public RPC allows about 100 `arkiv_query` calls per hour per caller; a public page must budget for it (this page uses 2 per load).
- **F8:** the documented "predict a key, then reference it in the same batch" example calls `predictEntityKeys` and `executeBatch` on one client, but no client has both: the wallet client lacks `predictEntityKeys`.
- **F9:** permissionless extension lets any third party make an owner's atomic batch revert, by extending one of its entities further than the batch does.

## Run locally

```bash
git clone https://github.com/ttimesai-star/sitelog
cd sitelog
npm install
npm test             # 44 unit tests: hashing, verification and tamper cases, writer, custody, SiteLog trust rules (no network)
npm run typecheck    # tsc over the TypeScript SDK, CLI and tests
npm run dev          # web app on http://localhost:5173/sitelog/
```

Scripts that produced the demo data (keys come from local files or environment variables, never committed): `agentlog/examples/release-agent.ts` (agent runs), `agentlog/examples/forge.ts` (the attacker), `scripts/probe-agentlog-custody.mjs` (custody rules), `scripts/seed-demo.mjs` and `scripts/seed-load.mjs` (construction projects), `scripts/probe-extension.mjs` (lease rules). The raw evidence of the demo run is in [`public/demo/runs/`](public/demo/runs/).

## Wallets that create the demo entities (Tiramisu)

| Role | Address |
|---|---|
| Agent `release-checker` (`$creator` of every step) | `0x3ad7cD724fF2c472aC5Ca5a0F0edbd6880d2c546` |
| Custodian of the agent's entries; client in the construction demo | `0xBDe3eD9ecD0E7078d010B220cDEcA3Af3F7AC6f0` |
| Attacker in the agent demo; contractor in the construction demo | `0x0757a42040C19A8C686c9D3A36336203C889d29B` |
| Site inspector (construction demo) | `0x6BEa8012E15605564cc67Bad1F8941262cC68f69` |

All four are synthetic test wallets created for this demo.

## Licence

MIT. Built during Arkiv: Global Tour Stop (9 to 18 October 2026) with AI coding assistants (Claude; one review by Google Jules).

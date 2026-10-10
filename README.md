# SiteLog: Agent Action Log on Arkiv

**A tamper-evident, censorship-resistant audit trail for AI agents.** Every LLM call and every tool call of an agent becomes a signed, hash-chained, readonly entity on [Arkiv](https://arkiv.network), the Web3 database. Anyone can verify a run in the browser, from the public RPC, with no server of ours. The same trust rules also power a construction site log, the project's first use case.

- Live app: https://ttimesai-star.github.io/sitelog/ (Tiramisu testnet, read-only, no login)
  - Agent Action Log: a real run of an LLM agent, 9 steps, verified in your tab, plus two forgeries an attacker wrote into the same run
  - Dispute replay: the agent's operator and its client bring their own raw data; the page says, step by step, whose version is what the agent signed
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
7. Press **Load the demo dispute** under **Dispute replay**: the operator and the client of the agent each bring their own raw data for the same run. The page checks both against the run and gives a verdict per disputed step (step 2 both agree, step 4 the operator, step 8 the client), with a JSON report and a print layout. Their files are read in the tab only.
8. Under **Details off chain**, see both sides of one step (public on Arkiv, private with the operator), and write a strict step with salted commitments in the tab. The **EU AI Act, Article 12** table maps the log's fields to the text of the Act.
9. Copy the curl command under **Read it without this page** and run it: the same entities, with no SiteLog code.

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
node agentlog/cli.ts dispute --export run.json --operator op.json --client cl.json --out report.json   # offline
```

Reads need no key. `verify` exits with code 2 when a run is broken, so it can gate a CI job.

## Dispute replay: the operator and the client, one run

The operator of an agent and its client disagree about what the agent did. Neither of them can change the run on Arkiv, so both can accept it as the common record. Each side brings its own private file of raw data: the operator its evidence file, the client the copies it received (a reply, a report, a tool result), each with an optional claim per step. The dispute replay checks every step:

1. Is the step itself sound on chain: hash, signature, link to the previous step, `$creator`? A step the chain does not anchor (deleted, forked, edited) can be confirmed for nobody.
2. Does each party's raw input and output match the hashes the agent signed when it wrote the step?

Each disputed step gets one verdict: `operator` (only the operator's version matches), `client`, `both`, `neither` or `no_anchor`. Steps nobody disputes are listed too, so the report reads as "what the agent actually did, step by step". The report (`agentlog-dispute-report/v1`) pins the run (head hash, signer, chain verdict, block), the SHA-256 of both party files and its own `report_hash`. It carries hashes and verdicts only, unless excerpts of the raw outputs are switched on.

On the page: section **Dispute replay**. The run record is the run loaded above from Arkiv (no extra query) or an export file (offline). Party files are read in the tab and never uploaded; the replay makes no network request. **Load the demo dispute** replays a prepared case on the demo run: the client says the live page was down and the release was never approved, the operator says the opposite and has edited the final report after the run. Verdicts: step 2 both agree, step 4 the operator's version (the agent did get HTTP 200), step 8 the client's version (the signed report never said "approved"). Report export: JSON and a print layout (print or save as PDF).

```bash
node agentlog/cli.ts dispute --export run.json --operator op.json --client cl.json [--steps 2,4] [--excerpts] --out report.json
```

A party file is the operator's `agentlog-evidence/v1` file as is, or a minimal file:

```json
{ "party": "client", "run_id": "run-20261009T152956",
  "entries": [ { "step": 4, "raw": { "output": { "status": 503 } }, "claim": "The live page was down." } ] }
```

What a match proves: the party's raw data is exactly what the agent hashed and signed at the time. It does not prove the agent told the truth at that moment. Code: [`agentlog/src/dispute.ts`](agentlog/src/dispute.ts); demo files: [`public/demo/runs/`](public/demo/runs/), built by [`scripts/make-dispute-demo.mjs`](scripts/make-dispute-demo.mjs).

## Details off chain

Raw prompts, model replies and tool results never go on chain. Arkiv holds what is needed to prove the record was not changed: step, action, hash links, input and output hashes, signature. The operator keeps the raw record (`log.evidence()`) and shows it only to the other party in a dispute or to an auditor, who check it against Arkiv themselves.

The default mode still puts the tool or model name and a short public `note` on chain, and a plain hash of a short value can be guessed (anyone can hash `200` or `[]` and compare). Strict mode removes both:

```ts
const log = new AgentLog({ wallet, account, agentId, runId, detailsOffChain: true })
```

- every step gets a fresh random 32-byte salt;
- `input_hash` and `output_hash` are SHA-256 of the canonical JSON of `{ "s": salt, "v": value }`;
- `tool` becomes `h:` + 32 hex characters of SHA-256 over `{ "s": salt, "t": tool }`;
- `note` is empty on chain (kept in the evidence file);
- salts, plain tool names and notes live only in the evidence file; `checkRaw(entry, raw)` opens the commitments.

From the chain alone one then learns only that step N was a `tool.call` at time T, linked and signed. Queries by tool name are no longer possible in this mode; that is the trade. The verifier and the entry format are unchanged, so strict and plain runs verify the same way. The page shows both sides of a real step, and writes a strict step in the tab with a throwaway key.

### Same direction as Verifiable Agent Arbiter

On 6 October 2026 Google Cloud and Mysten Labs announced Verifiable Agent Arbiter: detailed agent telemetry stays private in customer-controlled Google Cloud Storage, cryptographic proofs go to Walrus and are coordinated on Sui, and two organisations can replay a disputed workflow against the same receipts over the A2A protocol ([report](https://cryptobriefing.com/mysten-labs-google-cloud-verifiable-agent-arbiter/)). SiteLog follows the same split. Where it differs:

- **Open source (MIT).** Writer, verifier, dispute replay and page are in this repository.
- **Any wallet, any stack.** Entries are signed with a plain EVM key (EIP-191) and stored as Arkiv entities. Anything that can sign a message can write a run, through the TypeScript SDK or the CLI; any wallet can keep a run alive.
- **No cloud tied in.** The private record is a JSON file the operator keeps where it wants. A dispute needs the public run and the two party files, nothing else.
- **Checked without our server.** The page and the CLI read only the public Arkiv RPC; a signed export verifies offline after the entities expire.

## EU AI Act, Article 12: what each field covers

A map of the log's fields to the text of Regulation (EU) 2024/1689, quoted from the official text on [EUR-Lex](https://eur-lex.europa.eu/eli/reg/2024/1689/oj). **Not legal advice and not a compliance claim.** Article 12 applies to high-risk AI systems; whether a system is high-risk and whether its logs are adequate is for its provider, its deployer and their counsel to decide.

| Text of the Act | What the Agent Action Log records | What it does not do |
|---|---|---|
| **12(1)** "High-risk AI systems shall technically allow for the automatic recording of events (logs) over the lifetime of the system." | Every call made through `wrap()` or `record()` becomes an entry as it happens: `run.start`, `llm.call`, `tool.call`, `tool.error`, `run.end`, hash-linked and signed. | Only calls routed through the SDK or CLI are logged; lifetime coverage is the integrator's job. |
| **12(2)(a)** logs "shall enable the recording of events relevant for: (a) identifying situations that may result in the high-risk AI system presenting a risk within the meaning of Article 79(1) or in a substantial modification" | `tool.error` entries; the model name of every `llm.call` (a model change is visible); forks, gaps and edits found by the verifier; unsealed runs show as OPEN. | Records events; does not decide what counts as a risk. |
| **12(2)(b)** "facilitating the post-market monitoring referred to in Article 72" | Agent, run, step, action, tool and time are typed Arkiv attributes: queries across runs need no indexer. Signed exports for archiving. | No monitoring plan or dashboards. |
| **12(2)(c)** "monitoring the operation of high-risk AI systems referred to in Article 26(5)" | Per-run verification in a browser or the CLI from the public RPC; the dispute replay for a disagreement about one run. | No alerting. |
| **12(3)** applies only to systems of Annex III point 1(a) (remote biometric identification); listed here as a checklist. "(a) recording of the period of each use of the system (start date and time and end date and time of each use)" | `timestamp` of `run.start` and `run.end` (agent's clock) and the block number of each entity (chain's clock). | The agent's clock is not trusted; the block number is. |
| **12(3)(b)** "the reference database against which input data has been checked by the system" | `tool` name and `input_hash` of the lookup call; the raw query in the off-chain evidence. | Only if the lookup goes through a logged tool. |
| **12(3)(c)** "the input data for which the search has led to a match" | `output_hash` of that call on chain; the result itself in the off-chain evidence. | Only as complete as what the tool returned. |
| **12(3)(d)** "the identification of the natural persons involved in the verification of the results, as referred to in Article 14(5)" | Not recorded by default. A reviewer's decision can be logged as a step (e.g. `action: "human.review"`) with the identity off chain and only its hash on chain. | No built-in reviewer identity: personal data must not go on chain. |
| **Art. 19(1)** and **26(6)**: logs kept "for a period appropriate to the intended purpose of the high-risk AI system, of at least six months" | The seal moves every entry of a run to 180 days; anyone can extend further (`agentlog retain --days N`); a signed export stays verifiable after expiry. | 180 days can be shorter than six calendar months: set `sealedDays` to 186 or more, or extend with `retain`. |

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
- **Privacy:** only hashes, tool names and a short public note go on chain (in strict mode, `detailsOffChain`, only salted hashes and a tool commitment; see [Details off chain](#details-off-chain)). Raw prompts, replies and tool results stay with the operator and are shown to an auditor privately; the auditor checks them against the on-chain hashes (the page does this for the demo run with its public evidence file). Do not put secrets or personal data in `note`, `agent_id` or `run_id`.

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
npm test             # 60 unit tests: hashing, verification and tamper cases, writer, custody, dispute replay, strict mode, SiteLog trust rules (no network)
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

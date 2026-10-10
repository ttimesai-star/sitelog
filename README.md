# agentlog-mcp: "Alexa, what did my agent do yesterday, and was the log changed?"

An MCP server that keeps a **tamper-evident log of what an AI agent did**, and answers that question by voice. Every step of an agent run (a tool call, a model call, an error, the end of the run) is hashed, signed by the agent's key and linked to the step before it. If anyone edits, deletes or re-signs a step afterwards, the server finds it and says **which step and how**.

- MCP spec **2025-11-25**, **Streamable HTTP** (`/mcp`), TypeScript, official SDK `@modelcontextprotocol/sdk`
- Six tools: `log_action`, `verify_run`, `audit_day`, `list_runs`, `get_run`, `diff_versions`
- An **MCP App** view (`ui://agentlog/audit-card.html`): a card with each run's chain of steps and the place where it breaks
- A **simulated Alexa+ experience**: a web page that is a real MCP client, with voice in and voice out, that shows every JSON-RPC message
- State across sessions: local SQLite file, or the public **Arkiv** network for a log the operator cannot rewrite
- Library: [`packages/agentlog`](packages/agentlog), also published as its own MIT repo [ttimesai-star/agentlog](https://github.com/ttimesai-star/agentlog)
- Agent Skill: [`skills/agentlog-audit/SKILL.md`](skills/agentlog-audit/SKILL.md)
- MIT license. Track: **Alexa+**. Mini challenge: **Open Source**.

## Run it (one command)

Requirements: Node.js 22.18 or newer (TypeScript runs from source, no build step).

```bash
npm install && npm run demo
```

Open http://localhost:8787 in Chrome or Edge (for voice input), press the microphone and say:

> "Alexa, what did my agent do yesterday, and has its log been tampered with?"

`npm run demo` writes three runs of a release-checking agent dated yesterday in your time zone (real keys, real hashes, real signatures), and turns on the demo controls. The answer:

> "Yesterday, release-checker ran 3 times, 18 logged steps in total. No log was tampered with, but 1 run never finished, so it may have stopped early."

Now press **Tamper with the log**. This plays an attacker with write access to the server's SQLite file: the afternoon run's failed health check (`503`) is rewritten to `200`, the way someone would hide why a release was blocked. The MCP server is not told. Ask again:

> "Yesterday, release-checker ran 3 times, 18 logged steps in total. Warning: one log was tampered with. In the run at 1:05 PM, "Check release v1.4.3 before deploy", step 2 cannot be trusted: its content was edited after the agent signed it. The other 2 runs are unchanged."

The card shows the chain of that run with step 2 in red. Try the other modes (re-sign the step with an intruder's key, delete it) and **Reset demo**. Other questions the page understands:

- "Check the afternoon run." → `verify_run`
- "Who is right about the afternoon release, the client or the operator?" → `diff_versions` with the client's own copy of the steps
- "Verify the release checker's run on Arkiv." → `verify_run` with `source: "arkiv"`: a real run written on 9 October 2026 to the public Arkiv testnet, read from its RPC and verified in place (needs internet)

Without the demo data: `npm start`. Tests: `npm test`. Same from the command line: `npm run seed`, `npm run tamper -- --mode forge`.

## Why

AI agents now call tools that matter: they approve releases, issue refunds, send messages, change records. What an agent did is kept in a log on the operator's server, and after an incident that log is the only evidence, held by the party with the most reason to change it. The operator, the agent itself, or whoever stole its credentials can delete a step, edit what a tool returned, or add a check that never ran.

A person who owns or pays for an agent should be able to ask, in one sentence and without opening a dashboard, what the agent did and whether that record is genuine. Voice is the right interface for that question: it is asked at home, on the way to work, from an Echo Show in the kitchen. Alexa+ talks to services through MCP, so the log is an MCP server.

## How it works

```
agent ──log_action──▶ ┌────────────── agentlog-mcp ──────────────┐ ◀──audit_day── Alexa+ (or the web simulator)
                      │ Recorder: hash in/out, sign, link, append │
                      │ Verifier: recompute, recover, follow links│
                      └──────┬──────────────────────────┬─────────┘
                       local SQLite file          Arkiv (public, readonly entities)
```

One entry is one action of the agent:

```json
{ "v": 1, "agent_id": "release-checker", "run_id": "run-afternoon-v1.4.3-20261009", "step": 2,
  "action": "tool.call", "tool": "http_get", "note": "GET staging health -> 503",
  "input_hash": "0x…", "output_hash": "0x…", "prev_entry_hash": "0x…",
  "timestamp": 1791972330000, "signer": "0x…", "entry_hash": "0x…", "sig": "0x…" }
```

- `input_hash` and `output_hash`: SHA-256 of the canonical JSON (sorted keys) of the call's arguments and result. The raw data stays on the server as private evidence.
- `prev_entry_hash`: the previous step's `entry_hash`. Removing, reordering or editing a step breaks the links after it.
- `entry_hash`: SHA-256 of all fields above; `sig`: the agent key's EIP-191 signature of `agentlog:v1:<entry_hash>`.
- `run.end` seals the run and commits to the step count and the head hash, so a cut-off run shows as **open**, never as complete.

Verification (the same code in Node, in a browser and offline) recomputes every hash, recovers every signature, checks it against the wallet expected for that agent, and follows the links from step 0. It reports the first break and its kind: `edited`, `deleted`, `forked`, `foreign_signer`, `bad_signature`, `relinked`, `after_seal`. The spoken answer and the card are built from that result, never from a flag stored next to the data.

### Tools

| Tool | What it does | Read-only |
|---|---|---|
| `log_action` | Append one signed step to a run. Starts the run automatically; omit `run_id` to start a new one. `action: "run.end"` seals it. | no |
| `audit_day` | "What did my agent do yesterday (or on a date), and was the log changed?" Lists that day's runs in the user's time zone, verifies each, returns a spoken summary that leads with the verdict, and the card. | yes |
| `verify_run` | Verdict of one run (`intact`, `open`, `broken`) and the first step that cannot be trusted. Card. | yes |
| `list_runs` | Runs of an agent, optionally of one day. | yes |
| `get_run` | The run as an `agentlog-export/v1` bundle anyone can re-verify offline; with `include_raw`, the private evidence. | yes |
| `diff_versions` | Two parties disagree about what the agent did. Checks each party's raw version against what the agent signed; a verdict per disputed step: `operator`, `client`, `both`, `neither`, `no_anchor`. | yes |

Also: resource template `agentlog://{source}/{agent_id}/{run_id}` (the export bundle), prompt `daily_audit`, server `instructions` that tell a model never to call a log intact unless a tool said so.

### MCP App: the audit card

`audit_day` and `verify_run` declare `_meta.ui.resourceUri = "ui://agentlog/audit-card.html"`. The resource (`text/html;profile=mcp-app`) is a self-contained view with no network access. A host that supports MCP Apps renders it in a sandboxed frame and passes it the tool result over `postMessage` (`ui/initialize`, `ui/notifications/tool-input`, `ui/notifications/tool-result`, `ui/notifications/size-changed`). The web simulator is such a host: it reads the resource over MCP, frames it with `sandbox="allow-scripts"` behind a sandbox page whose CSP forbids any network request, and logs every `postMessage` in the wire panel.

### The simulated Alexa+ experience

Alexa+ developer tooling (MCP Toolkit, CLI, Web Simulator) is in preview for selected partners, so a self-hosted MCP server cannot be connected to a real Alexa+ device. The page at `/` simulates the experience and is a real MCP client:

- `initialize` (protocol `2025-11-25`, declaring the MCP Apps UI extension) → `notifications/initialized` → `tools/list` → `tools/call` → `resources/read`, over Streamable HTTP with the `Mcp-Session-Id` and `MCP-Protocol-Version` headers, SSE responses parsed by hand. No SDK on the page, so every byte on the wire is the page's own and is shown in the **MCP wire** panel.
- Voice in: Web Speech API (`SpeechRecognition`, Chrome and Edge). Voice out: `speechSynthesis`. Typing works everywhere.
- Alexa+ chooses tools with its own model. On this page a small, visible intent router stands in for it: the chosen tool and arguments are shown under **Tool plan**. Any MCP client with a model (Claude, VS Code, the MCP Inspector) can call the same server directly.

### Where the log lives

| | Local (default) | Arkiv |
|---|---|---|
| Storage | SQLite file in `.agentlog-mcp/` (Node's built-in `node:sqlite`) | one readonly entity per step on the Arkiv network ([schema](https://github.com/ttimesai-star/sitelog/blob/main/arkiv/schema.md#agent-action-log)) |
| Keys | one key per agent, created on first use in `.agentlog-mcp/agent-keys.json` (git-ignored) | `AGENTLOG_PRIVATE_KEY`, a funded Tiramisu test key |
| Catches | any edit, deletion, reordering or insertion by someone without the agent's key | the same, and also an operator who holds the key: entities are readonly, `$creator` is set by the chain, an optional custodian owns the entries |
| Does not catch | whoever holds both the key and the file rewriting the whole run consistently | an agent that lies at the moment it writes |

Reading from Arkiv needs no key: `verify_run` with `source: "arkiv"` checks runs written by anyone, against the wallet expected for the agent (`AGENTLOG_ARKIV_SIGNERS=agent=0xwallet`). To write there: `AGENTLOG_WRITE=arkiv AGENTLOG_PRIVATE_KEY=0x… npm start` (raw evidence then stays in the local file).

## Use it from an agent or an MCP client

Any MCP client that speaks Streamable HTTP: URL `http://localhost:8787/mcp`. For clients that launch servers themselves: `node --conditions=agentlog-source src/main.ts --stdio`.

An agent logs as it works:

```jsonc
// tools/call log_action
{ "agent_id": "release-checker", "action": "run.start", "note": "Check release v1.4.4" }      // → run_id
{ "agent_id": "release-checker", "run_id": "…", "action": "tool.call", "tool": "http_get",
  "input": { "url": "https://staging.example/health" }, "output": { "status": 200 } }
{ "agent_id": "release-checker", "run_id": "…", "action": "run.end", "output": { "result": "approved" } }
```

The [Agent Skill](skills/agentlog-audit/SKILL.md) tells a model when and how to do this. Agents written in TypeScript can use the library directly instead of MCP ([`packages/agentlog`](packages/agentlog)).

## Security

- Listens on `127.0.0.1` by default; DNS-rebinding protection (allowed `Host` and `Origin` headers) on `/mcp`.
- `AGENTLOG_TOKEN` requires a bearer token on `/mcp`; the server warns if it listens beyond loopback without one.
- Stateful sessions (`Mcp-Session-Id`); requests without a valid session are refused; 1 MB body limit; input ids validated.
- The MCP App view runs in a sandboxed frame (opaque origin) under a CSP that blocks every network request.
- `/demo/*` exists only with `--demo`, accepts same-origin requests only, and only touches the demo agent's rows.
- Raw inputs and outputs never enter the chain; do not put secrets or personal data in `note`, `agent_id` or `run_id`.

## Configuration

| Variable | Default | |
|---|---|---|
| `PORT`, `HOST` | `8787`, `127.0.0.1` | |
| `AGENTLOG_DATA` | `./.agentlog-mcp` | SQLite file and local agent keys |
| `AGENTLOG_TZ` | system time zone | for "yesterday" when the client passes no `tz` |
| `AGENTLOG_TOKEN` | none | bearer token for `/mcp` |
| `AGENTLOG_ALLOWED_HOSTS` | none | extra `Host` values (proxy, LAN) |
| `AGENTLOG_ARKIV` | on | `off`: no Arkiv source |
| `AGENTLOG_ARKIV_SIGNERS` | the SiteLog demo agent | `agent=0xwallet,…` |
| `AGENTLOG_WRITE`, `AGENTLOG_PRIVATE_KEY` | `local` | `arkiv` to write on chain |

## Tests

`npm test` runs 65 tests: the library (hashing, signatures, gaps, forks, foreign signers, seals, export, dispute replay, salted commitments, SQLite persistence and tampering) and the server end to end, where the SDK's own MCP client talks Streamable HTTP to it: protocol negotiation, the six tools and the MCP App resource, a run logged step by step, the voice question before and after an attacker edits the SQLite file, a re-signed and a deleted step, a dispute, an offline-verifiable export, state across a server restart, refused requests (no session, foreign `Origin` or `Host`, bad ids) and static paths that try to leave `web/`. CI runs them on Node 22.18 and 24 and smoke-tests the HTTP endpoint.

## Built during the hackathon

Everything in this repository was written from 10 October 2026, inside the submission period. It builds on the agentlog SDK (hash chain, signatures, verifier, Arkiv writer, dispute replay), which I wrote on 9 October 2026 for the SiteLog project ([ttimesai-star/sitelog](https://github.com/ttimesai-star/sitelog)), also inside the submission period. New here: the MCP server and its six tools, the storage layer (store interface, SQLite and memory stores, store-agnostic recorder, Arkiv store), plain-language explanations of a broken log, day audits with time zones, the MCP App card, the web simulator, the Agent Skill, the demo attacker, and the tests above. Product feedback and friction log: [`docs/`](docs/).

## License

MIT, see [LICENSE](LICENSE).

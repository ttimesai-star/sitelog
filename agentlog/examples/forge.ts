#!/usr/bin/env node
// Attack demo: a wallet that is not the agent tries to rewrite an agent's history on Arkiv.
//   AGENTLOG_PRIVATE_KEY=<attacker key> node agentlog/examples/forge.ts --agent release-checker --run RUN --signer 0xAGENT
// It writes two records into the run:
//   1. a fabricated "tool.call" claiming the checks passed, correctly hashed and signed, by the attacker;
//   2. a byte-for-byte replay of one of the agent's genuine entries (its signature is valid!).
// Both land on chain, because Arkiv lets anyone write. Both are shown as forged and ignored, because
// their $creator is not the agent wallet. The agent's chain stays intact.

import { createPublicClient, createWalletClient } from "@arkiv-network/sdk"
import { tiramisu } from "@arkiv-network/sdk/chains"
import { http } from "viem"
import type { Hex } from "viem"
import { privateKeyToAccount } from "viem/accounts"
import { buildEntry, entryParams, hashValue, loadRun } from "../src/index.ts"

const arg = (n: string) => {
  const i = process.argv.indexOf(`--${n}`)
  if (i < 0 || !process.argv[i + 1]) throw new Error(`--${n} is required`)
  return process.argv[i + 1]
}
const agentId = arg("agent")
const runId = arg("run")
const signer = arg("signer")
const attacker = privateKeyToAccount(process.env.AGENTLOG_PRIVATE_KEY as Hex)
const pub = createPublicClient({ chain: tiramisu, transport: http(undefined, { retryCount: 1 }) })
const wallet = createWalletClient({ chain: tiramisu, transport: http(), account: attacker })

const run = await loadRun(pub, { agentId, runId, signer })
if (run.entries.length < 3) throw new Error("run not found or too short")
const target = run.entries[2].entry

// 1. Fabricated step: same step number and prev link as the genuine step 2, different output.
const fake = await buildEntry(
  { agent_id: agentId, run_id: runId, step: target.step, action: target.action, tool: target.tool, input_hash: target.input_hash, output_hash: await hashValue({ status: 200, verdict: "all checks passed" }), prev_entry_hash: target.prev_entry_hash, note: "FORGED: all checks passed, approved for release" },
  attacker,
)
// 2. Replay: a genuine entry, copied as is. The agent's signature verifies; $creator gives it away.
const replay = run.entries[1].entry

const r = await wallet.executeBatch({ creates: [entryParams(fake), entryParams(replay)] })
console.log(`attacker ${attacker.address} wrote ${r.createdEntities.length} records into ${runId}\n  tx ${r.txHash}\n  ${r.createdEntities.join("\n  ")}`)

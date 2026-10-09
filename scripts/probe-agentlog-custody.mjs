#!/usr/bin/env node
// Checks the custody rules of an agentlog run on Tiramisu (results in arkiv/friction.md, T9):
// who owns each entry, how long it lives, and whether the agent can still delete or patch its own entry
// after ownership moved to the custodian in the creating transaction. Nothing is deleted: the attempts
// are rejected at gas estimation, which costs nothing.
//
//   AGENTLOG_PRIVATE_KEY=<agent key> node scripts/probe-agentlog-custody.mjs --run RUN --signer 0xAGENT

import { createPublicClient, createWalletClient } from "@arkiv-network/sdk"
import { tiramisu } from "@arkiv-network/sdk/chains"
import { jsonToPayload } from "@arkiv-network/sdk/utils"
import { http } from "viem"
import { privateKeyToAccount } from "viem/accounts"
import { loadRun } from "../agentlog/src/index.ts"

const arg = (n) => (process.argv.includes(`--${n}`) ? process.argv[process.argv.indexOf(`--${n}`) + 1] : undefined)
const pub = createPublicClient({ chain: tiramisu, transport: http(undefined, { retryCount: 1 }) })
const agent = privateKeyToAccount(process.env.AGENTLOG_PRIVATE_KEY)
const wallet = createWalletClient({ chain: tiramisu, transport: http(), account: agent })

const run = await loadRun(pub, { agentId: arg("agent") || "release-checker", runId: arg("run"), signer: arg("signer") })
const head = await pub.getBlockNumber()
for (const x of run.entries) {
  const e = await pub.getEntity(x.entity_key)
  console.log(`step ${x.entry.step} ${x.entry.action.padEnd(9)} creator ${e.creator} owner ${e.owner} days left ${((Number(e.expiresAt - head) * 2) / 86400).toFixed(1)} readonly ${e.creationFlags?.readonly} anyoneExtends ${e.creationFlags?.permissionlessExtension}`)
}
const target = run.entries[2].entity_key
for (const [label, fn] of [
  ["agent deletes its own step 2", () => wallet.deleteEntity({ entityKey: target })],
  ["agent patches its own step 2", () => wallet.patchEntity({ entityKey: target, payload: jsonToPayload({ edited: true }), contentType: "application/json" })],
]) {
  try {
    const r = await fn()
    console.log(`${label}: ACCEPTED (tx ${r.txHash})`)
  } catch (e) {
    console.log(`${label}: rejected: ${(e.shortMessage || e.message).split("\n")[0].slice(0, 200)}`)
  }
}

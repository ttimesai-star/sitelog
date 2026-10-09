#!/usr/bin/env node
// Seeds a second synthetic project, "load-1", big enough to exercise cursor pagination:
// a roster, N remarks written by the inspector in atomic batches, fix claims on some of them
// and closures on others. All text is generated demo data.
//
//   SITELOG_WALLETS_FILE=wallets.json node scripts/seed-load.mjs [--count 160] [--batch 40]
// Then open the app with ?project=load-1

import { createPublicClient, createWalletClient } from "@arkiv-network/sdk"
import { tiramisu } from "@arkiv-network/sdk/chains"
import { readFileSync } from "node:fs"
import { http } from "viem"
import { privateKeyToAccount } from "viem/accounts"
import { DEMO_CLIENT, EXPLORER, closeBatch, fixBatch, remarkParams, rolesParams } from "../src/lib/sitelog.js"

const arg = (n, d) => {
  const i = process.argv.indexOf(`--${n}`)
  return i > 0 ? Number(process.argv[i + 1]) : d
}
const COUNT = arg("count", 160)
const BATCH = arg("batch", 40)
const project = "load-1"

const W = JSON.parse(readFileSync(process.env.SITELOG_WALLETS_FILE, "utf8")).wallets
const pub = createPublicClient({ chain: tiramisu, transport: http() })
const acct = (r) => privateKeyToAccount(W[r].privateKey)
const wc = (r) => createWalletClient({ chain: tiramisu, transport: http(), account: acct(r) })
const bal = async (r) => (Number(await pub.getBalance({ address: acct(r).address })) / 1e18).toFixed(6)
if (acct("client").address.toLowerCase() !== DEMO_CLIENT.toLowerCase()) throw new Error("client wallet != DEMO_CLIENT")

const sections = ["formwork", "concrete", "rebar", "masonry", "waterproofing", "facade", "roofing", "electrical"]
const issues = [
  "Spacer blocks missing on the bottom rebar layer",
  "Surface cracks wider than allowed after curing",
  "Mortar joints not filled on two courses",
  "Membrane overlap shorter than specified",
  "Anchor spacing does not match the facade drawing",
  "Cable tray support missing at the corridor bend",
  "Formwork joint leaking cement paste",
  "Insulation boards not staggered at the corner",
]

console.log(`balances before: inspector ${await bal("inspector")}, contractor ${await bal("contractor")}, client ${await bal("client")}`)

const roles = await wc("client").createEntity(
  rolesParams({ project, title: "Load-1 synthetic pagination test, 2 blocks", inspectors: [acct("inspector").address], contractors: [acct("contractor").address] }),
)
console.log(`roster ${roles.entityKey} ${EXPLORER}/tx/${roles.txHash}`)

const keys = []
for (let start = 0; start < COUNT; start += BATCH) {
  const creates = []
  for (let i = start; i < Math.min(COUNT, start + BATCH); i++) {
    const n = i + 1
    creates.push(
      remarkParams({
        project,
        severity: (i % 5) + 1,
        section: sections[i % sections.length],
        location: `Block ${n % 2 ? "A" : "B"}, floor ${(i % 9) + 1}, grid ${(i % 12) + 1}/${String.fromCharCode(65 + (i % 6))}`,
        text: `#${n}. ${issues[i % issues.length]} (synthetic load-test remark).`,
      }),
    )
  }
  const r = await wc("inspector").executeBatch({ creates })
  keys.push(...r.createdEntities)
  console.log(`remarks ${start + 1}..${start + creates.length}: ${r.createdEntities.length} created ${EXPLORER}/tx/${r.txHash}`)
}

// Fix claims on every 6th remark, in one batch (each also renews its remark's lease).
const head = await pub.getBlockNumber()
const fixTargets = keys.filter((_, i) => i % 6 === 1)
const fb = { creates: [], extensions: [] }
for (const k of fixTargets) {
  const b = fixBatch({ project, remarkKey: k, text: "Fixed on site; ready for re-inspection (synthetic).", headBlock: head })
  fb.creates.push(...b.creates)
  fb.extensions.push(...(b.extensions || []))
}
if (fb.extensions.length === 0) delete fb.extensions
const fr = await wc("contractor").executeBatch(fb)
console.log(`fix claims: ${fr.createdEntities.length} ${EXPLORER}/tx/${fr.txHash}`)

// Closures on every 6th remark (another subset), in one batch.
const closeTargets = keys.filter((_, i) => i % 6 === 3)
const cb = { creates: [], extensions: [] }
for (const k of closeTargets) {
  const b = closeBatch({ project, remarkKey: k, text: "Accepted on re-inspection (synthetic)." })
  cb.creates.push(...b.creates)
  cb.extensions.push(...b.extensions)
}
const cr = await wc("inspector").executeBatch(cb)
console.log(`closures: ${cr.createdEntities.length} ${EXPLORER}/tx/${cr.txHash}`)

console.log(`balances after: inspector ${await bal("inspector")}, contractor ${await bal("contractor")}, client ${await bal("client")}`)
console.log(`open ?project=${project}`)

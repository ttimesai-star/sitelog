#!/usr/bin/env node
// Seeds the synthetic "demo-1" project on Tiramisu: roster, remarks, a fix claim, a closure,
// and two forgery attempts by the contractor wallet. All text is invented demo data.
//
//   SITELOG_WALLETS_FILE=wallets.json node scripts/seed-demo.mjs
// wallets.json: {"wallets":{"client":{"privateKey":"0x.."},"inspector":{...},"contractor":{...}}}
// The client wallet must match DEMO_CLIENT in src/lib/sitelog.js.

import { createPublicClient, createWalletClient } from "@arkiv-network/sdk"
import { tiramisu } from "@arkiv-network/sdk/chains"
import { readFileSync } from "node:fs"
import { http, parseEther } from "viem"
import { privateKeyToAccount } from "viem/accounts"
import { DEMO_CLIENT, DEMO_PROJECT, EXPLORER, closeBatch, fixBatch, remarkParams, rolesParams } from "../src/lib/sitelog.js"

const W = JSON.parse(readFileSync(process.env.SITELOG_WALLETS_FILE, "utf8")).wallets
const pub = createPublicClient({ chain: tiramisu, transport: http() })
const acct = (r) => privateKeyToAccount(W[r].privateKey)
const wc = (r) => createWalletClient({ chain: tiramisu, transport: http(), account: acct(r) })
const project = DEMO_PROJECT
const log = (s, r) => console.log(s, r?.txHash ? `${EXPLORER}/tx/${r.txHash}` : "")

if (acct("client").address.toLowerCase() !== DEMO_CLIENT.toLowerCase()) throw new Error("client wallet != DEMO_CLIENT")

// 0. Spread test GLM from the funded wallet (FUNDER=inspector by default) to the others.
const funder = process.env.FUNDER || "inspector"
for (const r of ["client", "inspector", "contractor"]) {
  if (r === funder) continue
  const bal = await pub.getBalance({ address: acct(r).address })
  if (bal < parseEther("0.5")) {
    const tx = await wc(funder).sendTransaction({ to: acct(r).address, value: parseEther("2") })
    await pub.waitForTransactionReceipt({ hash: tx })
    log(`funded ${r}`, { txHash: tx })
  }
}

// 1. The client publishes the roster.
const roles = await wc("client").createEntity(
  rolesParams({ project, title: "Demo-1 residential block, frame stage (synthetic)", inspectors: [acct("inspector").address], contractors: [acct("contractor").address] }),
)
log(`roster ${roles.entityKey}`, roles)

// 2. The inspector records remarks (readonly, permissionless extension).
const remarks = [
  { severity: 5, section: "formwork", location: "Block A, floor 4, slab P-4", text: "Slab formwork props spaced wider than the formwork design; concreting not allowed until fixed.", normRef: "formwork design sheet FW-4 (synthetic)" },
  { severity: 4, section: "concrete", location: "Block A, floor 3, column C-12", text: "Honeycombing at the base of the column, rebar visible over about 20 cm.", normRef: "project spec section 3.2 (synthetic)" },
  { severity: 3, section: "rebar", location: "Block A, floor 4, beam B-7", text: "Cover spacers missing on the bottom layer over 2 m.", normRef: "drawing KZh-7 note 5 (synthetic)" },
  { severity: 2, section: "masonry", location: "Block A, floor 2, wall W-3", text: "Mortar joints not filled on two courses near the window opening.", normRef: "" },
]
const keys = []
for (const r of remarks) {
  const res = await wc("inspector").createEntity(remarkParams({ project, ...r }))
  keys.push(res.entityKey)
  log(`remark sev${r.severity} ${res.entityKey}`, res)
}

// 3. The contractor claims a fix on the column (batch: fix record + remark lease renewal).
const head = await pub.getBlockNumber()
const rem1 = await pub.getEntity(keys[1])
const fix = await wc("contractor").executeBatch(
  fixBatch({ project, remarkKey: keys[1], text: "Column base repaired with repair mortar; ready for re-inspection.", remarkExpiresAtBlock: rem1.expiresAt, headBlock: head }),
)
log(`fix claim ${fix.createdEntities[0]}`, fix)

// 4. The inspector closes the rebar remark (batch: closure + remark extended to 365 days).
const close = await wc("inspector").executeBatch(closeBatch({ project, remarkKey: keys[2], text: "Spacers installed and checked before concreting." }))
log(`closure ${close.createdEntities[0]}`, close)

// 5. Forgery attempts by the contractor wallet: both are public, neither is trusted.
const forgedRemark = await wc("contractor").createEntity(
  remarkParams({ project, severity: 1, section: "general", text: "All inspection remarks on Block A resolved. Signed: site inspector.", location: "" }),
)
log(`forged remark ${forgedRemark.entityKey}`, forgedRemark)
const forgedClose = await wc("contractor").executeBatch(closeBatch({ project, remarkKey: keys[0], text: "Props fixed (closed by contractor)." }))
log(`forged closure ${forgedClose.createdEntities[0]}`, forgedClose)

// 6. The contractor tries to delete the stop-work remark. It is not the owner, so the chain refuses.
try {
  await wc("contractor").deleteEntity({ entityKey: keys[0] })
  console.log("UNEXPECTED: contractor deleted a remark")
} catch (e) {
  console.log("contractor delete refused as expected:", (e.shortMessage || e.message).split("\n")[0])
}

console.log("\nremark keys:", keys.join(" "))

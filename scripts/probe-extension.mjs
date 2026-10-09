#!/usr/bin/env node
// Checks the lease rules SiteLog relies on, against the live demo entities on Tiramisu:
//   1. a remark (readonly + permissionlessExtension) can be extended by a wallet that is not its owner;
//   2. nobody can shorten it: an extension that does not move the expiry later is rejected;
//   3. a closure (readonly, no permissionless flag) cannot be extended by a stranger;
//   4. a stranger cannot delete a remark.
// Rejected attempts fail during gas estimation, so they cost nothing.
//
//   SITELOG_WALLETS_FILE=wallets.json node scripts/probe-extension.mjs [--extend]
// --extend also sends one real extension (client wallet extends the sev 2 remark to 120 days).

import { createPublicClient, createWalletClient } from "@arkiv-network/sdk"
import { tiramisu } from "@arkiv-network/sdk/chains"
import { ExpirationTime } from "@arkiv-network/sdk/utils"
import { readFileSync } from "node:fs"
import { http } from "viem"
import { privateKeyToAccount } from "viem/accounts"
import { EXPLORER } from "../src/lib/sitelog.js"

const REMARK_SEV5 = "0xbc7c43e83c18c3fbc49c1cec149069d4c459c7208cc10ed7fae5ec7dc94988d3"
const REMARK_SEV2 = "0xb6a97435ed804e2d246fd1903cafa18658a762372cfae1567879765dc07d1406"
const CLOSURE = "0x1dd8b9c028cde2844b9551ba37519be2132089fe4468b2093d134f13e268c887"

const W = JSON.parse(readFileSync(process.env.SITELOG_WALLETS_FILE, "utf8")).wallets
const pub = createPublicClient({ chain: tiramisu, transport: http() })
const wc = (r) => createWalletClient({ chain: tiramisu, transport: http(), account: privateKeyToAccount(W[r].privateKey) })
const head = await pub.getBlockNumber()
const days = (e) => (Number(e.expiresAt - head) * 2 / 86400).toFixed(1)

async function attempt(label, fn) {
  try {
    const r = await fn()
    console.log(`ACCEPTED  ${label}: tx ${EXPLORER}/tx/${r.txHash}`)
  } catch (e) {
    console.log(`REJECTED  ${label}: ${(e.shortMessage || e.message).split("\n")[0]}`)
  }
}

for (const [name, k] of [["remark sev5", REMARK_SEV5], ["remark sev2", REMARK_SEV2], ["closure", CLOSURE]]) {
  const e = await pub.getEntity(k)
  console.log(`${name}: owner ${e.owner}, creator ${e.creator}, flags ${JSON.stringify(e.creationFlags)}, expires in ${days(e)} days`)
}

await attempt("contractor shortens the sev5 remark to 1 day", () => wc("contractor").extendEntity({ entityKey: REMARK_SEV5, expires: ExpirationTime.fromDays(1) }))
await attempt("contractor extends the inspector's closure (no permissionless flag)", () => wc("contractor").extendEntity({ entityKey: CLOSURE, expires: ExpirationTime.fromDays(400) }))
await attempt("contractor deletes the sev2 remark", () => wc("contractor").deleteEntity({ entityKey: REMARK_SEV2 }))
if (process.argv.includes("--extend")) {
  await attempt("client (not the owner) extends the sev2 remark to 120 days", () => wc("client").extendEntity({ entityKey: REMARK_SEV2, expires: ExpirationTime.fromDays(120) }))
  const e = await pub.getEntity(REMARK_SEV2)
  console.log(`remark sev2 now expires in ${days(e)} days`)
}

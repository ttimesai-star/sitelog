#!/usr/bin/env node
// SiteLog CLI: write and read the site journal on Arkiv (Tiramisu testnet) from a terminal.
//
//   node scripts/sitelog.mjs journal [--project demo-1] [--min 3] [--orphans]
//   node scripts/sitelog.mjs roles   --inspectors 0x..,0x.. --contractors 0x.. [--title "..."]
//   node scripts/sitelog.mjs remark  --severity 4 --section concrete --text "..." [--photo file.jpg]
//   node scripts/sitelog.mjs fix     --remark 0xKEY --text "..." [--photo file.jpg]
//   node scripts/sitelog.mjs close   --remark 0xKEY [--fix 0xKEY] --text "..."
//   node scripts/sitelog.mjs keepalive --remark 0xKEY --days 120
//   node scripts/sitelog.mjs whoami
//
// Signing key: env SITELOG_PRIVATE_KEY (0x...). Never pass a key on the command line.
// Optional: SITELOG_WALLETS_FILE=path.json plus --as inspector|contractor|client picks a key from a
// local JSON file of synthetic test wallets ({"wallets":{"inspector":{"privateKey":"0x.."}}}).

import { createPublicClient, createWalletClient } from "@arkiv-network/sdk"
import { tiramisu } from "@arkiv-network/sdk/chains"
import { ExpirationTime } from "@arkiv-network/sdk/utils"
import { readFileSync } from "node:fs"
import { createHash } from "node:crypto"
import { http } from "viem"
import { privateKeyToAccount } from "viem/accounts"
import {
  DEMO_CLIENT, DEMO_PROJECT, EXPLORER, SEVERITY, attrValue, blocksToDate, closeBatch, creatorRole, fixBatch, loadJournal, loadOrphans,
  payloadJson, remarkParams, rolesParams,
} from "../src/lib/sitelog.js"

const [cmd, ...rest] = process.argv.slice(2)
const opt = {}
for (let i = 0; i < rest.length; i++) {
  if (rest[i].startsWith("--")) opt[rest[i].slice(2)] = rest[i + 1] && !rest[i + 1].startsWith("--") ? rest[++i] : true
}
const project = opt.project || DEMO_PROJECT
const trustRoot = opt["trust-root"] || DEMO_CLIENT

const pub = createPublicClient({ chain: tiramisu, transport: http() })

function account() {
  let k = process.env.SITELOG_PRIVATE_KEY
  if (!k && process.env.SITELOG_WALLETS_FILE && opt.as) {
    k = JSON.parse(readFileSync(process.env.SITELOG_WALLETS_FILE, "utf8")).wallets?.[opt.as]?.privateKey
  }
  if (!k) throw new Error("set SITELOG_PRIVATE_KEY (or SITELOG_WALLETS_FILE + --as ROLE)")
  return privateKeyToAccount(k)
}
const wallet = () => createWalletClient({ chain: tiramisu, transport: http(), account: account() })
const photoHash = (p) => (p ? createHash("sha256").update(readFileSync(p)).digest("hex") : "")
const need = (...names) => names.forEach((n) => { if (!opt[n]) throw new Error(`--${n} is required`) })
const show = (label, r) => console.log(`${label}\n  tx: ${EXPLORER}/tx/${r.txHash}`)

async function main() {
  switch (cmd) {
    case "whoami": {
      const a = account()
      const bal = await pub.getBalance({ address: a.address })
      console.log(a.address, `${Number(bal) / 1e18} GLM`)
      break
    }
    case "roles": {
      need("inspectors")
      const split = (s) => (s && s !== true ? String(s).split(",").map((x) => x.trim()).filter(Boolean) : [])
      const r = await wallet().createEntity(rolesParams({ project, title: opt.title || "Demo-1 residential block (synthetic)", inspectors: split(opt.inspectors), contractors: split(opt.contractors) }))
      show(`roles entity ${r.entityKey}`, r)
      break
    }
    case "remark": {
      need("severity", "text")
      const r = await wallet().createEntity(remarkParams({ project, severity: Number(opt.severity), section: opt.section, text: opt.text, location: opt.location, normRef: opt.norm, photoSha256: photoHash(opt.photo) }))
      show(`remark ${r.entityKey}`, r)
      break
    }
    case "fix": {
      need("remark", "text")
      const head = await pub.getBlockNumber()
      const rem = await pub.getEntity(opt.remark)
      const r = await wallet().executeBatch(fixBatch({ project, remarkKey: opt.remark, text: opt.text, photoSha256: photoHash(opt.photo), remarkExpiresAtBlock: rem.expiresAt, headBlock: head }))
      show(`fix ${r.createdEntities[0]} (remark lease renewed: ${r.extendedEntities.length > 0})`, r)
      break
    }
    case "close": {
      need("remark", "text")
      const r = await wallet().executeBatch(closeBatch({ project, remarkKey: opt.remark, fixKey: opt.fix, text: opt.text }))
      show(`closure ${r.createdEntities[0]}; remark extended in the same batch`, r)
      break
    }
    case "keepalive": {
      // Works for any funded wallet thanks to the permissionlessExtension flag on remarks.
      need("remark")
      const r = await wallet().extendEntity({ entityKey: opt.remark, expires: ExpirationTime.fromDays(Number(opt.days || 120)) })
      show(`remark ${opt.remark} now expires at block ${r.expiresAt}`, r)
      break
    }
    case "journal": {
      const head = await pub.getBlockNumber()
      const j = await loadJournal(pub, { project, trustRoot, minSeverity: Number(opt.min || 1) })
      if (!j.roles) return console.log(`no roles entity created by ${trustRoot} for project ${project}`)
      console.log(`${j.roles.title}\n  inspectors: ${j.roles.inspectors.join(", ")}\n  contractors: ${j.roles.contractors.join(", ")}\n`)
      for (const r of j.remarks) {
        const p = payloadJson(r.entity)
        const sev = attrValue(r.entity, "severity")
        console.log(`[${r.status}] sev ${sev} ${SEVERITY[sev]} | ${attrValue(r.entity, "section")} | ${p.text}`)
        console.log(`   key ${r.entity.key} by ${r.entity.creator} (verified inspector), expires ~${blocksToDate(r.entity.expiresAt, head).toISOString().slice(0, 10)}`)
        for (const f of r.fixes) console.log(`   fix claim by ${f.creator} (${creatorRole(j.roles, f.creator)}): ${payloadJson(f).text}`)
        if (r.closure) console.log(`   closed by ${r.closure.creator}: ${payloadJson(r.closure).text}`)
        for (const c of r.fakeClosures) console.log(`   IGNORED closure by ${c.creator} (${creatorRole(j.roles, c.creator)}): not an inspector`)
      }
      for (const f of j.forged) console.log(`UNVERIFIED remark ${f.key} by ${f.creator} (${creatorRole(j.roles, f.creator)}): ${payloadJson(f).text}`)
      if (opt.orphans) {
        const known = [...j.remarks.map((r) => r.entity.key), ...j.forged.map((f) => f.key)]
        const orphans = await loadOrphans(pub, { project, known, atBlock: j.atBlock })
        console.log(`
${orphans.length} fix claims or closures point at a remark that no longer exists (expired or deleted)`)
        for (const o of orphans) console.log(`  ORPHAN ${attrValue(o, "kind")} ${o.key} by ${o.creator} -> remark ${attrValue(o, "remark")}: ${payloadJson(o).text}`)
      }
      break
    }
    default:
      console.log(readFileSync(new URL(import.meta.url), "utf8").split("\n").slice(1, 15).join("\n"))
  }
}

main().catch((e) => {
  console.error("error:", e.shortMessage || e.message)
  process.exit(1)
})

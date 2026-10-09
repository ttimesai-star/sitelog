#!/usr/bin/env node
// agentlog CLI: write and verify an AI agent's action log on Arkiv (Tiramisu testnet).
// Runs from source with Node.js 22.18+ (built-in TypeScript type stripping): node agentlog/cli.ts ...
//
//   agentlog start  --agent ID --run ID [--input JSON] [--note TEXT]
//   agentlog step   --agent ID --run ID --tool NAME [--action tool.call] [--input JSON | --input-file F] [--output JSON | --output-file F] [--note TEXT]
//   agentlog seal   --agent ID --run ID [--output JSON]
//   agentlog runs   --agent ID --signer 0x..                      list runs of an agent wallet
//   agentlog verify --agent ID --run ID --signer 0x.. [--out run.json]   read from Arkiv, verify, export
//   agentlog verify-file run.json                                verify an export offline (no network)
//   agentlog retain --agent ID --run ID --signer 0x.. --days 365 keep a run alive (any funded wallet)
//   agentlog hash   [--json JSON | --file F]                     the hash agentlog would store for a value
//
// Writes need a funded Tiramisu key in env AGENTLOG_PRIVATE_KEY (never on the command line).
// start/step/seal keep the run's head in .agentlog/<agent>__<run>.json, so separate processes
// (for example one per tool call from a shell-based agent) extend the same hash chain.

import { createPublicClient, createWalletClient } from "@arkiv-network/sdk"
import { tiramisu } from "@arkiv-network/sdk/chains"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { http } from "viem"
import type { Hex } from "viem"
import { privateKeyToAccount } from "viem/accounts"
import { AgentLog, exportBundle, hashValue, listRuns, loadRun, resumeState, retainRun, verifyExport } from "./src/index.ts"
import type { Landed, RunReport } from "./src/index.ts"

const EXPLORER = "https://tiramisu.explorer.arkiv.network"
const [cmd, ...rest] = process.argv.slice(2)
const opt: Record<string, string> = {}
const pos: string[] = []
for (let i = 0; i < rest.length; i++) {
  if (rest[i].startsWith("--")) opt[rest[i].slice(2)] = rest[i + 1] !== undefined && !rest[i + 1].startsWith("--") ? rest[++i] : "true"
  else pos.push(rest[i])
}
const need = (...names: string[]) => names.forEach((n) => { if (!opt[n]) throw new Error(`--${n} is required`) })
const pub = createPublicClient({ chain: tiramisu, transport: http(undefined, { retryCount: 1 }) })

function account() {
  const k = process.env.AGENTLOG_PRIVATE_KEY
  if (!k) throw new Error("set AGENTLOG_PRIVATE_KEY (a funded Tiramisu test key, 0x...)")
  return privateKeyToAccount(k as Hex)
}

// A value is hashed as JSON when it parses as JSON, otherwise as a plain string (file content included).
const parseJson = (s: string | undefined, file: string | undefined): unknown => {
  if (file) s = readFileSync(file, "utf8")
  if (s === undefined) return null
  try {
    return JSON.parse(s)
  } catch {
    return s // a plain string is a valid input too
  }
}

const stateFile = (agent: string, run: string) => join(process.env.AGENTLOG_STATE_DIR || ".agentlog", `${agent}__${run}.json`)
function loadState(agent: string, run: string): Landed[] {
  const f = stateFile(agent, run)
  return existsSync(f) ? JSON.parse(readFileSync(f, "utf8")).entries : []
}
function saveState(agent: string, run: string, entries: Landed[]) {
  const f = stateFile(agent, run)
  mkdirSync(join(f, ".."), { recursive: true })
  writeFileSync(f, JSON.stringify({ format: "agentlog-evidence/v1", agent_id: agent, run_id: run, entries }, null, 1))
}

function logFor(agent: string, run: string) {
  const prior = loadState(agent, run)
  const r = resumeState(prior.map((l) => l.entry))
  if (r.sealed) throw new Error(`run ${run} is already sealed`)
  const acct = account()
  const wallet = createWalletClient({ chain: tiramisu, transport: http(), account: acct })
  const log = new AgentLog({ wallet, account: acct, agentId: agent, runId: run, resume: { step: r.step, prev: r.prev } })
  return { log, prior }
}

function printLanded(l: Landed) {
  console.log(`step ${l.entry.step} ${l.entry.action}${l.entry.tool ? " " + l.entry.tool : ""}\n  entry_hash ${l.entry.entry_hash}\n  entity ${l.entity_key}\n  tx ${EXPLORER}/tx/${l.tx}`)
}

function printReport(r: RunReport, foreign = 0) {
  const mark = r.verdict === "intact" ? "INTACT" : r.verdict === "open" ? "OPEN (intact so far, not sealed)" : r.verdict.toUpperCase()
  console.log(`${mark}: ${r.steps} steps, signer ${r.signer}, head ${r.head}`)
  for (const c of r.checks) console.log(`  ${c.ok ? "ok " : "BAD"} step ${c.step} ${c.entry_hash.slice(0, 18)}…${c.problems.length ? " " + c.problems.join("; ") : ""}`)
  for (const p of r.problems) console.log(`  ! ${p}`)
  if (foreign) console.log(`  ${foreign} record(s) claim this run but were created by another wallet: ignored (forged)`)
}

async function main() {
  switch (cmd) {
    case "start":
    case "step":
    case "seal": {
      need("agent", "run")
      if (cmd === "step") need("tool")
      const { log, prior } = logFor(opt.agent, opt.run)
      if (cmd === "start" && prior.length) throw new Error(`run ${opt.run} already started (${stateFile(opt.agent, opt.run)})`)
      if (cmd !== "start" && !prior.length) throw new Error(`run ${opt.run} has no start in ${stateFile(opt.agent, opt.run)}`)
      const l =
        cmd === "start"
          ? await log.start(parseJson(opt.input, opt["input-file"]), opt.note)
          : cmd === "seal"
            ? await log.seal(parseJson(opt.output, opt["output-file"]), opt.note)
            : await log.record({ action: opt.action || "tool.call", tool: opt.tool, input: parseJson(opt.input, opt["input-file"]), output: parseJson(opt.output, opt["output-file"]), note: opt.note })
      saveState(opt.agent, opt.run, [...prior, ...log.entries])
      printLanded(l)
      break
    }
    case "runs": {
      need("agent", "signer")
      const runs = await listRuns(pub, { agentId: opt.agent, signer: opt.signer as Hex })
      for (const r of runs) console.log(`${new Date(r.ts * 1000).toISOString()}  ${r.run_id}  ${r.note}`)
      if (!runs.length) console.log("no runs")
      break
    }
    case "verify": {
      need("agent", "run", "signer")
      const run = await loadRun(pub, { agentId: opt.agent, runId: opt.run, signer: opt.signer })
      printReport(run.report, run.foreign.length)
      for (const f of run.foreign) console.log(`  FORGED step ${f.entry.step} ${f.entry.action} ${f.entry.tool} by ${f.creator}: ${f.entry.note}`)
      if (opt.out) {
        writeFileSync(opt.out, JSON.stringify(exportBundle(run, { agentId: opt.agent, runId: opt.run, signer: opt.signer }), null, 1))
        console.log(`export written to ${opt.out}`)
      }
      if (run.report.verdict === "broken") process.exitCode = 2
      break
    }
    case "verify-file": {
      const file = pos[0] || opt.file
      if (!file) throw new Error("usage: agentlog verify-file run.json")
      const bundle = JSON.parse(readFileSync(file, "utf8"))
      const r = await verifyExport(bundle)
      printReport(r, bundle.foreign?.length ?? 0)
      if (r.verdict === "broken") process.exitCode = 2
      break
    }
    case "retain": {
      need("agent", "run", "signer", "days")
      const acct = account()
      const wallet = createWalletClient({ chain: tiramisu, transport: http(), account: acct })
      const run = await loadRun(pub, { agentId: opt.agent, runId: opt.run, signer: opt.signer })
      const keys = run.entries.map((x) => x.entity_key as Hex)
      const txs = await retainRun(wallet, keys, Number(opt.days))
      console.log(`${keys.length} entries extended to ${opt.days} days by ${acct.address}\n${txs.map((t) => `  ${EXPLORER}/tx/${t}`).join("\n")}`)
      break
    }
    case "hash": {
      console.log(await hashValue(parseJson(opt.json, opt.file)))
      break
    }
    default:
      console.log(readFileSync(new URL(import.meta.url), "utf8").split("\n").slice(1, 17).join("\n"))
  }
}

main().catch((e) => {
  console.error("error:", e.shortMessage || e.message)
  process.exit(1)
})


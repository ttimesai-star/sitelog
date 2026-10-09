#!/usr/bin/env node
// A real, small LLM agent whose every step is logged to Arkiv with agentlog.
//
// Task: check the public deployment of this repository (latest commit on GitHub, the live page,
// the Arkiv network) and write a short status report. The model decides which tools to call.
// Every LLM call and every tool call becomes one signed, hash-chained, readonly Arkiv entity.
//
//   AGENTLOG_PRIVATE_KEY=0x...  MISTRAL_API_KEY=...  node agentlog/examples/release-agent.ts
// Optional: AGENTLOG_CUSTODIAN=0x... hands ownership of every entry to that wallet in the same
// transaction that creates it, so the agent cannot delete its own trail afterwards.
// Writes the local evidence file (raw inputs and outputs, never sent to Arkiv) to public/demo/runs/.
//
// Any OpenAI-compatible chat API with tool calling works: set LLM_BASE_URL and LLM_MODEL.

import { createPublicClient, createWalletClient } from "@arkiv-network/sdk"
import { tiramisu } from "@arkiv-network/sdk/chains"
import { mkdirSync, writeFileSync } from "node:fs"
import { http } from "viem"
import type { Hex } from "viem"
import { privateKeyToAccount } from "viem/accounts"
import { AgentLog, hashValue } from "../src/index.ts"

const BASE = process.env.LLM_BASE_URL || "https://api.mistral.ai/v1"
const MODEL = process.env.LLM_MODEL || "mistral-small-latest"
const KEY = process.env.MISTRAL_API_KEY || process.env.LLM_API_KEY
if (!KEY) throw new Error("set MISTRAL_API_KEY (or LLM_API_KEY with LLM_BASE_URL and LLM_MODEL)")
const pk = process.env.AGENTLOG_PRIVATE_KEY as Hex
if (!pk) throw new Error("set AGENTLOG_PRIVATE_KEY")

const account = privateKeyToAccount(pk)
const pub = createPublicClient({ chain: tiramisu, transport: http(undefined, { retryCount: 1 }) })
const wallet = createWalletClient({ chain: tiramisu, transport: http(), account })
const runId = `run-${new Date().toISOString().replace(/[-:]/g, "").slice(0, 15)}`
const custodian = process.env.AGENTLOG_CUSTODIAN as Hex | undefined
const log = new AgentLog({ wallet, publicClient: pub, account, agentId: "release-checker", runId, custodian })

// ---------- tools (read-only, allow-listed hosts) ----------
const ALLOWED = new Set(["api.github.com", "ttimesai-star.github.io"])
async function httpGet(url: string) {
  const u = new URL(url)
  if (u.protocol !== "https:" || !ALLOWED.has(u.hostname)) throw new Error(`host not allowed: ${u.hostname}`)
  const res = await fetch(u, { headers: { "user-agent": "agentlog-release-checker", accept: "application/json, text/html" } })
  const body = await res.text()
  return { url, status: res.status, content_type: res.headers.get("content-type"), body_sha256: await hashValue(body), excerpt: body.slice(0, 600) }
}
async function arkivStatus() {
  const [chainId, block, entities] = await Promise.all([pub.getChainId(), pub.getBlockNumber(), pub.getEntityCount()])
  return { chain_id: chainId, block: block.toString(), entity_count: entities.toString() }
}
const tools = {
  http_get: log.wrap("http_get", httpGet, (url) => `GET ${url}`.slice(0, 200)),
  arkiv_status: log.wrap("arkiv_status", arkivStatus, () => "chain id, head block, entity count"),
}
const toolSpecs = [
  { type: "function", function: { name: "http_get", description: "HTTPS GET of a URL on api.github.com or ttimesai-star.github.io. Returns status, content type, SHA-256 of the body and the first 600 characters.", parameters: { type: "object", properties: { url: { type: "string" } }, required: ["url"] } } },
  { type: "function", function: { name: "arkiv_status", description: "Chain id, head block and entity count of the Arkiv Tiramisu testnet.", parameters: { type: "object", properties: {} } } },
]

// ---------- the agent loop ----------
const task = [
  "You are a release checker. Check the public deployment of the GitHub repository ttimesai-star/sitelog.",
  "1) Get the latest commit on main: https://api.github.com/repos/ttimesai-star/sitelog/commits/main",
  "2) Check that the live app responds: https://ttimesai-star.github.io/sitelog/",
  "3) Check that the Arkiv network is reachable.",
  "Call the tools you need, then answer with a 3-line status report: commit (short sha and message), live page (HTTP status), Arkiv (head block).",
].join("\n")

type Msg = { role: string; content: string | null; tool_calls?: any[]; tool_call_id?: string; name?: string }
const messages: Msg[] = [{ role: "user", content: task }]

async function chat(): Promise<Msg> {
  const req = { model: MODEL, messages, tools: toolSpecs, tool_choice: "auto", temperature: 0 }
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(`${BASE}/chat/completions`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${KEY}` }, body: JSON.stringify(req) })
    if (res.status === 429 && attempt < 4) {
      await new Promise((r) => setTimeout(r, 2000 * (attempt + 1)))
      continue
    }
    if (!res.ok) throw new Error(`LLM HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`)
    const out = await res.json()
    const msg = out.choices[0].message as Msg
    // The request (messages + tool specs) and the reply are hashed; the API key is never part of it.
    await log.record({ action: "llm.call", tool: MODEL, input: req, output: msg, note: msg.tool_calls?.length ? `asks for ${msg.tool_calls.map((t: any) => t.function.name).join(", ")}` : "final answer" })
    return msg
  }
}

await log.start({ task, model: MODEL, tools: toolSpecs.map((t) => t.function.name) }, "release check of ttimesai-star/sitelog")
console.log(`agent ${account.address} run ${runId}${custodian ? ` custodian ${custodian}` : ""}`)
let report = ""
for (let turn = 0; turn < 6; turn++) {
  const msg = await chat()
  messages.push({ role: "assistant", content: msg.content ?? "", tool_calls: msg.tool_calls })
  if (!msg.tool_calls?.length) {
    report = String(msg.content ?? "")
    break
  }
  for (const call of msg.tool_calls) {
    let args: any = {}
    try {
      args = JSON.parse(call.function.arguments || "{}")
    } catch {
      // Small models sometimes emit broken JSON for a no-argument tool; treat it as no arguments.
    }
    let result: unknown
    try {
      result = call.function.name === "http_get" ? await tools.http_get(String(args.url)) : call.function.name === "arkiv_status" ? await tools.arkiv_status() : { error: "unknown tool" }
    } catch (e) {
      result = { error: (e as Error).message }
    }
    messages.push({ role: "tool", name: call.function.name, tool_call_id: call.id, content: JSON.stringify(result).slice(0, 4000) })
    console.log(`  tool ${call.function.name} ${args.url ?? ""}`)
  }
}
const seal = await log.seal({ report }, "run sealed: status report written")
console.log(`\nreport:\n${report}\n\nsealed at step ${seal.entry.step}, ${log.entries.length} entries, txs ${log.txs.length}`)

mkdirSync("public/demo/runs", { recursive: true })
const file = `public/demo/runs/${runId}.evidence.json`
writeFileSync(file, JSON.stringify({ ...log.evidence(), custodian: custodian ?? null }, (_k, v) => (typeof v === "bigint" ? v.toString() : v), 1))
console.log(`evidence: ${file}`)

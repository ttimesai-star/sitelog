// Mystery shopper: buys from the cheapest well-formed x402 endpoints and records what came back.
// Hard limits (cannot be raised by flags): <= 0.05 USDC per purchase, <= 2 USDC in total across all runs
// and chains (summed from the spend log). Only scheme "exact", USDC, on one mainnet: Solana or Base.
// Every step (challenge, payment, response, on-chain receipt) is a signed AgentLog entry.
// Usage: node src/buyer.mjs [--chain solana|base] [--wallet secrets-file] [--n 1] [--max-price 0.01] [--dry-run]
import { readFile, appendFile, writeFile } from "node:fs/promises"
import { existsSync } from "node:fs"
import { createHash } from "node:crypto"
import { x402Client, x402HTTPClient } from "@x402/core/client"
import { UA, openLog } from "./lib.mjs"
import { baseChain, solanaChain } from "./chains.mjs"

const HARD_PER_OP = 0.05
const HARD_TOTAL = 2.0
const args = process.argv.slice(2)
const opt = (k, d) => (args.includes(k) ? args[args.indexOf(k) + 1] : d)
const N = Number(opt("--n", 1))
const CHAIN = opt("--chain", "solana")
const MAX_PRICE = Math.min(Number(opt("--max-price", 0.01)), HARD_PER_OP)
const DRY = args.includes("--dry-run")
const SPEND_LOG = opt("--spend-log", "../../inbox/startup/delivery_score/spend_log.csv")
const TIMEOUT = 30_000
const AGENT = "delivery-score-buyer"

if (!["solana", "base"].includes(CHAIN)) throw new Error("--chain must be solana or base")
const chain = CHAIN === "base" ? await baseChain({ walletFile: opt("--wallet", "solana_wallet_bounties.json") }) : await solanaChain({ walletFile: opt("--wallet", "delivery_score_solana.json") })
const NET = chain.network

async function spentSoFar() {
  if (!existsSync(SPEND_LOG)) return 0
  const rows = (await readFile(SPEND_LOG, "utf8")).trim().split("\n").slice(1)
  // Budget column (11th): the on-chain amount, or the signed amount when settlement could not be
  // confirmed. Rows without it fall back to amount_usdc.
  return rows.reduce((s, r) => {
    const c = r.split(",")
    return s + (Number(c[10] ?? c[5]) || 0)
  }, 0)
}
async function spendRow(o) {
  if (!existsSync(SPEND_LOG)) await writeFile(SPEND_LOG, "ts_utc,endpoint,method,payTo,network,amount_usdc,txid,paid_status,delivered,agentlog_run,budget_usdc\n")
  const esc = (v) => `"${String(v ?? "").replace(/"/g, "'")}"`
  await appendFile(SPEND_LOG, [o.ts, esc(o.endpoint), o.method, o.payTo, o.network, o.amount, o.txid ?? "", o.paid_status, o.delivered, o.run, o.budget ?? o.amount].join(",") + "\n")
}

// ---------- targets: cheapest well-formed USDC/exact challenges on the chosen network, one per host ----------
const probe = JSON.parse(await readFile("data/probe.json", "utf8"))
const cat = new Map(JSON.parse(await readFile("data/catalog.json", "utf8")).catalog.map((c) => [c.id, c]))
// Never buy calls with side effects on third parties or money (sending, posting, trading, minting).
const SIDE_EFFECTS = /send|transfer|swap|mint|deploy|bridge|withdraw|email|mail|sms|tweet|post-?message|order|trade|bet|faucet|payout|airdrop|buy|purchase|checkout|auth|login|\/pay\b|invoice/i
const cands = []
for (const r of probe.results) {
  if (!r.challenge?.ok) continue
  if (SIDE_EFFECTS.test(new URL(r.resource).pathname)) continue
  const a = r.challenge.accepts.find((x) => x.ok && x.scheme === "exact" && x.network === NET && chain.sameAsset(x.asset) && x.usd !== null && x.usd > 0 && x.usd <= MAX_PRICE)
  if (a) cands.push({ r, a, c: cat.get(r.id) })
}
cands.sort((x, y) => x.a.usd - y.a.usd || (y.c?.quality?.l30DaysTotalCalls ?? 0) - (x.c?.quality?.l30DaysTotalCalls ?? 0))
const seenHost = new Set()
const targets = []
for (const t of cands) {
  if (seenHost.has(t.r.host)) continue
  seenHost.add(t.r.host)
  targets.push(t)
  if (targets.length >= N) break
}
const planned = targets.reduce((s, t) => s + t.a.usd, 0)
console.log(`candidates ${cands.length} (${CHAIN} USDC exact <= ${MAX_PRICE}); targets ${targets.length}; planned spend ${planned.toFixed(6)} USDC`)
for (const t of targets) console.log(`  ${t.a.usd.toFixed(4)}  ${t.r.method} ${t.r.resource}`)

// ---------- wallet and budget guards ----------
const balance = await chain.balance()
const spent = await spentSoFar()
console.log(`wallet ${chain.wallet}: ${balance} USDC on ${CHAIN}; spent so far ${spent.toFixed(6)} of ${HARD_TOTAL}`)

const { rec } = openLog()
const runTag = new Date().toISOString().slice(0, 16).replace(/[-:T]/g, "")
const PURCHASES = "data/purchases.json"
const purchases = existsSync(PURCHASES) ? JSON.parse(await readFile(PURCHASES, "utf8")) : []
let total = spent
let stop = false
if (DRY) {
  console.log("dry run: nothing signed, nothing paid")
  stop = true
} else if (balance < (targets[0]?.a.usd ?? Infinity)) {
  const l = await rec.log({ agent_id: AGENT, run_id: `buy-${runTag}-guard`, action: "tool.call", tool: "wallet.balance", input: { wallet: chain.wallet, network: NET, asset: chain.usdc }, output: { usdc: balance, decision: `stop: not enough USDC on ${CHAIN}, purchases not attempted` }, note: "balance guard" })
  await rec.log({ agent_id: AGENT, run_id: l.run_id, action: "run.end" })
  console.log(`STOP: ${balance} USDC on ${CHAIN}. Nothing bought. Logged as ${l.run_id}#${l.entry.step}`)
  process.exitCode = 2
  stop = true
}

// The selector records exactly which requirement the client signs, for v1 and v2 alike.
let selected = null
const client = new x402Client((v, reqs) => {
  selected = { v, req: reqs[0] }
  return reqs[0]
})
chain.register(client)
// Policy: only USDC exact on the chosen network within the per-op cap, whatever else the seller offers.
client.registerPolicy((v, reqs) =>
  reqs.filter((q) => {
    const net = v === 1 ? (q.network === chain.v1Name ? NET : q.network) : q.network
    const raw = String(v === 1 ? q.maxAmountRequired : q.amount)
    if (!/^\d+$/.test(raw)) return false
    const amt = Number(raw) / 1e6
    return q.scheme === "exact" && net === NET && chain.sameAsset(q.asset) && amt > 0 && amt <= MAX_PRICE && chain.extraOk(q)
  }),
)
const httpc = new x402HTTPClient(client)

function reqInit(t) {
  const it = t.c ?? {}
  const init = { method: t.r.method, headers: { "user-agent": UA, accept: "application/json" } }
  let url = t.r.resource
  if (["POST", "PUT", "PATCH"].includes(t.r.method)) {
    init.headers["content-type"] = "application/json"
    init.body = JSON.stringify(it.exampleInput && typeof it.exampleInput === "object" ? it.exampleInput : {})
  } else if (it.exampleInput && typeof it.exampleInput === "object" && !Array.isArray(it.exampleInput)) {
    const u = new URL(url)
    for (const [k, v] of Object.entries(it.exampleInput)) if (v !== null && typeof v !== "object") u.searchParams.set(k, String(v))
    url = u.toString()
  }
  return { url, init }
}

// Fraction of the advertised example's top-level keys present in the delivered JSON.
function shapeMatch(example, body) {
  if (!example || typeof example !== "object" || Array.isArray(example)) return null
  let got
  try {
    got = JSON.parse(body)
  } catch {
    return 0
  }
  const keys = Object.keys(example)
  if (!keys.length || !got || typeof got !== "object") return 0
  const inner = got.data && typeof got.data === "object" ? { ...got, ...got.data } : got
  return keys.filter((k) => k in inner).length / keys.length
}

for (const t of stop ? [] : targets) {
  if (total + t.a.usd > HARD_TOTAL) {
    console.log(`budget: ${total.toFixed(6)} + ${t.a.usd} would pass ${HARD_TOTAL}, stopping`)
    break
  }
  const run = `buy-${runTag}-${createHash("sha256").update(t.r.id).digest("hex").slice(0, 10)}`
  const { url, init } = reqInit(t)
  const log = (tool, input, output, note) => rec.log({ agent_id: AGENT, run_id: run, action: "tool.call", tool, input, output, note })
  let sentUsd = 0
  const row = { ts: new Date().toISOString(), endpoint: t.r.resource, method: t.r.method, payTo: t.a.payTo, network: NET, amount: 0, paid_status: "not_paid", delivered: "n/a", run }
  try {
    const first = await fetch(url, { ...init, signal: AbortSignal.timeout(TIMEOUT) })
    const firstBody = await first.text()
    if (first.status !== 402) {
      await log("x402.challenge", { url, method: init.method }, { status: first.status }, "no 402 at purchase time")
      row.paid_status = `no_402_${first.status}`
      await spendRow(row)
      await rec.log({ agent_id: AGENT, run_id: run, action: "run.end" })
      continue
    }
    const pr = httpc.getPaymentRequiredResponse((h) => first.headers.get(h), (() => { try { return JSON.parse(firstBody) } catch { return undefined } })())
    await log("x402.challenge", { url, method: init.method }, { status: 402, payment_required: pr }, "challenge before paying")
    selected = null
    const payload = await httpc.createPaymentPayload(pr)
    const chosen = selected?.req
    if (!chosen) throw new Error("guard: the client did not report the requirement it signed")
    const amountRaw = String(selected.v === 1 ? chosen.maxAmountRequired : chosen.amount)
    const usd = Number(amountRaw) / 1e6
    if (!(usd > 0 && usd <= MAX_PRICE) || total + usd > HARD_TOTAL) throw new Error(`guard: amount ${usd} outside limits`)
    const headers = httpc.encodePaymentSignatureHeader(payload)
    await log("x402.pay", { url, accepted: chosen, from: chain.wallet }, { header_names: Object.keys(headers), amount_usdc: usd }, `paying ${usd} USDC to ${chosen?.payTo}`)
    sentUsd = usd // from here on a signed payment has left the process
    const t0 = performance.now()
    let paid, body = "", err = null
    try {
      // No redirects with a signed payment attached.
      paid = await fetch(url, { ...init, redirect: "manual", headers: { ...init.headers, ...headers }, signal: AbortSignal.timeout(TIMEOUT) })
      body = (await paid.text()).slice(0, 65536)
    } catch (e) {
      err = e.name === "TimeoutError" ? `no response within ${TIMEOUT / 1000} s` : String(e.message).slice(0, 200)
    }
    const ms = Math.round(performance.now() - t0)
    let settle = null
    try {
      settle = paid ? httpc.getPaymentSettleResponse((h) => paid.headers.get(h)) : null
    } catch {}
    const txid = settle?.transaction ?? null
    const out = {
      status: paid?.status ?? null,
      error: err,
      latency_ms: ms,
      bytes: body.length,
      body_sha256: createHash("sha256").update(body).digest("hex"),
      body_preview: body.slice(0, 300),
      content_type: paid?.headers.get("content-type") ?? null,
      settle,
      shape_match: shapeMatch(t.c?.exampleOutput, body),
    }
    await log("x402.paid_response", { url }, out, `paid response ${out.status ?? err}`)
    const chainFact = txid ? await chain.receipt(txid, chosen.payTo, amountRaw) : { status: "no txid in PAYMENT-RESPONSE" }
    await log("chain.receipt", { txid, network: NET }, chainFact, "on-chain check of the payment")
    const charged = chainFact.transfer_found ? chainFact.value : 0
    // A signed authorization may still be settled later: unless the transfer is confirmed, the signed
    // amount counts against the budget.
    const budget = chainFact.transfer_found ? charged : usd
    total += budget
    row.amount = charged
    row.budget = budget
    row.txid = txid
    row.paid_status = chainFact.transfer_found ? "settled_onchain" : txid ? "txid_without_transfer" : "no_settlement"
    row.delivered = out.status >= 200 && out.status < 300 && out.bytes > 0 ? "yes" : err ? "no_response" : `status_${out.status}`
    const lastRef = await rec.o.store.load(AGENT, run, (await rec.o.signerFor(AGENT)).address.toLowerCase()).then((x) => x.entries.at(-1)?.entry)
    purchases.push({
      endpoint: t.r.resource,
      method: t.r.method,
      ts: row.ts,
      amount_usdc: charged,
      txid,
      paid: chainFact.transfer_found === true,
      delivered: row.delivered === "yes",
      latency_ms: ms,
      shape_match: out.shape_match,
      fact: err ? `${err}` : `HTTP ${out.status}, ${out.bytes} bytes in ${ms} ms${out.shape_match != null ? `, ${Math.round(out.shape_match * 100)}% of advertised example keys present` : ""}`,
      log: lastRef ? { run_id: run, step: lastRef.step, entry_hash: lastRef.entry_hash } : { run_id: run },
    })
    await writeFile(PURCHASES, JSON.stringify(purchases, null, 1))
    console.log(`${row.paid_status} ${charged} USDC  ${row.delivered}  ${ms} ms  ${t.r.resource}`)
  } catch (e) {
    await log("buyer.error", { url }, { error: String(e.message).slice(0, 300) }, sentUsd ? "error after the signed payment was sent" : "purchase aborted before payment").catch(() => {})
    row.paid_status = sentUsd ? "error_after_payment_sent" : "aborted"
    if (sentUsd && row.budget === undefined) {
      row.budget = sentUsd
      total += sentUsd
    }
    console.log(`aborted ${t.r.resource}: ${e.message}`)
  }
  await spendRow(row)
  await rec.log({ agent_id: AGENT, run_id: run, action: "run.end" }).catch(() => {})
}
if (!stop) console.log(`total spent ${total.toFixed(6)} USDC`)

// Unpaid probe of every catalogued x402 endpoint (capped per host). No payment header is ever sent.
// For each endpoint: does it answer, does it answer 402, is the payment challenge well-formed
// (scheme, network, asset, payTo, amount), what does it cost, and does it match its catalogue entry.
// Every probe is a signed AgentLog entry (agent "delivery-score-probe"); the raw response summary is
// kept as the store's evidence and its hash is in the signed entry.
// Usage: node src/probe.mjs [--per-host 100] [--limit N] [--timeout 20000]
import { readFile, writeFile } from "node:fs/promises"
import { createHash } from "node:crypto"
import { UA, parseChallenge, validateChallenge, openLog, ref, pool, caip } from "./lib.mjs"

const arg = (k, d) => (process.argv.includes(k) ? Number(process.argv[process.argv.indexOf(k) + 1]) : d)
const PER_HOST = arg("--per-host", 100)
const LIMIT = arg("--limit", Infinity)
const TIMEOUT = arg("--timeout", 20000)
const AGENT = "delivery-score-probe"
const day = new Date().toISOString().slice(0, 16).replace(/[-:T]/g, "")

const { catalog } = JSON.parse(await readFile("data/catalog.json", "utf8"))
const byHost = new Map()
for (const it of catalog) {
  const h = new URL(it.resource).host
  if (!byHost.has(h)) byHost.set(h, [])
  byHost.get(h).push(it)
}
// Even sample per host: every k-th entry, so a host with 9 000 routes is not hammered.
let selected = []
for (const [h, list] of byHost) {
  const k = Math.max(1, Math.ceil(list.length / PER_HOST))
  selected.push(...list.filter((_, i) => i % k === 0).slice(0, PER_HOST).map((it) => ({ ...it, host: h, host_listed: list.length })))
}
selected = selected.sort(() => Math.random() - 0.5).slice(0, LIMIT)
console.error(`probing ${selected.length} endpoints on ${byHost.size} hosts (cap ${PER_HOST}/host)`)

const { rec, account } = openLog()
const runOf = (host) => `probe-${day}-${createHash("sha256").update(host).digest("hex").slice(0, 12)}`
const results = []
let done = 0

function requestFor(it) {
  const init = { method: it.method, headers: { "user-agent": UA, accept: "application/json" }, redirect: "follow", signal: AbortSignal.timeout(TIMEOUT) }
  let url = it.resource
  if (["POST", "PUT", "PATCH"].includes(it.method)) {
    init.headers["content-type"] = "application/json"
    init.body = JSON.stringify(it.exampleInput && typeof it.exampleInput === "object" ? it.exampleInput : {})
  } else if (it.exampleInput && typeof it.exampleInput === "object" && !Array.isArray(it.exampleInput)) {
    const u = new URL(url)
    for (const [k, v] of Object.entries(it.exampleInput)) if (!u.searchParams.has(k) && v !== null && typeof v !== "object") u.searchParams.set(k, String(v))
    url = u.toString()
  }
  return { url, init }
}

async function probeOne(it) {
  const { url, init } = requestFor(it)
  const t0 = performance.now()
  const out = { id: it.id, resource: it.resource, method: it.method, host: it.host, probed_at: new Date().toISOString() }
  try {
    const r = await fetch(url, init)
    out.latency_ms = Math.round(performance.now() - t0)
    out.status = r.status
    out.final_url = r.url !== url ? r.url : undefined
    out.https = new URL(r.url).protocol === "https:"
    const text = (await r.text()).slice(0, 65536)
    out.body_sha256 = createHash("sha256").update(text).digest("hex")
    out.content_type = r.headers.get("content-type")
    if (r.status === 402) {
      const ch = parseChallenge(r.headers, text)
      const v = validateChallenge(ch)
      out.challenge = { source: ch.source, version: v.version, ok: v.ok, issues: v.issues.slice(0, 10), accepts: v.accepts }
      // Does the live challenge match what the catalogue advertises?
      const live = new Set(v.accepts.map((a) => `${a.network}|${String(a.payTo).toLowerCase()}`))
      const listed = new Set(it.accepts.map((a) => `${caip(a.network)}|${String(a.payTo).toLowerCase()}`))
      out.catalog_match = {
        payTo_same: [...listed].some((x) => live.has(x)),
        price_same: it.accepts.some((a) => v.accepts.some((b) => caip(a.network) === b.network && String(a.amount) === b.amount)),
      }
    } else if (r.status >= 200 && r.status < 300) {
      out.unpaid_success = true
      out.body_preview = text.slice(0, 200)
    } else {
      out.body_preview = text.slice(0, 200)
    }
  } catch (e) {
    out.latency_ms = Math.round(performance.now() - t0)
    const c = e.cause ?? {}
    out.error = e.name === "TimeoutError" ? `timeout ${TIMEOUT} ms` : `${c.code ?? e.name}: ${c.message ?? e.message}`.slice(0, 200)
  }
  try {
    const logged = await rec.log({
      agent_id: AGENT,
      run_id: runOf(it.host),
      action: "tool.call",
      tool: "x402.probe",
      input: { method: it.method, url, body: init.body ?? null, payment_header_sent: false },
      output: out,
      note: `unpaid probe ${it.method} ${it.resource}`.slice(0, 200),
    })
    out.log = ref(logged)
  } catch (e) {
    out.log_error = String(e.message)
  }
  results.push(out)
  if (++done % 500 === 0) console.error(`${done}/${selected.length}`)
}

const t0 = Date.now()
await pool(
  selected.map((it) => ({ it, run: () => probeOne(it) })),
  { global: 48, perHost: 2, hostOf: (t) => t.it.host },
)
// Seal every host run so a truncated run cannot pass as complete.
for (const h of new Set(selected.map((s) => s.host))) {
  await rec.log({ agent_id: AGENT, run_id: runOf(h), action: "run.end", note: `probe of ${h} finished` }).catch(() => {})
}
await writeFile(
  "data/probe.json",
  JSON.stringify({ agent_id: AGENT, signer: account.address, started: new Date(t0).toISOString(), finished: new Date().toISOString(), per_host_cap: PER_HOST, hosts_listed: byHost.size, catalog_unique: catalog.length, host_listed: Object.fromEntries([...byHost].map(([h, l]) => [h, l.length])), results }),
)
console.log(`probed ${results.length} in ${Math.round((Date.now() - t0) / 1000)} s`)

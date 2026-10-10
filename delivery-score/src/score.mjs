// Delivery Score: a transparent score per endpoint, plus per-host and per-payTo aggregates.
//
//   score = 100 * (0.20*live + 0.30*challenge + 0.10*catalog + 0.10*speed + 0.30*delivery)
//
//   live      1 if the endpoint answered at all (any HTTP status) within the probe timeout
//   challenge 1 if it answered 402 with a well-formed x402 challenge (>= 1 valid accept)
//   catalog   1 if the live payTo and price both match the Bazaar listing, 0.5 if one does, else 0
//   speed     1 at <= 1 s, falling linearly to 0 at 10 s (probe latency)
//   delivery  share of our paid purchases that returned 2xx with a non-empty body; 0 if never bought,
//             so an endpoint whose delivery has not been tested cannot score above 70
//
// Every fact carries the AgentLog reference (run_id, step, entry_hash) of the signed record behind it.
// Wording is factual only: what was sent, what came back, when.
import { readFile, writeFile } from "node:fs/promises"
import { existsSync } from "node:fs"

const W = { live: 0.2, challenge: 0.3, catalog: 0.1, speed: 0.1, delivery: 0.3 }
const speedOf = (ms) => (ms == null ? 0 : ms <= 1000 ? 1 : ms >= 10000 ? 0 : 1 - (ms - 1000) / 9000)
const round = (x, d = 2) => Math.round(x * 10 ** d) / 10 ** d

const probe = JSON.parse(await readFile("data/probe.json", "utf8"))
const buys = existsSync("data/purchases.json") ? JSON.parse(await readFile("data/purchases.json", "utf8")) : []
const byEndpoint = new Map()
for (const b of buys) {
  if (!byEndpoint.has(b.endpoint)) byEndpoint.set(b.endpoint, [])
  byEndpoint.get(b.endpoint).push(b)
}

function factsOf(r, purchases) {
  const f = []
  const at = r.probed_at
  if (r.error) f.push(`unpaid ${r.method} at ${at}: ${r.error}`)
  else if (r.status === 402 && r.challenge?.ok) {
    const a = r.challenge.accepts.find((x) => x.ok)
    f.push(`unpaid ${r.method} at ${at}: 402 in ${r.latency_ms} ms, valid x402 v${r.challenge.version} challenge: ${a.usd != null ? a.usd + " USDC" : a.amount + " base units"} on ${a.network} to ${a.payTo}`)
  } else if (r.status === 402) f.push(`unpaid ${r.method} at ${at}: 402 in ${r.latency_ms} ms, challenge not well-formed: ${(r.challenge?.issues ?? []).slice(0, 3).join("; ")}`)
  else if (r.unpaid_success) f.push(`unpaid ${r.method} at ${at}: ${r.status} without any payment (no 402)`)
  else f.push(`unpaid ${r.method} at ${at}: HTTP ${r.status} in ${r.latency_ms} ms, no 402`)
  if (r.catalog_match && !r.catalog_match.payTo_same) f.push("live payTo differs from the Bazaar listing")
  if (r.catalog_match && !r.catalog_match.price_same) f.push("live price differs from the Bazaar listing")
  if (r.challenge?.accepts?.some((a) => a.testnet)) f.push("challenge offers a testnet network")
  for (const p of purchases) f.push(`paid ${p.amount_usdc} USDC at ${p.ts} (tx ${p.txid ?? "none"}): ${p.fact}`)
  return f
}

const endpoints = []
for (const r of probe.results) {
  const purchases = byEndpoint.get(r.resource) ?? []
  const live = r.error ? 0 : 1
  const challenge = r.status === 402 && r.challenge?.ok ? 1 : 0
  const catalog = r.catalog_match ? (r.catalog_match.payTo_same ? 0.5 : 0) + (r.catalog_match.price_same ? 0.5 : 0) : 0
  const speed = live ? speedOf(r.latency_ms) : 0
  const paid = purchases.filter((p) => p.paid)
  const delivery = paid.length ? paid.filter((p) => p.delivered).length / paid.length : 0
  const score = 100 * (W.live * live + W.challenge * challenge + W.catalog * catalog + W.speed * speed + W.delivery * delivery)
  const ok = r.challenge?.accepts?.find((a) => a.ok)
  endpoints.push({
    id: r.id,
    resource: r.resource,
    method: r.method,
    host: r.host,
    payTo: ok?.payTo ?? null,
    price_usdc: ok?.usd ?? null,
    network: ok?.network ?? null,
    score: round(score, 1),
    components: { live, challenge, catalog, speed: round(speed), delivery: round(delivery) },
    delivery_tested: paid.length > 0,
    facts: factsOf(r, purchases),
    evidence: [r.log, ...purchases.map((p) => p.log)].filter(Boolean),
  })
}

function aggregate(key) {
  const m = new Map()
  for (const e of endpoints) {
    const k = e[key]
    if (!k) continue
    if (!m.has(k)) m.set(k, [])
    m.get(k).push(e)
  }
  return Object.fromEntries(
    [...m].map(([k, list]) => [
      k,
      {
        probed: list.length,
        listed: key === "host" ? probe.host_listed?.[k] ?? list.length : undefined,
        live: list.filter((e) => e.components.live).length,
        valid_402: list.filter((e) => e.components.challenge).length,
        delivery_tested: list.filter((e) => e.delivery_tested).length,
        mean_score: round(list.reduce((s, e) => s + e.score, 0) / list.length, 1),
        hosts: key === "payTo" ? [...new Set(list.map((e) => e.host))].slice(0, 20) : undefined,
      },
    ]),
  )
}

const n = endpoints.length
const cnt = (p) => endpoints.filter(p).length
const pct = (x) => round((100 * x) / n, 1)
const r = probe.results
const summary = {
  generated_at: new Date().toISOString(),
  formula: "score = 100 * (0.20*live + 0.30*challenge + 0.10*catalog + 0.10*speed + 0.30*delivery)",
  catalogue: { source: "Coinbase CDP Bazaar discovery", unique_resources: probe.catalog_unique, hosts: probe.hosts_listed, per_host_cap: probe.per_host_cap },
  probed: n,
  live: cnt((e) => e.components.live),
  live_pct: pct(cnt((e) => e.components.live)),
  answered_402: r.filter((x) => x.status === 402).length,
  valid_402: cnt((e) => e.components.challenge),
  valid_402_pct: pct(cnt((e) => e.components.challenge)),
  malformed_402: r.filter((x) => x.status === 402 && !x.challenge?.ok).length,
  unpaid_2xx: r.filter((x) => x.unpaid_success).length,
  errors: r.filter((x) => x.error).length,
  timeouts: r.filter((x) => String(x.error).startsWith("timeout")).length,
  status_counts: Object.entries(r.reduce((m, x) => ((m[x.error ? "network_error" : x.status] = (m[x.error ? "network_error" : x.status] ?? 0) + 1), m), {})).sort((a, b) => b[1] - a[1]),
  payTo_mismatch_vs_catalog: r.filter((x) => x.catalog_match && !x.catalog_match.payTo_same).length,
  price_mismatch_vs_catalog: r.filter((x) => x.catalog_match && !x.catalog_match.price_same).length,
  testnet_offers: r.filter((x) => x.challenge?.accepts?.some((a) => a.testnet)).length,
  top_issues: Object.entries(r.flatMap((x) => x.challenge?.issues ?? []).map((s) => s.replace(/accepts\[\d+\]/, "accepts[i]").replace(/"[^"]*"/g, '"…"')).reduce((m, s) => ((m[s] = (m[s] ?? 0) + 1), m), {})).sort((a, b) => b[1] - a[1]).slice(0, 10),
  networks_valid: Object.entries(endpoints.filter((e) => e.network).reduce((m, e) => ((m[e.network] = (m[e.network] ?? 0) + 1), m), {})).sort((a, b) => b[1] - a[1]).slice(0, 10),
  price_usdc_quantiles: (() => {
    const p = endpoints.map((e) => e.price_usdc).filter((x) => x != null).sort((a, b) => a - b)
    const q = (f) => p[Math.min(p.length - 1, Math.floor(f * p.length))]
    return p.length ? { n: p.length, min: p[0], p25: q(0.25), median: q(0.5), p75: q(0.75), max: p[p.length - 1], le_0_01: p.filter((x) => x <= 0.01).length } : null
  })(),
  hosts_with_any_valid_402: 0,
  purchases: buys.length,
  purchases_paid: buys.filter((b) => b.paid).length,
  purchases_delivered: buys.filter((b) => b.paid && b.delivered).length,
  latency_ms_median_402: (() => {
    const l = r.filter((x) => x.status === 402).map((x) => x.latency_ms).sort((a, b) => a - b)
    return l[Math.floor(l.length / 2)] ?? null
  })(),
}
const hosts = aggregate("host")
summary.hosts_probed = Object.keys(hosts).length
summary.hosts_with_any_valid_402 = Object.values(hosts).filter((h) => h.valid_402 > 0).length
summary.hosts_all_dead = Object.values(hosts).filter((h) => h.live === 0).length

await writeFile("data/scores.json", JSON.stringify({ summary, endpoints, hosts, payTo: aggregate("payTo") }))
await writeFile("data/summary.json", JSON.stringify(summary, null, 2))
// Compact index read by check_before_pay (agentlog-mcp, DELIVERY_SCORE_INDEX).
await writeFile(
  "data/index.json",
  JSON.stringify({
    generated_at: summary.generated_at,
    formula: summary.formula,
    signer: probe.signer,
    endpoints: Object.fromEntries(endpoints.map((e) => [e.id, { score: e.score, components: e.components, delivery_tested: e.delivery_tested, payTo: e.payTo, price_usdc: e.price_usdc, network: e.network, facts: e.facts.slice(0, 4), evidence: e.evidence }])),
    hosts,
    payTo: aggregate("payTo"),
  }),
)
console.log(JSON.stringify(summary, null, 2))

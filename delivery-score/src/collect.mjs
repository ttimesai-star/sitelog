// Collects the public x402 catalogue from the Coinbase CDP Bazaar discovery API (free, no key).
// Output: data/catalog.json — one compact record per (resource, method), plus source metadata.
// Usage: node src/collect.mjs [--max N]
import { writeFile, mkdir } from "node:fs/promises"

const BAZAAR = "https://api.cdp.coinbase.com/platform/v2/x402/discovery/resources"
const PAGE = 1000
const args = process.argv.slice(2)
const max = args.includes("--max") ? Number(args[args.indexOf("--max") + 1]) : Infinity

async function page(offset) {
  for (let attempt = 1; attempt <= 4; attempt++) {
    const r = await fetch(`${BAZAAR}?limit=${PAGE}&offset=${offset}`, { signal: AbortSignal.timeout(60_000) }).catch((e) => ({ ok: false, status: String(e) }))
    if (r.ok) return r.json()
    console.error(`offset ${offset}: ${r.status}, retry ${attempt}`)
    await new Promise((res) => setTimeout(res, 2000 * attempt))
  }
  throw new Error(`Bazaar page ${offset} failed`)
}

const compactAccept = (a) => ({
  scheme: a.scheme,
  network: a.network,
  asset: a.asset,
  amount: a.amount ?? a.maxAmountRequired,
  payTo: a.payTo,
  maxTimeoutSeconds: a.maxTimeoutSeconds,
  extra: a.extra ? { name: a.extra.name, version: a.extra.version } : undefined,
})

const items = []
let total = Infinity
for (let offset = 0; offset < Math.min(total, max); offset += PAGE) {
  const d = await page(offset)
  total = d.pagination?.total ?? 0
  items.push(...(d.items ?? []))
  console.error(`fetched ${items.length}/${total}`)
}

const seen = new Set()
const catalog = []
for (const it of items.slice(0, max)) {
  const info = it.extensions?.bazaar?.info?.input ?? {}
  const method = String(info.method || "GET").toUpperCase()
  const key = `${method} ${it.resource}`
  if (seen.has(key)) continue
  seen.add(key)
  catalog.push({
    id: key,
    resource: it.resource,
    method,
    serviceName: it.serviceName,
    description: String(it.description ?? "").slice(0, 300),
    x402Version: it.x402Version,
    accepts: (it.accepts ?? []).map(compactAccept),
    exampleInput: info.body ?? info.queryParams ?? null,
    bodyType: info.bodyType ?? null,
    exampleOutput: it.extensions?.bazaar?.info?.output?.example ?? null,
    quality: it.quality ?? null,
    lastUpdated: it.lastUpdated,
  })
}

await mkdir("data", { recursive: true })
await writeFile(
  "data/catalog.json",
  JSON.stringify({ source: BAZAAR, fetched_at: new Date().toISOString(), listed: total, items_received: items.length, unique: catalog.length, catalog }, null, 0),
)
console.log(`catalog: ${catalog.length} unique (resource, method) of ${items.length} listed items (total reported ${total})`)

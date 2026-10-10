// check_before_pay: look at an x402 endpoint before an agent pays it.
// 1. A live unpaid request: does it answer 402, is the challenge well-formed (scheme, network, asset,
//    payTo, amount), what does it cost, is it HTTPS.
// 2. Its history in the Delivery Score index (https://github.com/ttimesai-star/delivery-score), when one
//    is configured: earlier probes, paid purchases and whether they delivered, each with the AgentLog
//    reference of the signed record.
// 3. The caller's own limits: maximum price, expected payTo.
// The result is facts and a proceed flag with reasons; it never labels a seller.

import { readFile } from "node:fs/promises"

export const USDC: Record<string, string> = {
  "eip155:8453": "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
  "eip155:84532": "0x036cbd53842c5426634e7929541ec2318f3dcf7e",
  "eip155:137": "0x3c499c542cef5e3811e1192ce70d8cc03d5c3359",
  "eip155:42161": "0xaf88d065e77c8cc2239327c5edb3a432268e5831",
  "eip155:1": "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
  "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp": "EPjFWdd5AufqSSqeM2qJ1zrHzbMMrX7KpJ7GdbW4fzG",
  "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1": "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
}
const V1: Record<string, string> = {
  base: "eip155:8453",
  "base-sepolia": "eip155:84532",
  polygon: "eip155:137",
  avalanche: "eip155:43114",
  solana: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
  "solana-devnet": "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1",
}
const TESTNETS = new Set(["eip155:84532", "eip155:80002", "eip155:43113", "eip155:11155111", "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1"])
const SCHEMES = new Set(["exact", "upto", "batch-settlement", "deferred", "aggr_deferred", "agent-pay"])
const EVM = /^0x[0-9a-fA-F]{40}$/
const B58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/

export interface Accept {
  scheme: string
  network: string | null
  asset: string
  amount: string | null
  payTo: string
  usd: number | null
  testnet: boolean
  ok: boolean
}

export interface Challenge {
  version?: number
  source: "header" | "body" | "none"
  ok: boolean
  issues: string[]
  accepts: Accept[]
}

const caip = (n: unknown): string | null => (typeof n === "string" ? (n.includes(":") ? n : V1[n] ?? null) : null)
const fam = (n: string | null) => (n?.startsWith("eip155:") ? "evm" : n?.startsWith("solana:") ? "solana" : n ? n.split(":")[0] : null)
const addrOk = (f: string | null, a: unknown) => typeof a === "string" && (f === "evm" ? EVM.test(a) && !/^0x0{40}$/.test(a) : f === "solana" ? B58.test(a) : a.length > 0)

export function parseChallenge(getHeader: (h: string) => string | null, body: string): { source: Challenge["source"]; value?: any; error?: string } {
  const h = getHeader("payment-required")
  if (h) {
    try {
      return { source: "header", value: JSON.parse(Buffer.from(h, "base64").toString("utf8")) }
    } catch {
      return { source: "header", error: "PAYMENT-REQUIRED header is not base64 JSON" }
    }
  }
  try {
    const v = JSON.parse(body)
    if (v && typeof v === "object" && ("accepts" in v || "x402Version" in v)) return { source: "body", value: v }
    return { source: "body", error: "402 body has no x402 fields" }
  } catch {
    return { source: "none", error: "no PAYMENT-REQUIRED header and the body is not JSON" }
  }
}

export function validateChallenge(ch: ReturnType<typeof parseChallenge>): Challenge {
  const issues: string[] = []
  const v = ch.value
  if (!v) return { source: ch.source, ok: false, issues: [ch.error ?? "no challenge"], accepts: [] }
  if (![1, 2].includes(v.x402Version)) issues.push(`x402Version is ${JSON.stringify(v.x402Version)}, expected 1 or 2`)
  if (!Array.isArray(v.accepts) || v.accepts.length === 0) return { version: v.x402Version, source: ch.source, ok: false, issues: [...issues, "accepts is missing or empty"], accepts: [] }
  const accepts: Accept[] = v.accepts.map((a: any, i: number) => {
    const amount = a.amount ?? a.maxAmountRequired
    const network = caip(a.network)
    const f = fam(network)
    const p: string[] = []
    if (!SCHEMES.has(a.scheme)) p.push(`accepts[${i}].scheme "${a.scheme}" is not a known x402 scheme`)
    if (!network) p.push(`accepts[${i}].network "${a.network}" is not recognised`)
    if (!addrOk(f, a.payTo)) p.push(`accepts[${i}].payTo is not a valid ${f ?? "?"} address`)
    if (!addrOk(f, a.asset)) p.push(`accepts[${i}].asset is not a valid ${f ?? "?"} address`)
    if (!/^\d+$/.test(String(amount ?? "")) || BigInt(amount) <= 0n) p.push(`accepts[${i}].amount "${amount}" is not a positive integer`)
    issues.push(...p)
    const usdc = network ? USDC[network] : undefined
    const isUsdc = !!usdc && typeof a.asset === "string" && (f === "evm" ? a.asset.toLowerCase() === usdc : a.asset === usdc)
    return {
      scheme: a.scheme,
      network,
      asset: a.asset,
      amount: amount === undefined ? null : String(amount),
      payTo: a.payTo,
      usd: isUsdc && /^\d+$/.test(String(amount)) ? Number(amount) / 1e6 : null,
      testnet: !!network && TESTNETS.has(network),
      ok: p.length === 0,
    }
  })
  return { version: v.x402Version, source: ch.source, ok: accepts.some((a) => a.ok), issues, accepts }
}

export interface History {
  score: number
  components: Record<string, number>
  delivery_tested: boolean
  payTo: string | null
  price_usdc: number | null
  facts: string[]
  evidence: { run_id: string; step?: number; entry_hash?: string }[]
}
interface Index {
  generated_at?: string
  endpoints: Record<string, History>
  hosts: Record<string, { probed: number; live: number; valid_402: number; delivery_tested: number; mean_score: number }>
  payTo?: Record<string, { probed: number; valid_402: number; delivery_tested: number; mean_score: number; hosts?: string[] }>
}

let cached: { src: string; at: number; index: Index } | null = null
/** The Delivery Score index from a file path or an https URL (DELIVERY_SCORE_INDEX). Cached for 10 minutes. */
export async function loadIndex(src = process.env.DELIVERY_SCORE_INDEX): Promise<Index | null> {
  if (!src) return null
  if (cached && cached.src === src && Date.now() - cached.at < 600_000) return cached.index
  const text = /^https?:\/\//.test(src) ? await (await fetch(src, { signal: AbortSignal.timeout(20_000) })).text() : await readFile(src, "utf8")
  const index = JSON.parse(text) as Index
  cached = { src, at: Date.now(), index }
  return index
}

export interface CheckInput {
  url: string
  method?: string
  body?: unknown
  max_price_usdc?: number
  expected_pay_to?: string
  network?: string
}

export interface CheckResult {
  url: string
  checked_at: string
  proceed: boolean
  reasons: string[]
  live: { status: number | null; latency_ms: number; https: boolean; error?: string; challenge?: Challenge }
  offer: Accept | null
  history: (History & { index_generated_at?: string }) | null
  host_history: Index["hosts"][string] | null
  payTo_history: NonNullable<Index["payTo"]>[string] | null
  facts: string[]
}

// The server fetches a caller-supplied URL: only public https hosts, never loopback, link-local or
// private ranges (a literal check; it does not resolve names, so a public name pointing inside is not caught).
export function refuseTarget(url: URL): string | null {
  if (url.protocol !== "https:") return "only https URLs are checked"
  const h = url.hostname.replace(/^\[|\]$/g, "").toLowerCase()
  if (h === "localhost" || h.endsWith(".localhost") || h.endsWith(".local") || h.endsWith(".internal")) return `host ${h} is local`
  const v4 = h.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/)
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])]
    if (a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224) return `address ${h} is not public`
  }
  if (h.includes(":") && (h === "::1" || h === "::" || /^f[cd]/.test(h) || /^fe[89ab]/.test(h) || h.startsWith("::ffff:"))) return `address ${h} is not public`
  return null
}

export async function checkBeforePay(a: CheckInput, fetchImpl: typeof fetch = fetch, timeoutMs = 15_000): Promise<CheckResult> {
  const url = new URL(a.url)
  const refused = refuseTarget(url)
  if (refused) return { url: a.url, checked_at: new Date().toISOString(), proceed: false, reasons: [refused], live: { status: null, latency_ms: 0, https: url.protocol === "https:" }, offer: null, history: null, host_history: null, payTo_history: null, facts: [`not requested: ${refused}`] }
  const method = (a.method ?? "GET").toUpperCase()
  const init: RequestInit = { method, redirect: "manual", headers: { accept: "application/json", "user-agent": "agentlog-mcp/check_before_pay" }, signal: AbortSignal.timeout(timeoutMs) }
  if (a.body !== undefined && method !== "GET" && method !== "HEAD") {
    init.body = typeof a.body === "string" ? a.body : JSON.stringify(a.body)
    ;(init.headers as Record<string, string>)["content-type"] = "application/json"
  }
  const facts: string[] = []
  const reasons: string[] = []
  const t0 = performance.now()
  const live: CheckResult["live"] = { status: null, latency_ms: 0, https: url.protocol === "https:" }
  try {
    const r = await fetchImpl(url, init)
    live.latency_ms = Math.round(performance.now() - t0)
    live.status = r.status
    live.https = new URL(r.url || url.href).protocol === "https:"
    const text = (await r.text()).slice(0, 65536)
    if (r.status === 402) live.challenge = validateChallenge(parseChallenge((h) => r.headers.get(h), text))
  } catch (e) {
    live.latency_ms = Math.round(performance.now() - t0)
    live.error = (e as Error).name === "TimeoutError" ? `no response within ${timeoutMs / 1000} s` : String((e as Error).message)
  }
  const now = new Date().toISOString()
  if (live.error) facts.push(`unpaid ${method} at ${now}: ${live.error}`)
  else facts.push(`unpaid ${method} at ${now}: HTTP ${live.status} in ${live.latency_ms} ms`)

  let offer: Accept | null = null
  if (live.challenge?.ok) {
    const valid = live.challenge.accepts.filter((x) => x.ok && (!a.network || x.network === a.network))
    offer = valid.sort((x, y) => (x.usd ?? Infinity) - (y.usd ?? Infinity))[0] ?? null
    if (offer) facts.push(`valid x402 v${live.challenge.version} challenge: ${offer.usd != null ? `${offer.usd} USDC` : `${offer.amount} base units of ${offer.asset}`} on ${offer.network} to ${offer.payTo}`)
  }
  if (!live.https) reasons.push("the endpoint is not HTTPS")
  if (live.error) reasons.push(`no answer: ${live.error}`)
  else if (live.status !== 402) reasons.push(`answered ${live.status}, not 402: there is no payment challenge to pay`)
  else if (!live.challenge?.ok) reasons.push(`the 402 challenge is not well-formed: ${(live.challenge?.issues ?? []).slice(0, 3).join("; ")}`)
  else if (!offer) reasons.push(`no valid offer on ${a.network}`)
  if (offer?.testnet) reasons.push(`the offer is on a testnet (${offer.network})`)
  if (offer && a.max_price_usdc !== undefined) {
    if (offer.usd == null) reasons.push("the price is not in a known USDC asset, so it cannot be compared with max_price_usdc")
    else if (offer.usd > a.max_price_usdc) reasons.push(`price ${offer.usd} USDC is above max_price_usdc ${a.max_price_usdc}`)
  }
  if (offer && a.expected_pay_to && offer.payTo.toLowerCase() !== a.expected_pay_to.toLowerCase()) reasons.push(`payTo ${offer.payTo} is not the expected ${a.expected_pay_to}`)

  let history: CheckResult["history"] = null
  let host_history: CheckResult["host_history"] = null
  let payTo_history: CheckResult["payTo_history"] = null
  try {
    const idx = await loadIndex()
    if (idx) {
      const h = idx.endpoints[`${method} ${a.url}`] ?? idx.endpoints[a.url]
      history = h ? { ...h, index_generated_at: idx.generated_at } : null
      host_history = idx.hosts[url.host] ?? null
      payTo_history = offer && idx.payTo ? idx.payTo[offer.payTo] ?? idx.payTo[offer.payTo.toLowerCase()] ?? null : null
      if (history) {
        facts.push(`Delivery Score ${history.score}/100 (index of ${idx.generated_at ?? "unknown date"}${history.delivery_tested ? "" : ", delivery not tested yet"})`)
        facts.push(...history.facts.slice(0, 4))
        if (offer && history.payTo && history.payTo.toLowerCase() !== offer.payTo.toLowerCase()) reasons.push(`payTo changed since the last probe: was ${history.payTo}, now ${offer.payTo}`)
        if (history.delivery_tested && history.components.delivery === 0) reasons.push("paid purchases recorded in the index did not deliver (see facts and evidence)")
      } else if (host_history) facts.push(`endpoint not in the index; host ${url.host}: ${host_history.live}/${host_history.probed} probed endpoints answered, ${host_history.valid_402} with a valid 402`)
      else facts.push(`neither the endpoint nor host ${url.host} is in the Delivery Score index`)
    }
  } catch (e) {
    facts.push(`Delivery Score index not available: ${(e as Error).message}`)
  }
  return { url: a.url, checked_at: now, proceed: reasons.length === 0, reasons, live, offer, history, host_history, payTo_history, facts }
}

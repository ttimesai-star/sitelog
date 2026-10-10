// What the MCP tools do, without MCP: write a step, verify a run, list runs of a day, replay a dispute.
// Every answer that says "intact" or "tampered" comes from recomputing hashes and signatures here,
// never from a flag stored next to the data.

import { Recorder, explain, replayDispute, verifyStored } from "agentlog"
import type { DisputeReport, Entry, Explanation, LogStore, PartyFile, RunInfo, RunReport, Verified } from "agentlog"
import type { KeyRing } from "./keys.ts"

export type Source = "local" | "arkiv"

export interface Ctx {
  stores: { local: LogStore; arkiv?: LogStore }
  /** Where log_action writes. */
  writeTo: Source
  keys: KeyRing
  /** Wallets expected on Arkiv, by agent id (read-only verification of runs written elsewhere). */
  arkivSigners: Record<string, string>
  recorders: Partial<Record<Source, Recorder>>
  now: () => number
  defaultTz: string
}

export function store(ctx: Ctx, source: Source = "local"): LogStore {
  const s = ctx.stores[source]
  if (!s) throw new Error(`source "${source}" is not configured on this server`)
  return s
}

function recorder(ctx: Ctx, source: Source): Recorder {
  return (ctx.recorders[source] ??= new Recorder({ store: store(ctx, source), signerFor: (a) => ctx.keys.signerFor(a), now: ctx.now }))
}

/** The wallet a run must be signed by. Never taken from the run itself when we know better. */
export function expectedSigner(ctx: Ctx, source: Source, agentId: string, fallback?: string): { signer: string; known: boolean } {
  const known = source === "arkiv" ? (ctx.arkivSigners[agentId] ?? ctx.keys.expected(agentId)) : ctx.keys.expected(agentId)
  if (known) return { signer: known.toLowerCase(), known: true }
  return { signer: String(fallback ?? "").toLowerCase(), known: false }
}

// ---------- log_action ----------

export async function logAction(ctx: Ctx, a: { agent_id: string; run_id?: string; action: string; tool?: string; input?: unknown; output?: unknown; note?: string }) {
  const r = await recorder(ctx, ctx.writeTo).log(a)
  const steps = [r.started, r.entry].filter(Boolean) as Entry[]
  return {
    agent_id: a.agent_id,
    run_id: r.run_id,
    source: ctx.writeTo,
    sealed: r.sealed,
    written: steps.map((e) => ({ step: e.step, action: e.action, tool: e.tool, entry_hash: e.entry_hash, prev_entry_hash: e.prev_entry_hash, signer: e.signer })),
    head: r.entry.entry_hash,
  }
}

// ---------- verify ----------

export interface RunAudit {
  agent_id: string
  run_id: string
  source: Source
  signer: string
  signer_known: boolean
  verdict: RunReport["verdict"]
  sealed: boolean
  steps: number
  head: string
  started_at: string | null
  ended_at: string | null
  task: string
  explain: Explanation
  forged_records: number
  problems: string[]
  timeline: {
    step: number
    action: string
    tool: string
    note: string
    time: string
    entry_hash: string
    /** "ok", "break" (first untrusted step), "after_break" (cannot be trusted, chain already broken), "bad" */
    status: "ok" | "break" | "after_break" | "bad"
    problems: string[]
  }[]
}

export async function auditRun(ctx: Ctx, source: Source, agentId: string, runId: string): Promise<{ audit: RunAudit; verified: Verified }> {
  const s = store(ctx, source)
  let exp = expectedSigner(ctx, source, agentId)
  if (!exp.known && source === "local") {
    // Unknown agent: verify against the signer of step 0 and say so.
    const first = (await s.load(agentId, runId)).entries.map((x) => x.entry).sort((a, b) => a.step - b.step)[0]
    exp = expectedSigner(ctx, source, agentId, first?.signer)
  }
  const v = await verifyStored(s, agentId, runId, exp.signer)
  const ex = v.explain
  const byStep = new Map(v.report.checks.map((c) => [c.step, c]))
  const entries = v.bundle.entries.map((x) => x.entry).sort((a, b) => a.step - b.step)
  const brk = ex.first_break?.step ?? Infinity
  const timeline: RunAudit["timeline"] = entries.map((e) => {
    const c = byStep.get(e.step)
    // After the first break, a step that verifies on its own stays "ok" (its signature and link hold);
    // one whose only fault is the hole before it is "after_break"; anything else is "bad".
    const own = (c?.problems ?? []).filter((p) => p !== "previous step missing, link cannot be checked")
    const status = e.step === brk ? "break" : !c || c.ok ? "ok" : own.length ? "bad" : "after_break"
    return { step: e.step, action: e.action, tool: e.tool, note: e.note, time: iso(e.timestamp), entry_hash: e.entry_hash, status, problems: c?.problems ?? [] }
  })
  // A deleted step has no row: show the hole where it was.
  if (ex.first_break?.kind === "deleted") {
    timeline.push({ step: brk, action: "(missing)", tool: "", note: "", time: "", entry_hash: "", status: "break", problems: [`step ${brk} is missing`] })
    timeline.sort((a, b) => a.step - b.step || (a.action === "(missing)" ? -1 : 1))
  }
  const start = entries.find((e) => e.step === 0)
  const end = entries.find((e) => e.action === "run.end")
  const audit: RunAudit = {
    agent_id: agentId,
    run_id: runId,
    source,
    signer: exp.signer,
    signer_known: exp.known,
    verdict: v.report.verdict,
    sealed: v.report.sealed,
    steps: v.report.steps,
    head: v.report.head,
    started_at: start ? iso(start.timestamp) : null,
    ended_at: end ? iso(end.timestamp) : null,
    task: start?.note && start.note !== "run started" ? start.note : "",
    explain: ex,
    forged_records: v.bundle.foreign.length,
    problems: v.report.problems,
    timeline,
  }
  return { audit, verified: v }
}

const iso = (ms: number) => (Number.isFinite(ms) ? new Date(ms).toISOString() : "")

// ---------- list runs of a day ----------

/** "today", "yesterday" or YYYY-MM-DD, in an IANA time zone, as a YYYY-MM-DD string. */
export function resolveDate(date: string | undefined, tz: string, now: number): string {
  const today = localDate(now, tz)
  const d = String(date ?? "").trim().toLowerCase()
  if (!d || d === "today") return today
  if (d === "yesterday") return shiftDate(today, -1)
  if (/^\d{4}-\d{2}-\d{2}$/.test(d)) return d
  throw new Error(`date: "today", "yesterday" or YYYY-MM-DD, got "${date}"`)
}

export function localDate(ms: number, tz: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(ms))
}

export function localTime(ms: number, tz: string): string {
  return new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "numeric", minute: "2-digit" }).format(new Date(ms))
}

function shiftDate(ymd: string, days: number): string {
  const [y, m, d] = ymd.split("-").map(Number)
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10)
}

export function checkTz(tz: string | undefined, fallback: string): string {
  const t = tz || fallback
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: t })
    return t
  } catch {
    throw new Error(`unknown time zone "${t}" (use an IANA name such as Europe/Minsk or America/Los_Angeles)`)
  }
}

export async function listRuns(ctx: Ctx, q: { source?: Source; agent_id?: string; date?: string; tz?: string; limit?: number }): Promise<{ date: string | null; tz: string; runs: RunInfo[] }> {
  const tz = checkTz(q.tz, ctx.defaultTz)
  const s = store(ctx, q.source ?? "local")
  let runs = await s.listRuns({ agentId: q.agent_id })
  const date = q.date ? resolveDate(q.date, tz, ctx.now()) : null
  if (date) runs = runs.filter((r) => localDate(r.first_ts, tz) === date)
  return { date, tz, runs: runs.slice(0, Math.max(1, Math.min(q.limit ?? 50, 200))) }
}

// ---------- audit a day: the voice question ----------

export interface DayAudit {
  date: string
  tz: string
  label: string
  source: Source
  agent_id: string | null
  runs: RunAudit[]
  totals: { runs: number; intact: number; open: number; broken: number; steps: number; tools: Record<string, number> }
  speech: string
}

export async function auditDay(ctx: Ctx, q: { source?: Source; agent_id?: string; date?: string; tz?: string }): Promise<DayAudit> {
  const source = q.source ?? "local"
  const { date, tz, runs } = await listRuns(ctx, { source, agent_id: q.agent_id, date: q.date ?? "yesterday", tz: q.tz, limit: 20 })
  const audits: RunAudit[] = []
  for (const r of runs.slice().sort((a, b) => a.first_ts - b.first_ts)) audits.push((await auditRun(ctx, source, r.agent_id, r.run_id)).audit)
  const tools: Record<string, number> = {}
  for (const a of audits) for (const t of a.timeline) if (t.action === "tool.call" || t.action === "llm.call") tools[t.tool || t.action] = (tools[t.tool || t.action] ?? 0) + 1
  const totals = {
    runs: audits.length,
    intact: audits.filter((a) => a.verdict === "intact").length,
    open: audits.filter((a) => a.verdict === "open").length,
    broken: audits.filter((a) => a.verdict === "broken").length,
    steps: audits.reduce((n, a) => n + a.steps, 0),
    tools,
  }
  const label = q.date && !["yesterday", "today"].includes(q.date.toLowerCase()) ? `On ${date}` : (q.date ?? "yesterday").toLowerCase() === "today" ? "Today" : "Yesterday"
  return { date: date as string, tz, label, source, agent_id: q.agent_id ?? null, runs: audits, totals, speech: speak(label, q.agent_id, audits, totals, tz) }
}

function plural(n: number, one: string, many = `${one}s`) {
  return `${n} ${n === 1 ? one : many}`
}

/** Short enough to be read aloud by a voice assistant: the verdict first, the details after. */
export function speak(label: string, agentId: string | undefined, runs: RunAudit[], t: DayAudit["totals"], tz: string): string {
  const who = agentId ?? (new Set(runs.map((r) => r.agent_id)).size === 1 ? runs[0].agent_id : "your agents")
  if (!runs.length) return `${label}, ${who} did not log any runs.`
  const parts: string[] = []
  parts.push(`${label}, ${who} ran ${plural(t.runs, "time")}, ${plural(t.steps, "logged step")} in total.`)
  // Spoken answers stay short: the task list goes on the card, except for a single run.
  if (runs.length === 1 && runs[0].task) parts.push(`The task was: ${runs[0].task}.`)
  const broken = runs.filter((r) => r.verdict === "broken")
  if (!broken.length && !t.open) parts.push("Every log is intact: signed by the agent, linked, and sealed.")
  else if (!broken.length) parts.push(`No log was tampered with, but ${plural(t.open, "run")} never finished, so ${t.open === 1 ? "it" : "they"} may have stopped early.`)
  else {
    const b = broken[0]
    const when = b.started_at ? ` at ${localTime(Date.parse(b.started_at), tz)}` : ""
    const fb = b.explain.first_break
    parts.push(`Warning: ${broken.length === 1 ? "one log was" : `${broken.length} logs were`} tampered with. In the run${when}${b.task ? `, "${b.task}"` : ""}, step ${fb?.step ?? "?"} cannot be trusted: ${fb?.reason ?? "it fails verification"}.`)
    const rest = t.runs - broken.length
    if (rest) parts.push(`The other ${plural(rest, "run")} ${rest === 1 ? "is" : "are"} ${t.open ? "unchanged" : "intact"}.`)
  }
  return parts.join(" ")
}

// ---------- dispute ----------

export async function diffVersions(ctx: Ctx, q: { source?: Source; agent_id: string; run_id: string; client: PartyFile; operator?: PartyFile; steps?: number[] }): Promise<DisputeReport> {
  const source = q.source ?? "local"
  const { verified } = await auditRun(ctx, source, q.agent_id, q.run_id)
  let operator = q.operator
  if (!operator) {
    const ev = await store(ctx, source).evidence(q.agent_id, q.run_id)
    operator = { format: "agentlog-evidence/v1", party: "operator", agent_id: q.agent_id, run_id: q.run_id, entries: [...ev].map(([step, raw]) => ({ step, raw })) }
  }
  return replayDispute(verified.bundle, { operator: { file: operator, name: q.operator ? "operator file" : "server evidence" }, client: { file: q.client, name: "client file" }, steps: q.steps, now: new Date(ctx.now()) })
}

export { explain }

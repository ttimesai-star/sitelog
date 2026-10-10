// Storage-agnostic layer: a run can live on Arkiv, in a local SQLite file or in memory, and is
// written and verified the same way. A store only keeps entries; it never decides whether they are
// genuine. That is the verifier's job (core.ts), and it trusts nothing the store says except, on
// Arkiv, the $creator the chain itself sets.

import { ACTION_END, ACTION_START, GENESIS, buildEntry, canonicalJson, checkId, commitTool, commitValue, hashValue, newSalt, verifyExport } from "./core.ts"
import type { Entry, ExportBundle, ExportedEntry, RawRecord, RunReport } from "./core.ts"
import type { Hex, LocalAccount } from "viem"

export type Signer = Pick<LocalAccount, "address" | "signMessage">

/** One run as a store holds it. */
export interface RunInfo {
  agent_id: string
  run_id: string
  /** Signer of step 0 as stored (a claim, checked only by verification). */
  signer: string
  /** Entries stored, if the store knows without loading the run. */
  entries?: number
  first_ts: number
  last_ts?: number
  last_action?: string
  sealed?: boolean
  note?: string
}

export interface LoadedEntries {
  entries: ExportedEntry[]
  /** Records that claim to belong to the run but were created by another wallet (Arkiv only). */
  foreign: ExportedEntry[]
  source: ExportBundle["source"]
}

export interface LogStore {
  /** "memory", "sqlite" or "arkiv". */
  readonly kind: string
  /** Appends entries of one run, in order. A store must never overwrite an existing entry. */
  append(agentId: string, runId: string, items: { entry: Entry; raw?: RawRecord }[], opts?: { seal?: boolean }): Promise<{ keys?: string[]; tx?: string }>
  /** Every stored entry of a run. With `signer`, a store that knows the chain-set creator splits off foreign records. */
  load(agentId: string, runId: string, signer?: string): Promise<LoadedEntries>
  listRuns(q?: { agentId?: string; signer?: string }): Promise<RunInfo[]>
  /** The operator's raw inputs and outputs, by step (never public). */
  evidence(agentId: string, runId: string): Promise<Map<number, RawRecord>>
  close?(): void | Promise<void>
}

// ---------- memory store (tests, browser) ----------

export class MemoryStore implements LogStore {
  readonly kind = "memory"
  readonly rows: { entry: Entry; raw?: RawRecord }[] = []

  async append(_a: string, _r: string, items: { entry: Entry; raw?: RawRecord }[]) {
    for (const it of items) {
      if (this.rows.some((x) => x.entry.entry_hash === it.entry.entry_hash && x.entry.run_id === it.entry.run_id)) throw new Error("entry already stored")
      this.rows.push(structuredClone(it))
    }
    return {}
  }

  async load(agentId: string, runId: string): Promise<LoadedEntries> {
    const entries = this.rows.filter((x) => x.entry.agent_id === agentId && x.entry.run_id === runId).map((x) => ({ entry: structuredClone(x.entry) }))
    return { entries, foreign: [], source: null }
  }

  async listRuns(q: { agentId?: string } = {}): Promise<RunInfo[]> {
    const runs = new Map<string, Entry[]>()
    for (const { entry: e } of this.rows) {
      if (q.agentId && e.agent_id !== q.agentId) continue
      const k = `${e.agent_id}\u0000${e.run_id}`
      runs.set(k, [...(runs.get(k) ?? []), e])
    }
    return [...runs.values()].map(summarize).sort((a, b) => b.first_ts - a.first_ts)
  }

  async evidence(agentId: string, runId: string) {
    const m = new Map<number, RawRecord>()
    for (const x of this.rows) if (x.entry.agent_id === agentId && x.entry.run_id === runId && x.raw) m.set(x.entry.step, structuredClone(x.raw))
    return m
  }
}

export function summarize(es: Entry[]): RunInfo {
  const s = [...es].sort((a, b) => a.step - b.step)
  const first = s[0]
  const last = s[s.length - 1]
  return {
    agent_id: first.agent_id,
    run_id: first.run_id,
    signer: String(first.signer),
    entries: s.length,
    first_ts: first.timestamp,
    last_ts: last.timestamp,
    last_action: last.action,
    sealed: s.some((e) => e.action === ACTION_END),
    note: first.note,
  }
}

// ---------- recorder: one append-only writer over any store ----------

export interface LogAction {
  agent_id: string
  /** Omitted: a new run id is minted. A run that does not exist yet is started automatically. */
  run_id?: string
  action: string
  tool?: string
  input?: unknown
  output?: unknown
  note?: string
}

export interface Logged {
  run_id: string
  entry: Entry
  /** run.start written automatically because the run did not exist yet. */
  started?: Entry
  sealed: boolean
}

export interface RecorderOptions {
  store: LogStore
  /** The key that signs for an agent. One key per agent is the usual setup. */
  signerFor: (agentId: string) => Promise<Signer>
  /** Salted commitments instead of plain hashes, empty public note, tool name committed (see core.ts). */
  detailsOffChain?: boolean
  now?: () => number
}

const snapshot = (v: unknown): unknown => JSON.parse(canonicalJson(v ?? null))

export function newRunId(now = Date.now()): string {
  const d = new Date(now).toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "")
  return `run-${d}-${newSalt().slice(2, 6)}`
}

/**
 * Appends actions to runs in any store. Writes to one run are strictly serialized, so two concurrent
 * calls can never both take the same step number. The head of a run is read back from the store
 * every time, so several processes (or a restarted server) continue the same chain.
 */
export class Recorder {
  private queues = new Map<string, Promise<unknown>>()
  readonly o: RecorderOptions
  constructor(o: RecorderOptions) {
    this.o = o
  }

  private serial<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.queues.get(key) ?? Promise.resolve()
    const next = prev.then(fn, fn)
    const tail = next.catch(() => undefined)
    this.queues.set(key, tail)
    tail.then(() => this.queues.get(key) === tail && this.queues.delete(key))
    return next
  }

  log(a: LogAction): Promise<Logged> {
    checkId(a.agent_id, "agent_id")
    const runId = a.run_id ? checkId(a.run_id, "run_id") : newRunId(this.o.now?.())
    return this.serial(`${a.agent_id}\u0000${runId}`, () => this.write({ ...a, run_id: runId }))
  }

  private async write(a: LogAction & { run_id: string }): Promise<Logged> {
    const account = await this.o.signerFor(a.agent_id)
    const signer = account.address.toLowerCase()
    const { entries } = await this.o.store.load(a.agent_id, a.run_id, signer)
    const own = entries.map((x) => x.entry).filter((e) => String(e.signer).toLowerCase() === signer && Number.isInteger(e.step))
    const last = own.sort((x, y) => x.step - y.step)[own.length - 1]
    if (last?.action === ACTION_END) throw new Error(`run ${a.run_id} is sealed: start a new run`)
    let step = last ? last.step + 1 : 0
    let prev: Hex = last ? last.entry_hash : GENESIS
    const items: { entry: Entry; raw?: RawRecord }[] = []
    const make = async (action: string, tool: string, input: unknown, output: unknown, note: string) => {
      const c = await this.commit(tool, snapshot(input), snapshot(output), note)
      const entry = await buildEntry(
        { agent_id: a.agent_id, run_id: a.run_id, step, action, tool: c.tool, input_hash: c.input_hash, output_hash: c.output_hash, prev_entry_hash: prev, note: c.note, timestamp: this.o.now?.() },
        account,
      )
      items.push({ entry, raw: c.raw })
      step += 1
      prev = entry.entry_hash
      return entry
    }
    let started: Entry | undefined
    const action = String(a.action || "").trim()
    if (!action) throw new Error("action is required")
    if (step === 0 && action !== ACTION_START) started = await make(ACTION_START, "", { task: a.note ?? "", auto: true }, null, "run started")
    if (step > 0 && action === ACTION_START) throw new Error(`run ${a.run_id} has already started`)
    const isEnd = action === ACTION_END
    // The seal commits to the step count and the head: a truncated run cannot pass as a finished one.
    const input = isEnd ? { steps: step, head: prev } : a.input
    const entry = await make(action, isEnd ? "" : String(a.tool ?? ""), input, a.output, String(a.note ?? (isEnd ? "run sealed" : "")))
    await this.o.store.append(a.agent_id, a.run_id, items, { seal: isEnd })
    return { run_id: a.run_id, entry, started, sealed: isEnd }
  }

  private async commit(tool: string, input: unknown, output: unknown, note: string) {
    if (!this.o.detailsOffChain) return { tool, note, input_hash: await hashValue(input), output_hash: await hashValue(output), raw: { input, output } as RawRecord }
    const salt = newSalt()
    return {
      tool: await commitTool(tool, salt),
      note: "",
      input_hash: await commitValue(input, salt),
      output_hash: await commitValue(output, salt),
      raw: { input, output, salt, tool, ...(note ? { note } : {}) } as RawRecord & { note?: string },
    }
  }
}

// ---------- verification over a store ----------

export interface Verified {
  bundle: ExportBundle
  report: RunReport
  explain: Explanation
}

/** Loads a run from a store and verifies it against the wallet expected for the agent. */
export async function verifyStored(store: LogStore, agentId: string, runId: string, signer: string): Promise<Verified> {
  const s = signer.toLowerCase()
  const run = await store.load(agentId, runId, s)
  const bundle: ExportBundle = {
    format: "agentlog-export/v1",
    exported_at: new Date().toISOString(),
    source: run.source,
    agent_id: agentId,
    run_id: runId,
    signer: s,
    entries: run.entries,
    foreign: run.foreign,
    report: undefined as unknown as RunReport,
  }
  const report = await verifyExport(bundle)
  bundle.report = report
  return { bundle, report, explain: explain(report) }
}

// ---------- plain-language explanation of a verdict ----------

export type BreakKind = "edited" | "deleted" | "forked" | "foreign_signer" | "bad_signature" | "relinked" | "after_seal" | "not_on_chain" | "invalid"

export interface Explanation {
  verdict: RunReport["verdict"]
  /** The first step where the chain cannot be trusted, or null. */
  first_break: { step: number; kind: BreakKind; reason: string } | null
  /** Steps that verified, from 0, before the first break. */
  trusted_prefix: number
  /** One or two sentences, fit to be spoken. */
  sentence: string
}

const KIND_TEXT: Record<BreakKind, string> = {
  edited: "its content was edited after the agent signed it",
  deleted: "it is missing, deleted or expired",
  forked: "the agent's key signed two different versions of it",
  foreign_signer: "it was signed by a key that is not the agent's",
  bad_signature: "its signature is not valid",
  relinked: "it does not link to the step before it",
  after_seal: "it was written after the run was sealed",
  not_on_chain: "the chain does not confirm who wrote it",
  invalid: "it is malformed",
}

function kindOf(problems: string[]): BreakKind {
  const p = problems.join(" | ")
  if (/edited after signing/.test(p)) return "edited"
  if (/not by the expected agent wallet|\$creator is/.test(p)) return /\$creator/.test(p) ? "not_on_chain" : "foreign_signer"
  if (/signature/.test(p)) return "bad_signature"
  if (/after run\.end/.test(p)) return "after_seal"
  if (/prev_entry_hash|GENESIS/.test(p)) return "relinked"
  if (/no Arkiv entity/.test(p)) return "not_on_chain"
  return "invalid"
}

export function explain(r: RunReport): Explanation {
  const breaks: { step: number; kind: BreakKind; reason: string }[] = []
  for (const m of r.problems) {
    const gap = /^step (\d+) is missing/.exec(m)
    if (gap) breaks.push({ step: Number(gap[1]), kind: "deleted", reason: KIND_TEXT.deleted })
    const fork = /^step (\d+) has \d+ different entries/.exec(m)
    if (fork) breaks.push({ step: Number(fork[1]), kind: "forked", reason: KIND_TEXT.forked })
  }
  for (const c of r.checks) {
    if (c.ok) continue
    // A step whose only problem is the missing link before it is a consequence, not a new break.
    const own = c.problems.filter((p) => p !== "previous step missing, link cannot be checked")
    if (!own.length) continue
    const kind = kindOf(own)
    breaks.push({ step: c.step, kind, reason: KIND_TEXT[kind] })
  }
  breaks.sort((a, b) => a.step - b.step)
  const first = breaks[0] ?? null
  const trusted = first ? first.step : r.steps
  let sentence: string
  if (r.verdict === "empty") sentence = "There is no record of this run."
  else if (r.verdict === "intact") sentence = `The log is intact: all ${r.steps} steps are signed by the agent, linked, and sealed.`
  else if (r.verdict === "open") sentence = `The log is intact so far, ${r.steps} steps, but the run was never sealed, so it may have stopped early.`
  else if (first) {
    const others = new Set(breaks.map((b) => b.step).filter((s) => s !== first.step)).size
    const rest = others ? ` ${others} more step${others === 1 ? " fails" : "s fail"} after it.` : r.steps > 1 ? " Every other step checks out." : ""
    sentence = `The log was tampered with. Step ${first.step} cannot be trusted: ${first.reason}.${rest}`
  }
  else sentence = `The log fails verification: ${r.problems[0] ?? "unknown problem"}.`
  return { verdict: r.verdict, first_break: first, trusted_prefix: trusted, sentence }
}

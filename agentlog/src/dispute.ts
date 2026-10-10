// Dispute replay: two parties, one agent run, one report.
//
// The operator of an agent and its client disagree about what the agent did. Both accept the run on
// Arkiv (or a signed export of it) as the common record, because neither of them can change it. Each
// side brings its own private file of raw data (the operator's evidence file, the client's copies of
// what it received), optionally with a written claim per step. This module checks every step:
//   1. is the step itself sound on chain (hash, signature, link, $creator)?
//   2. does each party's raw data match the hashes (or salted commitments) the agent signed?
// and gives a verdict for every disputed step. No network, no server: it runs the same in Node, in the
// browser and offline. Raw data never leaves the process that runs it.
//
// What a match proves, and what it does not: a match means "this is exactly what the agent recorded
// when it wrote the step". It does not prove the agent told the truth at the moment of writing.

import { canonicalJson, checkRaw, sha256, verifyExport } from "./core.ts"
import type { Entry, ExportBundle, RawCheck, RawRecord, RunReport } from "./core.ts"

export const DISPUTE_FORMAT = "agentlog-dispute-report/v1"
export const PARTIES = ["operator", "client"] as const
export type Party = (typeof PARTIES)[number]

/**
 * A party's file. The operator's agentlog-evidence/v1 file works as is. A minimal file is
 *   { "party": "client", "entries": [ { "step": 4, "raw": { "output": {...} }, "claim": "..." } ],
 *     "claims": [ { "step": 8, "text": "..." } ] }
 */
export interface PartyFile {
  format?: string
  party?: string
  agent_id?: string
  run_id?: string
  entries?: Array<{ step?: number; entry?: { step?: number }; raw?: RawRecord; claim?: string }>
  claims?: Array<{ step: number; text: string }>
}

export interface PartyInput {
  file: PartyFile
  /** File name as the party gave it (shown in the report). */
  name?: string
  /** SHA-256 of the file bytes, so the report pins exactly which file was checked. */
  sha256?: string
}

export type StepVerdict = "operator" | "client" | "both" | "neither" | "no_anchor" | "not_disputed"

export interface PartyStep {
  provided: boolean
  claim?: string
  check?: RawCheck
  /** Every part the party provided matches the chain (and at least one part was provided). */
  matches: boolean
  /** Short excerpt of the party's output, only with includeExcerpts. */
  excerpt?: string
}

export interface DisputeStep {
  step: number
  action: string
  tool: string
  /** Plain tool name, when the step was written with details off chain and a matching party opened it. */
  tool_revealed?: string
  note: string
  entry_hash: string
  chain_ok: boolean
  chain_problems: string[]
  operator: PartyStep
  client: PartyStep
  /** Both parties provided this step and their raw data differs. */
  versions_differ: boolean
  disputed: boolean
  verdict: StepVerdict
  finding: string
}

export interface DisputeReport {
  format: typeof DISPUTE_FORMAT
  created_at: string
  run: {
    agent_id: string
    run_id: string
    signer: string
    head: string
    chain_verdict: RunReport["verdict"]
    sealed: boolean
    steps: number
    source: ExportBundle["source"]
  }
  files: Partial<Record<Party, { name: string; sha256: string; steps_provided: number; claims: number }>>
  summary: Record<StepVerdict, number> & { disputed: number }
  steps: DisputeStep[]
  warnings: string[]
  caveats: string[]
  /** SHA-256 of the canonical JSON of the report without this field. */
  report_hash?: string
}

export interface DisputeOptions {
  operator?: PartyInput
  client?: PartyInput
  /** Steps to treat as disputed even if nobody wrote a claim and the versions agree. */
  steps?: number[]
  /** Put a short excerpt of each party's output into the report (off by default: raw data is private). */
  includeExcerpts?: boolean
  now?: Date
}

const CAVEATS = [
  "A match means the party's raw data is exactly what the agent hashed and signed when it wrote the step. It does not prove the agent told the truth at that moment.",
  "Raw data was checked locally. This report carries hashes and verdicts; it carries raw data only where excerpts were switched on.",
  "Who the agent wallet is comes from the operator, out of band. Check that the signer in this report is the wallet you expect.",
]

function normalize(input: PartyInput | undefined, party: Party, warnings: string[], agentId: string, runId: string) {
  const raw = new Map<number, RawRecord>()
  const claims = new Map<number, string>()
  if (!input) return { raw, claims }
  const f = input.file
  if (!f || typeof f !== "object" || (f.entries !== undefined && !Array.isArray(f.entries)) || (f.claims !== undefined && !Array.isArray(f.claims))) {
    throw new Error(`${party} file: expected an object with an "entries" array (agentlog-evidence/v1 or a party file)`)
  }
  if (f.agent_id && f.agent_id !== agentId) warnings.push(`${party} file names agent ${f.agent_id}, the run is of ${agentId}`)
  if (f.run_id && f.run_id !== runId) warnings.push(`${party} file names run ${f.run_id}, the run is ${runId}`)
  // The first claim for a step counts; a second one is reported, not silently swapped in (FIND-04).
  const addClaim = (step: number, text: string) => {
    if (claims.has(step)) warnings.push(`${party} file: more than one claim for step ${step}, the first one is used`)
    else claims.set(step, text.trim().slice(0, 1000))
  }
  if (f.party && f.party !== party) warnings.push(`the file given as the ${party}'s says party "${f.party}"`)
  for (const x of f.entries ?? []) {
    const step = Number(x?.step ?? x?.entry?.step)
    if (!Number.isInteger(step) || step < 0) {
      warnings.push(`${party} file: an entry without a valid step number was skipped`)
      continue
    }
    if (raw.has(step)) warnings.push(`${party} file: step ${step} appears twice, the first one is used`)
    else if (x.raw && typeof x.raw === "object") raw.set(step, x.raw)
    if (typeof x.claim === "string" && x.claim.trim()) addClaim(step, x.claim)
  }
  for (const c of f.claims ?? []) {
    const step = Number(c?.step)
    if (Number.isInteger(step) && step >= 0 && typeof c.text === "string" && c.text.trim()) addClaim(step, c.text)
  }
  return { raw, claims }
}

const provided = (c: RawCheck) => [c.input, c.output, c.tool].filter((x) => x !== null)
// A tool name alone never confirms a version: in the plain mode it is public, so anyone can "match" it.
const matchesAll = (c: RawCheck) => (c.input !== null || c.output !== null) && provided(c).every(Boolean)

/** Parts (input, output) the other party gave and this one did not: its confirmation does not cover them. */
function uncovered(winner: RawCheck | undefined, other: RawCheck | undefined): string[] {
  if (!winner || !other) return []
  return (["input", "output"] as const).filter((k) => winner[k] === null && other[k] !== null)
}

function describe(c: RawCheck | undefined): string {
  if (!c) return "nothing"
  const parts: string[] = []
  if (c.input !== null) parts.push(`input ${c.input ? "matches" : "does not match"}`)
  if (c.output !== null) parts.push(`output ${c.output ? "matches" : "does not match"}`)
  if (c.tool !== null) parts.push(`tool name ${c.tool ? "matches" : "does not match"}`)
  return parts.join(", ") || "no input or output"
}

function excerpt(v: unknown): string {
  let s: string
  try {
    s = typeof v === "string" ? v : canonicalJson(v ?? null)
  } catch {
    s = String(v)
  }
  return s.length > 240 ? `${s.slice(0, 240)}…` : s
}

/**
 * Replays a dispute over one run. `bundle` is an agentlog-export/v1 (from Arkiv, from the CLI or from
 * the page). It is re-verified here: its own `report` field is not trusted.
 */
export async function replayDispute(bundle: ExportBundle, opts: DisputeOptions = {}): Promise<DisputeReport> {
  const chain = await verifyExport(bundle)
  const warnings: string[] = []
  const agentId = bundle.agent_id || chain.agent_id
  const runId = bundle.run_id || chain.run_id
  const sides = {
    operator: normalize(opts.operator, "operator", warnings, agentId, runId),
    client: normalize(opts.client, "client", warnings, agentId, runId),
  }
  const forced = new Set((opts.steps ?? []).filter((s) => Number.isInteger(s) && s >= 0))

  // The chain's view of every step: entries by step (a fork gives two), and the checks.
  const entries = new Map<number, Entry[]>()
  for (const x of bundle.entries) {
    const e = x.entry
    if (!Number.isInteger(e?.step) || e.step < 0) continue
    entries.set(e.step, [...(entries.get(e.step) ?? []), e])
  }
  const checksByHash = new Map(chain.checks.map((c) => [String(c.entry_hash), c]))
  // Steps after a missing one cannot be linked; verifyRun reports them by step number in problems.
  // Missing steps are listed too, so a deleted step shows in the report even if nobody mentions it
  // (review finding FIND-02, Jules 10.10).
  const missing = new Set(chain.problems.map((p) => /^step (\d+) is missing/.exec(p)?.[1]).filter(Boolean).map(Number))
  const allSteps = new Set<number>([...entries.keys(), ...forced, ...missing])
  for (const p of PARTIES) for (const k of [...sides[p].raw.keys(), ...sides[p].claims.keys()]) allSteps.add(k)

  const steps: DisputeStep[] = []
  for (const s of [...allSteps].sort((a, b) => a - b)) {
    const at = entries.get(s) ?? []
    const e = at[0]
    const chainProblems: string[] = []
    if (!e) chainProblems.push(missing.has(s) || s < chain.steps ? "step is missing from the chain (deleted, expired or never written)" : "the run has no such step")
    if (at.length > 1) chainProblems.push(`fork: ${at.length} different signed entries for this step`)
    for (const x of at) for (const p of checksByHash.get(String(x.entry_hash))?.problems ?? []) chainProblems.push(p)
    const chainOk = Boolean(e) && chainProblems.length === 0

    const party = async (p: Party): Promise<PartyStep> => {
      const raw = sides[p].raw.get(s)
      const claim = sides[p].claims.get(s)
      if (!raw) return { provided: false, matches: false, ...(claim ? { claim } : {}) }
      const check = e ? await checkRaw(e, raw) : { input: null, output: null, tool: null, salted: typeof raw.salt === "string" }
      const out: PartyStep = { provided: true, check, matches: Boolean(e) && matchesAll(check), ...(claim ? { claim } : {}) }
      if (opts.includeExcerpts && "output" in raw) out.excerpt = excerpt(raw.output)
      return out
    }
    const op = await party("operator")
    const cl = await party("client")
    const opRaw = sides.operator.raw.get(s)
    const clRaw = sides.client.raw.get(s)
    const version = (r: RawRecord) => canonicalJson({ i: r.input ?? null, o: r.output ?? null, t: r.tool ?? null })
    const versionsDiffer = Boolean(opRaw && clRaw) && version(opRaw!) !== version(clRaw!)
    const mismatch = (x: PartyStep) => x.provided && !x.matches
    // A step the chain does not anchor is always reported as such (FIND-02).
    const disputed = !chainOk || forced.has(s) || Boolean(op.claim || cl.claim) || versionsDiffer || mismatch(op) || mismatch(cl)

    let verdict: StepVerdict
    let finding: string
    const what = `${e?.action ?? "?"}${e?.tool ? " " + e.tool : ""}`
    if (!disputed) {
      verdict = "not_disputed"
      finding = op.matches || cl.matches ? `${what}: raw data provided by ${[op.matches && "the operator", cl.matches && "the client"].filter(Boolean).join(" and ")} matches the chain` : `${what}: on chain only (hashes), no raw data provided`
    } else if (!chainOk) {
      verdict = "no_anchor"
      finding = `The chain does not anchor this step (${chainProblems[0] ?? "unknown problem"}), so no version of it can be confirmed.`
    } else if (op.matches && cl.matches) {
      verdict = "both"
      finding = "Both versions match what the agent signed: on this step the parties hold the same record."
    } else if (op.matches) {
      verdict = "operator"
      finding = `The operator's version matches what the agent signed (${describe(op.check)}). ${cl.provided ? `The client's version does not (${describe(cl.check)}).` : "The client provided no raw data for this step."}`
    } else if (cl.matches) {
      verdict = "client"
      finding = `The client's version matches what the agent signed (${describe(cl.check)}). ${op.provided ? `The operator's version does not (${describe(op.check)}).` : "The operator provided no raw data for this step."}`
    } else {
      verdict = "neither"
      const said = [op.provided && `operator: ${describe(op.check)}`, cl.provided && `client: ${describe(cl.check)}`].filter(Boolean).join("; ")
      finding = said ? `No version provided matches what the agent signed (${said}). The chain shows only that this step happened, with these hashes.` : "Nobody provided raw data for this step. The chain shows only that it happened, with these hashes."
    }

    if (verdict === "operator" || verdict === "client") {
      const [w, o] = verdict === "operator" ? [op, cl] : [cl, op]
      const gap = uncovered(w.check, o.check)
      if (gap.length) finding += ` The ${verdict} gave no ${gap.join(" or ")} for this step: that part is confirmed for neither side.`
    }

    let toolRevealed: string | undefined
    if (e && String(e.tool).startsWith("h:")) {
      for (const [x, raw] of [[op, opRaw], [cl, clRaw]] as const) if (x.matches && x.check?.tool && typeof raw?.tool === "string") toolRevealed = raw.tool
    }
    steps.push({
      step: s,
      action: e?.action ?? "",
      tool: e?.tool ?? "",
      ...(toolRevealed !== undefined ? { tool_revealed: toolRevealed } : {}),
      note: e?.note ?? "",
      entry_hash: e?.entry_hash ?? "",
      chain_ok: chainOk,
      chain_problems: chainProblems,
      operator: op,
      client: cl,
      versions_differ: versionsDiffer,
      disputed,
      verdict,
      finding,
    })
  }

  const summary = { operator: 0, client: 0, both: 0, neither: 0, no_anchor: 0, not_disputed: 0, disputed: 0 }
  for (const x of steps) {
    summary[x.verdict] += 1
    if (x.disputed) summary.disputed += 1
  }
  const files: DisputeReport["files"] = {}
  for (const p of PARTIES) {
    const i = opts[p]
    if (i) files[p] = { name: i.name ?? `${p}.json`, sha256: i.sha256 ?? (await sha256(canonicalJson(i.file))), steps_provided: sides[p].raw.size, claims: sides[p].claims.size }
  }
  if (chain.verdict === "broken") warnings.unshift("The run itself does not verify (BROKEN): steps the chain cannot anchor are marked no_anchor.")
  if (chain.verdict === "open") warnings.unshift("The run has no run.end seal (OPEN): it may have been cut short.")

  const report: DisputeReport = {
    format: DISPUTE_FORMAT,
    created_at: (opts.now ?? new Date()).toISOString(),
    run: { agent_id: agentId, run_id: runId, signer: chain.signer, head: chain.head, chain_verdict: chain.verdict, sealed: chain.sealed, steps: chain.steps, source: bundle.source ?? null },
    files,
    summary,
    steps,
    warnings,
    caveats: CAVEATS,
  }
  report.report_hash = await disputeReportHash(report)
  return report
}

/** Hash that pins a report: SHA-256 of its canonical JSON without report_hash. */
export function disputeReportHash(r: DisputeReport): Promise<string> {
  const { report_hash: _omit, ...rest } = r
  return sha256(canonicalJson(rest))
}

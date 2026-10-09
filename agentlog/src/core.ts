// agentlog core: the entry format, hashing, signing and chain verification.
// No network and no Arkiv here: this file runs the same in Node, in the browser and offline,
// so an auditor can verify an exported run without trusting our page or the RPC.
//
// One entry = one action of an AI agent (an LLM call, a tool call, the start or the end of a run).
// Entries of a run form a hash chain: each entry carries the hash of the previous one, so removing,
// reordering or editing any entry breaks every link after it. Each entry is also signed by the
// agent's wallet (EIP-191), so an export stays verifiable after the Arkiv entities expire.

import { recoverMessageAddress } from "viem"
import type { Hex, LocalAccount } from "viem"

export const FORMAT = "agentlog/v1"
export const GENESIS: Hex = `0x${"0".repeat(64)}`
export const ACTION_START = "run.start"
export const ACTION_END = "run.end"

/** The signed part of an entry. Every field here goes into `entry_hash`. */
export interface EntryBody {
  v: 1
  agent_id: string
  run_id: string
  /** 0-based position in the run; run.start is 0. */
  step: number
  /** What happened: "run.start", "llm.call", "tool.call", "tool.error", "run.end", or your own. */
  action: string
  /** Tool or model name, e.g. "http_get" or "mistral-small-latest". */
  tool: string
  /** SHA-256 of the canonical JSON of the input. The input itself stays with the operator. */
  input_hash: Hex
  output_hash: Hex
  /** entry_hash of the previous step, GENESIS for step 0. */
  prev_entry_hash: Hex
  /** Unix milliseconds, as the agent's clock saw it. */
  timestamp: number
  /** The agent's wallet, lowercase. On Arkiv it must equal the entity's $creator. */
  signer: Hex
  /** Optional short public label. Never put secrets or personal data here: it is public. */
  note: string
}

export interface Entry extends EntryBody {
  entry_hash: Hex
  /** EIP-191 personal_sign of `agentlog:v1:<entry_hash>` by `signer`. */
  sig: Hex
}

// ---------- canonical JSON + hashing ----------

/**
 * Canonical JSON: object keys sorted, no whitespace, undefined fields dropped (as JSON.stringify
 * does), bigint written as a decimal string. The same value always gives the same bytes, so its
 * hash can be recomputed by anyone in any language that sorts keys the same way.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value)
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("canonicalJson: non-finite number")
    return JSON.stringify(value)
  }
  if (typeof value === "bigint") return JSON.stringify(value.toString())
  if (Array.isArray(value)) return `[${value.map((v) => (v === undefined ? "null" : canonicalJson(v))).join(",")}]`
  if (typeof value === "object") {
    const o = value as Record<string, unknown>
    const keys = Object.keys(o).filter((k) => o[k] !== undefined && typeof o[k] !== "function").sort()
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`).join(",")}}`
  }
  throw new Error(`canonicalJson: unsupported type ${typeof value}`)
}

export async function sha256(bytes: Uint8Array | string): Promise<Hex> {
  const data = typeof bytes === "string" ? new TextEncoder().encode(bytes) : bytes
  const d = await globalThis.crypto.subtle.digest("SHA-256", data as BufferSource)
  return `0x${[...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("")}`
}

/** Hash of any JSON-like value (tool input, tool output, LLM messages). */
export const hashValue = (value: unknown): Promise<Hex> => sha256(canonicalJson(value ?? null))

const BODY_FIELDS = ["v", "agent_id", "run_id", "step", "action", "tool", "input_hash", "output_hash", "prev_entry_hash", "timestamp", "signer", "note"] as const

export function bodyOf(e: EntryBody): EntryBody {
  const out: Record<string, unknown> = {}
  for (const k of BODY_FIELDS) out[k] = (e as unknown as Record<string, unknown>)[k]
  return out as unknown as EntryBody
}

export const entryHash = (body: EntryBody): Promise<Hex> => sha256(canonicalJson(bodyOf(body)))
export const signedMessage = (entryHashHex: Hex): string => `${FORMAT.replace("/", ":")}:${entryHashHex}`

// ---------- building entries ----------

const HEX32 = /^0x[0-9a-f]{64}$/
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/

export function checkId(id: string, what: string): string {
  if (!ID_RE.test(String(id ?? ""))) throw new Error(`${what}: 1-64 characters, letters, digits, dot, dash, underscore, colon`)
  return id
}

export interface NewEntry {
  agent_id: string
  run_id: string
  step: number
  action: string
  tool?: string
  input_hash: Hex
  output_hash: Hex
  prev_entry_hash: Hex
  timestamp?: number
  note?: string
}

/** Builds, hashes and signs one entry. `account` is a viem local account (privateKeyToAccount). */
export async function buildEntry(n: NewEntry, account: Pick<LocalAccount, "address" | "signMessage">): Promise<Entry> {
  checkId(n.agent_id, "agent_id")
  checkId(n.run_id, "run_id")
  if (!Number.isInteger(n.step) || n.step < 0) throw new Error("step must be a non-negative integer")
  for (const [k, v] of [["input_hash", n.input_hash], ["output_hash", n.output_hash], ["prev_entry_hash", n.prev_entry_hash]] as const) {
    if (!HEX32.test(v)) throw new Error(`${k} must be 0x + 64 lowercase hex`)
  }
  const note = String(n.note ?? "")
  if (new TextEncoder().encode(note).length > 280) throw new Error("note: at most 280 bytes")
  const body: EntryBody = {
    v: 1,
    agent_id: n.agent_id,
    run_id: n.run_id,
    step: n.step,
    action: String(n.action),
    tool: String(n.tool ?? ""),
    input_hash: n.input_hash,
    output_hash: n.output_hash,
    prev_entry_hash: n.prev_entry_hash,
    timestamp: n.timestamp ?? Date.now(),
    signer: account.address.toLowerCase() as Hex,
    note,
  }
  const h = await entryHash(body)
  const sig = await account.signMessage({ message: signedMessage(h) })
  return { ...body, entry_hash: h, sig }
}

// ---------- verification ----------

export interface StepCheck {
  step: number
  entry_hash: string
  ok: boolean
  problems: string[]
}

export interface RunReport {
  format: typeof FORMAT
  agent_id: string
  run_id: string
  signer: string
  /** intact: sealed and every check passed; open: every check passed but no run.end yet; broken: anything failed. */
  verdict: "intact" | "open" | "broken" | "empty"
  sealed: boolean
  steps: number
  head: string
  problems: string[]
  checks: StepCheck[]
}

export interface VerifyOptions {
  /** The wallet the auditor expects; defaults to the signer of step 0. */
  signer?: string
  /** Map entry_hash -> on-chain $creator, when the entries came from Arkiv. */
  creators?: Map<string, string>
}

/**
 * Verifies one run: recomputes every hash, recovers every signature, follows the prev links from
 * GENESIS, and reports gaps (a step deleted or expired), forks (two signed entries for one step),
 * edits (hash mismatch), foreign signers and entries after run.end.
 * Entries from wallets that are not the signer should be filtered out before (they are "forged");
 * if they are passed in anyway they fail the signer check.
 */
export async function verifyRun(entries: Entry[], opts: VerifyOptions = {}): Promise<RunReport> {
  const sorted = [...entries].sort((a, b) => a.step - b.step || String(a.entry_hash).localeCompare(String(b.entry_hash)))
  const signer = String(opts.signer || sorted[0]?.signer || "").toLowerCase()
  const report: RunReport = { format: FORMAT, agent_id: sorted[0]?.agent_id ?? "", run_id: sorted[0]?.run_id ?? "", signer, verdict: "empty", sealed: false, steps: 0, head: GENESIS, problems: [], checks: [] }
  if (!sorted.length) return report

  const byStep = new Map<number, Entry[]>()
  for (const e of sorted) byStep.set(e.step, [...(byStep.get(e.step) ?? []), e])
  const minStep = Math.min(0, ...sorted.map((e) => (Number.isInteger(e.step) ? e.step : 0)))
  const maxStep = Math.max(0, ...sorted.map((e) => (Number.isInteger(e.step) ? e.step : 0)))

  let prev: string = GENESIS
  let sealedAt = -1
  for (let s = minStep; s <= maxStep; s++) {
    const at = byStep.get(s)
    if (!at) {
      report.problems.push(`step ${s} is missing (deleted, expired or never written): the chain is broken here`)
      prev = "" // unknown, so the next link cannot be confirmed
      continue
    }
    if (at.length > 1) report.problems.push(`step ${s} has ${at.length} different entries (fork: the signer wrote two histories)`)
    for (const e of at) {
      const problems: string[] = []
      if (!Number.isInteger(e.step) || e.step < 0) problems.push(`step ${e.step} must be a non-negative integer`)
      if (e.v !== 1) problems.push(`unknown version ${e.v}`)
      if (e.agent_id !== report.agent_id || e.run_id !== report.run_id) problems.push("belongs to another agent or run")
      let recomputed: string
      try {
        recomputed = await entryHash(e)
      } catch (err) {
        recomputed = `invalid (${(err as Error).message})`
      }
      if (recomputed !== e.entry_hash) problems.push("content does not match entry_hash (edited after signing)")
      try {
        const rec = (await recoverMessageAddress({ message: signedMessage(e.entry_hash), signature: e.sig })).toLowerCase()
        if (rec !== String(e.signer).toLowerCase()) problems.push(`signature recovers to ${rec}, not the stated signer`)
      } catch {
        problems.push("signature is not a valid EIP-191 signature")
      }
      if (String(e.signer).toLowerCase() !== signer) problems.push(`signed by ${e.signer}, not by the expected agent wallet`)
      const creator = opts.creators?.get(String(e.entry_hash).toLowerCase())
      if (opts.creators && creator === undefined) problems.push("no Arkiv entity found for this entry")
      if (creator !== undefined && creator.toLowerCase() !== signer) problems.push(`Arkiv $creator is ${creator}, not the agent wallet`)
      if (prev === "") problems.push("previous step missing, link cannot be checked")
      else if (e.prev_entry_hash !== prev) problems.push(s === 0 ? "step 0 must point at GENESIS" : `prev_entry_hash does not match step ${s - 1}`)
      if (sealedAt >= 0) problems.push(`written after run.end (step ${sealedAt})`)
      if (s === 0 && e.action !== ACTION_START) problems.push(`step 0 should be ${ACTION_START}`)
      report.checks.push({ step: s, entry_hash: e.entry_hash, ok: problems.length === 0, problems })
    }
    const first = at[0]
    if (first.action === ACTION_END && sealedAt < 0) sealedAt = s
    prev = first.entry_hash
  }

  report.steps = maxStep + 1
  report.head = byStep.get(maxStep)![0].entry_hash
  report.sealed = sealedAt === maxStep
  const bad = report.checks.filter((c) => !c.ok).length
  if (bad) report.problems.push(`${bad} entr${bad === 1 ? "y fails" : "ies fail"} verification`)
  report.verdict = report.problems.length ? "broken" : report.sealed ? "intact" : "open"
  return report
}

// ---------- export bundle ----------

export interface ExportedEntry {
  entity_key?: string
  creator?: string
  /** Current owner: the agent, or the custodian it handed the entry to. */
  owner?: string
  created_at_block?: string
  expires_at_block?: string
  entry: Entry
}

export interface ExportBundle {
  format: "agentlog-export/v1"
  exported_at: string
  source: { network: string; chain_id: number; rpc: string; at_block: string } | null
  agent_id: string
  run_id: string
  signer: string
  entries: ExportedEntry[]
  /** Records that claim to belong to this run but were created by another wallet. Shown, never trusted. */
  foreign: ExportedEntry[]
  report: RunReport
}

/** Re-verifies an export offline: hashes, signatures, links, and the recorded $creator of each entry. */
export async function verifyExport(bundle: ExportBundle): Promise<RunReport> {
  if (!bundle || bundle.format !== "agentlog-export/v1" || !Array.isArray(bundle.entries)) throw new Error("not an agentlog-export/v1 file")
  const creators = new Map<string, string>()
  const withCreator = bundle.entries.filter((x) => x.creator)
  for (const x of withCreator) creators.set(String(x.entry.entry_hash).toLowerCase(), String(x.creator))
  return verifyRun(
    bundle.entries.map((x) => x.entry),
    { signer: bundle.signer, creators: withCreator.length ? creators : undefined },
  )
}

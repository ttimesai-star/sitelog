// Demo data: yesterday's runs of a release-checking agent, written through the real Recorder (real
// keys, real hashes, real signatures), and an "attacker" who edits the SQLite file afterwards.
// Used by `npm run demo`, `npm run seed`, `npm run tamper` and the tests.

import { Recorder, hashValue } from "agentlog"
import type { Entry } from "agentlog"
import type { SqliteStore } from "agentlog/sqlite"
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts"
import { buildEntry } from "agentlog"
import type { KeyRing } from "./keys.ts"
import { localDate } from "./audit.ts"

export const DEMO_AGENT = "release-checker"

/** UTC milliseconds of a wall-clock time on a local date in an IANA time zone. */
export function zonedTime(ymd: string, hh: number, mm: number, tz: string): number {
  const [y, m, d] = ymd.split("-").map(Number)
  let t = Date.UTC(y, m - 1, d, hh, mm)
  for (let i = 0; i < 2; i++) {
    const p = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }).formatToParts(new Date(t)).map((x) => [x.type, x.value]))
    const shown = Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), Number(p.hour), Number(p.minute))
    t += Date.UTC(y, m - 1, d, hh, mm) - shown
  }
  return t
}

type Step = { action: string; tool?: string; input?: unknown; output?: unknown; note?: string; at: number }

function runs(): { run_id: string; hh: number; mm: number; steps: Omit<Step, "at">[] }[] {
  return [
    {
      run_id: "run-morning-v1.4.2", hh: 9, mm: 14,
      steps: [
        { action: "run.start", input: { task: "Check release v1.4.2 before deploy", repo: "acme/shop" }, note: "Check release v1.4.2 before deploy" },
        { action: "llm.call", tool: "gpt-oss-20b", input: { messages: [{ role: "user", content: "Plan the release checks for v1.4.2" }] }, output: { plan: ["latest commit", "staging health", "tests"] }, note: "plan the checks" },
        { action: "tool.call", tool: "http_get", input: { url: "https://api.github.com/repos/acme/shop/commits/main" }, output: { status: 200, sha: "9f2c1e7", message: "Fix cart rounding" }, note: "GET latest commit" },
        { action: "tool.call", tool: "http_get", input: { url: "https://staging.acme.example/health" }, output: { status: 200, body: "ok" }, note: "GET staging health -> 200" },
        { action: "tool.call", tool: "run_tests", input: { suite: "e2e" }, output: { passed: 128, failed: 0 }, note: "e2e tests: 128 passed" },
        { action: "llm.call", tool: "gpt-oss-20b", input: { messages: [{ role: "user", content: "Summarize and decide" }] }, output: { decision: "approve", reason: "all checks green" }, note: "decide" },
        { action: "tool.call", tool: "post_report", input: { channel: "#releases", approved: true }, output: { ok: true }, note: "report: v1.4.2 approved" },
        { action: "run.end", output: { result: "approved" }, note: "run sealed" },
      ],
    },
    {
      run_id: "run-afternoon-v1.4.3", hh: 13, mm: 5,
      steps: [
        { action: "run.start", input: { task: "Check release v1.4.3 before deploy", repo: "acme/shop" }, note: "Check release v1.4.3 before deploy" },
        { action: "tool.call", tool: "http_get", input: { url: "https://api.github.com/repos/acme/shop/commits/main" }, output: { status: 200, sha: "b71d0a4", message: "New checkout flow" }, note: "GET latest commit" },
        { action: "tool.call", tool: "http_get", input: { url: "https://staging.acme.example/health" }, output: { status: 503, body: "upstream payment API timeout" }, note: "GET staging health -> 503" },
        { action: "tool.call", tool: "run_tests", input: { suite: "e2e" }, output: { passed: 119, failed: 9 }, note: "e2e tests: 9 failed" },
        { action: "llm.call", tool: "gpt-oss-20b", input: { messages: [{ role: "user", content: "Summarize and decide" }] }, output: { decision: "block", reason: "staging down, 9 tests failed" }, note: "decide" },
        { action: "tool.call", tool: "post_report", input: { channel: "#releases", approved: false }, output: { ok: true }, note: "report: v1.4.3 blocked" },
        { action: "run.end", output: { result: "blocked" }, note: "run sealed" },
      ],
    },
    {
      run_id: "run-night-deps", hh: 17, mm: 30,
      steps: [
        { action: "run.start", input: { task: "Audit dependencies for known vulnerabilities" }, note: "Audit dependencies for known vulnerabilities" },
        { action: "tool.call", tool: "npm_audit", input: { path: "." }, output: { high: 1, moderate: 3 }, note: "npm audit: 1 high" },
        { action: "tool.error", tool: "gpt-oss-20b", input: { messages: [{ role: "user", content: "Propose fixes" }] }, output: { error: "429 quota exceeded" }, note: "model quota exceeded" },
      ],
    },
  ]
}

/** Writes yesterday's demo runs (in tz) unless they are there already. Returns the run ids. */
export async function seedDemo(store: SqliteStore, keys: KeyRing, tz: string, now = Date.now(), force = false): Promise<string[]> {
  const ymd = (() => {
    const today = localDate(now, tz)
    const [y, m, d] = today.split("-").map(Number)
    return new Date(Date.UTC(y, m - 1, d - 1)).toISOString().slice(0, 10)
  })()
  if (force) store.db.prepare("DELETE FROM entries WHERE agent_id = ?").run(DEMO_AGENT)
  const existing = new Set((await store.listRuns({ agentId: DEMO_AGENT })).filter((r) => localDate(r.first_ts, tz) === ymd).map((r) => r.run_id))
  const ids: string[] = []
  for (const r of runs()) {
    const runId = `${r.run_id}-${ymd.replace(/-/g, "")}`
    ids.push(runId)
    if (existing.has(runId)) continue
    if ((await store.load(DEMO_AGENT, runId)).entries.length) continue
    let clock = zonedTime(ymd, r.hh, r.mm, tz)
    const rec = new Recorder({ store, signerFor: (a) => keys.signerFor(a), now: () => clock })
    for (const s of r.steps) {
      await rec.log({ agent_id: DEMO_AGENT, run_id: runId, ...s })
      clock += 4_000 + Math.floor(Math.random() * 9_000)
    }
  }
  return ids
}

export type TamperMode = "edit" | "delete" | "forge"

/**
 * The attacker: someone with write access to the SQLite file (an operator covering up, or an intruder)
 * rewrites the afternoon run so the failed health check reads 200. Without the agent's key the
 * signature cannot follow; the verifier finds the exact step.
 */
export async function tamperDemo(store: SqliteStore, q: { run_id?: string; step?: number; mode?: TamperMode } = {}) {
  const runs = await store.listRuns({ agentId: DEMO_AGENT })
  const runId = q.run_id ?? runs.find((r) => r.run_id.startsWith("run-afternoon-v1.4.3"))?.run_id
  if (!runId) throw new Error("no demo run to tamper with: seed first")
  const step = q.step ?? 2
  const mode: TamperMode = q.mode ?? "edit"
  const row = store.db.prepare("SELECT body, raw FROM entries WHERE agent_id = ? AND run_id = ? AND step = ?").get(DEMO_AGENT, runId, step) as { body: string; raw: string | null } | undefined
  if (!row) throw new Error(`run ${runId} has no step ${step}`)
  const e = JSON.parse(row.body) as Entry
  const fakeOutput = { status: 200, body: "ok" }
  if (mode === "delete") {
    store.db.prepare("DELETE FROM entries WHERE agent_id = ? AND run_id = ? AND step = ?").run(DEMO_AGENT, runId, step)
  } else if (mode === "forge") {
    const intruder = privateKeyToAccount(generatePrivateKey())
    const forged = await buildEntry({ ...e, output_hash: await hashValue(fakeOutput), note: "GET staging health -> 200" }, intruder)
    store.db.prepare("UPDATE entries SET body = ?, entry_hash = ?, raw = ? WHERE agent_id = ? AND run_id = ? AND step = ?").run(JSON.stringify(forged), forged.entry_hash, JSON.stringify({ ...(row.raw ? JSON.parse(row.raw) : {}), output: fakeOutput }), DEMO_AGENT, runId, step)
  } else {
    const edited = { ...e, output_hash: await hashValue(fakeOutput), note: "GET staging health -> 200" }
    store.db.prepare("UPDATE entries SET body = ?, raw = ? WHERE agent_id = ? AND run_id = ? AND step = ?").run(JSON.stringify(edited), JSON.stringify({ ...(row.raw ? JSON.parse(row.raw) : {}), output: fakeOutput }), DEMO_AGENT, runId, step)
  }
  return { tampered: true, mode, agent_id: DEMO_AGENT, run_id: runId, step, what: mode === "delete" ? `deleted step ${step}` : `rewrote step ${step}: staging health 503 -> 200${mode === "forge" ? ", re-signed with an intruder's key" : ""}` }
}

/** The client's own copy of what it received from the afternoon run (for diff_versions). */
export async function demoClientFile(store: SqliteStore) {
  const runs = await store.listRuns({ agentId: DEMO_AGENT })
  const runId = runs.find((r) => r.run_id.startsWith("run-afternoon-v1.4.3"))?.run_id
  return {
    party: "client",
    agent_id: DEMO_AGENT,
    run_id: runId,
    entries: [
      { step: 2, raw: { output: { status: 503, body: "upstream payment API timeout" } }, claim: "Our monitor saw staging down during the check." },
      { step: 5, raw: { input: { channel: "#releases", approved: false } }, claim: "The report we received said the release was blocked." },
    ],
  }
}

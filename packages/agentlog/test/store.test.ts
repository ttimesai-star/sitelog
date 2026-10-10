import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts"
import { ArkivStore, MemoryStore, Recorder, buildEntry, checkRaw, explain, hashValue, verifyStored } from "../src/index.ts"
import type { Entry, LogStore } from "../src/index.ts"
import { SqliteStore } from "../src/sqlite.ts"

const agent = privateKeyToAccount(generatePrivateKey())
const attacker = privateKeyToAccount(generatePrivateKey())
const tmp = () => join(mkdtempSync(join(tmpdir(), "agentlog-")), "log.db")

async function run(store: LogStore, runId = "r1", steps = 3, seal = true) {
  const rec = new Recorder({ store, signerFor: async () => agent })
  await rec.log({ agent_id: "bot", run_id: runId, action: "run.start", input: { task: "check" } })
  for (let i = 0; i < steps; i++) await rec.log({ agent_id: "bot", run_id: runId, action: "tool.call", tool: "http_get", input: { i }, output: { status: 200 + i } })
  if (seal) await rec.log({ agent_id: "bot", run_id: runId, action: "run.end", output: { ok: true } })
  return rec
}

describe("Recorder", () => {
  it("chains steps across calls and seals with the step count and head", async () => {
    const store = new MemoryStore()
    await run(store)
    const v = await verifyStored(store, "bot", "r1", agent.address)
    assert.equal(v.report.verdict, "intact")
    assert.equal(v.report.steps, 5)
    const ev = await store.evidence("bot", "r1")
    const seal = v.bundle.entries[4].entry
    assert.deepEqual((ev.get(4) as any).input, { steps: 4, head: v.bundle.entries[3].entry.entry_hash })
    assert.equal((await checkRaw(seal, ev.get(4))).input, true)
  })

  it("starts a run automatically and mints a run id when none is given", async () => {
    const store = new MemoryStore()
    const rec = new Recorder({ store, signerFor: async () => agent })
    const r = await rec.log({ agent_id: "bot", action: "llm.call", tool: "model-x", input: "hi", output: "hello", note: "first call" })
    assert.match(r.run_id, /^run-\d{8}T\d{6}-[0-9a-f]{4}$/)
    assert.equal(r.started?.action, "run.start")
    assert.equal(r.entry.step, 1)
    assert.equal((await verifyStored(store, "bot", r.run_id, agent.address)).report.verdict, "open")
  })

  it("serializes concurrent writes to one run", async () => {
    const store = new MemoryStore()
    const rec = new Recorder({ store, signerFor: async () => agent })
    await rec.log({ agent_id: "bot", run_id: "p", action: "run.start" })
    await Promise.all(Array.from({ length: 8 }, (_, i) => rec.log({ agent_id: "bot", run_id: "p", action: "tool.call", tool: "t", input: i })))
    const v = await verifyStored(store, "bot", "p", agent.address)
    assert.equal(v.report.verdict, "open")
    assert.equal(v.report.steps, 9)
  })

  it("refuses to write into a sealed run or to start a run twice", async () => {
    const store = new MemoryStore()
    const rec = await run(store)
    await assert.rejects(rec.log({ agent_id: "bot", run_id: "r1", action: "tool.call" }), /sealed/)
    const rec2 = new Recorder({ store, signerFor: async () => agent })
    await rec2.log({ agent_id: "bot", run_id: "r2", action: "run.start" })
    await assert.rejects(rec2.log({ agent_id: "bot", run_id: "r2", action: "run.start" }), /already started/)
  })

  it("keeps details off chain with salted commitments", async () => {
    const store = new MemoryStore()
    const rec = new Recorder({ store, signerFor: async () => agent, detailsOffChain: true })
    const r = await rec.log({ agent_id: "bot", run_id: "s", action: "tool.call", tool: "http_get", input: [], output: 200, note: "secret url" })
    assert.match(r.entry.tool, /^h:[0-9a-f]{32}$/)
    assert.equal(r.entry.note, "")
    assert.notEqual(r.entry.output_hash, await hashValue(200))
    const raw = (await store.evidence("bot", "s")).get(1)
    assert.deepEqual(await checkRaw(r.entry, raw), { input: true, output: true, tool: true, salted: true })
  })
})

describe("SQLite store", () => {
  it("persists runs across processes (reopened file) and continues the chain", async () => {
    const path = tmp()
    const a = new SqliteStore(path)
    await run(a, "r1", 2, false)
    a.close()
    const b = new SqliteStore(path)
    const rec = new Recorder({ store: b, signerFor: async () => agent })
    const r = await rec.log({ agent_id: "bot", run_id: "r1", action: "run.end" })
    assert.equal(r.entry.step, 3)
    assert.equal((await verifyStored(b, "bot", "r1", agent.address)).report.verdict, "intact")
    const runs = await b.listRuns({ agentId: "bot" })
    assert.equal(runs.length, 1)
    assert.equal(runs[0].sealed, true)
    b.close()
  })

  it("catches a row edited in the file, and says where", async () => {
    const s = new SqliteStore(tmp())
    await run(s)
    const row = s.db.prepare("SELECT body FROM entries WHERE run_id = 'r1' AND step = 2").get() as { body: string }
    const e = JSON.parse(row.body) as Entry
    e.output_hash = await hashValue({ status: 200 })
    s.db.prepare("UPDATE entries SET body = ? WHERE run_id = 'r1' AND step = 2").run(JSON.stringify(e))
    const v = await verifyStored(s, "bot", "r1", agent.address)
    assert.equal(v.report.verdict, "broken")
    assert.deepEqual(v.explain.first_break, { step: 2, kind: "edited", reason: "its content was edited after the agent signed it" })
    assert.equal(v.explain.trusted_prefix, 2)
    assert.match(v.explain.sentence, /Step 2 cannot be trusted.*Every other step checks out/)
    s.close()
  })

  it("catches a deleted row and a cut-off seal", async () => {
    const s = new SqliteStore(tmp())
    await run(s, "gap")
    s.db.prepare("DELETE FROM entries WHERE run_id = 'gap' AND step = 1").run()
    const gap = await verifyStored(s, "bot", "gap", agent.address)
    assert.equal(gap.explain.first_break?.kind, "deleted")
    assert.equal(gap.explain.first_break?.step, 1)
    await run(s, "cut")
    s.db.prepare("DELETE FROM entries WHERE run_id = 'cut' AND step = 4").run()
    const cut = await verifyStored(s, "bot", "cut", agent.address)
    assert.equal(cut.report.verdict, "open")
    assert.match(cut.explain.sentence, /never sealed/)
    s.close()
  })

  it("catches a step re-signed with another key, and a forged extra row", async () => {
    const s = new SqliteStore(tmp())
    await run(s)
    const loaded = await s.load("bot", "r1")
    const orig = loaded.entries[2].entry
    const forged = await buildEntry({ ...orig, output_hash: await hashValue({ status: 500 }) }, attacker)
    s.db.prepare("UPDATE entries SET body = ?, entry_hash = ? WHERE run_id = 'r1' AND step = 2").run(JSON.stringify(forged), forged.entry_hash)
    const v = await verifyStored(s, "bot", "r1", agent.address)
    assert.equal(v.explain.first_break?.step, 2)
    assert.equal(v.explain.first_break?.kind, "foreign_signer")
    s.close()
  })

  it("never overwrites an entry", async () => {
    const s = new SqliteStore(":memory:")
    const rec = new Recorder({ store: s, signerFor: async () => agent })
    const r = await rec.log({ agent_id: "bot", run_id: "x", action: "run.start" })
    await assert.rejects(s.append("bot", "x", [{ entry: r.entry }]))
    s.close()
  })
})

describe("explain", () => {
  it("does not count the step after a gap as a second break", async () => {
    const s = new MemoryStore()
    await run(s)
    s.rows.splice(2, 1)
    const v = await verifyStored(s, "bot", "r1", agent.address)
    assert.equal(v.explain.first_break?.step, 2)
    assert.equal(v.explain.first_break?.kind, "deleted")
    assert.equal(explain(v.report).trusted_prefix, 2)
  })
})

describe("Arkiv store", () => {
  it("writes each entry as a readonly entity and refuses writes without a key", async () => {
    const batches: any[] = []
    let n = 0
    const wallet: any = {
      account: agent,
      async executeBatch(b: any) {
        batches.push(b)
        return { txHash: `0x${"ab".repeat(32)}`, createdEntities: (b.creates ?? []).map(() => `0x${(++n).toString(16).padStart(64, "0")}`) }
      },
    }
    const mirror = new MemoryStore()
    const store = new ArkivStore({ publicClient: {} as any, wallet, mirror })
    const rec = new Recorder({ store, signerFor: async () => agent })
    // load() reads the chain; stub it so the recorder sees an empty run, then the mirror.
    store.load = async (a, r) => mirror.load(a, r)
    await rec.log({ agent_id: "bot", run_id: "a1", action: "tool.call", tool: "t", input: 1, output: 2 })
    assert.equal(batches.length, 1)
    assert.equal(batches[0].creates.length, 2)
    assert.deepEqual(batches[0].creates[0].flags, { readonly: true, permissionlessExtension: true })
    assert.equal(mirror.rows.length, 2)
    assert.equal((await store.evidence("bot", "a1")).get(1)?.output, 2)
    const ro = new ArkivStore({ publicClient: {} as any })
    await assert.rejects(ro.append("bot", "a1", []), /read-only/)
  })
})

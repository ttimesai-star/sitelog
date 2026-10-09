import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts"
import {
  ACTION_END, AgentLog, GENESIS, buildEntry, canonicalJson, entryParams, hashValue, resumeState, verifyExport, verifyRun,
} from "../agentlog/src/index.ts"
import type { Entry, ExportBundle } from "../agentlog/src/index.ts"

const agent = privateKeyToAccount(generatePrivateKey())
const other = privateKeyToAccount(generatePrivateKey())

async function chain(n: number, acct = agent, sealed = true): Promise<Entry[]> {
  const out: Entry[] = []
  let prev = GENESIS
  for (let i = 0; i < n; i++) {
    const action = i === 0 ? "run.start" : sealed && i === n - 1 ? ACTION_END : "tool.call"
    const e = await buildEntry({ agent_id: "test-agent", run_id: "r1", step: i, action, tool: "t", input_hash: await hashValue({ i }), output_hash: await hashValue(i * 2), prev_entry_hash: prev, timestamp: 1_760_000_000_000 + i }, acct)
    out.push(e)
    prev = e.entry_hash
  }
  return out
}

// A stand-in for the Arkiv wallet client: records batches, mints fake keys.
function fakeWallet(acct = agent) {
  const batches: any[] = []
  let n = 0
  const wallet: any = {
    account: acct,
    async executeBatch(b: any) {
      batches.push(b)
      const createdEntities = (b.creates ?? []).map(() => `0x${(++n).toString(16).padStart(64, "0")}`)
      return { txHash: `0x${"ab".repeat(32)}`, createdEntities, extendedEntities: (b.extensions ?? []).map((x: any) => x.entityKey) }
    },
  }
  return { wallet, batches }
}

describe("canonical JSON and hashes", () => {
  it("sorts keys at every level and drops undefined", () => {
    assert.equal(canonicalJson({ b: 1, a: { d: [1, { z: 1, y: 2 }], c: undefined } }), '{"a":{"d":[1,{"y":2,"z":1}]},"b":1}')
  })
  it("gives the same hash for the same value regardless of key order", async () => {
    assert.equal(await hashValue({ x: 1, y: "a" }), await hashValue({ y: "a", x: 1 }))
    assert.notEqual(await hashValue({ x: 1 }), await hashValue({ x: 2 }))
  })
  it("matches a known SHA-256 vector", async () => {
    // sha256('"abc"'), the canonical JSON of the string abc
    assert.equal(await hashValue("abc"), "0x6cc43f858fbb763301637b5af970e2a46b46f461f27e5a0f41e009c59b827b25")
  })
  it("rejects values JSON cannot represent", () => {
    assert.throws(() => canonicalJson({ x: Infinity }), /non-finite/)
  })
})

describe("verifyRun", () => {
  it("an untouched sealed run is intact", async () => {
    const r = await verifyRun(await chain(5))
    assert.equal(r.verdict, "intact")
    assert.equal(r.steps, 5)
    assert.equal(r.sealed, true)
  })
  it("an unsealed run is open, not broken", async () => {
    const r = await verifyRun(await chain(3, agent, false))
    assert.equal(r.verdict, "open")
  })
  it("detects an edited field", async () => {
    const es = await chain(4)
    es[2] = { ...es[2], output_hash: (await hashValue("forged output")) }
    const r = await verifyRun(es)
    assert.equal(r.verdict, "broken")
    assert.match(r.checks[2].problems.join(), /edited after signing/)
  })
  it("detects an edit that also recomputes entry_hash (signature and next link fail)", async () => {
    const es = await chain(4)
    const forged = await buildEntry({ ...es[1], tool: "rm -rf", timestamp: es[1].timestamp }, other)
    es[1] = { ...forged, signer: es[1].signer, sig: es[1].sig }
    const r = await verifyRun(es)
    assert.equal(r.verdict, "broken")
    assert.ok(r.checks[1].problems.length > 0)
    assert.match(r.checks[2].problems.join(), /prev_entry_hash does not match/)
  })
  it("detects a deleted step (gap)", async () => {
    const es = await chain(5)
    es.splice(2, 1)
    const r = await verifyRun(es)
    assert.equal(r.verdict, "broken")
    assert.match(r.problems.join(), /step 2 is missing/)
  })
  it("detects a fork: two signed entries for one step", async () => {
    const es = await chain(3, agent, false)
    const alt = await buildEntry({ ...es[1], tool: "other", timestamp: es[1].timestamp + 1 }, agent)
    const r = await verifyRun([...es, alt])
    assert.equal(r.verdict, "broken")
    assert.match(r.problems.join(), /fork/)
  })
  it("rejects entries signed by another wallet", async () => {
    const r = await verifyRun(await chain(3, other), { signer: agent.address })
    assert.equal(r.verdict, "broken")
    assert.match(r.checks[0].problems.join(), /not by the expected agent wallet/)
  })
  it("rejects a forged signature field", async () => {
    const es = await chain(3)
    const fake = await buildEntry({ ...es[1] }, other)
    es[1] = { ...es[1], sig: fake.sig }
    const r = await verifyRun(es)
    assert.match(r.checks[1].problems.join(), /signature recovers to/)
  })
  it("flags entries after run.end", async () => {
    const es = await chain(3)
    const after = await buildEntry({ ...es[2], step: 3, action: "tool.call", prev_entry_hash: es[2].entry_hash }, agent)
    const r = await verifyRun([...es, after])
    assert.match(r.checks[3].problems.join(), /after run.end/)
  })
  it("checks the on-chain $creator when given", async () => {
    const es = await chain(2)
    const creators = new Map(es.map((e) => [e.entry_hash, agent.address.toLowerCase()]))
    creators.set(es[1].entry_hash, other.address.toLowerCase())
    const r = await verifyRun(es, { creators })
    assert.match(r.checks[1].problems.join(), /\$creator/)
  })
})

describe("export bundle", () => {
  it("verifies offline and catches a tampered export", async () => {
    const es = await chain(4)
    const bundle: ExportBundle = {
      format: "agentlog-export/v1", exported_at: "", source: null, agent_id: "test-agent", run_id: "r1", signer: agent.address.toLowerCase(),
      entries: es.map((entry, i) => ({ entity_key: `0x${i}`, creator: agent.address.toLowerCase(), entry })), foreign: [], report: await verifyRun(es),
    }
    assert.equal((await verifyExport(bundle)).verdict, "intact")
    const copy = JSON.parse(JSON.stringify(bundle))
    copy.entries[1].entry.note = "edited later"
    assert.equal((await verifyExport(copy)).verdict, "broken")
    assert.rejects(() => verifyExport({ format: "nope" } as any))
  })
})

describe("Arkiv entity parameters", () => {
  it("are readonly, extendable by anyone, and queryable by run, step and hash", async () => {
    const [e] = await chain(1, agent, false)
    const p = entryParams(e)
    assert.deepEqual(p.flags, { readonly: true, permissionlessExtension: true })
    assert.equal(p.attributes.app.value, "agentlog")
    assert.equal(p.attributes.kind.value, "step")
    assert.equal(p.attributes.run.value, "r1")
    assert.equal(p.attributes.step.value, 0n)
    assert.equal(p.attributes.entry.value, e.entry_hash)
    assert.equal(p.attributes.prev.value, GENESIS)
    assert.equal(p.contentType, "application/json")
  })
})

describe("AgentLog writer", () => {
  it("chains steps, wraps tools (results and errors) and seals atomically with retention", async () => {
    const { wallet, batches } = fakeWallet()
    const log = new AgentLog({ wallet, account: agent, agentId: "test-agent", runId: "r2" })
    await log.start({ task: "demo" })
    const add = log.wrap("add", async (a: number, b: number) => a + b)
    assert.equal(await add(2, 3), 5)
    const boom = log.wrap("boom", async () => {
      throw new Error("tool failed")
    })
    await assert.rejects(boom(), /tool failed/)
    await log.seal({ ok: true })
    const es = log.entries.map((l) => l.entry)
    assert.deepEqual(es.map((e) => e.action), ["run.start", "tool.call", "tool.error", "run.end"])
    assert.equal(es[1].input_hash, await hashValue([2, 3]))
    assert.equal(es[1].output_hash, await hashValue(5))
    assert.equal((await verifyRun(es)).verdict, "intact")
    // batchSize 1: one tx per step, then the seal batch creates run.end and extends the 3 earlier entries.
    assert.equal(batches.length, 4)
    assert.equal(batches[3].creates.length, 1)
    assert.equal(batches[3].extensions.length, 3)
    assert.ok(log.entries.every((l) => l.entity_key))
    assert.throws(() => log.start({}), /first entry/)
    await assert.rejects(log.record({ action: "x" }), /sealed/)
  })

  it("records parallel tool calls in call order", async () => {
    const { wallet } = fakeWallet()
    const log = new AgentLog({ wallet, account: agent, agentId: "test-agent", runId: "r3", batchSize: 10 })
    await log.start(null)
    const slow = log.wrap("slow", (ms: number) => new Promise<number>((r) => setTimeout(() => r(ms), ms)))
    await Promise.all([slow(30), slow(1)])
    await log.seal()
    const r = await verifyRun(log.entries.map((l) => l.entry))
    assert.equal(r.verdict, "intact")
  })

  it("hands ownership to a custodian in the batch that creates the entries", async () => {
    const { wallet, batches } = fakeWallet()
    const custodian = other.address
    let salt = 0n
    const publicClient: any = { predictEntityKeys: async ({ count }: { count: number }) => Array.from({ length: count }, () => ({ key: `0x${(++salt).toString(16).padStart(64, "0")}`, salt })) }
    const log = new AgentLog({ wallet, publicClient, account: agent, agentId: "test-agent", runId: "r4", custodian, batchSize: 2 })
    await log.start(null)
    await log.record({ action: "tool.call", tool: "x" })
    assert.equal(batches[0].creates.length, 2)
    assert.equal(batches[0].ownershipChanges.length, 2)
    assert.equal(batches[0].ownershipChanges[0].newOwner, custodian)
    assert.equal(batches[0].creates[0].salt, 1n)
    assert.equal(batches[0].ownershipChanges[0].entityKey, `0x${"1".padStart(64, "0")}`)
  })

  it("resumes a run from saved entries", async () => {
    const es = await chain(3, agent, false)
    const st = resumeState(es)
    assert.equal(st.step, 3)
    assert.equal(st.prev, es[2].entry_hash)
    const { wallet } = fakeWallet()
    const log = new AgentLog({ wallet, account: agent, agentId: "test-agent", runId: "r1", resume: st })
    await log.record({ action: "tool.call", tool: "t" })
    await log.seal()
    assert.equal((await verifyRun([...es, ...log.entries.map((l) => l.entry)])).verdict, "intact")
  })

  it("refuses an account that is not the wallet's", () => {
    const { wallet } = fakeWallet(other)
    assert.throws(() => new AgentLog({ wallet, account: agent, agentId: "a", runId: "b" }), /wallet's account/)
  })
})

describe("evidence snapshots", () => {
  it("keeps the input as it was when hashed, even if the agent mutates it later", async () => {
    const { wallet } = fakeWallet()
    const log = new AgentLog({ wallet, account: agent, agentId: "test-agent", runId: "r5" })
    const messages = [{ role: "user", content: "hi" }]
    await log.start(null)
    const l = await log.record({ action: "llm.call", tool: "m", input: { messages }, output: "ok" })
    messages.push({ role: "assistant", content: "later" })
    assert.equal(await hashValue(l.raw!.input), l.entry.input_hash)
  })
})

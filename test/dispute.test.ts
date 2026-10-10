import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts"
import {
  AgentLog, checkRaw, commitTool, commitValue, disputeReportHash, hashValue, replayDispute, verifyRun,
} from "../agentlog/src/index.ts"
import type { ExportBundle, Landed } from "../agentlog/src/index.ts"

const agent = privateKeyToAccount(generatePrivateKey())

function fakeWallet(acct = agent) {
  let n = 0
  const wallet: any = {
    account: acct,
    async executeBatch(b: any) {
      const createdEntities = (b.creates ?? []).map(() => `0x${(++n).toString(16).padStart(64, "0")}`)
      return { txHash: `0x${"ab".repeat(32)}`, createdEntities, extendedEntities: [] }
    },
  }
  return wallet
}

// A small sealed run written through the real writer (fake chain), plus its export and evidence.
async function run(opts: { detailsOffChain?: boolean } = {}) {
  const log = new AgentLog({ wallet: fakeWallet(), account: agent, agentId: "pay-agent", runId: "r1", ...opts })
  await log.start({ task: "pay invoice 17" })
  const lookup = log.wrap("invoice_lookup", async (id: number) => ({ id, amount: 120, currency: "EUR" }))
  const pay = log.wrap("send_payment", async (to: string, amount: number) => ({ ok: true, to, amount, ref: "tx-1" }))
  const inv = await lookup(17)
  await pay("ACME", inv.amount)
  await log.seal({ summary: "paid 120 EUR to ACME" })
  const bundle: ExportBundle = {
    format: "agentlog-export/v1", exported_at: new Date(0).toISOString(), source: null,
    agent_id: "pay-agent", run_id: "r1", signer: agent.address.toLowerCase(),
    entries: log.entries.map((l) => ({ entry: l.entry, creator: agent.address.toLowerCase() })),
    foreign: [], report: await verifyRun(log.entries.map((l) => l.entry)),
  }
  const evidence = log.evidence()
  return { log, bundle, evidence }
}
const clone = <T,>(v: T): T => JSON.parse(JSON.stringify(v))
const partyFrom = (entries: Landed[], steps?: number[]) => ({ entries: entries.filter((l) => !steps || steps.includes(l.entry.step)).map((l) => ({ step: l.entry.step, raw: clone(l.raw) })) })

describe("dispute replay", () => {
  it("gives one verdict per disputed step: operator, client, both, neither", async () => {
    const { bundle, evidence } = await run()
    const operator = partyFrom(evidence.entries)
    // The operator edits the payment result afterwards; the client edits the invoice lookup.
    operator.entries[2].raw!.output = { ok: true, to: "ACME", amount: 1200, ref: "tx-1" }
    const client = partyFrom(evidence.entries, [1, 2, 3])
    client.entries[0].raw!.output = { id: 17, amount: 12, currency: "EUR" }
    ;(client.entries[2] as any).claim = "we agree the run was sealed"
    // Step 0: both provide a wrong task: neither matches.
    operator.entries[0].raw!.input = { task: "pay invoice 18" }
    ;(client.entries as any[]).unshift({ step: 0, raw: { input: { task: "pay invoice 19" } } })

    const r = await replayDispute(bundle, { operator: { file: operator }, client: { file: client } })
    const v = Object.fromEntries(r.steps.map((s) => [s.step, s.verdict]))
    assert.deepEqual(v, { 0: "neither", 1: "operator", 2: "client", 3: "both" })
    assert.equal(r.run.chain_verdict, "intact")
    assert.deepEqual({ ...r.summary }, { operator: 1, client: 1, both: 1, neither: 1, no_anchor: 0, not_disputed: 0, disputed: 4 })
    assert.match(r.steps[1].finding, /client's version does not \(input matches, output does not match\)/)
    assert.equal(r.steps[3].client.claim, "we agree the run was sealed")
  })

  it("a step only the operator holds, matching, is not disputed", async () => {
    const { bundle, evidence } = await run()
    const r = await replayDispute(bundle, { operator: { file: partyFrom(evidence.entries) } })
    assert.ok(r.steps.every((s) => s.verdict === "not_disputed"))
    assert.equal(r.summary.disputed, 0)
  })

  it("forces a step into the dispute on request, and reports a step nobody holds as neither", async () => {
    const { bundle } = await run()
    const r = await replayDispute(bundle, { steps: [2] })
    // The report covers every step of the run (what the agent did), and judges the disputed ones.
    assert.equal(r.steps.length, 4)
    const s2 = r.steps.find((s) => s.step === 2)!
    assert.equal(s2.verdict, "neither")
    assert.match(s2.finding, /Nobody provided raw data/)
    assert.equal(r.summary.disputed, 1)
  })

  it("a step the chain does not anchor cannot be confirmed for anyone", async () => {
    const { bundle, evidence } = await run()
    const cut = clone(bundle)
    cut.entries.splice(2, 1) // step 2 deleted from the record
    const r = await replayDispute(cut, { operator: { file: partyFrom(evidence.entries) } })
    assert.equal(r.run.chain_verdict, "broken")
    const s2 = r.steps.find((s) => s.step === 2)!
    assert.equal(s2.verdict, "no_anchor")
    assert.match(s2.chain_problems[0], /missing/)
    // Step 3 is fine itself but its link to step 2 cannot be checked: no anchor either.
    assert.equal(r.steps.find((s) => s.step === 3)!.verdict, "no_anchor")
    assert.match(r.warnings[0], /BROKEN/)
  })

  it("does not trust the report field of the bundle", async () => {
    const { bundle, evidence } = await run()
    const forged = clone(bundle)
    forged.entries[1].entry.output_hash = await hashValue({ id: 17, amount: 12, currency: "EUR" })
    forged.report.verdict = "intact"
    const client = { entries: [{ step: 1, raw: { output: { id: 17, amount: 12, currency: "EUR" } } }] }
    const r = await replayDispute(forged, { client: { file: client }, operator: { file: partyFrom(evidence.entries, [1]) } })
    assert.equal(r.run.chain_verdict, "broken")
    assert.equal(r.steps.find((s) => s.step === 1)!.verdict, "no_anchor")
  })

  it("warns about a file of another run, a duplicated step and a mislabelled party", async () => {
    const { bundle, evidence } = await run()
    const f = { party: "client", run_id: "r9", entries: [...partyFrom(evidence.entries, [1]).entries, ...partyFrom(evidence.entries, [1]).entries] }
    const r = await replayDispute(bundle, { operator: { file: f } })
    assert.ok(r.warnings.some((w) => /run r9/.test(w)))
    assert.ok(r.warnings.some((w) => /appears twice/.test(w)))
    assert.ok(r.warnings.some((w) => /says party "client"/.test(w)))
  })

  it("rejects a file that is not a party file", async () => {
    const { bundle } = await run()
    await assert.rejects(replayDispute(bundle, { client: { file: { entries: "nope" } as any } }), /entries/)
  })

  it("keeps raw data out of the report unless excerpts are asked for", async () => {
    const { bundle, evidence } = await run()
    const op = partyFrom(evidence.entries)
    const plain = JSON.stringify(await replayDispute(bundle, { operator: { file: op }, steps: [2] }))
    assert.ok(!plain.includes("ACME"))
    const withEx = await replayDispute(bundle, { operator: { file: op }, steps: [2], includeExcerpts: true })
    assert.match(withEx.steps.find((s) => s.step === 2)!.operator.excerpt!, /ACME/)
  })

  it("pins the report with a hash that changes when the report changes", async () => {
    const { bundle, evidence } = await run()
    const r = await replayDispute(bundle, { operator: { file: partyFrom(evidence.entries) }, steps: [1], now: new Date(0) })
    assert.equal(r.report_hash, await disputeReportHash(r))
    const edited = clone(r)
    edited.steps[1].verdict = "client"
    assert.notEqual(await disputeReportHash(edited), r.report_hash)
  })

  it("replays the published demo dispute: step 2 both, step 4 operator, step 8 client", async () => {
    const dir = "public/demo/runs/run-20261009T152956"
    const read = (f: string) => JSON.parse(readFileSync(f, "utf8"))
    const r = await replayDispute(read(`${dir}.export.json`), { operator: { file: read(`${dir}.dispute-operator.json`) }, client: { file: read(`${dir}.dispute-client.json`) } })
    assert.equal(r.run.chain_verdict, "intact")
    const disputed = Object.fromEntries(r.steps.filter((s) => s.disputed).map((s) => [s.step, s.verdict]))
    assert.deepEqual(disputed, { 2: "both", 4: "operator", 8: "client" })
    assert.deepEqual(r.warnings, [])
  })
})

describe("details off chain (salted commitments)", () => {
  it("puts no note, no tool name and no guessable hash on chain", async () => {
    const { log } = await run({ detailsOffChain: true })
    for (const l of log.entries) {
      assert.equal(l.entry.note, "")
      if (l.entry.action === "tool.call") assert.match(l.entry.tool, /^h:[0-9a-f]{32}$/)
      // Hashing the plain value (the guess an outsider would make) does not give the on-chain hash.
      assert.notEqual(await hashValue(l.raw!.output), l.entry.output_hash)
      assert.equal(await commitValue(l.raw!.output, l.raw!.salt!), l.entry.output_hash)
      assert.match(l.raw!.salt!, /^0x[0-9a-f]{64}$/)
    }
    assert.equal(log.entries[1].raw!.tool, "invoice_lookup")
    assert.equal(await commitTool("invoice_lookup", log.entries[1].raw!.salt!), log.entries[1].entry.tool)
    assert.equal(new Set(log.entries.map((l) => l.raw!.salt)).size, log.entries.length)
    // The chain itself still verifies.
    assert.equal((await verifyRun(log.entries.map((l) => l.entry))).verdict, "intact")
  })

  it("checkRaw opens commitments with the salt and refuses a wrong value or tool", async () => {
    const { log } = await run({ detailsOffChain: true })
    const l = log.entries[2]
    assert.deepEqual(await checkRaw(l.entry, l.raw), { input: true, output: true, tool: true, salted: true })
    assert.deepEqual(await checkRaw(l.entry, { ...l.raw, output: { ok: false } }), { input: true, output: false, tool: true, salted: true })
    assert.equal((await checkRaw(l.entry, { ...l.raw, tool: "other_tool" })).tool, false)
    assert.deepEqual(await checkRaw(l.entry, { output: l.raw!.output }), { input: null, output: false, tool: null, salted: false })
  })

  it("a dispute over an off-chain run reveals the tool name of the matching version", async () => {
    const { bundle, evidence } = await run({ detailsOffChain: true })
    const client = partyFrom(evidence.entries, [2])
    client.entries[0].raw!.output = { ok: true, to: "EVIL", amount: 120, ref: "tx-1" }
    const r = await replayDispute(bundle, { operator: { file: partyFrom(evidence.entries) }, client: { file: client } })
    const s2 = r.steps.find((s) => s.step === 2)!
    assert.equal(s2.verdict, "operator")
    assert.equal(s2.tool_revealed, "send_payment")
  })

  it("keepRaw: false is refused with details off chain", () => {
    assert.throws(() => new AgentLog({ wallet: fakeWallet(), account: agent, agentId: "a", runId: "r", detailsOffChain: true, keepRaw: false }), /keepRaw/)
  })

  it("the plain mode is unchanged: plain hashes, plain tool names", async () => {
    const { log } = await run()
    const l = log.entries[1]
    assert.equal(l.entry.tool, "invoice_lookup")
    assert.equal(await hashValue(l.raw!.output), l.entry.output_hash)
    assert.equal(l.raw!.salt, undefined)
  })
})

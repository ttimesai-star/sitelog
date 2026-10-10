// check_before_pay without the network: a fake fetch returns prepared x402 answers.
import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { checkBeforePay, validateChallenge, parseChallenge } from "../src/x402check.ts"

const PAY_TO = "0x52E29e0d2Aa49bfBfC548C0A9F2196F4aa51f3ea"
const USDC_BASE = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"
const challenge = (over: Record<string, unknown> = {}) => ({
  x402Version: 2,
  accepts: [{ scheme: "exact", network: "eip155:8453", asset: USDC_BASE, amount: "1000", payTo: PAY_TO, maxTimeoutSeconds: 60, extra: { name: "USD Coin", version: "2" }, ...over }],
})
const b64 = (v: unknown) => Buffer.from(JSON.stringify(v)).toString("base64")
const fake = (status: number, headers: Record<string, string> = {}, body = "") =>
  (async () => new Response(body, { status, headers })) as unknown as typeof fetch
const URL_ = "https://seller.example/api/thing"

describe("check_before_pay", () => {
  it("proceeds on a well-formed v2 challenge within the caller's limits", async () => {
    const r = await checkBeforePay({ url: URL_, max_price_usdc: 0.01, expected_pay_to: PAY_TO.toLowerCase() }, fake(402, { "payment-required": b64(challenge()) }))
    assert.equal(r.proceed, true, r.reasons.join("; "))
    assert.equal(r.offer?.usd, 0.001)
    assert.equal(r.offer?.network, "eip155:8453")
  })

  it("reads a v1 challenge from the body", () => {
    const v1 = { x402Version: 1, accepts: [{ scheme: "exact", network: "base", asset: USDC_BASE, maxAmountRequired: "5000", payTo: PAY_TO }] }
    const c = validateChallenge(parseChallenge(() => null, JSON.stringify(v1)))
    assert.equal(c.ok, true)
    assert.equal(c.accepts[0].usd, 0.005)
  })

  it("does not proceed: price above the cap, a different payTo, a malformed challenge, no 402, testnet", async () => {
    let r = await checkBeforePay({ url: URL_, max_price_usdc: 0.0005 }, fake(402, { "payment-required": b64(challenge()) }))
    assert.equal(r.proceed, false)
    assert.match(r.reasons.join(), /above max_price_usdc/)
    r = await checkBeforePay({ url: URL_, expected_pay_to: "0x1111111111111111111111111111111111111111" }, fake(402, { "payment-required": b64(challenge()) }))
    assert.match(r.reasons.join(), /not the expected/)
    r = await checkBeforePay({ url: URL_ }, fake(402, { "payment-required": b64(challenge({ payTo: "0x0000000000000000000000000000000000000000", amount: "-1" })) }))
    assert.equal(r.proceed, false)
    assert.match(r.reasons.join(), /not well-formed/)
    r = await checkBeforePay({ url: URL_ }, fake(200, {}, "{}"))
    assert.match(r.reasons.join(), /answered 200, not 402/)
    r = await checkBeforePay({ url: URL_ }, fake(402, { "payment-required": b64(challenge({ network: "eip155:84532", asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e" })) }))
    assert.match(r.reasons.join(), /testnet/)
  })

  it("refuses to fetch non-https, loopback and private targets", async () => {
    let called = false
    const spy = (async () => ((called = true), new Response("", { status: 402 }))) as unknown as typeof fetch
    for (const u of ["http://seller.example/x", "https://127.0.0.1/x", "https://localhost:8787/mcp", "https://192.168.1.1/", "https://[::1]/", "https://10.0.0.5/", "https://169.254.169.254/latest"]) {
      const r = await checkBeforePay({ url: u }, spy)
      assert.equal(r.proceed, false, u)
    }
    assert.equal(called, false)
  })

  it("reports a payTo change against the Delivery Score index and cites its evidence", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ds-"))
    const file = join(dir, "index.json")
    writeFileSync(file, JSON.stringify({
      generated_at: "2026-10-10T12:00:00Z",
      endpoints: { [`GET ${URL_}`]: { score: 68, components: { live: 1, challenge: 1, catalog: 1, speed: 0.8, delivery: 0 }, delivery_tested: false, payTo: "0x2222222222222222222222222222222222222222", price_usdc: 0.001, facts: ["unpaid GET: 402 in 120 ms"], evidence: [{ run_id: "probe-x", step: 3 }] } },
      hosts: { "seller.example": { probed: 4, live: 4, valid_402: 4, delivery_tested: 0, mean_score: 66 } },
    }))
    process.env.DELIVERY_SCORE_INDEX = file
    try {
      const r = await checkBeforePay({ url: URL_ }, fake(402, { "payment-required": b64(challenge()) }))
      assert.equal(r.proceed, false)
      assert.match(r.reasons.join(), /payTo changed since the last probe/)
      assert.equal(r.history?.evidence[0].run_id, "probe-x")
      assert.match(r.facts.join("\n"), /Delivery Score 68\/100.*delivery not tested yet/)
    } finally {
      delete process.env.DELIVERY_SCORE_INDEX
    }
  })
})

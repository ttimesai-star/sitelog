import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { parseChallenge, validateChallenge, usdPrice, caip } from "../src/lib.mjs"

const USDC_BASE = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"
const PAY_TO = "0x52E29e0d2Aa49bfBfC548C0A9F2196F4aa51f3ea"
const hdr = (v) => new Headers({ "payment-required": Buffer.from(JSON.stringify(v)).toString("base64") })
const ok = { x402Version: 2, accepts: [{ scheme: "exact", network: "eip155:8453", asset: USDC_BASE, amount: "10000", payTo: PAY_TO, maxTimeoutSeconds: 60, extra: { name: "USD Coin", version: "2" } }] }

describe("x402 challenge validation", () => {
  it("accepts a well-formed v2 header challenge and prices it in USDC", () => {
    const v = validateChallenge(parseChallenge(hdr(ok), ""))
    assert.equal(v.ok, true)
    assert.equal(v.accepts[0].usd, 0.01)
  })
  it("accepts a v1 body challenge with network names", () => {
    const body = JSON.stringify({ x402Version: 1, accepts: [{ scheme: "exact", network: "base", asset: USDC_BASE, maxAmountRequired: "1000", payTo: PAY_TO, extra: { name: "USD Coin" } }] })
    const v = validateChallenge(parseChallenge(new Headers(), body))
    assert.equal(v.ok, true)
    assert.equal(v.accepts[0].network, "eip155:8453")
  })
  it("reports each malformed field as a fact", () => {
    const bad = { x402Version: 3, accepts: [{ scheme: "magic", network: "eip155:8453", asset: "0x12", amount: "0", payTo: "0x0000000000000000000000000000000000000000" }] }
    const v = validateChallenge(parseChallenge(hdr(bad), ""))
    assert.equal(v.ok, false)
    assert.equal(v.issues.length, 5)
  })
  it("a 402 with an HTML body is not a challenge", () => {
    const v = validateChallenge(parseChallenge(new Headers(), "<html>pay me</html>"))
    assert.equal(v.ok, false)
    assert.match(v.issues[0], /not JSON/)
  })
  it("prices only known USDC contracts", () => {
    assert.equal(usdPrice({ network: "eip155:8453", asset: "0x1111111111111111111111111111111111111111", amount: "1000" }), null)
    assert.equal(caip("solana"), "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp")
  })
})

import { describe, it } from "node:test"
import assert from "node:assert/strict"
import {
  APP,
  SCHEMA_VERSION,
  LIFETIME_DAYS,
  rolesParams,
  remarkParams,
  fixParams,
  closureParams,
  closeBatch,
  fixBatch,
  creatorRole,
  attrValue,
  payloadJson,
  verifiedRemarksQuery,
} from "../src/lib/sitelog.js"

describe("SiteLog Schema & Params", () => {
  it("rolesParams builds correct base attributes and payload", () => {
    const res = rolesParams({
      project: "demo-1",
      title: "Test Project",
      inspectors: ["0x1111111111111111111111111111111111111111"],
      contractors: ["0x2222222222222222222222222222222222222222"],
    })
    assert.equal(res.contentType, "application/json")
    assert.equal(res.attributes.app.value, APP)
    assert.equal(res.attributes.v.value, SCHEMA_VERSION)
    assert.equal(res.attributes.kind.value, "roles")
    assert.equal(res.attributes.project.value, "demo-1")
  })

  it("remarkParams validates severity 1..5", () => {
    assert.throws(() => {
      remarkParams({ project: "demo-1", severity: 6, text: "Invalid" })
    }, /severity must be 1\.\.5/)

    const res = remarkParams({ project: "demo-1", severity: 4, section: "concrete", text: "Honeycombing" })
    assert.equal(res.attributes.severity.value, 4)
    assert.equal(res.attributes.section.value, "concrete")
    assert.equal(res.flags.readonly, true)
    assert.equal(res.flags.permissionlessExtension, true)
  })

  it("fixBatch and closeBatch build atomic batch actions", () => {
    const k = "0x" + "00".repeat(32)
    const closeB = closeBatch({ project: "demo-1", remarkKey: k, text: "Accepted" })
    assert.equal(closeB.creates.length, 1)
    assert.equal(closeB.extensions.length, 1)
    assert.equal(closeB.extensions[0].entityKey, k)

    const fixB = fixBatch({ project: "demo-1", remarkKey: k, text: "Fixed", headBlock: 1000n, remarkExpiresAtBlock: 2000n })
    assert.equal(fixB.creates.length, 1)
    assert.equal(fixB.extensions.length, 1)
  })
})

describe("Trust Evaluation", () => {
  const roles = {
    inspectors: ["0x6bea8012e15605564cc67bad1f8941262cc68f69"],
    contractors: ["0x0757a42040c19a8c686c9d3a36336203c889d29b"],
  }

  it("correctly identifies inspector, contractor, and unknown roles", () => {
    assert.equal(creatorRole(roles, "0x6BEa8012E15605564cc67Bad1F8941262cC68f69"), "inspector")
    assert.equal(creatorRole(roles, "0x0757a42040C19A8C686c9D3A36336203C889d29B"), "contractor")
    assert.equal(creatorRole(roles, "0x0000000000000000000000000000000000000000"), "unknown")
    assert.equal(creatorRole(null, "0x6BEa8012E15605564cc67Bad1F8941262cC68f69"), "unknown")
  })
})

describe("Attribute & Payload Parsing", () => {
  it("attrValue extracts primitive value or object value correctly", () => {
    const entity = {
      attributes: {
        kind: { type: "str", value: "remark" },
        severity: 4,
      },
    }
    assert.equal(attrValue(entity, "kind"), "remark")
    assert.equal(attrValue(entity, "severity"), 4)
    assert.equal(attrValue(entity, "missing"), undefined)
  })

  it("payloadJson handles valid and invalid entity JSON payloads", () => {
    const valid = {
      toJson: () => ({ text: "Defect found" }),
    }
    const invalid = {
      toJson: () => {
        throw new Error("Invalid JSON")
      },
    }
    assert.deepEqual(payloadJson(valid), { text: "Defect found" })
    assert.deepEqual(payloadJson(invalid), {})
  })
})

// ---- added after the review: lease arithmetic, query rendering, input checks, trust rules ----
import { createPublicClient } from "@arkiv-network/sdk"
import { tiramisu } from "@arkiv-network/sdk/chains"
import { http } from "viem"
import { checkAddress, checkProject, daysLeft, unverifiedRemarksQuery, withStatus } from "../src/lib/sitelog.js"

const client = createPublicClient({ chain: tiramisu, transport: http("http://127.0.0.1:1") }) // never called: only toString()
const INSPECTOR = "0x6bea8012e15605564cc67bad1f8941262cc68f69"
const CONTRACTOR = "0x0757a42040c19a8c686c9d3a36336203c889d29b"
const KEY = "0x" + "ab".repeat(32)

describe("Lease renewal on a fix claim (RENT-01)", () => {
  const ninetyDays = BigInt((LIFETIME_DAYS.remark * 86400) / 2)
  it("extends to an absolute block, head + 90 days of 2 s blocks", () => {
    const b = fixBatch({ project: "demo-1", remarkKey: KEY, text: "x", headBlock: 1000n, remarkExpiresAtBlock: 2000n })
    assert.equal(b.extensions[0].expires.expiresAt, 1000n + ninetyDays)
  })
  it("skips the extension when the remark already lives longer, so the batch cannot revert", () => {
    const b = fixBatch({ project: "demo-1", remarkKey: KEY, text: "x", headBlock: 1000n, remarkExpiresAtBlock: 1000n + ninetyDays })
    assert.equal(b.extensions, undefined)
  })
  it("refuses to guess the current block", () => {
    assert.throws(() => fixBatch({ project: "demo-1", remarkKey: KEY, text: "x" }), /headBlock/)
  })
  it("daysLeft converts blocks to days", () => {
    assert.equal(daysLeft(1000n + 43200n, 1000n), 1)
  })
})

describe("Queries the node evaluates", () => {
  it("verified remarks: OR of $creator over the roster's inspectors", () => {
    const q = verifiedRemarksQuery(client, { project: "demo-1", inspectors: [INSPECTOR, CONTRACTOR], minSeverity: 3 }).toString()
    assert.match(q, /severity >= i32\(3\)/)
    assert.match(q, /\(\$creator = addr\(0x6bea.*\) OR \$creator = addr\(0x0757.*\)\)/i)
  })
  it("unverified remarks use NOT (...), not != which the node rejects (friction F5)", () => {
    const q = unverifiedRemarksQuery(client, { project: "demo-1", inspectors: [INSPECTOR] }).toString()
    assert.match(q, /NOT \(?\$creator = addr\(0x6bea/i)
    assert.doesNotMatch(q, /!=/)
  })
  it("a quote in a project id cannot leave its string literal", () => {
    const q = unverifiedRemarksQuery(client, { project: "demo-1", inspectors: [INSPECTOR] }).toString()
    assert.match(q, /project = str\('demo-1'\)/)
    assert.throws(() => verifiedRemarksQuery(client, { project: "x' OR '1'='1", inspectors: [INSPECTOR] }), /project id/)
  })
  it("rejects non-integer severities and bad addresses", () => {
    assert.throws(() => verifiedRemarksQuery(client, { project: "demo-1", inspectors: [INSPECTOR], minSeverity: "3; drop" }), /minSeverity/)
    assert.throws(() => checkAddress("<img src=x onerror=alert(1)>"), /not a valid/)
    assert.equal(checkProject("load-1"), "load-1")
  })
})

describe("Status is derived from who wrote the closure", () => {
  const roles = { inspectors: [INSPECTOR], contractors: [CONTRACTOR] }
  const ent = (kind, creator, ts, extra = {}) => ({ key: "0x" + Math.random().toString(16).slice(2).padEnd(64, "0"), creator, createdAt: BigInt(ts), attributes: { kind, created_ts: ts, ...extra }, toJson: () => ({ text: kind }) })
  const remark = { ...ent("remark", INSPECTOR, 1), key: KEY }
  it("a contractor's closure is ignored and the remark stays open", () => {
    const [r] = withStatus([remark], [ent("closure", CONTRACTOR, 2, { remark: KEY })], roles)
    assert.equal(r.status, "open")
    assert.equal(r.fakeClosures.length, 1)
  })
  it("a fix claim alone gives fix-claimed; the latest inspector closure closes it", () => {
    const fix = ent("fix", CONTRACTOR, 2, { remark: KEY })
    assert.equal(withStatus([remark], [fix], roles)[0].status, "fix-claimed")
    const c1 = ent("closure", INSPECTOR, 3, { remark: KEY })
    const c2 = ent("closure", INSPECTOR, 5, { remark: KEY })
    const [r] = withStatus([remark], [fix, c1, c2], roles)
    assert.equal(r.status, "closed")
    assert.equal(r.closure, c2)
  })
  it("payloadJson ignores payloads that are not JSON objects", () => {
    assert.deepEqual(payloadJson({ toJson: () => [1, 2] }), {})
    assert.deepEqual(payloadJson({ toJson: () => "text" }), {})
  })
})

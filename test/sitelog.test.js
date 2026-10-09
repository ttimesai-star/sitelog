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

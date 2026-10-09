// SiteLog core: entity schema, Arkiv queries and trust rules.
// Shared by the web app (src/main.js) and the CLI (scripts/sitelog.mjs).
//
// Trust model in one paragraph: the client (the party paying for the building) publishes a
// "roles" entity that lists which wallets are site inspectors and which are contractors. The app
// only trusts a roles entity whose on-chain creator ($creator) is the client's wallet, and only
// trusts a remark or a closure whose $creator is in that list. Nothing in the payload or in a
// writable attribute ("author", "role", ...) is ever used to decide who wrote a record.

import { addr, i32, key, str, u64 } from "@arkiv-network/sdk/attr"
import { and, eq, gte, lte, or } from "@arkiv-network/sdk/query"
import { ExpirationTime, jsonToPayload } from "@arkiv-network/sdk/utils"

export const APP = "sitelog"
export const SCHEMA_VERSION = 1

// The client wallet of the synthetic demo project. It is the single trust root of the demo:
// the roles entity counts only if this address created it.
export const DEMO_PROJECT = "demo-1"
export const DEMO_CLIENT = "0xBDe3eD9ecD0E7078d010B220cDEcA3Af3F7AC6f0"

export const RPC_HTTP = "https://rpc.tiramisu.db-chain.testnet.arkiv.network"
export const RPC_WS = "wss://rpc.tiramisu.db-chain.testnet.arkiv.network"
export const EXPLORER = "https://tiramisu.explorer.arkiv.network"
export const BLOCK_TIME_S = 2

// Entity Expiration per type, in days. Each value follows the product rule written next to it.
export const LIFETIME_DAYS = {
  roles: 365, // the project roster lives as long as the build; the client re-extends it on edits
  remark: 90, // an open defect must be acted on; any activity on it renews the 90-day lease
  fix: 30, // a contractor's "fixed" claim is a request for re-inspection, not a fact
  closure: 365, // an accepted fix is evidence for the warranty period, so it outlives the remark lease
  closedRemark: 365, // when a remark is closed its lease is extended to match its closure
}

export const SEVERITY = {
  1: "note",
  2: "minor",
  3: "major",
  4: "critical",
  5: "stop-work",
}

const nowS = () => Math.floor(Date.now() / 1000)

function baseAttrs(kind, project) {
  return { app: str(APP), v: i32(SCHEMA_VERSION), kind: str(kind), project: str(project), created_ts: u64(nowS()) }
}

// ---------- writes: parameter builders (no network) ----------

export function rolesParams({ project, inspectors, contractors, title }) {
  return {
    attributes: baseAttrs("roles", project),
    payload: jsonToPayload({ title, inspectors, contractors }),
    contentType: "application/json",
    expires: ExpirationTime.fromDays(LIFETIME_DAYS.roles),
  }
}

// A remark (defect record) is created readonly: nobody, its own author included, can edit the text
// or the severity after the fact. It is created with permissionless extension so that the client,
// or anyone who needs the evidence, can keep it alive without being able to change it.
export function remarkParams({ project, severity, section, text, location, photoSha256, normRef }) {
  if (!SEVERITY[severity]) throw new Error("severity must be 1..5")
  return {
    attributes: { ...baseAttrs("remark", project), severity: i32(severity), section: str(section || "general") },
    payload: jsonToPayload({ text, location: location || "", photo_sha256: photoSha256 || "", norm_ref: normRef || "" }),
    contentType: "application/json",
    expires: ExpirationTime.fromDays(LIFETIME_DAYS.remark),
    flags: { readonly: true, permissionlessExtension: true },
  }
}

export function fixParams({ project, remarkKey, text, photoSha256 }) {
  return {
    attributes: { ...baseAttrs("fix", project), remark: key(remarkKey) },
    payload: jsonToPayload({ text, photo_sha256: photoSha256 || "" }),
    contentType: "application/json",
    expires: ExpirationTime.fromDays(LIFETIME_DAYS.fix),
    flags: { readonly: true },
  }
}

export function closureParams({ project, remarkKey, fixKey, text }) {
  const attributes = { ...baseAttrs("closure", project), remark: key(remarkKey) }
  if (fixKey) attributes.fix = key(fixKey)
  return {
    attributes,
    payload: jsonToPayload({ text }),
    contentType: "application/json",
    expires: ExpirationTime.fromDays(LIFETIME_DAYS.closure),
    flags: { readonly: true },
  }
}

// Closing a remark is one atomic batch: the closure record and the extension of the remark it
// closes land together or not at all, so a remark is never "closed" while about to expire.
export function closeBatch({ project, remarkKey, fixKey, text }) {
  return {
    creates: [closureParams({ project, remarkKey, fixKey, text })],
    extensions: [{ entityKey: remarkKey, expires: ExpirationTime.fromDays(LIFETIME_DAYS.closedRemark) }],
  }
}

// Activity lease: a fix claim on an open remark renews the remark for another 90 days in the same
// transaction. extendEntity sets (not adds) the expiry and reverts if the new one is not later,
// so the caller passes the remark's current expiry and we skip the extension when it would revert.
export function fixBatch({ project, remarkKey, text, photoSha256, remarkExpiresAtBlock, headBlock }) {
  const batch = { creates: [fixParams({ project, remarkKey, text, photoSha256 })] }
  const renewTo = BigInt(headBlock) + BigInt((LIFETIME_DAYS.remark * 86400) / BLOCK_TIME_S)
  if (remarkExpiresAtBlock === undefined || renewTo > BigInt(remarkExpiresAtBlock)) {
    batch.extensions = [{ entityKey: remarkKey, expires: ExpirationTime.fromDays(LIFETIME_DAYS.remark) }]
  }
  return batch
}

// ---------- reads ----------

const FULL = { key: true, creator: true, owner: true, createdAt: true, expiresAt: true, creationFlags: true, attributes: true, payload: true }

export function attrValue(entity, name) {
  const a = entity.attributes?.[name]
  if (a === undefined) return undefined
  return typeof a === "object" && a !== null && "value" in a ? a.value : a
}

export function payloadJson(entity) {
  try {
    return entity.toJson()
  } catch {
    return {}
  }
}

async function fetchAll(builder, max = 2000) {
  const out = []
  let page = await builder.fetch()
  for (;;) {
    out.push(...page.entities)
    if (out.length >= max || !page.hasNextPage()) break
    page = await page.next()
  }
  return out
}

// The roster counts only if the trust root created it. Latest one wins (client sorts: no server ordering).
export async function loadRoles(client, { project, trustRoot }) {
  const ents = await fetchAll(
    client.select(FULL).where(eq("app", APP), eq("kind", "roles"), eq("project", project)).createdBy(trustRoot).limit(50),
  )
  ents.sort((a, b) => Number(attrValue(b, "created_ts")) - Number(attrValue(a, "created_ts")))
  const latest = ents[0]
  if (!latest) return null
  const p = payloadJson(latest)
  return {
    entity: latest,
    title: p.title || project,
    inspectors: (p.inspectors || []).map((x) => x.toLowerCase()),
    contractors: (p.contractors || []).map((x) => x.toLowerCase()),
  }
}

export function creatorRole(roles, creator) {
  const c = (creator || "").toLowerCase()
  if (!roles) return "unknown"
  if (roles.inspectors.includes(c)) return "inspector"
  if (roles.contractors.includes(c)) return "contractor"
  return "unknown"
}

// Verified remarks: the $creator filter runs on the node, not in our code.
export function verifiedRemarksQuery(client, { project, inspectors, minSeverity = 1, maxSeverity = 5, sinceTs, untilTs }) {
  const preds = [eq("app", APP), eq("kind", "remark"), eq("project", project), gte("severity", i32(minSeverity)), lte("severity", i32(maxSeverity))]
  if (sinceTs) preds.push(gte("created_ts", u64(sinceTs)))
  if (untilTs) preds.push(lte("created_ts", u64(untilTs)))
  preds.push(or(inspectors.map((a) => eq("$creator", addr(a)))))
  return client.select(FULL).where(and(preds)).limit(100)
}

// Everything that claims to be a remark for this project, whoever wrote it. Used to show forgeries.
export function anyRemarksQuery(client, { project }) {
  return client.select(FULL).where(eq("app", APP), eq("kind", "remark"), eq("project", project)).limit(100)
}

export async function loadJournal(client, { project, trustRoot, minSeverity = 1, maxSeverity = 5, sinceTs, untilTs }) {
  const roles = await loadRoles(client, { project, trustRoot })
  if (!roles) return { roles: null, remarks: [], forged: [], fixes: [], closures: [] }
  const verified = roles.inspectors.length
    ? await fetchAll(verifiedRemarksQuery(client, { project, inspectors: roles.inspectors, minSeverity, maxSeverity, sinceTs, untilTs }))
    : []
  const all = await fetchAll(anyRemarksQuery(client, { project }))
  const vset = new Set(verified.map((e) => e.key))
  const forged = all.filter((e) => !vset.has(e.key) && creatorRole(roles, e.creator) !== "inspector")
  const linked = await fetchAll(
    client.select(FULL).where(eq("app", APP), eq("project", project), or(eq("kind", "fix"), eq("kind", "closure"))).limit(200),
  )
  const fixes = linked.filter((e) => attrValue(e, "kind") === "fix")
  // A closure counts only when an inspector created it; a contractor "closing" its own defect is ignored.
  const closures = linked.filter((e) => attrValue(e, "kind") === "closure")
  const remarks = verified
    .map((e) => {
      const k = e.key.toLowerCase()
      const myFixes = fixes.filter((f) => String(attrValue(f, "remark")).toLowerCase() === k)
      const myClosures = closures.filter((c) => String(attrValue(c, "remark")).toLowerCase() === k)
      const validClosure = myClosures.find((c) => creatorRole(roles, c.creator) === "inspector")
      const fakeClosures = myClosures.filter((c) => creatorRole(roles, c.creator) !== "inspector")
      return { entity: e, fixes: myFixes, closure: validClosure, fakeClosures, status: validClosure ? "closed" : myFixes.length ? "fix-claimed" : "open" }
    })
    .sort((a, b) => Number(attrValue(b.entity, "created_ts")) - Number(attrValue(a.entity, "created_ts")))
  return { roles, remarks, forged, fixes, closures }
}

export async function sha256Hex(bytes) {
  const d = await crypto.subtle.digest("SHA-256", bytes)
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("")
}

export function blocksToDate(expiresAt, headBlock) {
  const diff = Number(BigInt(expiresAt) - BigInt(headBlock))
  return new Date(Date.now() + diff * BLOCK_TIME_S * 1000)
}

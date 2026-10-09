// SiteLog core: entity schema, Arkiv queries and trust rules.
// Shared by the web app (src/main.js) and the CLI (scripts/sitelog.mjs).
//
// Trust model in one paragraph: the client (the party paying for the building) publishes a
// "roles" entity that lists which wallets are site inspectors and which are contractors. The app
// only trusts a roles entity whose on-chain creator ($creator) is the client's wallet, and only
// trusts a remark or a closure whose $creator is in that list. Nothing in the payload or in a
// writable attribute ("author", "role", ...) is ever used to decide who wrote a record.

import { addr, i32, key, str, u64 } from "@arkiv-network/sdk/attr"
import { and, eq, gte, lte, not, or } from "@arkiv-network/sdk/query"
import { ExpirationTime, jsonToPayload } from "@arkiv-network/sdk/utils"
import { isAddress, parseAbiItem } from "viem"

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
// The address that emits Arkiv entity events (SDK 0.8.1 does not export its ARKIV_ADDRESS constant).
export const ARKIV_OPERATIONS = "0x4400000000000000000000000000000000000044"
const ENTITY_CREATED = parseAbiItem("event EntityCreated(bytes32 indexed entityKey, address indexed owner, uint64 expiresAt, uint8 creationFlags)")

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
// The decision and the extension use the same unit, an absolute block (ExpirationTime.atBlock),
// so "renew only if it moves the expiry later" is exact and the batch cannot revert on it.
export function fixBatch({ project, remarkKey, text, photoSha256, remarkExpiresAtBlock, headBlock }) {
  if (headBlock === undefined || headBlock === null) throw new Error("fixBatch needs headBlock (the current block number)")
  const batch = { creates: [fixParams({ project, remarkKey, text, photoSha256 })] }
  const renewTo = BigInt(headBlock) + BigInt((LIFETIME_DAYS.remark * 86400) / BLOCK_TIME_S)
  if (remarkExpiresAtBlock === undefined || remarkExpiresAtBlock === null || renewTo > BigInt(remarkExpiresAtBlock)) {
    batch.extensions = [{ entityKey: remarkKey, expires: ExpirationTime.atBlock(renewTo) }]
  }
  return batch
}

// ---------- input checks (SEC-02, QUERY-02) ----------
// The SDK already doubles quotes inside str(), so a hostile project id cannot change the query;
// these checks give a clear error instead of an empty journal or a node-side type error.
export const PROJECT_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/
export function checkProject(project) {
  if (!PROJECT_RE.test(String(project || ""))) throw new Error("project id: 1-64 characters, letters, digits, dot, dash, underscore")
  return project
}
export function checkAddress(a, what = "address") {
  if (!isAddress(String(a || ""), { strict: false })) throw new Error(`${what} is not a valid 0x address`)
  return a
}
function intIn(v, lo, hi, what) {
  const n = Number(v)
  if (!Number.isInteger(n) || n < lo || n > hi) throw new Error(`${what} must be an integer ${lo}..${hi}`)
  return n
}

// RENT-03: a remark whose lease runs out disappears from queries, and its fix claims and closures
// become orphans. The page flags remarks close to expiry so someone can extend them in time.
export const EXPIRY_WARN_DAYS = 14
export function daysLeft(expiresAt, headBlock) {
  return (Number(BigInt(expiresAt) - BigInt(headBlock)) * BLOCK_TIME_S) / 86400
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
    const p = entity.toJson()
    return p && typeof p === "object" && !Array.isArray(p) ? p : {}
  } catch {
    return {}
  }
}

// Cursor pagination. A cursor is bound to the block its first page was served at, but
// QueryResult.next() in SDK 0.8.1 does not pin that block, so on a live chain (2 s blocks) the
// second or third page fails with -32005 "cursor belongs to a different query, block or select".
// Pinning the whole walk to one block with atBlock() fixes it (arkiv/friction.md, F4).
async function fetchAll(builder, atBlock, max = 2000) {
  const out = []
  let page = await builder.atBlock(atBlock).fetch()
  for (;;) {
    out.push(...page.entities)
    if (out.length >= max || !page.hasNextPage()) break
    page = await page.next()
  }
  return out
}

const addressList = (xs) => (Array.isArray(xs) ? xs : []).filter((x) => typeof x === "string" && isAddress(x, { strict: false })).map((x) => x.toLowerCase())

// The roster counts only if the trust root created it. Latest one wins (client sorts: no server ordering).
export async function loadRoles(client, { project, trustRoot, atBlock }) {
  atBlock ??= await client.getBlockNumber()
  const ents = await fetchAll(
    client.select(FULL).where(eq("app", APP), eq("kind", "roles"), eq("project", project)).createdBy(trustRoot).limit(50),
    atBlock,
  )
  ents.sort((a, b) => Number(attrValue(b, "created_ts")) - Number(attrValue(a, "created_ts")))
  const latest = ents[0]
  if (!latest) return null
  const p = payloadJson(latest)
  return {
    entity: latest,
    title: p.title || project,
    inspectors: addressList(p.inspectors),
    contractors: addressList(p.contractors),
  }
}

export function creatorRole(roles, creator) {
  const c = (creator || "").toLowerCase()
  if (!roles) return "unknown"
  if (roles.inspectors.includes(c)) return "inspector"
  if (roles.contractors.includes(c)) return "contractor"
  return "unknown"
}

function remarkPreds({ project, minSeverity = 1, maxSeverity = 5, sinceTs, untilTs }) {
  checkProject(project)
  minSeverity = intIn(minSeverity, 1, 5, "minSeverity")
  maxSeverity = intIn(maxSeverity, 1, 5, "maxSeverity")
  if (sinceTs !== undefined) sinceTs = intIn(sinceTs, 0, 2 ** 40, "sinceTs")
  if (untilTs !== undefined) untilTs = intIn(untilTs, 0, 2 ** 40, "untilTs")
  const preds = [eq("app", APP), eq("kind", "remark"), eq("project", project), gte("severity", i32(minSeverity)), lte("severity", i32(maxSeverity))]
  if (sinceTs) preds.push(gte("created_ts", u64(sinceTs)))
  if (untilTs) preds.push(lte("created_ts", u64(untilTs)))
  return preds
}

// Verified remarks: the $creator filter runs on the node, not in our code.
export function verifiedRemarksQuery(client, { inspectors, pageSize = 100, ...f }) {
  const preds = remarkPreds(f)
  preds.push(or(inspectors.map((a) => eq("$creator", addr(a)))))
  return client.select(FULL).where(and(preds)).limit(pageSize)
}

// Records that claim to be remarks for this project but were not created by any inspector.
// The node does the exclusion with NOT ($creator = ...); nothing is filtered in our code.
export function unverifiedRemarksQuery(client, { project, inspectors, pageSize = 100 }) {
  const preds = [eq("app", APP), eq("kind", "remark"), eq("project", project), ...inspectors.map((a) => not(eq("$creator", addr(a))))]
  return client.select(FULL).where(and(preds)).limit(pageSize)
}

const LINK_CHUNK = 25

// Fix claims and closures that point at the given remark keys: one compound query per page.
function linkedQuery(client, { project, remarkKeys }) {
  return client
    .select(FULL)
    .where(and([eq("app", APP), eq("project", project), or(eq("kind", "fix"), eq("kind", "closure")), or(remarkKeys.map((k) => eq("remark", key(k))))]))
    .limit(200)
}

export function withStatus(remarkEntities, linked, roles) {
  const fixes = linked.filter((e) => attrValue(e, "kind") === "fix")
  // A closure counts only when an inspector created it; a contractor "closing" its own defect is ignored.
  const closures = linked.filter((e) => attrValue(e, "kind") === "closure")
  return remarkEntities.map((e) => {
    const k = e.key.toLowerCase()
    const myFixes = fixes.filter((f) => String(attrValue(f, "remark")).toLowerCase() === k)
    const myClosures = closures.filter((c) => String(attrValue(c, "remark")).toLowerCase() === k)
    const validClosure = myClosures.filter((c) => creatorRole(roles, c.creator) === "inspector").sort(newestFirst)[0]
    const fakeClosures = myClosures.filter((c) => creatorRole(roles, c.creator) !== "inspector")
    return { entity: e, fixes: myFixes, closure: validClosure, fakeClosures, status: validClosure ? "closed" : myFixes.length ? "fix-claimed" : "open" }
  })
}

export function newestFirst(a, b) {
  const ea = a.entity || a
  const eb = b.entity || b
  return Number(attrValue(eb, "created_ts")) - Number(attrValue(ea, "created_ts")) || Number(eb.createdAt ?? 0n) - Number(ea.createdAt ?? 0n)
}

async function statusesFor(client, { project, roles, entities, atBlock }) {
  if (!entities.length) return []
  // The node rejects very long queries (F6 in friction.md), so keys go in chunks of LINK_CHUNK.
  const keys = entities.map((e) => e.key)
  const linked = []
  for (let i = 0; i < keys.length; i += LINK_CHUNK) {
    linked.push(...(await fetchAll(linkedQuery(client, { project, remarkKeys: keys.slice(i, i + LINK_CHUNK) }), atBlock)))
  }
  return withStatus(entities, linked, roles)
}

// The whole journal in one go (CLI). Every query is pinned to the same block, so the result is a
// consistent snapshot even while new entities land.
export async function loadJournal(client, { project, trustRoot, minSeverity = 1, maxSeverity = 5, sinceTs, untilTs }) {
  const atBlock = await client.getBlockNumber()
  const roles = await loadRoles(client, { project, trustRoot, atBlock })
  if (!roles || !roles.inspectors.length) return { roles, remarks: [], forged: [], atBlock }
  const f = { project, inspectors: roles.inspectors, minSeverity, maxSeverity, sinceTs, untilTs }
  const verified = await fetchAll(verifiedRemarksQuery(client, f), atBlock)
  const forged = await fetchAll(unverifiedRemarksQuery(client, f), atBlock)
  const remarks = (await statusesFor(client, { project, roles, entities: verified, atBlock })).sort(newestFirst)
  return { roles, remarks, forged, atBlock }
}

// RENT-03: fix claims and closures whose remark no longer exists (expired or deleted by its owner).
// One query for the project's linked records, then a getEntity only for keys not seen in the journal.
export async function loadOrphans(client, { project, known = [], atBlock }) {
  atBlock ??= await client.getBlockNumber()
  const linked = await fetchAll(client.select(FULL).where(eq("app", APP), eq("project", checkProject(project)), or(eq("kind", "fix"), eq("kind", "closure"))).limit(200), atBlock)
  const seen = new Set(known.map((k) => k.toLowerCase()))
  const missing = new Map()
  for (const e of linked) {
    const k = String(attrValue(e, "remark")).toLowerCase()
    if (seen.has(k)) continue
    if (!missing.has(k)) {
      let gone = false
      try {
        await client.getEntity(k)
      } catch {
        gone = true
      }
      missing.set(k, gone)
    }
  }
  return linked.filter((e) => missing.get(String(attrValue(e, "remark")).toLowerCase()) === true)
}

// One page of the journal (web app). `cursor` comes from the previous page; the walk stays on
// `atBlock`, the block of its first page, so "Load more" keeps working while the chain moves.
// Arkiv has no server-side ordering, so a page is sorted on its own; order across pages is the node's.
export async function loadJournalPage(client, { roles, project, minSeverity, maxSeverity, sinceTs, untilTs, pageSize = 25, cursor, atBlock }) {
  atBlock ??= await client.getBlockNumber()
  let b = verifiedRemarksQuery(client, { project, inspectors: roles.inspectors, minSeverity, maxSeverity, sinceTs, untilTs, pageSize }).atBlock(atBlock)
  if (cursor) b = b.cursor(cursor)
  const page = await b.fetch()
  const remarks = (await statusesFor(client, { project, roles, entities: page.entities, atBlock })).sort(newestFirst)
  return { remarks, cursor: page.hasNextPage() ? page.cursor : undefined, atBlock }
}

export async function loadUnverified(client, { project, roles, atBlock }) {
  return fetchAll(unverifiedRemarksQuery(client, { project, inspectors: roles.inspectors }), atBlock, 500)
}

// Creation transaction of each entity, read from the EntityCreated logs of the Arkiv operations
// address (an entity carries its creation block, not its tx hash). One eth_getLogs per call.
export async function creationTxs(client, entities) {
  const out = new Map()
  const withBlock = entities.filter((e) => e.createdAt !== undefined && e.createdAt !== null)
  if (!withBlock.length) return out
  const blocks = withBlock.map((e) => BigInt(e.createdAt))
  const fromBlock = blocks.reduce((a, b) => (b < a ? b : a))
  const toBlock = blocks.reduce((a, b) => (b > a ? b : a))
  const logs = await client.getLogs({ address: ARKIV_OPERATIONS, event: ENTITY_CREATED, args: { entityKey: withBlock.map((e) => e.key) }, fromBlock, toBlock })
  for (const l of logs) out.set(String(l.args.entityKey).toLowerCase(), l.transactionHash)
  return out
}

export async function sha256Hex(bytes) {
  const d = await crypto.subtle.digest("SHA-256", bytes)
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("")
}

export function blocksToDate(expiresAt, headBlock) {
  const diff = Number(BigInt(expiresAt) - BigInt(headBlock))
  return new Date(Date.now() + diff * BLOCK_TIME_S * 1000)
}

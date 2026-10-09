import { createPublicClient, createWalletClient } from "@arkiv-network/sdk"
import { tiramisu } from "@arkiv-network/sdk/chains"
import { toRpcSelect } from "@arkiv-network/sdk/query"
import { ExpirationTime } from "@arkiv-network/sdk/utils"
import { custom, http, webSocket } from "viem"
import {
  APP, DEMO_CLIENT, DEMO_PROJECT, EXPIRY_WARN_DAYS, EXPLORER, RPC_HTTP, RPC_WS, SEVERITY, attrValue, blocksToDate, checkAddress, checkProject, closeBatch, creationTxs, creatorRole, daysLeft,
  fixBatch, loadJournalPage, loadRoles, loadUnverified, payloadJson, remarkParams, sha256Hex, verifiedRemarksQuery,
} from "./lib/sitelog.js"

const PAGE = 25
const CHAIN_ID_HEX = "0x7614d1" // 7738577, Tiramisu

const $ = (id) => document.getElementById(id)
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c])
const short = (a) => (a ? `${a.slice(0, 6)}…${a.slice(-4)}` : "")
// SEC-01: addresses and keys come from chain data (a roster payload is free text), so every value is
// escaped, and URL parts are also URI-encoded.
const addrLink = (a) => `<a href="${EXPLORER}/address/${encodeURIComponent(a ?? "")}" target="_blank" rel="noopener" title="${esc(a)}">${esc(short(a))}</a>`
const entityLink = (k, label) => `<a href="${EXPLORER}/entity/${encodeURIComponent(k ?? "")}" target="_blank" rel="noopener" title="entity ${esc(k)}">${label ? esc(label) : "entity " + esc(short(k))}</a>`
const txLink = (h, label = "tx") => (h ? `<a href="${EXPLORER}/tx/${encodeURIComponent(h)}" target="_blank" rel="noopener" title="${esc(h)}">${esc(label)} ${esc(short(h))}</a>` : "")

// Few retries: on HTTP 429 (quota) waiting longer does not help, the quota resets hourly.
const pub = createPublicClient({ chain: tiramisu, transport: http(RPC_HTTP, { retryCount: 1 }) })
// Journal state: one cursor walk pinned to one block (see loadJournalPage).
let state = { roles: null, remarks: [], forged: [], cursor: undefined, atBlock: 0n, pages: 0, txs: new Map(), me: null, wallet: null }

const params = new URLSearchParams(location.search)
$("project").value = params.get("project") || DEMO_PROJECT
$("trustRoot").value = params.get("client") || DEMO_CLIENT
for (const id of ["minSev", "maxSev", "wSev"]) {
  $(id).innerHTML = Object.entries(SEVERITY).map(([n, name]) => `<option value="${n}">${n} ${name}</option>`).join("")
}
$("maxSev").value = "5"
$("wSev").value = "3"

function filters() {
  const since = $("since").value ? Math.floor(new Date($("since").value).getTime() / 1000) : undefined
  return { project: $("project").value.trim(), trustRoot: $("trustRoot").value.trim(), minSeverity: Number($("minSev").value), maxSeverity: Number($("maxSev").value), sinceTs: since }
}

// The public RPC has a per-IP quota (friction F7); say so instead of a bare "HTTP request failed".
function rpcError(err) {
  const msg = err?.data?.message || err?.shortMessage || err?.message || String(err)
  if (/429|rate limit|Too Many/i.test(`${err?.status ?? ""} ${err?.details ?? ""} ${msg}`)) return "the public Tiramisu RPC quota for your network address is used up (HTTP 429). It resets within the hour; the CLI and curl query hit the same quota."
  return msg
}

const statusBadge = (s) => `<span class="badge ${s}">${s.replace("-", " ")}</span>`

function renderRoles(roles, f) {
  if (!roles) {
    $("roles").innerHTML = `No roster for <b>${esc(f.project)}</b> created by ${addrLink(f.trustRoot)}. Nothing on this project can be verified.`
    return
  }
  $("roles").innerHTML = `<b>${esc(roles.title)}</b> · roster ${entityLink(roles.entity.key)} ${txLink(state.txs.get(roles.entity.key.toLowerCase()))} created by client ${addrLink(roles.entity.creator)}
    <div class="rolegrid"><div><span class="role inspector">inspectors</span> ${roles.inspectors.map(addrLink).join(", ") || "none"}</div>
    <div><span class="role contractor">contractors</span> ${roles.contractors.map(addrLink).join(", ") || "none"}</div></div>`
}

function linkLine(e, text, cls = "") {
  const role = creatorRole(state.roles, e.creator)
  return `<li class="${cls}">${text} by ${addrLink(e.creator)} <span class="role ${role}">${role}</span> · ${entityLink(e.key, "entity")} ${txLink(state.txs.get(e.key.toLowerCase()))}</li>`
}

function remarkCard(r) {
  const e = r.entity
  const p = payloadJson(e)
  const sev = attrValue(e, "severity")
  const created = new Date(Number(attrValue(e, "created_ts")) * 1000)
  const exp = blocksToDate(e.expiresAt, state.atBlock)
  const left = daysLeft(e.expiresAt, state.atBlock)
  const expiring = r.status !== "closed" && left < EXPIRY_WARN_DAYS
    ? ` <span class="badge expiring" title="When the lease runs out the remark disappears from queries">expires in ${Math.max(0, left).toFixed(1)} days</span> <button class="ghost tiny" data-keep="${esc(e.key)}">keep alive</button>`
    : ""
  const fixes = r.fixes.map((f) => linkLine(f, `fix claim: "${esc(payloadJson(f).text)}"`)).join("")
  const closure = r.closure ? linkLine(r.closure, `closed: "${esc(payloadJson(r.closure).text)}"`, "ok") : ""
  const fake = r.fakeClosures.map((c) => linkLine(c, `<b>ignored</b> "closure" (not an inspector): "${esc(payloadJson(c).text)}"`, "bad")).join("")
  return `<article class="remark sev${Number(sev) || 0}">
    <div class="rhead"><span class="vbadge ok" title="$creator ${e.creator} is an inspector in the client's roster">verified</span> ${statusBadge(r.status)}${expiring} <span class="sev">sev ${esc(sev)} · ${esc(SEVERITY[sev])}</span> <span class="muted">${esc(attrValue(e, "section"))} · ${created.toISOString().slice(0, 16).replace("T", " ")} UTC</span></div>
    <p class="rtext">${esc(p.text)}</p>
    <div class="meta">
      ${p.location ? `<span>at ${esc(p.location)}</span>` : ""}${p.norm_ref ? `<span>norm: ${esc(p.norm_ref)}</span>` : ""}
      <span>inspector ${addrLink(e.creator)}</span>
      <span>${entityLink(e.key)} · ${txLink(state.txs.get(e.key.toLowerCase()), "created in tx") || "tx…"}</span>
      <span>readonly ${e.creationFlags?.readonly ? "yes" : "no"} · anyone may extend ${e.creationFlags?.permissionlessExtension ? "yes" : "no"} · expires ≈ ${exp.toISOString().slice(0, 10)}</span>
      <span class="k"><button class="ghost tiny" data-copy="${esc(e.key)}" title="${esc(e.key)}">copy key</button></span>
    </div>
    ${p.photo_sha256 ? `<div class="photo">photo SHA-256 <code>${p.photo_sha256.slice(0, 16)}…</code> <label class="ghost tiny">check a photo <input type="file" data-hash="${esc(p.photo_sha256)}" hidden /></label><span class="photoRes"></span></div>` : ""}
    <ul class="links">${fixes}${closure}${fake}</ul>
  </article>`
}

function forgedCard(e) {
  const role = creatorRole(state.roles, e.creator)
  const p = payloadJson(e)
  return `<div class="forged"><span class="vbadge bad">forged</span> <span class="sev">sev ${esc(attrValue(e, "severity"))}</span> "${esc(p.text)}"
    <div class="meta"><span>written by ${addrLink(e.creator)} <span class="role ${role}">${role}</span>, not an inspector</span><span>${entityLink(e.key)} · ${txLink(state.txs.get(e.key.toLowerCase()), "created in tx")}</span></div></div>`
}

function renderCurl(f, roles) {
  if (!roles || !roles.inspectors.length) {
    $("curl").textContent = "(no roster yet)"
    return
  }
  const b = verifiedRemarksQuery(pub, { project: f.project, inspectors: roles.inspectors, minSeverity: f.minSeverity, maxSeverity: f.maxSeverity, sinceTs: f.sinceTs })
  const select = toRpcSelect({ key: true, creator: true, expiresAt: true, attributes: true, payload: true })
  const body = { jsonrpc: "2.0", id: 1, method: "arkiv_query", params: [b.toString(), { select, limit: "0x64" }] }
  $("curl").textContent = `curl -s ${RPC_HTTP} -H 'content-type: application/json' --data '${JSON.stringify(body).replace(/'/g, `'"'"'`)}'`
}

function renderJournal() {
  const st = $("status").value
  const list = state.remarks.filter((r) => !st || r.status === st)
  const count = (s) => state.remarks.filter((r) => r.status === s).length
  const more = state.cursor ? "+" : ""
  $("tiles").innerHTML = state.roles
    ? `<div class="tile"><b>${state.remarks.length}${more}</b><span>verified remarks</span></div>
       <div class="tile"><b>${count("open")}</b><span>open</span></div>
       <div class="tile"><b>${count("closed")}</b><span>closed by an inspector</span></div>
       <div class="tile bad"><b>${state.forged.length + state.remarks.reduce((n, r) => n + r.fakeClosures.length, 0)}</b><span>forged records ignored</span></div>`
    : ""
  $("stats").innerHTML = state.roles
    ? `<span>${state.remarks.length} loaded${state.cursor ? ", more on Arkiv" : ""}</span><span>${count("fix-claimed")} fix claimed</span><span class="muted">snapshot at block ${state.atBlock}</span>`
    : ""
  $("journal").innerHTML = list.length ? list.map(remarkCard).join("") : `<p class="muted">No verified remarks match.</p>`
  $("more").classList.toggle("hidden", !state.cursor)
  $("pageInfo").textContent = state.roles ? `${state.pages} page${state.pages === 1 ? "" : "s"} of ${PAGE}, cursor pinned to block ${state.atBlock}${state.cursor ? "" : " · end of journal"}` : ""
  $("forged").innerHTML = state.forged.length ? state.forged.map(forgedCard).join("") : "None."
}

// Creation tx links come from EntityCreated logs; looked up per page, after the cards render.
async function addTxs(entities) {
  const missing = entities.filter((e) => !state.txs.has(e.key.toLowerCase()))
  if (!missing.length) return
  try {
    const m = await creationTxs(pub, missing)
    for (const [k, v] of m) state.txs.set(k, v)
  } catch (e) {
    console.warn("creation tx lookup failed", e)
  }
}
const pageEntities = (remarks) => remarks.flatMap((r) => [r.entity, ...r.fixes, ...(r.closure ? [r.closure] : []), ...r.fakeClosures])

async function load() {
  const f = filters()
  try {
    checkProject(f.project)
    checkAddress(f.trustRoot, "client wallet")
  } catch (err) {
    $("roles").innerHTML = `<span class="badtext">${esc(err.message)}</span>`
    $("journal").innerHTML = ""
    return
  }
  history.replaceState(null, "", `?project=${encodeURIComponent(f.project)}${f.trustRoot.toLowerCase() !== DEMO_CLIENT.toLowerCase() ? "&client=" + encodeURIComponent(f.trustRoot) : ""}`)
  document.querySelectorAll(".chip").forEach((c) => c.classList.toggle("on", c.dataset.project === f.project))
  $("journal").innerHTML = `<p class="muted">Querying Arkiv…</p>`
  $("newActivity")?.remove()
  try {
    const atBlock = await pub.getBlockNumber()
    const roles = await loadRoles(pub, { project: f.project, trustRoot: f.trustRoot, atBlock })
    state = { ...state, roles, remarks: [], forged: [], cursor: undefined, atBlock, pages: 0 }
    renderRoles(roles, f)
    renderCurl(f, roles)
    if (!roles || !roles.inspectors.length) return renderJournal()
    const [page, forged] = await Promise.all([loadJournalPage(pub, { roles, ...f, pageSize: PAGE, atBlock }), loadUnverified(pub, { project: f.project, roles, atBlock })])
    state.remarks = page.remarks
    state.cursor = page.cursor
    state.forged = forged
    state.pages = 1
    renderJournal()
    await addTxs([roles.entity, ...pageEntities(page.remarks), ...forged])
    renderRoles(roles, f)
    renderJournal()
  } catch (err) {
    $("journal").innerHTML = `<p class="badtext">Arkiv query failed: ${esc(rpcError(err))}</p>`
  }
}

async function loadMore() {
  if (!state.cursor) return
  const f = filters()
  $("more").disabled = true
  try {
    const page = await loadJournalPage(pub, { roles: state.roles, ...f, pageSize: PAGE, cursor: state.cursor, atBlock: state.atBlock })
    state.remarks = state.remarks.concat(page.remarks)
    state.cursor = page.cursor
    state.pages += 1
    renderJournal()
    await addTxs(pageEntities(page.remarks))
    renderJournal()
  } catch (err) {
    $("pageInfo").textContent = `next page failed: ${rpcError(err)}`
  } finally {
    $("more").disabled = false
  }
}

document.addEventListener("click", (ev) => {
  const keep = ev.target.closest("[data-keep]")
  if (keep) {
    $("kRemark").value = keep.dataset.keep
    document.querySelector("#writeForms details:last-of-type").open = true
    $("connect").scrollIntoView({ behavior: "smooth", block: "center" })
  }
  const c = ev.target.closest("[data-copy]")
  if (c) navigator.clipboard?.writeText(c.dataset.copy)
  const chip = ev.target.closest(".chip")
  if (chip) {
    ev.preventDefault()
    $("project").value = chip.dataset.project
    $("trustRoot").value = DEMO_CLIENT
    load()
  }
})
document.addEventListener("change", async (ev) => {
  const inp = ev.target
  if (inp.dataset?.hash && inp.files?.[0]) {
    const h = await sha256Hex(await inp.files[0].arrayBuffer())
    const out = inp.closest(".photo").querySelector(".photoRes")
    out.innerHTML = h === inp.dataset.hash ? ` <b class="oktext">matches the hash on Arkiv</b>` : ` <b class="badtext">does NOT match (${h.slice(0, 12)}…)</b>`
  }
})
$("load").addEventListener("click", load)
$("more").addEventListener("click", loadMore)
for (const id of ["minSev", "maxSev", "since"]) $(id).addEventListener("change", load)
$("status").addEventListener("change", renderJournal)
$("copyCurl").addEventListener("click", () => navigator.clipboard?.writeText($("curl").textContent))

// ---------- live events over WebSocket (no fromBlock, so the SDK subscribes instead of polling) ----------
let reloadTimer
function onOurEvent() {
  // On the first page the journal reloads by itself; deeper in a cursor walk we offer a refresh
  // instead of throwing away the pages the reader already loaded.
  if (state.pages <= 1) {
    clearTimeout(reloadTimer)
    reloadTimer = setTimeout(load, 1500)
  } else if (!$("newActivity")) {
    const b = document.createElement("button")
    b.id = "newActivity"
    b.textContent = "New activity on this project: refresh"
    b.addEventListener("click", load)
    $("stats").after(b)
  }
}

let liveRetry = 0
let liveTimer
let unwatchLive
function restartLive(reason) {
  try {
    unwatchLive?.()
  } catch {}
  unwatchLive = undefined
  const delay = Math.min(60, 2 ** liveRetry) * 1000
  liveRetry += 1
  $("liveText").textContent = `${reason}; reconnecting in ${delay / 1000} s`
  $("live").classList.remove("on")
  clearTimeout(liveTimer)
  liveTimer = setTimeout(startLive, delay)
}

function startLive() {
  try {
    const ws = createPublicClient({ chain: tiramisu, transport: webSocket(RPC_WS, { reconnect: { attempts: 5, delay: 2000 } }) })
    const tracked = () =>
      new Set([...pageEntities(state.remarks), ...state.forged, ...(state.roles ? [state.roles.entity] : [])].map((e) => e.key.toLowerCase()))
    unwatchLive = ws.watchEntityEvents({
      onEvent: async (ev) => {
        liveRetry = 0
        $("liveText").textContent = "live"
        $("live").classList.add("on")
        // Events carry no attributes. Looking up every new entity on a shared chain would burn the
        // public RPC quota (friction F7), so a new entity counts as ours when its owner is a wallet
        // this page cares about: the roster, the client, or the visitor's own connected wallet.
        const k = String(ev.entityKey).toLowerCase()
        let ours = tracked().has(k)
        if (!ours && ev.type === "EntityCreated") {
          const o = String(ev.owner || "").toLowerCase()
          const watched = new Set([...(state.roles?.inspectors || []), ...(state.roles?.contractors || []), filters().trustRoot.toLowerCase(), String(state.me || "").toLowerCase()])
          ours = watched.has(o)
        }
        if (!ours) return
        const li = document.createElement("li")
        const who = ev.owner || ev.newOwner || ""
        li.innerHTML = `<span class="evt">${esc(ev.type)}</span> ${entityLink(ev.entityKey)} ${who ? "owner " + addrLink(who) : ""} ${txLink(ev.transactionHash)} <span class="muted">block ${ev.blockNumber ?? ""} · ${new Date().toISOString().slice(11, 19)} UTC</span>`
        const list = $("events")
        if (list.firstElementChild?.classList.contains("muted")) list.innerHTML = ""
        list.prepend(li)
        while (list.children.length > 30) list.lastElementChild.remove()
        onOurEvent()
      },
      onError: (e) => restartLive("socket error: " + (e.shortMessage || e.message || "").slice(0, 40)),
    })
    $("liveText").textContent = "listening"
  } catch (e) {
    restartLive("no WebSocket")
  }
}
document.addEventListener("visibilitychange", () => {
  // Phones and laptops drop sockets while asleep; come back with a fresh subscription.
  if (document.visibilityState === "visible" && !$("live").classList.contains("on")) {
    liveRetry = 0
    clearTimeout(liveTimer)
    startLive()
  }
})

// ---------- writes with the visitor's own wallet (EIP-1193: MetaMask, Rabby, ...) ----------
function logw(s) {
  const el = $("writeLog")
  el.classList.remove("hidden")
  el.innerHTML = `${new Date().toISOString().slice(11, 19)} ${s}\n` + el.innerHTML
}

async function ensureTiramisu(eth) {
  const id = await eth.request({ method: "eth_chainId" })
  if (String(id).toLowerCase() === CHAIN_ID_HEX) return
  try {
    await eth.request({ method: "wallet_switchEthereumChain", params: [{ chainId: CHAIN_ID_HEX }] })
  } catch (e) {
    // 4902: the wallet does not know the chain yet, so add it (MetaMask switches to it after adding).
    if (e.code !== 4902 && e.data?.originalError?.code !== 4902 && !/unrecognized|not added|4902/i.test(e.message || "")) throw e
    await eth.request({
      method: "wallet_addEthereumChain",
      params: [{ chainId: CHAIN_ID_HEX, chainName: "Arkiv Tiramisu testnet", nativeCurrency: { name: "GLM", symbol: "GLM", decimals: 18 }, rpcUrls: [RPC_HTTP], blockExplorerUrls: [EXPLORER] }],
    })
  }
  const after = await eth.request({ method: "eth_chainId" })
  if (String(after).toLowerCase() !== CHAIN_ID_HEX) throw new Error(`wallet is on chain ${after}, not Tiramisu (${CHAIN_ID_HEX})`)
}

function showMe() {
  const role = creatorRole(state.roles, state.me)
  $("me").innerHTML = `${addrLink(state.me)} · your role in this roster: <span class="role ${role}">${role}</span>${role === "unknown" ? " (what you write will show as forged/unverified)" : ""}`
}

async function connect() {
  const eth = window.ethereum
  if (!eth) return logw("No browser wallet found. Install MetaMask, or use the CLI: see the README.")
  try {
    const [a] = await eth.request({ method: "eth_requestAccounts" })
    await ensureTiramisu(eth)
    state.me = a
    state.wallet = createWalletClient({ chain: tiramisu, transport: custom(eth), account: a })
    const bal = await pub.getBalance({ address: a })
    showMe()
    $("me").innerHTML += ` · ${(Number(bal) / 1e18).toFixed(4)} GLM`
    $("writeForms").classList.remove("hidden")
    if (!eth._sitelogListeners && eth.on) {
      eth._sitelogListeners = true
      eth.on("accountsChanged", (accs) => (accs[0] ? connect() : $("writeForms").classList.add("hidden")))
      eth.on("chainChanged", (id) => {
        if (String(id).toLowerCase() !== CHAIN_ID_HEX) {
          $("writeForms").classList.add("hidden")
          $("me").innerHTML = `<span class="badtext">Wallet switched to chain ${esc(id)}: writing is disabled. Press Connect wallet to return to Tiramisu.</span>`
        } else connect()
      })
    }
  } catch (e) {
    $("writeForms").classList.add("hidden")
    $("me").innerHTML = `<span class="badtext">Not connected to Tiramisu: writing is disabled.</span>`
    logw("connect failed: " + esc(e.shortMessage || e.message))
  }
}
$("connect").addEventListener("click", connect)

async function fileHash(id) {
  const f = $(id).files?.[0]
  return f ? sha256Hex(await f.arrayBuffer()) : ""
}

async function run(label, fn) {
  try {
    await ensureTiramisu(window.ethereum)
  } catch (e) {
    $("writeForms").classList.add("hidden")
    $("me").innerHTML = `<span class="badtext">Wallet left Tiramisu: writing is disabled until you reconnect.</span>`
    return logw(`${esc(label)} not sent: ${esc(e.shortMessage || e.message)}`)
  }
  try {
    logw(esc(label) + "… confirm in your wallet")
    const r = await fn()
    const created = r.createdEntities || (r.entityKey ? [r.entityKey] : [])
    logw(`${esc(label)}: done, ${txLink(r.txHash)}${created.length ? " · " + created.map((k) => entityLink(k)).join(", ") : ""}`)
    setTimeout(load, 2500)
    return r
  } catch (e) {
    logw(`${esc(label)} failed: ${esc(e.shortMessage || e.message)}`)
  }
}

$("wRemark").addEventListener("click", async () => {
  const p = remarkParams({ project: filters().project, severity: Number($("wSev").value), section: $("wSection").value, location: $("wLoc").value, text: $("wText").value, photoSha256: await fileHash("wPhoto") })
  run("create remark", () => state.wallet.createEntity(p))
})
$("wFix").addEventListener("click", async () => {
  const remarkKey = $("fRemark").value.trim()
  const rem = await pub.getEntity(remarkKey)
  const b = fixBatch({ project: filters().project, remarkKey, text: $("fText").value, photoSha256: await fileHash("fPhoto"), remarkExpiresAtBlock: rem.expiresAt, headBlock: await pub.getBlockNumber() })
  run("claim fix", () => state.wallet.executeBatch(b))
})
$("wClose").addEventListener("click", () => {
  const b = closeBatch({ project: filters().project, remarkKey: $("cRemark").value.trim(), fixKey: $("cFix").value.trim() || undefined, text: $("cText").value })
  run("close remark", () => state.wallet.executeBatch(b))
})
$("wKeep").addEventListener("click", () => {
  run("extend remark", () => state.wallet.extendEntity({ entityKey: $("kRemark").value.trim(), expires: ExpirationTime.fromDays(Number($("kDays").value || 120)) }))
})

load().then(startLive)
console.log(`${APP}: reading ${RPC_HTTP}`)

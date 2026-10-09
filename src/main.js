import { createPublicClient, createWalletClient } from "@arkiv-network/sdk"
import { tiramisu } from "@arkiv-network/sdk/chains"
import { toRpcSelect } from "@arkiv-network/sdk/query"
import { ExpirationTime } from "@arkiv-network/sdk/utils"
import { custom, http, webSocket } from "viem"
import {
  APP, DEMO_CLIENT, DEMO_PROJECT, EXPLORER, RPC_HTTP, RPC_WS, SEVERITY, attrValue, blocksToDate, closeBatch, creatorRole,
  fixBatch, loadJournal, payloadJson, remarkParams, sha256Hex, verifiedRemarksQuery,
} from "./lib/sitelog.js"

const $ = (id) => document.getElementById(id)
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c])
const short = (a) => (a ? `${a.slice(0, 6)}…${a.slice(-4)}` : "")
const addrLink = (a) => `<a href="${EXPLORER}/address/${esc(a)}" target="_blank" rel="noopener" title="${esc(a)}">${esc(short(a))}</a>`

const pub = createPublicClient({ chain: tiramisu, transport: http(RPC_HTTP) })
let state = { journal: null, head: 0n, me: null, wallet: null }

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

function badge(status) {
  return `<span class="badge ${status}">${status}</span>`
}

function renderRoles(roles, f) {
  if (!roles) {
    $("roles").innerHTML = `No roster for <b>${esc(f.project)}</b> created by ${addrLink(f.trustRoot)}. Nothing on this project can be verified.`
    return
  }
  $("roles").innerHTML = `<b>${esc(roles.title)}</b> · roster entity <code>${short(roles.entity.key)}</code> created by client ${addrLink(roles.entity.creator)}
    <div class="rolegrid"><div><span class="role inspector">inspectors</span> ${roles.inspectors.map(addrLink).join(", ") || "none"}</div>
    <div><span class="role contractor">contractors</span> ${roles.contractors.map(addrLink).join(", ") || "none"}</div></div>`
}

function remarkCard(r, roles) {
  const e = r.entity
  const p = payloadJson(e)
  const sev = attrValue(e, "severity")
  const created = new Date(Number(attrValue(e, "created_ts")) * 1000)
  const exp = blocksToDate(e.expiresAt, state.head)
  const fixes = r.fixes
    .map((f) => `<li>fix claim by ${addrLink(f.creator)} <span class="role ${creatorRole(roles, f.creator)}">${creatorRole(roles, f.creator)}</span>: ${esc(payloadJson(f).text)} <code class="k" title="fix key">${short(f.key)}</code></li>`)
    .join("")
  const closure = r.closure ? `<li class="ok">closed by inspector ${addrLink(r.closure.creator)}: ${esc(payloadJson(r.closure).text)}</li>` : ""
  const fake = r.fakeClosures.map((c) => `<li class="bad">ignored "closure" by ${addrLink(c.creator)} (${creatorRole(roles, c.creator)}): not an inspector</li>`).join("")
  return `<article class="remark sev${sev}">
    <div class="rhead">${badge(r.status)} <span class="sev">sev ${sev} · ${SEVERITY[sev]}</span> <span class="muted">${esc(attrValue(e, "section"))} · ${created.toISOString().slice(0, 16).replace("T", " ")} UTC</span></div>
    <p class="rtext">${esc(p.text)}</p>
    <div class="meta">
      ${p.location ? `<span>at ${esc(p.location)}</span>` : ""}${p.norm_ref ? `<span>norm: ${esc(p.norm_ref)}</span>` : ""}
      <span>verified: <code>$creator</code> ${addrLink(e.creator)} is an inspector</span>
      <span>readonly: ${e.creationFlags?.readonly ? "yes" : "no"} · anyone may extend: ${e.creationFlags?.permissionlessExtension ? "yes" : "no"}</span>
      <span>expires ≈ ${exp.toISOString().slice(0, 10)}</span>
      <span class="k">key <code>${e.key}</code> <button class="ghost tiny" data-copy="${e.key}">copy</button></span>
    </div>
    ${p.photo_sha256 ? `<div class="photo">photo SHA-256 <code>${p.photo_sha256.slice(0, 16)}…</code> <label class="ghost tiny">check a photo <input type="file" data-hash="${p.photo_sha256}" hidden /></label><span class="photoRes"></span></div>` : ""}
    <ul class="links">${fixes}${closure}${fake}</ul>
  </article>`
}

function renderCurl(f, roles) {
  if (!roles || !roles.inspectors.length) {
    $("curl").textContent = "(no roster yet)"
    return
  }
  const b = verifiedRemarksQuery(pub, { project: f.project, inspectors: roles.inspectors, minSeverity: f.minSeverity, maxSeverity: f.maxSeverity, sinceTs: f.sinceTs })
  const select = toRpcSelect({ key: true, creator: true, expiresAt: true, attributes: true, payload: true })
  const body = { jsonrpc: "2.0", id: 1, method: "arkiv_query", params: [b.toString(), { select, limit: "0x64" }] }
  $("curl").textContent = `curl -s ${RPC_HTTP} -H 'content-type: application/json' --data '${JSON.stringify(body)}'`
}

async function load() {
  const f = filters()
  history.replaceState(null, "", `?project=${encodeURIComponent(f.project)}&client=${encodeURIComponent(f.trustRoot)}`)
  $("journal").innerHTML = `<p class="muted">Querying Arkiv…</p>`
  try {
    state.head = await pub.getBlockNumber()
    const j = await loadJournal(pub, f)
    state.journal = j
    renderRoles(j.roles, f)
    renderCurl(f, j.roles)
    const st = $("status").value
    const list = j.remarks.filter((r) => !st || r.status === st)
    const count = (s) => j.remarks.filter((r) => r.status === s).length
    $("stats").innerHTML = j.roles ? `<span>${j.remarks.length} verified remarks</span><span>${count("open")} open</span><span>${count("fix-claimed")} fix claimed</span><span>${count("closed")} closed</span><span class="badtext">${j.forged.length} unverified</span><span class="muted">block ${state.head}</span>` : ""
    $("journal").innerHTML = list.length ? list.map((r) => remarkCard(r, j.roles)).join("") : `<p class="muted">No verified remarks match.</p>`
    $("forged").innerHTML = j.forged.length
      ? j.forged.map((e) => `<div class="forged">${addrLink(e.creator)} <span class="role ${creatorRole(j.roles, e.creator)}">${creatorRole(j.roles, e.creator)}</span> wrote: "${esc(payloadJson(e).text)}" <code>${short(e.key)}</code></div>`).join("")
      : "None."
  } catch (err) {
    $("journal").innerHTML = `<p class="badtext">Arkiv query failed: ${esc(err.shortMessage || err.message)}</p>`
  }
}

document.addEventListener("click", (ev) => {
  const c = ev.target.closest("[data-copy]")
  if (c) navigator.clipboard?.writeText(c.dataset.copy)
})
document.addEventListener("change", async (ev) => {
  const inp = ev.target
  if (inp.dataset?.hash && inp.files?.[0]) {
    const h = await sha256Hex(await inp.files[0].arrayBuffer())
    const out = inp.closest(".photo").querySelector(".photoRes")
    out.innerHTML = h === inp.dataset.hash ? ` <b class="oktext">matches the hash on Arkiv</b>` : ` <b class="badtext">does NOT match (${h.slice(0, 12)}…)</b>`
  }
})
for (const id of ["load"]) $(id).addEventListener("click", load)
for (const id of ["minSev", "maxSev", "since", "status"]) $(id).addEventListener("change", load)
$("copyCurl").addEventListener("click", () => navigator.clipboard?.writeText($("curl").textContent))

// ---------- live events over WebSocket (no fromBlock, so the SDK subscribes instead of polling) ----------
let reloadTimer
function startLive() {
  try {
    const ws = createPublicClient({ chain: tiramisu, transport: webSocket(RPC_WS) })
    const tracked = () => {
      const j = state.journal
      if (!j) return new Set()
      return new Set([...j.remarks.map((r) => r.entity.key), ...j.forged.map((e) => e.key)].map((k) => k.toLowerCase()))
    }
    ws.watchEntityEvents({
      onEvent: async (ev) => {
        $("liveText").textContent = "live"
        $("live").classList.add("on")
        // Events carry no attributes, so a new entity is looked up once to see if it belongs to SiteLog.
        let ours = tracked().has(String(ev.entityKey).toLowerCase())
        if (!ours && ev.type === "EntityCreated") {
          try {
            const e = await pub.getEntity(ev.entityKey)
            ours = attrValue(e, "app") === APP && attrValue(e, "project") === filters().project
          } catch {}
        }
        if (!ours) return
        const li = document.createElement("li")
        const who = ev.owner || ev.newOwner || ""
        li.innerHTML = `<span class="evt">${esc(ev.type)}</span> <code>${short(ev.entityKey)}</code> ${who ? "owner " + addrLink(who) : ""} <span class="muted">block ${ev.blockNumber ?? ""} · ${new Date().toISOString().slice(11, 19)} UTC</span>`
        const list = $("events")
        if (list.firstElementChild?.classList.contains("muted")) list.innerHTML = ""
        list.prepend(li)
        while (list.children.length > 30) list.lastElementChild.remove()
        clearTimeout(reloadTimer)
        reloadTimer = setTimeout(load, 1500)
      },
      onError: (e) => {
        $("liveText").textContent = "socket error: " + (e.shortMessage || e.message).slice(0, 60)
        $("live").classList.remove("on")
      },
    })
    $("liveText").textContent = "listening"
  } catch (e) {
    $("liveText").textContent = "no WebSocket"
  }
}

// ---------- writes with the visitor's own wallet ----------
function logw(s) {
  const el = $("writeLog")
  el.classList.remove("hidden")
  el.textContent = `${new Date().toISOString().slice(11, 19)} ${s}\n` + el.textContent
}

$("connect").addEventListener("click", async () => {
  if (!window.ethereum) return logw("No browser wallet found. Use the CLI instead: see the README.")
  try {
    const [a] = await window.ethereum.request({ method: "eth_requestAccounts" })
    try {
      await window.ethereum.request({ method: "wallet_switchEthereumChain", params: [{ chainId: "0x7614d1" }] })
    } catch {
      await window.ethereum.request({ method: "wallet_addEthereumChain", params: [{ chainId: "0x7614d1", chainName: "Arkiv Tiramisu", nativeCurrency: { name: "Golem", symbol: "GLM", decimals: 18 }, rpcUrls: [RPC_HTTP], blockExplorerUrls: [EXPLORER] }] })
    }
    state.me = a
    state.wallet = createWalletClient({ chain: tiramisu, transport: custom(window.ethereum), account: a })
    const role = creatorRole(state.journal?.roles, a)
    $("me").innerHTML = `${addrLink(a)} · your role in this roster: <span class="role ${role}">${role}</span>${role === "unknown" ? " (what you write will be shown as unverified)" : ""}`
    $("writeForms").classList.remove("hidden")
  } catch (e) {
    logw("connect failed: " + (e.shortMessage || e.message))
  }
})

async function fileHash(id) {
  const f = $(id).files?.[0]
  return f ? sha256Hex(await f.arrayBuffer()) : ""
}

async function run(label, fn) {
  try {
    logw(label + "… confirm in your wallet")
    const r = await fn()
    logw(`${label}: done, tx ${r.txHash}${r.entityKey ? " entity " + r.entityKey : ""}${r.createdEntities ? " created " + r.createdEntities.join(",") : ""}`)
    setTimeout(load, 2500)
  } catch (e) {
    logw(`${label} failed: ${e.shortMessage || e.message}`)
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

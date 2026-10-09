// Agent Action Log page: reads one agent run from the public Tiramisu RPC, verifies it in the
// browser (hashes, EIP-191 signatures, hash links, seal, $creator) and lets anyone export it,
// tamper with a copy, or check an export offline. No SiteLog server is involved.
import { createPublicClient } from "@arkiv-network/sdk"
import { tiramisu } from "@arkiv-network/sdk/chains"
import { toRpcSelect } from "@arkiv-network/sdk/query"
import { http } from "viem"
import { exportBundle, hashValue, listRuns, loadRun, runQuery, verifyExport } from "../agentlog/src/index.ts"
import { EXPLORER, RPC_HTTP, creationTxs } from "./lib/sitelog.js"

export const DEMO_AGENT = "release-checker"
export const DEMO_SIGNER = "0x3ad7cD724fF2c472aC5Ca5a0F0edbd6880d2c546"
export const DEMO_RUN = "run-20261009T152956"
const BLOCK_S = 2

const $ = (id) => document.getElementById(id)
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c])
const short = (a, n = 6) => (a ? `${String(a).slice(0, n)}…${String(a).slice(-4)}` : "")
const addrLink = (a) => `<a href="${EXPLORER}/address/${encodeURIComponent(a ?? "")}" target="_blank" rel="noopener" title="${esc(a)}">${esc(short(a))}</a>`
const entityLink = (k, label) => `<a href="${EXPLORER}/entity/${encodeURIComponent(k ?? "")}" target="_blank" rel="noopener" title="entity ${esc(k)}">${esc(label || short(k))}</a>`
const txLink = (h, label = "tx") => (h ? `<a href="${EXPLORER}/tx/${encodeURIComponent(h)}" target="_blank" rel="noopener" title="${esc(h)}">${esc(label)}</a>` : "")
const hashCell = (h) => `<code title="${esc(h)}">${esc(String(h).slice(0, 10))}…</code>`

const pub = createPublicClient({ chain: tiramisu, transport: http(RPC_HTTP, { retryCount: 1 }) })
let state = { run: null, agentId: DEMO_AGENT, signer: DEMO_SIGNER, runId: DEMO_RUN, txs: new Map(), head: 0n }

function rpcError(err) {
  const msg = err?.data?.message || err?.shortMessage || err?.message || String(err)
  if (/429|rate limit|Too Many|COST_LIMITED/i.test(`${err?.status ?? ""} ${err?.details ?? ""} ${msg}`)) return "the public Tiramisu RPC quota for your network address is used up (HTTP 429). It resets within the hour."
  return msg
}

const params = new URLSearchParams(location.search)
state.agentId = params.get("agent") || DEMO_AGENT
state.signer = params.get("signer") || DEMO_SIGNER
state.runId = params.get("run") || DEMO_RUN
$("agentId").value = state.agentId
$("signer").value = state.signer
$("runId").value = state.runId

const verdictText = {
  intact: ["ok", "INTACT", "every hash, signature and link checks out, and the run is sealed"],
  open: ["warn", "OPEN", "every step checks out so far, but the run has no run.end seal (it may still be running, or it stopped)"],
  broken: ["bad", "BROKEN", "at least one check failed: see the rows marked below"],
  empty: ["bad", "NOT FOUND", "no step of this run was created by this agent wallet"],
}

function renderVerdict(r, foreign) {
  const [cls, word, text] = verdictText[r.verdict]
  $("verdict").className = `verdict ${cls}`
  $("verdict").innerHTML = `<b>${word}</b> ${esc(text)}.${r.problems.length ? `<ul>${r.problems.map((p) => `<li>${esc(p)}</li>`).join("")}</ul>` : ""}`
  const owners = new Set(state.run.entries.map((x) => x.owner))
  $("tiles").innerHTML = `
    <div class="tile"><b>${r.steps}</b><span>steps by the agent wallet</span></div>
    <div class="tile"><b>${r.checks.filter((c) => c.ok).length}/${r.checks.length}</b><span>entries verified in this tab</span></div>
    <div class="tile"><b>${r.sealed ? "yes" : "no"}</b><span>sealed with run.end</span></div>
    <div class="tile bad"><b>${foreign}</b><span>forged records ignored</span></div>`
  const custody = [...owners].filter((o) => o && o !== state.signer.toLowerCase())
  $("facts").innerHTML = `agent <b>${esc(state.agentId)}</b> · wallet ${addrLink(state.signer)} · head <code title="${esc(r.head)}">${esc(short(r.head, 12))}</code> ·
    owner of the entries: ${custody.length ? `custodian ${custody.map(addrLink).join(", ")} <span class="muted">(the agent cannot delete or patch them)</span>` : `the agent itself <span class="muted">(no custodian)</span>`} ·
    <span class="muted">snapshot at block ${state.run.atBlock}</span>`
}

function renderSteps(run) {
  const checks = new Map(run.report.checks.map((c) => [c.entry_hash, c]))
  const rows = run.entries.map((x) => {
    const e = x.entry
    const c = checks.get(e.entry_hash)
    const days = x.expires_at_block ? ((Number(BigInt(x.expires_at_block) - state.head) * BLOCK_S) / 86400).toFixed(0) : "?"
    const when = new Date(e.timestamp).toISOString().slice(11, 19)
    return `<tr class="${c?.ok ? "" : "badrow"}">
      <td>${e.step}</td><td><span class="act">${esc(e.action)}</span>${e.tool ? `<br><span class="muted">${esc(e.tool)}</span>` : ""}</td>
      <td class="note">${esc(e.note)}</td>
      <td>${hashCell(e.input_hash)}<br>${hashCell(e.output_hash)}</td>
      <td>${hashCell(e.prev_entry_hash)}<br>${hashCell(e.entry_hash)}</td>
      <td>${when}<br><span class="muted">${days} d left</span></td>
      <td>${entityLink(x.entity_key, "entity")}<br>${txLink(state.txs.get(String(x.entity_key).toLowerCase()), "tx") || '<span class="muted">tx…</span>'}</td>
      <td>${c?.ok ? '<span class="vbadge ok">ok</span>' : `<span class="vbadge bad">bad</span><div class="badtext small">${esc(c?.problems.join("; "))}</div>`}</td></tr>`
  })
  $("steps").innerHTML = `<thead><tr><th>#</th><th>action / tool</th><th>note</th><th>input / output hash</th><th>prev / entry hash</th><th>time UTC</th><th>Arkiv</th><th>check</th></tr></thead><tbody>${rows.join("")}</tbody>`
}

function renderForged(run) {
  $("forged").innerHTML = run.foreign.length
    ? run.foreign
        .map((x) => {
          const genuine = run.entries.some((g) => g.entry.entry_hash === x.entry.entry_hash)
          return `<div class="forged"><span class="vbadge bad">forged</span> step ${x.entry.step} · ${esc(x.entry.action)} ${esc(x.entry.tool)} · "${esc(x.entry.note)}"
          <div class="meta"><span>created by ${addrLink(x.creator)}, not the agent wallet</span><span>${entityLink(x.entity_key, "entity")} ${txLink(state.txs.get(String(x.entity_key).toLowerCase()), "tx")}</span>
          <span>${genuine ? "a byte-for-byte replay of a genuine entry: the agent's signature is valid, but $creator gives it away" : "signed by " + esc(short(x.entry.signer)) + ", not the agent"}</span></div></div>`
        })
        .join("")
    : "None."
}

function renderCurl() {
  const b = runQuery(pub, { agentId: state.agentId, runId: state.runId })
  const select = toRpcSelect({ key: true, creator: true, owner: true, expiresAt: true, payload: true })
  const body = { jsonrpc: "2.0", id: 1, method: "arkiv_query", params: [b.toString(), { select, limit: "0xc8" }] }
  $("curl").textContent = `curl -s ${RPC_HTTP} -H 'content-type: application/json' --data '${JSON.stringify(body).replace(/'/g, `'"'"'`)}'`
}

async function addTxs(items) {
  try {
    const ents = items.filter((x) => x.created_at_block).map((x) => ({ key: x.entity_key, createdAt: BigInt(x.created_at_block) }))
    const m = await creationTxs(pub, ents)
    for (const [k, v] of m) state.txs.set(k, v)
  } catch (e) {
    console.warn("creation tx lookup failed", e)
  }
}

// Two arkiv_query calls per page load: the agent's runs, then the selected run (friction F7: ~100 per hour).
async function load({ refreshRuns = true } = {}) {
  history.replaceState(null, "", `?run=${encodeURIComponent(state.runId)}${state.agentId !== DEMO_AGENT ? "&agent=" + encodeURIComponent(state.agentId) : ""}${state.signer.toLowerCase() !== DEMO_SIGNER.toLowerCase() ? "&signer=" + encodeURIComponent(state.signer) : ""}`)
  $("verdict").className = "verdict muted"
  $("verdict").textContent = "Querying Arkiv…"
  for (const b of ["export", "tamper", "evidence"]) $(b).disabled = true
  try {
    state.head = await pub.getBlockNumber()
    if (refreshRuns) {
      const runs = await listRuns(pub, { agentId: state.agentId, signer: state.signer, atBlock: state.head })
      if (!runs.some((r) => r.run_id === state.runId)) runs.unshift({ run_id: state.runId, ts: 0, note: "" })
      $("runSel").innerHTML = runs.map((r) => `<option value="${esc(r.run_id)}">${esc(r.run_id)}${r.note ? " · " + esc(r.note) : ""}</option>`).join("")
    }
    $("runSel").value = state.runId
    renderCurl()
    const run = await loadRun(pub, { agentId: state.agentId, runId: state.runId, signer: state.signer, atBlock: state.head })
    state.run = run
    $("runSub").textContent = state.runId
    renderVerdict(run.report, run.foreign.length)
    renderSteps(run)
    renderForged(run)
    for (const b of ["export", "tamper", "evidence"]) $(b).disabled = !run.entries.length
    await addTxs([...run.entries, ...run.foreign])
    renderSteps(run)
    renderForged(run)
  } catch (err) {
    $("verdict").className = "verdict bad"
    $("verdict").innerHTML = `Arkiv query failed: ${esc(rpcError(err))}`
  }
}

function bundle() {
  return exportBundle(state.run, { agentId: state.agentId, runId: state.runId, signer: state.signer })
}
const json = (v) => JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? x.toString() : x), 1)

$("export").addEventListener("click", () => {
  const a = document.createElement("a")
  a.href = URL.createObjectURL(new Blob([json(bundle())], { type: "application/json" }))
  a.download = `${state.runId}.agentlog.json`
  a.click()
})

// Three edits an operator might be tempted to make, each re-verified on a copy. Nothing is sent anywhere.
$("tamper").addEventListener("click", async () => {
  const out = []
  const base = JSON.parse(json(bundle()))
  const n = base.entries.length
  const pick = Math.min(4, n - 1)
  const cases = [
    ["edit what a tool returned (step " + pick + " output_hash)", (b) => (b.entries[pick].entry.output_hash = "0x" + "11".repeat(32))],
    ["delete a step (step " + Math.min(3, n - 1) + ")", (b) => b.entries.splice(Math.min(3, n - 1), 1)],
    ["drop the seal (cut the run short)", (b) => b.entries.pop()],
    ["re-sign step 1 with another key", (b) => (b.entries[1].entry.signer = "0x0757a42040c19a8c686c9d3a36336203c889d29b")],
  ]
  for (const [label, fn] of cases) {
    const copy = JSON.parse(json(base))
    fn(copy)
    const r = await verifyExport(copy)
    out.push(`${label}\n  -> ${r.verdict.toUpperCase()}: ${(r.problems.find((p) => !/fails? verification/.test(p)) || r.checks.find((c) => !c.ok)?.problems.map((x) => `step ${r.checks.find((c) => !c.ok).step}: ${x}`).join("; ") || (r.sealed ? "sealed" : "no run.end seal: the run looks unfinished")).slice(0, 160)}`)
  }
  $("tamperOut").classList.remove("hidden")
  $("tamperOut").textContent = `Untouched copy -> ${(await verifyExport(base)).verdict.toUpperCase()}\n\n${out.join("\n\n")}`
})

// Raw inputs and outputs stay with the operator; given them, anyone can check them against the hashes on Arkiv.
$("evidence").addEventListener("click", async () => {
  const out = $("tamperOut")
  out.classList.remove("hidden")
  out.textContent = "Loading the evidence file published for this run…"
  try {
    const res = await fetch(`demo/runs/${encodeURIComponent(state.runId)}.evidence.json`)
    if (!res.ok) throw new Error(`no published evidence for ${state.runId} (HTTP ${res.status}). Raw inputs normally stay with the operator.`)
    const ev = await res.json()
    const onChain = new Map(state.run.entries.map((x) => [x.entry.step, x.entry]))
    const lines = []
    for (const l of ev.entries) {
      const e = onChain.get(l.entry.step)
      const inOk = e && (await hashValue(l.raw?.input)) === e.input_hash
      const outOk = e && (await hashValue(l.raw?.output)) === e.output_hash
      lines.push(`step ${l.entry.step} ${l.entry.action} ${l.entry.tool}: input ${inOk ? "matches" : "DOES NOT match"}, output ${outOk ? "matches" : "DOES NOT match"} the hash on Arkiv`)
    }
    out.textContent = `Evidence file: demo/runs/${state.runId}.evidence.json (raw LLM requests, replies and tool results, kept off chain)\n\n${lines.join("\n")}`
  } catch (e) {
    out.textContent = e.message
  }
})

$("vfile").addEventListener("change", async (ev) => {
  const f = ev.target.files?.[0]
  if (!f) return
  try {
    const b = JSON.parse(await f.text())
    const r = await verifyExport(b)
    const [cls, word, text] = verdictText[r.verdict]
    // An export proves "this wallet signed this chain". Whether that wallet is the agent you audit is
    // a separate question: compare it with the wallet the operator published.
    const who = String(r.signer).toLowerCase() === state.signer.toLowerCase()
      ? `<div class="oktext small">Signer matches the agent wallet loaded above (${esc(short(state.signer))}).</div>`
      : `<div class="badtext small">Signer ${esc(r.signer)} is not the agent wallet loaded above (${esc(state.signer)}): the file is consistent, but check that this is the wallet you expect.</div>`
    $("vout").innerHTML = `<div class="verdict ${cls}"><b>${word}</b> ${esc(text)}. ${r.steps} steps, signer ${esc(short(r.signer))}, head <code>${esc(short(r.head, 12))}</code>, exported ${esc(b.exported_at)} at block ${esc(b.source?.at_block ?? "?")}.
      ${r.problems.length ? `<ul>${r.problems.map((p) => `<li>${esc(p)}</li>`).join("")}</ul>` : ""}${b.foreign?.length ? `<div class="muted">${b.foreign.length} forged record(s) in the file are listed apart and never part of the chain.</div>` : ""}${who}</div>`
  } catch (e) {
    $("vout").innerHTML = `<div class="verdict bad">Not a valid export: ${esc(e.message)}</div>`
  }
})

$("runSel").addEventListener("change", () => {
  state.runId = $("runSel").value
  $("runId").value = state.runId
  load({ refreshRuns: false })
})
$("load").addEventListener("click", () => {
  state.agentId = $("agentId").value.trim()
  state.signer = $("signer").value.trim()
  state.runId = $("runId").value.trim()
  load()
})
$("copyCurl").addEventListener("click", () => navigator.clipboard?.writeText($("curl").textContent))

load()

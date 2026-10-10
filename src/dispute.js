// Dispute replay and "details off chain" sections of the Agent Action Log page.
// Party files are read with File.text() in this tab and passed to replayDispute() (agentlog/src/dispute.ts),
// which makes no network request. Only the demo button fetches files, and only this site's public demo files.
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts"
import { GENESIS, buildEntry, checkRaw, commitTool, commitValue, hashValue, newSalt, replayDispute, sha256 } from "../agentlog/src/index.ts"

const $ = (id) => document.getElementById(id)
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c])
const short = (a, n = 10) => (a ? `${String(a).slice(0, n)}…${String(a).slice(-4)}` : "")
const json = (v) => JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? x.toString() : x), 1)

const VERDICT = {
  operator: ["ok", "operator's version"],
  client: ["ok", "client's version"],
  both: ["ok", "both agree"],
  neither: ["warn", "neither version"],
  no_anchor: ["bad", "no anchor on chain"],
  not_disputed: ["muted", "not disputed"],
}

async function readFile(input) {
  const f = input.files?.[0]
  if (!f) return undefined
  const bytes = new Uint8Array(await f.arrayBuffer())
  let file
  try {
    file = JSON.parse(new TextDecoder().decode(bytes))
  } catch (e) {
    throw new Error(`${f.name} is not JSON: ${e.message}`)
  }
  return { file, name: f.name, sha256: await sha256(bytes) }
}

async function fetchDemo(path) {
  const res = await fetch(path)
  if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`)
  const bytes = new Uint8Array(await res.arrayBuffer())
  return { file: JSON.parse(new TextDecoder().decode(bytes)), name: path.split("/").pop(), sha256: await sha256(bytes) }
}

function partyCell(p, label) {
  if (!p.provided) return `<span class="muted">${p.claim ? "claim only" : "—"}</span>${p.claim ? `<div class="claim">“${esc(p.claim)}”</div>` : ""}`
  const c = p.check || {}
  const bit = (k) => (c[k] === null || c[k] === undefined ? "" : `<span class="vbadge ${c[k] ? "ok" : "bad"}">${k} ${c[k] ? "matches" : "differs"}</span> `)
  return `${bit("input")}${bit("output")}${bit("tool")}${p.claim ? `<div class="claim">“${esc(p.claim)}”</div>` : ""}${p.excerpt ? `<div class="excerpt" title="${esc(label)}'s output"><code>${esc(p.excerpt)}</code></div>` : ""}`
}

function renderReport(r) {
  const s = r.summary
  const runV = { intact: "ok", open: "warn", broken: "bad", empty: "bad" }[r.run.chain_verdict]
  const rows = r.steps.map((x) => {
    const [cls, word] = VERDICT[x.verdict]
    return `<tr class="${x.disputed ? "disputed" : "quiet"}">
      <td>${x.step}</td>
      <td><span class="act">${esc(x.action || "?")}</span>${x.tool ? `<br><span class="muted">${esc(x.tool_revealed ? `${x.tool_revealed} (${short(x.tool, 8)})` : x.tool)}</span>` : ""}${x.note ? `<div class="note small">${esc(x.note)}</div>` : ""}</td>
      <td>${x.chain_ok ? '<span class="vbadge ok">ok</span>' : `<span class="vbadge bad">bad</span><div class="badtext small">${esc(x.chain_problems.join("; "))}</div>`}</td>
      <td>${partyCell(x.operator, "operator")}</td>
      <td>${partyCell(x.client, "client")}</td>
      <td><span class="vword ${cls}">${esc(word)}</span>${x.disputed ? `<div class="small">${esc(x.finding)}</div>` : `<div class="small muted">${esc(x.finding)}</div>`}</td></tr>`
  })
  const files = Object.entries(r.files).map(([p, f]) => `<li>${esc(p)}: <code>${esc(f.name)}</code>, SHA-256 <code title="${esc(f.sha256)}">${esc(short(f.sha256, 14))}</code>, ${f.steps_provided} step(s), ${f.claims} claim(s)</li>`).join("")
  $("dOut").innerHTML = `<div class="dreport" id="dReport">
    <h3 class="printonly">SiteLog dispute replay report</h3>
    <div class="verdict ${runV}"><b>Run ${esc(r.run.chain_verdict.toUpperCase())}</b> ${esc(r.run.run_id)} of <b>${esc(r.run.agent_id)}</b>, ${r.run.steps} steps, signer <code title="${esc(r.run.signer)}">${esc(short(r.run.signer))}</code>, head <code title="${esc(r.run.head)}">${esc(short(r.run.head, 14))}</code>${r.run.source ? `, read from ${esc(r.run.source.network)} at block ${esc(r.run.source.at_block)}` : ", from a file"}.</div>
    ${r.warnings.length ? `<div class="verdict warn"><ul>${r.warnings.map((w) => `<li>${esc(w)}</li>`).join("")}</ul></div>` : ""}
    <div class="tiles">
      <div class="tile"><b>${s.operator}</b><span>operator's version confirmed</span></div>
      <div class="tile"><b>${s.client}</b><span>client's version confirmed</span></div>
      <div class="tile"><b>${s.both}</b><span>both agree</span></div>
      <div class="tile ${s.neither + s.no_anchor ? "bad" : ""}"><b>${s.neither + s.no_anchor}</b><span>not confirmable</span></div>
    </div>
    <h3>What the agent actually did, step by step <span class="muted small">${s.disputed} disputed step(s) highlighted</span></h3>
    <div class="tablewrap"><table class="steps dtable"><thead><tr><th>#</th><th>action / tool / note (on chain)</th><th>chain</th><th>operator's file</th><th>client's file</th><th>verdict</th></tr></thead><tbody>${rows.join("")}</tbody></table></div>
    <ul class="small">${files}</ul>
    <p class="small muted">${r.caveats.map(esc).join(" ")}</p>
    <p class="small">Report <code>${esc(r.format)}</code>, created ${esc(r.created_at)}, report_hash <code>${esc(r.report_hash)}</code></p>
  </div>`
}

export function initDispute({ currentBundle, demoRun }) {
  let last = null
  const status = (t) => ($("dStatus").textContent = t)
  let demo = null // { bundle?, operator, client } when the demo button filled the inputs

  $("dSource").addEventListener("change", () => $("dExportWrap").classList.toggle("hidden", $("dSource").value !== "file"))
  for (const id of ["dOperator", "dClient", "dExport"]) $(id).addEventListener("change", () => (demo = null))

  async function run() {
    try {
      let bundle
      if (demo) {
        bundle = demo.bundle ?? currentBundle()
      } else if ($("dSource").value === "file") {
        const f = await readFile($("dExport"))
        if (!f) throw new Error("choose an export file (agentlog-export/v1), or switch the run record to the run loaded above")
        bundle = f.file
      } else {
        bundle = currentBundle()
        if (!bundle) throw new Error("no run is loaded above (the Arkiv query may have failed): choose an export file instead")
      }
      const operator = demo ? demo.operator : await readFile($("dOperator"))
      const client = demo ? demo.client : await readFile($("dClient"))
      if (!operator && !client) throw new Error("choose at least one party's file")
      last = await replayDispute(bundle, { operator, client, includeExcerpts: $("dExcerpts").checked })
      renderReport(last)
      $("dJson").disabled = false
      $("dPrint").disabled = false
      status(`${demo ? demo.story + " " : ""}Replayed in this tab: ${last.summary.disputed} disputed step(s).`)
    } catch (e) {
      status(`Cannot replay: ${e.message}`)
    }
  }

  $("dRun").addEventListener("click", run)
  $("dDemo").addEventListener("click", async () => {
    status("Loading the two public demo files…")
    try {
      const base = `demo/runs/${demoRun}`
      const [operator, client] = await Promise.all([fetchDemo(`${base}.dispute-operator.json`), fetchDemo(`${base}.dispute-client.json`)])
      const loaded = currentBundle()
      // Without a live run (RPC quota used up, another run selected) the published export of the demo run is used.
      const useLoaded = loaded && loaded.run_id === demoRun
      demo = { operator, client, bundle: useLoaded ? null : (await fetchDemo(`${base}.export.json`)).file }
      demo.story = `Demo: the client says the live page was down and the release was never approved; the operator says the opposite. Run record: ${useLoaded ? "the run loaded above from Arkiv" : "the published export of the demo run (the Arkiv query above did not load it)"}.`
      await run()
    } catch (e) {
      status(`Cannot load the demo: ${e.message}`)
    }
  })
  $("dJson").addEventListener("click", () => {
    if (!last) return
    const a = document.createElement("a")
    a.href = URL.createObjectURL(new Blob([json(last)], { type: "application/json" }))
    a.download = `${last.run.run_id}.dispute-report.json`
    a.click()
  })
  $("dPrint").addEventListener("click", () => {
    document.body.classList.add("print-dispute")
    const off = () => {
      document.body.classList.remove("print-dispute")
      window.removeEventListener("afterprint", off)
    }
    window.addEventListener("afterprint", off)
    window.print()
  })
}

export function initOffchain({ currentBundle, demoRun }) {
  $("ocShow").addEventListener("click", async () => {
    try {
      const base = `demo/runs/${demoRun}`
      const loaded = currentBundle()
      const bundle = loaded && loaded.run_id === demoRun ? loaded : (await fetchDemo(`${base}.export.json`)).file
      const ev = (await fetchDemo(`${base}.evidence.json`)).file
      const pub = bundle.entries.find((x) => x.entry.step === 4)
      const raw = ev.entries.find((x) => x.entry.step === 4)?.raw
      $("ocPublic").textContent = json({ entity_key: pub.entity_key, $creator: pub.creator, owner: pub.owner, payload: pub.entry })
      const c = await checkRaw(pub.entry, raw)
      $("ocPrivate").textContent = `${json(raw)}\n\nchecked in this tab against the hashes on the left: input ${c.input ? "matches" : "DOES NOT match"}, output ${c.output ? "matches" : "DOES NOT match"}`
    } catch (e) {
      $("ocPublic").textContent = `Cannot load: ${e.message}`
    }
  })

  $("ocStrict").addEventListener("click", async () => {
    const out = $("ocStrictOut")
    out.classList.remove("hidden")
    const account = privateKeyToAccount(generatePrivateKey())
    const tool = "crm_lookup"
    const input = { customer: "ACME GmbH", field: "credit_limit" }
    const output = { credit_limit: 50000, currency: "EUR" }
    const salt = newSalt()
    const entry = await buildEntry(
      { agent_id: "demo-agent", run_id: "strict-demo", step: 0, action: "tool.call", tool: await commitTool(tool, salt), input_hash: await commitValue(input, salt), output_hash: await commitValue(output, salt), prev_entry_hash: GENESIS, note: "" },
      account,
    )
    const raw = { input, output, salt, tool }
    const ok = await checkRaw(entry, raw)
    const guess = (await hashValue(output)) === entry.output_hash
    const lie = await checkRaw(entry, { ...raw, output: { credit_limit: 500000, currency: "EUR" } })
    out.textContent = `Goes on Arkiv (public):\n${json(entry)}\n\nStays in the evidence file (private):\n${json(raw)}\n\nWith the evidence file: input ${ok.input ? "matches" : "fails"}, output ${ok.output ? "matches" : "fails"}, tool name ${ok.tool ? "matches" : "fails"}.\nA claimed credit limit of 500000 instead: output ${lie.output ? "matches" : "does not match"}.\nWithout the salt, hashing the right output gives the on-chain hash: ${guess ? "yes" : "no"}. Guessing does not work.\n(Throwaway key ${account.address}; nothing was sent anywhere.)`
  })
}

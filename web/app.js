// Simulated Alexa+ experience for the agentlog MCP server.
// 1. A hand-written MCP client (no SDK on purpose, so every byte on the wire is visible):
//    initialize -> notifications/initialized -> tools/list -> tools/call, over Streamable HTTP.
// 2. Voice in (Web Speech API recognition) and voice out (speech synthesis).
// 3. An MCP Apps host: a tool that declares _meta.ui.resourceUri gets its view rendered in a sandboxed frame.
// The intent router below stands in for Alexa+'s model: it maps an utterance to one tool call.

const MCP_URL = new URL("/mcp", location.href).href
const PROTOCOL = "2025-11-25"
const UI_MIME = "text/html;profile=mcp-app"
const ARKIV_RUN = { source: "arkiv", agent_id: "release-checker", run_id: "run-20261009T152956" }

const $ = (id) => document.getElementById(id)
const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"

// ---------------- wire log ----------------

function wire(dir, title, meta, body) {
  const li = document.createElement("li")
  li.className = dir
  const d = document.createElement("details")
  const s = document.createElement("summary")
  const arrow = dir === "out" ? "→" : dir === "in" ? "←" : "•"
  s.innerHTML = `<span>${arrow}</span><b></b><span class="meta"></span>`
  s.querySelector("b").textContent = title
  s.querySelector(".meta").textContent = meta || ""
  const pre = document.createElement("pre")
  pre.textContent = typeof body === "string" ? body : JSON.stringify(body, null, 2)
  d.append(s, pre)
  li.append(d)
  $("wire").append(li)
  li.scrollIntoView({ block: "nearest" })
}

// ---------------- MCP client over Streamable HTTP ----------------

class McpClient {
  constructor(url) {
    this.url = url
    this.id = 0
    this.session = null
    this.protocol = null
    this.server = null
  }

  headers() {
    const h = { "content-type": "application/json", accept: "application/json, text/event-stream" }
    if (this.session) h["mcp-session-id"] = this.session
    if (this.protocol) h["mcp-protocol-version"] = this.protocol
    return h
  }

  async post(msg) {
    const headers = this.headers()
    wire("out", msg.method, `POST /mcp${this.session ? ` · Mcp-Session-Id ${this.session.slice(0, 8)}…` : ""}`, { headers, body: msg })
    const res = await fetch(this.url, { method: "POST", headers, body: JSON.stringify(msg) })
    const sid = res.headers.get("mcp-session-id")
    if (sid) this.session = sid
    const type = res.headers.get("content-type") || ""
    if (res.status === 202) {
      wire("in", `${res.status} Accepted`, msg.method, "(no body: notification accepted)")
      return []
    }
    const text = await res.text()
    let messages = []
    if (type.includes("text/event-stream")) {
      // SSE, line by line: data: lines accumulate until a blank line ends the event.
      let data = []
      const flush = () => {
        if (data.length) messages.push(JSON.parse(data.join("\n")))
        data = []
      }
      for (const line of text.split(/\r\n|\r|\n/)) {
        if (line === "") flush()
        else if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""))
      }
      flush()
    } else if (text) {
      const j = JSON.parse(text)
      messages = Array.isArray(j) ? j : [j]
    }
    for (const m of messages) wire("in", m.error ? `error ${m.error.code}` : m.method || `result #${m.id}`, `${res.status} · ${type.split(";")[0]}${sid ? ` · Mcp-Session-Id ${sid.slice(0, 8)}…` : ""}`, m)
    if (!res.ok && !messages.length) throw new Error(`HTTP ${res.status}: ${text}`)
    return messages
  }

  async request(method, params) {
    const id = ++this.id
    const messages = await this.post({ jsonrpc: "2.0", id, method, params })
    const m = messages.find((x) => x.id === id)
    if (!m) throw new Error(`no response to ${method}`)
    if (m.error) throw new Error(m.error.message)
    return m.result
  }

  notify(method, params) {
    return this.post({ jsonrpc: "2.0", method, ...(params ? { params } : {}) })
  }

  async connect() {
    const r = await this.request("initialize", {
      protocolVersion: PROTOCOL,
      capabilities: { extensions: { "io.modelcontextprotocol/ui": { mimeTypes: [UI_MIME] } } },
      clientInfo: { name: "alexa-plus-web-simulator", title: "Alexa+ web simulator", version: "0.1.0" },
    })
    this.protocol = r.protocolVersion
    this.server = r
    await this.notify("notifications/initialized")
    return r
  }
}

const mcp = new McpClient(MCP_URL)
let tools = []
let health = { demo: false, arkiv: false }

// ---------------- MCP Apps host ----------------

const uiCache = new Map()
let pendingView = null

async function showView(tool, args, result) {
  const uri = tool?._meta?.ui?.resourceUri
  if (!uri) {
    $("cardWrap").hidden = true
    return
  }
  let html = uiCache.get(uri)
  if (!html) {
    const r = await mcp.request("resources/read", { uri })
    const c = r.contents.find((x) => x.mimeType === UI_MIME) || r.contents[0]
    html = c.text
    uiCache.set(uri, html)
  }
  pendingView = { html, args, result, tool }
  $("cardWrap").hidden = false
  // A fresh frame per answer: the view starts clean, like a new card on a device screen.
  $("card").src = `sandbox.html?v=${Date.now()}`
}

window.addEventListener("message", (ev) => {
  const frame = $("card").contentWindow
  if (ev.source !== frame || !ev.data) return
  const m = ev.data
  if (m.type === "agentlog-sandbox-ready" && pendingView) {
    frame.postMessage({ type: "agentlog-sandbox-html", html: pendingView.html }, "*")
    return
  }
  if (m.jsonrpc !== "2.0") return
  wire("note", `view → host: ${m.method || `result #${m.id}`}`, "MCP Apps postMessage", m)
  const reply = (msg) => {
    wire("note", `host → view: ${msg.method || `result #${msg.id}`}`, "MCP Apps postMessage", msg)
    frame.postMessage(msg, "*")
  }
  if (m.method === "ui/initialize") {
    const dark = matchMedia("(prefers-color-scheme: dark)").matches
    reply({ jsonrpc: "2.0", id: m.id, result: { protocolVersion: "2026-01-26", hostInfo: { name: "alexa-plus-web-simulator", version: "0.1.0" }, hostCapabilities: {}, hostContext: { theme: dark ? "dark" : "light", displayMode: "inline", platform: "web", locale: navigator.language, timeZone: tz } } })
  } else if (m.method === "ui/notifications/initialized" && pendingView) {
    reply({ jsonrpc: "2.0", method: "ui/notifications/tool-input", params: { arguments: pendingView.args } })
    reply({ jsonrpc: "2.0", method: "ui/notifications/tool-result", params: pendingView.result })
  } else if (m.method === "ui/notifications/size-changed" && m.params?.height) {
    $("card").style.height = `${Math.min(Math.max(m.params.height + 4, 160), 900)}px`
  } else if (m.id != null && m.method) {
    reply({ jsonrpc: "2.0", id: m.id, error: { code: -32601, message: `${m.method} is not supported by this host` } })
  }
})

// ---------------- intent router (stands in for Alexa+'s model) ----------------

async function findRun(prefix) {
  const r = await mcp.request("tools/call", { name: "list_runs", arguments: { agent_id: "release-checker", tz, limit: 50 } })
  return r.structuredContent?.runs?.find((x) => x.run_id.startsWith(prefix))?.run_id
}

async function plan(text) {
  const t = text.toLowerCase().replace(/^\s*(hey\s+)?alexa[,!\s]*/, "")
  const date = /\btoday\b/.test(t) ? "today" : (/\b(\d{4}-\d{2}-\d{2})\b/.exec(t)?.[1] ?? "yesterday")
  if (/\b(arkiv|on[- ]chain|blockchain|sitelog|public)\b/.test(t)) return { name: "verify_run", arguments: ARKIV_RUN, why: "asks about the public run on Arkiv" }
  if (/\b(who('?s| is)? right|dispute|disagree|client|operator)\b/.test(t)) {
    const run_id = await findRun("run-afternoon-v1.4.3")
    if (!run_id || !health.demo) throw new Error("The dispute demo needs the server started with npm run demo.")
    const client = await (await fetch("/demo/client-file.json")).json()
    return { name: "diff_versions", arguments: { agent_id: "release-checker", run_id, client }, why: "a dispute: replays the client's copy against the signed run" }
  }
  if (/\b(afternoon|1\.4\.3|that run)\b/.test(t)) {
    const run_id = await findRun("run-afternoon-v1.4.3")
    if (run_id) return { name: "verify_run", arguments: { agent_id: "release-checker", run_id }, why: "asks about one run" }
  }
  if (/\b(list|which runs|show runs)\b/.test(t)) return { name: "list_runs", arguments: { date, tz }, why: "asks for a list" }
  return { name: "audit_day", arguments: { date, tz }, why: "what the agent did on a day, and whether the log is intact" }
}

// ---------------- ask ----------------

let busy = false

async function ask(text) {
  if (busy || !text.trim()) return
  busy = true
  $("heard").hidden = false
  $("heard").textContent = `“${text}”`
  $("reply").className = "reply"
  $("reply").textContent = "…"
  try {
    const p = await plan(text)
    $("plan").hidden = false
    $("plan").textContent = `Tool plan: ${p.name}(${JSON.stringify(p.arguments).slice(0, 220)}) · ${p.why}`
    const result = await mcp.request("tools/call", { name: p.name, arguments: p.arguments })
    const say = (result.content || []).filter((c) => c.type === "text").map((c) => c.text).join(" ")
    $("reply").textContent = say
    if (result.isError) $("reply").className = "reply err"
    speak(say)
    await showView(tools.find((x) => x.name === p.name), p.arguments, result)
  } catch (err) {
    $("reply").className = "reply err"
    $("reply").textContent = String(err.message || err)
  } finally {
    busy = false
  }
}

function speak(text) {
  if (!$("speakOn").checked || !("speechSynthesis" in window)) return
  speechSynthesis.cancel()
  const u = new SpeechSynthesisUtterance(text)
  u.lang = "en-US"
  u.rate = 1.02
  speechSynthesis.speak(u)
}

// ---------------- voice in ----------------

const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition
let rec = null
if (Recognition) {
  rec = new Recognition()
  rec.lang = "en-US"
  rec.interimResults = true
  rec.maxAlternatives = 1
  rec.onresult = (ev) => {
    const r = ev.results[ev.results.length - 1]
    $("utter").value = r[0].transcript
    if (r.isFinal) ask(r[0].transcript)
  }
  rec.onend = () => $("mic").classList.remove("listening")
  rec.onerror = (ev) => {
    $("mic").classList.remove("listening")
    $("reply").className = "reply err"
    $("reply").textContent = `Microphone: ${ev.error}. You can type the question instead.`
  }
} else {
  $("mic").disabled = true
  $("mic").title = "This browser has no speech recognition (try Chrome or Edge). Type the question instead."
}
$("mic").addEventListener("click", () => {
  if (!rec) return
  speechSynthesis?.cancel()
  $("mic").classList.add("listening")
  try {
    rec.start()
  } catch {
    rec.stop()
  }
})
$("askForm").addEventListener("submit", (e) => {
  e.preventDefault()
  ask($("utter").value)
})

const CHIPS = [
  "Alexa, what did my agent do yesterday, and has its log been tampered with?",
  "Alexa, check the afternoon run.",
  "Alexa, who is right about the afternoon release, the client or the operator?",
  "Alexa, verify the release checker's run on Arkiv.",
]
for (const c of CHIPS) {
  const b = document.createElement("button")
  b.type = "button"
  b.textContent = c.replace(/^Alexa, /, "")
  b.addEventListener("click", () => {
    $("utter").value = c
    ask(c)
  })
  $("chips").append(b)
}

// ---------------- demo controls ----------------

$("tamper").addEventListener("click", async () => {
  const r = await fetch("/demo/tamper", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ mode: $("tamperMode").value }) })
  const j = await r.json()
  $("demoOut").textContent = j.error ? j.error : `Attacker ${j.what} in ${j.run_id}. The server was not told. Ask again.`
  wire("note", "demo: tamper", "outside MCP: direct write to the SQLite file", j)
})
$("reset").addEventListener("click", async () => {
  const j = await (await fetch("/demo/reset", { method: "POST" })).json()
  $("demoOut").textContent = j.error ? j.error : "Demo runs rewritten from scratch."
  wire("note", "demo: reset", "outside MCP", j)
})
$("clearWire").addEventListener("click", () => ($("wire").innerHTML = ""))

// ---------------- start ----------------

;(async () => {
  try {
    health = await (await fetch("/healthz")).json()
    $("demo").hidden = !health.demo
    const init = await mcp.connect()
    const list = await mcp.request("tools/list", {})
    tools = list.tools
    $("tools").innerHTML = ""
    for (const t of tools) {
      const s = document.createElement("span")
      s.textContent = t.name
      if (t._meta?.ui?.resourceUri) {
        s.className = "app"
        s.title = `MCP App view: ${t._meta.ui.resourceUri}`
      }
      $("tools").append(s)
    }
    $("conn").className = "conn ok"
    $("connText").textContent = `${init.serverInfo.name} ${init.serverInfo.version} · MCP ${init.protocolVersion} · session ${mcp.session?.slice(0, 8)}…`
  } catch (err) {
    $("conn").className = "conn err"
    $("connText").textContent = `not connected: ${err.message || err}`
  }
})()

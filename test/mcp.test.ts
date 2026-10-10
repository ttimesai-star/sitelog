// End to end over the wire: a real MCP client (the SDK's) talks Streamable HTTP to the server,
// writes runs, verifies them, an attacker edits the SQLite file, and the server says where.

import { after, before, describe, it } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync } from "node:fs"
import { createServer } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { request as httpRequest } from "node:http"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import { LATEST_PROTOCOL_VERSION } from "@modelcontextprotocol/sdk/types.js"
import { buildCtx } from "../src/ctx.ts"
import { startHttp } from "../src/http.ts"
import { DEMO_AGENT, demoClientFile, seedDemo, tamperDemo } from "../src/demo.ts"
import { UI_MIME, UI_URI } from "../src/mcp.ts"

const TZ = "Europe/Minsk"
const NOW = Date.parse("2026-10-10T09:00:00Z")

function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const s = createServer().listen(0, "127.0.0.1", () => {
      const p = (s.address() as { port: number }).port
      s.close(() => resolve(p))
    })
  })
}

async function boot(dataDir: string) {
  const port = await freePort()
  const built = buildCtx({ dataDir, tz: TZ, arkiv: false, now: () => NOW })
  const http = await startHttp(built.ctx, {
    host: "127.0.0.1",
    port,
    demo: {
      tamper: (q) => tamperDemo(built.local, q),
      reset: async () => ({ reset: true, runs: await seedDemo(built.local, built.ctx.keys, TZ, NOW, true) }),
      clientFile: () => demoClientFile(built.local),
    },
  })
  return { ...built, http, url: new URL(`http://127.0.0.1:${port}/mcp`) }
}

async function connect(url: URL) {
  const client = new Client({ name: "test-client", version: "1.0.0" })
  await client.connect(new StreamableHTTPClientTransport(url))
  return client
}

const call = async (c: Client, name: string, args: Record<string, unknown>) => {
  const r = (await c.callTool({ name, arguments: args })) as { isError?: boolean; content: { text: string }[]; structuredContent: any }
  assert.ok(!r.isError, r.content?.[0]?.text)
  return r
}

describe("MCP server over Streamable HTTP", () => {
  const dir = mkdtempSync(join(tmpdir(), "agentlog-mcp-"))
  let srv: Awaited<ReturnType<typeof boot>>
  let client: Client

  before(async () => {
    srv = await boot(dir)
    client = await connect(srv.url)
  })
  after(async () => {
    await client?.close()
    await new Promise((r) => srv.http.close(r))
    srv.local.close()
  })

  it("negotiates protocol 2025-11-25 and lists the six tools with an MCP App view", async () => {
    assert.equal(LATEST_PROTOCOL_VERSION, "2025-11-25")
    assert.equal(client.getServerVersion()?.name, "agentlog-mcp")
    const { tools } = await client.listTools()
    assert.deepEqual(tools.map((t) => t.name).sort(), ["audit_day", "diff_versions", "get_run", "list_runs", "log_action", "verify_run"])
    const audit = tools.find((t) => t.name === "audit_day")!
    assert.equal((audit._meta as any)?.ui?.resourceUri, UI_URI)
    assert.equal(audit.annotations?.readOnlyHint, true)
    const res = await client.readResource({ uri: UI_URI })
    assert.equal(res.contents[0].mimeType, UI_MIME)
    assert.match(String((res.contents[0] as any).text), /ui\/initialize/)
  })

  it("an agent logs a run step by step; verify_run says intact", async () => {
    const a = await call(client, "log_action", { agent_id: "bot", action: "tool.call", tool: "http_get", input: { url: "https://example.com" }, output: { status: 200 }, note: "GET example" })
    const runId = a.structuredContent.run_id
    assert.equal(a.structuredContent.written.length, 2) // run.start written automatically
    await call(client, "log_action", { agent_id: "bot", run_id: runId, action: "llm.call", tool: "m", input: "q", output: "a" })
    const open = await call(client, "verify_run", { agent_id: "bot", run_id: runId })
    assert.equal(open.structuredContent.verdict, "open")
    await call(client, "log_action", { agent_id: "bot", run_id: runId, action: "run.end", output: { ok: true } })
    const v = await call(client, "verify_run", { agent_id: "bot", run_id: runId })
    assert.equal(v.structuredContent.verdict, "intact")
    assert.equal(v.structuredContent.steps, 4)
    assert.match(v.content[0].text, /intact/)
    const sealed = (await client.callTool({ name: "log_action", arguments: { agent_id: "bot", run_id: runId, action: "tool.call" } })) as any
    assert.equal(sealed.isError, true)
    assert.match(sealed.content[0].text, /sealed/)
  })

  it("answers the voice question for yesterday, then catches the attacker's edit at the exact step", async () => {
    await seedDemo(srv.local, srv.ctx.keys, TZ, NOW)
    const before = await call(client, "audit_day", { date: "yesterday", tz: TZ, agent_id: DEMO_AGENT })
    assert.equal(before.structuredContent.date, "2026-10-09")
    assert.equal(before.structuredContent.totals.runs, 3)
    assert.equal(before.structuredContent.totals.broken, 0)
    assert.equal(before.structuredContent.totals.open, 1)
    assert.match(before.content[0].text, /^Yesterday, release-checker ran 3 times/)
    assert.match(before.content[0].text, /No log was tampered with/)

    const t = await tamperDemo(srv.local, { mode: "edit" })
    const afterEdit = await call(client, "audit_day", { date: "yesterday", tz: TZ, agent_id: DEMO_AGENT })
    assert.equal(afterEdit.structuredContent.totals.broken, 1)
    assert.match(afterEdit.content[0].text, /Warning: one log was tampered with/)
    assert.match(afterEdit.content[0].text, /step 2 cannot be trusted: its content was edited after the agent signed it/)
    const run = afterEdit.structuredContent.runs.find((r: any) => r.run_id === t.run_id)
    assert.deepEqual(run.timeline.map((s: any) => s.status), ["ok", "ok", "break", "ok", "ok", "ok", "ok"])
  })

  it("names a step re-signed by an intruder, and a deleted step", async () => {
    await seedDemo(srv.local, srv.ctx.keys, TZ, NOW, true)
    const t = await tamperDemo(srv.local, { mode: "forge" })
    const f = await call(client, "verify_run", { agent_id: DEMO_AGENT, run_id: t.run_id })
    assert.equal(f.structuredContent.explain.first_break.kind, "foreign_signer")
    await seedDemo(srv.local, srv.ctx.keys, TZ, NOW, true)
    const d = await tamperDemo(srv.local, { mode: "delete", step: 3 })
    const g = await call(client, "verify_run", { agent_id: DEMO_AGENT, run_id: d.run_id })
    assert.equal(g.structuredContent.explain.first_break.kind, "deleted")
    assert.equal(g.structuredContent.explain.first_break.step, 3)
    assert.ok(g.structuredContent.timeline.some((s: any) => s.action === "(missing)" && s.step === 3))
  })

  it("settles a dispute: the client's copy matches what the agent signed, the operator's rewrite does not", async () => {
    await seedDemo(srv.local, srv.ctx.keys, TZ, NOW, true)
    const client_file = await demoClientFile(srv.local)
    // The operator rewrites its own evidence (not the chain): the health check now reads 200.
    const t = await tamperDemo(srv.local, { mode: "evidence" })
    assert.equal(t.actor, "operator")
    assert.equal(t.run_id, client_file.run_id)
    const raw = JSON.parse((srv.local.db.prepare("SELECT raw FROM entries WHERE run_id = ? AND step = 2").get(t.run_id) as { raw: string }).raw)
    assert.deepEqual(raw.output, { status: 200, body: "ok" })
    assert.deepEqual(raw.input, { url: "https://staging.acme.example/health" })
    // The signed chain is untouched, so the run itself still verifies: only the dispute can tell the copies apart.
    const v = await call(client, "verify_run", { agent_id: DEMO_AGENT, run_id: t.run_id })
    assert.equal(v.structuredContent.verdict, "intact")
    const r = await call(client, "diff_versions", { agent_id: DEMO_AGENT, run_id: client_file.run_id, client: client_file })
    const verdicts = Object.fromEntries(r.structuredContent.steps.filter((s: any) => s.disputed).map((s: any) => [s.step, s.verdict]))
    assert.equal(verdicts[2], "client")
    assert.equal(verdicts[5], "both")
    assert.match(r.content[0].text, /Step 2 .*the client's version is what the agent signed/)
  })

  it("refuses an unknown tamper mode instead of falling back to an edit", async () => {
    await seedDemo(srv.local, srv.ctx.keys, TZ, NOW, true)
    await assert.rejects(tamperDemo(srv.local, { mode: "rewrite" as never }), (e: Error & { status?: number }) => e.status === 400 && /unknown tamper mode/.test(e.message))
    const res = await fetch(new URL("/demo/tamper", srv.url), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ mode: "rewrite" }),
    })
    assert.equal(res.status, 400)
    const json = (await res.json()) as { error: string }
    assert.match(json.error, /unknown tamper mode/)
  })

  it("get_run returns an export that verifies offline; the run resource returns the same", async () => {
    const runs = await call(client, "list_runs", { agent_id: DEMO_AGENT, date: "2026-10-09", tz: TZ })
    const id = runs.structuredContent.runs[0].run_id
    const g = await call(client, "get_run", { agent_id: DEMO_AGENT, run_id: id, include_raw: true })
    assert.equal(g.structuredContent.export.format, "agentlog-export/v1")
    assert.ok(g.structuredContent.evidence["0"])
    const { verifyExport } = await import("agentlog")
    assert.equal((await verifyExport(g.structuredContent.export)).verdict, g.structuredContent.export.report.verdict)
    const res = await client.readResource({ uri: `agentlog://local/${DEMO_AGENT}/${id}` })
    assert.equal(JSON.parse(String((res.contents[0] as any).text)).run_id, id)
  })

  it("keeps state across server restarts (a new process continues the same chain)", async () => {
    const r = await call(client, "log_action", { agent_id: "persist", run_id: "p1", action: "run.start", note: "survives restarts" })
    assert.equal(r.structuredContent.written[0].step, 0)
    await client.close()
    await new Promise((res) => srv.http.close(res))
    srv.local.close()
    srv = await boot(dir)
    client = await connect(srv.url)
    const r2 = await call(client, "log_action", { agent_id: "persist", run_id: "p1", action: "run.end" })
    assert.equal(r2.structuredContent.written[0].step, 1)
    const v = await call(client, "verify_run", { agent_id: "persist", run_id: "p1" })
    assert.equal(v.structuredContent.verdict, "intact")
  })

  it("rejects requests without a session, from a foreign Origin, and bad input", async () => {
    const noSession = await fetch(srv.url, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: 9, method: "tools/list" }) })
    assert.equal(noSession.status, 400)
    const evil = await fetch(srv.url, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", origin: "https://evil.example" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "x", version: "1" } } }) })
    assert.equal(evil.status, 403)
    const bad = (await client.callTool({ name: "verify_run", arguments: { agent_id: "../etc", run_id: "x" } })) as any
    assert.equal(bad.isError, true)
  })

  it("serves only files inside web/, and refuses a foreign Host on every route (review fixes, Jules 10 Oct)", async () => {
    const get = (path: string, host = `127.0.0.1:${srv.url.port}`) =>
      new Promise<number>((resolve, reject) => {
        const req = httpRequest({ host: "127.0.0.1", port: Number(srv.url.port), path, headers: { host } }, (res) => {
          res.resume()
          resolve(res.statusCode ?? 0)
        })
        req.on("error", reject)
        req.end()
      })
    assert.equal(await get("/"), 200)
    assert.equal(await get("/sandbox.html"), 200)
    for (const p of ["/..%2Fpackage.json", "/..%5Cpackage.json", "/C:%2FWindows%2Fwin.ini", "/%2Fetc%2Fpasswd", "/x%00.html", "/%E0%A4%A"]) {
      assert.ok([400, 404].includes(await get(p)), p)
    }
    assert.equal(await get("/package.json"), 404)
    assert.equal(await get("/healthz", "attacker.example:8787"), 403)
    assert.equal(await get("/demo/client-file.json", "attacker.example"), 403)
  })
})

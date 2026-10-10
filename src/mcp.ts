// The MCP server: six tools, one MCP App view (the audit card), one resource template (a run export).
// Protocol: MCP 2025-11-25 over Streamable HTTP (see http.ts). Tool results carry plain text for a
// voice assistant to read out, structuredContent for clients, and _meta.ui for hosts that render
// MCP Apps.

import { readFileSync } from "node:fs"
import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js"
import { z } from "zod"
import { auditDay, auditRun, diffVersions, listRuns, logAction, store } from "./audit.ts"
import type { Ctx, Source } from "./audit.ts"

export const UI_URI = "ui://agentlog/audit-card.html"
export const UI_MIME = "text/html;profile=mcp-app"
const CARD_HTML = readFileSync(new URL("./ui/audit-card.html", import.meta.url), "utf8")
const VERSION = "0.1.0"

const id = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/, "1-64 characters: letters, digits, dot, dash, underscore, colon")
const source = z.enum(["local", "arkiv"]).optional().describe('Where the run is stored: "local" (SQLite file of this server, default) or "arkiv" (public Arkiv testnet, read from its RPC)')
const tz = z.string().optional().describe("IANA time zone of the user, e.g. Europe/Minsk. Default: the server's.")
const json = z.any().optional()
const partyFile = z.object({
  party: z.string().optional(),
  agent_id: z.string().optional(),
  run_id: z.string().optional(),
  entries: z.array(z.object({ step: z.number().int().nonnegative(), raw: z.object({ input: json, output: json, salt: z.string().optional(), tool: z.string().optional() }).passthrough().optional(), claim: z.string().optional() }).passthrough()).optional(),
  claims: z.array(z.object({ step: z.number().int().nonnegative(), text: z.string() })).optional(),
}).passthrough()

const ui = { ui: { resourceUri: UI_URI } }

function result(text: string, structured: Record<string, unknown>) {
  return { content: [{ type: "text" as const, text }], structuredContent: structured }
}

function fail(err: unknown) {
  return { isError: true, content: [{ type: "text" as const, text: String((err as Error)?.message ?? err) }] }
}

const wrap = <A,>(fn: (a: A) => Promise<ReturnType<typeof result>>) => async (a: A) => {
  try {
    return await fn(a)
  } catch (err) {
    return fail(err)
  }
}

export function createMcpServer(ctx: Ctx): McpServer {
  const server = new McpServer(
    { name: "agentlog-mcp", title: "Agent Action Log", version: VERSION, websiteUrl: "https://github.com/ttimesai-star/agentlog-mcp" },
    {
      capabilities: { logging: {} },
      instructions: [
        "Agent Action Log keeps a tamper-evident record of what AI agents did: every step is hashed, signed by the agent's key and linked to the previous one.",
        "Agents: call log_action for every tool call or model call you make (action \"tool.call\" or \"llm.call\"), and log_action with action \"run.end\" when done.",
        "Users: to answer \"what did my agent do (yesterday) and was the log changed?\", call audit_day. To check one run, call verify_run. Read the 'speech' text out as is: it leads with the verdict.",
        "Never claim a log is intact unless verify_run or audit_day said so in this conversation.",
      ].join("\n"),
    },
  )

  server.registerTool(
    "log_action",
    {
      title: "Log an agent action",
      description:
        "Append one signed, hash-chained step to an agent's run: a tool call, a model call, an error, or the end of the run. A run that does not exist yet is started automatically; omit run_id to start a new one (its id is returned). action \"run.end\" seals the run. Raw input and output stay on this server; only their SHA-256 hashes enter the chain.",
      inputSchema: {
        agent_id: id.describe("Stable name of the agent, e.g. release-checker"),
        run_id: id.optional().describe("Run to append to. Omit to start a new run."),
        action: z.string().min(1).max(64).describe('"run.start", "tool.call", "llm.call", "tool.error", "run.end", or your own verb'),
        tool: z.string().max(64).optional().describe("Tool or model name, e.g. http_get or gpt-oss-20b"),
        input: json.describe("Arguments of the call (any JSON)"),
        output: json.describe("Result of the call (any JSON)"),
        note: z.string().max(280).optional().describe("Short public label. On run.start: the task. Never put secrets or personal data here."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    wrap(async (a) => {
      const r = await logAction(ctx, a)
      const last = r.written[r.written.length - 1]
      return result(`Logged step ${last.step} (${last.action}${last.tool ? ` ${last.tool}` : ""}) in run ${r.run_id} of ${r.agent_id}${r.sealed ? ". The run is sealed." : "."}`, r)
    }),
  )

  server.registerTool(
    "verify_run",
    {
      title: "Verify a run",
      description:
        "Recompute every hash and signature of one run and follow the links from step 0. Says whether the log is intact, open (never sealed) or broken, and where it breaks: the first step that was edited, deleted, re-signed by another key or written after the seal.",
      inputSchema: { agent_id: id, run_id: id, source },
      annotations: { readOnlyHint: true, openWorldHint: false },
      _meta: ui,
    },
    wrap(async (a) => {
      const { audit } = await auditRun(ctx, (a.source ?? "local") as Source, a.agent_id, a.run_id)
      const caveat = audit.signer_known ? "" : " Note: no key is registered for this agent here, so the expected signer was taken from the run itself."
      return result(audit.explain.sentence + caveat, { kind: "run", ...audit })
    }),
  )

  server.registerTool(
    "audit_day",
    {
      title: "What did my agent do, and was the log changed?",
      description:
        "Answer \"what did my agent do yesterday (or on a date), and has its log been tampered with?\". Lists the runs of that day, verifies each one, and returns a spoken summary that leads with the verdict, plus a card with each run's chain of steps and the place where it breaks.",
      inputSchema: {
        agent_id: id.optional().describe("Agent to audit. Omit for every agent."),
        date: z.string().optional().describe('"yesterday" (default), "today" or YYYY-MM-DD'),
        tz,
        source,
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
      _meta: ui,
    },
    wrap(async (a) => {
      const d = await auditDay(ctx, { ...a, source: a.source as Source | undefined })
      return result(d.speech, { kind: "day", ...d })
    }),
  )

  server.registerTool(
    "list_runs",
    {
      title: "List runs",
      description: "List an agent's runs, newest first, optionally only those started on one day. Does not verify them (use verify_run or audit_day for that).",
      inputSchema: { agent_id: id.optional(), date: z.string().optional().describe('"today", "yesterday" or YYYY-MM-DD'), tz, source, limit: z.number().int().min(1).max(200).optional() },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    wrap(async (a) => {
      const r = await listRuns(ctx, { ...a, source: a.source as Source | undefined })
      const lines = r.runs.map((x) => `${x.agent_id} / ${x.run_id}  ${new Date(x.first_ts).toISOString()}${x.entries !== undefined ? `  ${x.entries} entries${x.sealed ? ", sealed" : ", not sealed"}` : ""}${x.note && x.note !== "run started" ? `  "${x.note}"` : ""}`)
      return result(lines.length ? lines.join("\n") : "No runs.", r as unknown as Record<string, unknown>)
    }),
  )

  server.registerTool(
    "get_run",
    {
      title: "Get a run",
      description: "Return every entry of a run (hashes, links, signatures, public notes) and its verification report, as an agentlog-export/v1 bundle that anyone can re-verify offline. With include_raw, also the operator's raw inputs and outputs (private evidence; local runs only).",
      inputSchema: { agent_id: id, run_id: id, source, include_raw: z.boolean().optional() },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    wrap(async (a) => {
      const src = (a.source ?? "local") as Source
      const { audit, verified } = await auditRun(ctx, src, a.agent_id, a.run_id)
      const raw = a.include_raw ? Object.fromEntries(await store(ctx, src).evidence(a.agent_id, a.run_id)) : undefined
      return result(`${audit.steps} steps, verdict ${audit.verdict}. ${audit.explain.sentence}`, { export: verified.bundle, ...(raw ? { evidence: raw } : {}) })
    }),
  )

  server.registerTool(
    "diff_versions",
    {
      title: "Settle a dispute over a run",
      description:
        "Two parties disagree about what the agent did. Each brings its raw version of the steps (inputs, outputs, optional claims). Checks every version against the hashes the agent signed and gives a verdict per disputed step: operator, client, both, neither, or no_anchor (the step itself is not sound on the chain). The operator's version defaults to this server's evidence.",
      inputSchema: { agent_id: id, run_id: id, source, client: partyFile.describe("The client's version: { entries: [{ step, raw: { input?, output? }, claim? }] }"), operator: partyFile.optional(), steps: z.array(z.number().int().nonnegative()).optional().describe("Treat these steps as disputed even without a claim") },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    wrap(async (a) => {
      const r = await diffVersions(ctx, { ...a, source: a.source as Source | undefined } as Parameters<typeof diffVersions>[1])
      const disputed = r.steps.filter((s) => s.disputed)
      const text = disputed.length
        ? disputed.map((s) => `Step ${s.step} (${s.action}${s.tool_revealed || s.tool ? ` ${s.tool_revealed || s.tool}` : ""}): ${s.verdict === "both" ? "both versions match" : s.verdict === "neither" ? "neither version matches" : s.verdict === "no_anchor" ? "the chain does not anchor this step" : `the ${s.verdict}'s version is what the agent signed`}. ${s.finding}`).join("\n")
        : "No step is disputed: both versions agree with what the agent signed."
      return result(text, r as unknown as Record<string, unknown>)
    }),
  )

  server.registerResource(
    "audit-card",
    UI_URI,
    { title: "Agent log audit card", description: "MCP App view: runs of a day, each run's chain of steps, and where it breaks.", mimeType: UI_MIME, _meta: { ui: { prefersBorder: true, csp: { connectDomains: [], resourceDomains: [] } } } },
    async () => ({ contents: [{ uri: UI_URI, mimeType: UI_MIME, text: CARD_HTML, _meta: { ui: { prefersBorder: true } } }] }),
  )

  server.registerResource(
    "run-export",
    new ResourceTemplate("agentlog://{source}/{agent_id}/{run_id}", { list: undefined }),
    { title: "Run export", description: "agentlog-export/v1 bundle of one run, verifiable offline", mimeType: "application/json" },
    async (uri, vars) => {
      const { verified } = await auditRun(ctx, String(vars.source) as Source, String(vars.agent_id), String(vars.run_id))
      return { contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify(verified.bundle, null, 2) }] }
    },
  )

  server.registerPrompt(
    "daily_audit",
    { title: "Daily audit", description: "Ask what an agent did on a day and whether its log is intact", argsSchema: { agent_id: z.string().optional(), date: z.string().optional() } },
    ({ agent_id, date }) => ({
      messages: [{ role: "user", content: { type: "text", text: `What did ${agent_id ?? "my agent"} do ${date ?? "yesterday"}, and has its log been tampered with? Use audit_day.` } }],
    }),
  )

  return server
}

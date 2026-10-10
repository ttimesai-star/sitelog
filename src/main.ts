// agentlog-mcp entry point.
//   npm start                 MCP server on http://127.0.0.1:8787/mcp + web simulator on /
//   npm run demo              same, with yesterday's demo runs seeded and the demo tamper buttons on
//   node src/main.ts --stdio  MCP over stdio (for desktop clients that launch servers themselves)
//
// Environment:
//   PORT, HOST                        default 8787, 127.0.0.1
//   AGENTLOG_DATA                     data directory (SQLite file, local agent keys), default ./.agentlog-mcp
//   AGENTLOG_TZ                       default time zone for "yesterday", default the system's
//   AGENTLOG_TOKEN                    bearer token required on /mcp (set it whenever HOST is not loopback)
//   AGENTLOG_ALLOWED_HOSTS            extra Host header values, comma separated
//   AGENTLOG_ARKIV=off                do not configure the read-only Arkiv source
//   AGENTLOG_ARKIV_SIGNERS            agent=0xwallet pairs for Arkiv, comma separated
//   AGENTLOG_WRITE=arkiv              write log_action to Arkiv (needs AGENTLOG_PRIVATE_KEY, a funded Tiramisu key)

import { resolve } from "node:path"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { buildCtx } from "./ctx.ts"
import { startHttp } from "./http.ts"
import { createMcpServer } from "./mcp.ts"
import { demoClientFile, seedDemo, tamperDemo } from "./demo.ts"

function parseSigners(s?: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const pair of String(s ?? "").split(",").map((x) => x.trim()).filter(Boolean)) {
    const [k, v] = pair.split("=")
    if (k && /^0x[0-9a-fA-F]{40}$/.test(v ?? "")) out[k] = v.toLowerCase()
  }
  return out
}

async function main() {
  const args = new Set(process.argv.slice(2))
  const env = process.env
  const dataDir = resolve(env.AGENTLOG_DATA ?? ".agentlog-mcp")
  const { ctx, local } = buildCtx({
    dataDir,
    tz: env.AGENTLOG_TZ,
    arkiv: env.AGENTLOG_ARKIV !== "off",
    writeTo: env.AGENTLOG_WRITE === "arkiv" ? "arkiv" : "local",
    privateKey: env.AGENTLOG_PRIVATE_KEY,
    arkivSigners: parseSigners(env.AGENTLOG_ARKIV_SIGNERS),
  })
  const demo = args.has("--demo")
  // stdout belongs to the protocol in stdio mode: all logging goes to stderr.
  const log = (m: string) => process.stderr.write(`[agentlog-mcp] ${m}\n`)
  if (demo) {
    const ids = await seedDemo(local, ctx.keys, ctx.defaultTz)
    log(`demo runs for yesterday (${ctx.defaultTz}): ${ids.join(", ")}`)
  }
  if (args.has("--stdio")) {
    await createMcpServer(ctx).connect(new StdioServerTransport())
    log(`stdio mode, data in ${dataDir}`)
    return
  }
  const port = Number(env.PORT ?? 8787)
  const host = env.HOST ?? "127.0.0.1"
  if (!["127.0.0.1", "localhost", "::1"].includes(host) && !env.AGENTLOG_TOKEN) log("WARNING: listening beyond loopback without AGENTLOG_TOKEN: anyone who can reach this port can write logs")
  await startHttp(ctx, {
    host,
    port,
    token: env.AGENTLOG_TOKEN,
    allowedHosts: String(env.AGENTLOG_ALLOWED_HOSTS ?? "").split(",").map((x) => x.trim()).filter(Boolean),
    log,
    demo: demo
      ? {
          tamper: (q) => tamperDemo(local, q as Parameters<typeof tamperDemo>[1]),
          reset: async () => ({ reset: true, runs: await seedDemo(local, ctx.keys, ctx.defaultTz, Date.now(), true) }),
          clientFile: () => demoClientFile(local),
        }
      : undefined,
  })
  log(`MCP endpoint  http://${host}:${port}/mcp  (Streamable HTTP, protocol 2025-11-25)`)
  log(`Simulator     http://${host === "127.0.0.1" ? "localhost" : host}:${port}/`)
  log(`Data          ${dataDir}  (write target: ${ctx.writeTo}${ctx.stores.arkiv ? ", Arkiv read-only source on" : ""})`)
}

main().catch((err) => {
  process.stderr.write(`[agentlog-mcp] ${err?.stack ?? err}\n`)
  process.exit(1)
})

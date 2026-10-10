// HTTP front: the MCP endpoint (Streamable HTTP, stateful sessions), the web simulator, and demo-only
// helpers. Plain node:http, no framework.

import { createServer } from "node:http"
import type { IncomingMessage, Server, ServerResponse } from "node:http"
import { randomUUID, timingSafeEqual } from "node:crypto"
import { readFile } from "node:fs/promises"
import { extname, join, normalize } from "node:path"
import { fileURLToPath } from "node:url"
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js"
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js"
import { createMcpServer } from "./mcp.ts"
import type { Ctx } from "./audit.ts"

export interface HttpOptions {
  host: string
  port: number
  /** Extra Host header values to accept (behind a proxy or on a LAN). */
  allowedHosts?: string[]
  /** Bearer token required on /mcp, if set. */
  token?: string
  /** Demo helpers (/demo/*): tamper with the local file, reseed. Never on in production. */
  demo?: { tamper: (q: { run_id?: string; step?: number }) => Promise<unknown>; reset: () => Promise<unknown>; clientFile: () => Promise<unknown> }
  log?: (msg: string) => void
}

const WEB = fileURLToPath(new URL("../web/", import.meta.url))
const TYPES: Record<string, string> = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".json": "application/json", ".svg": "image/svg+xml" }
const MAX_BODY = 1_000_000

function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks: Buffer[] = []
    req.on("data", (c: Buffer) => {
      size += c.length
      if (size > MAX_BODY) {
        reject(Object.assign(new Error("request body too large"), { status: 413 }))
        req.destroy()
      } else chunks.push(c)
    })
    req.on("end", () => {
      if (!chunks.length) return resolve(undefined)
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")))
      } catch {
        reject(Object.assign(new Error("body is not JSON"), { status: 400 }))
      }
    })
    req.on("error", reject)
  })
}

function send(res: ServerResponse, status: number, body: unknown, type = "application/json") {
  res.writeHead(status, { "content-type": type, "cache-control": "no-store", "x-content-type-options": "nosniff" })
  res.end(typeof body === "string" ? body : JSON.stringify(body))
}

const rpcError = (res: ServerResponse, status: number, message: string) => send(res, status, { jsonrpc: "2.0", error: { code: -32000, message }, id: null })

function tokenOk(req: IncomingMessage, token?: string) {
  if (!token) return true
  const got = Buffer.from(String(req.headers.authorization ?? "").replace(/^Bearer\s+/i, ""))
  const want = Buffer.from(token)
  return got.length === want.length && timingSafeEqual(got, want)
}

export function startHttp(ctx: Ctx, o: HttpOptions): Promise<Server> {
  const sessions = new Map<string, StreamableHTTPServerTransport>()
  const hosts = [`127.0.0.1:${o.port}`, `localhost:${o.port}`, `[::1]:${o.port}`, ...(o.allowedHosts ?? [])]
  const origins = hosts.flatMap((h) => [`http://${h}`, `https://${h}`])
  const log = o.log ?? (() => {})

  async function mcp(req: IncomingMessage, res: ServerResponse) {
    if (!tokenOk(req, o.token)) return rpcError(res, 401, "missing or wrong bearer token")
    const sid = req.headers["mcp-session-id"] as string | undefined
    if (req.method === "POST") {
      const body = await readBody(req)
      let t = sid ? sessions.get(sid) : undefined
      if (!t) {
        if (sid) return rpcError(res, 404, "unknown session: initialize again")
        if (!isInitializeRequest(body)) return rpcError(res, 400, "no session: the first request must be initialize")
        t = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (id) => {
            sessions.set(id, t!)
            log(`session ${id.slice(0, 8)} opened (${sessions.size} live)`)
          },
          enableDnsRebindingProtection: true,
          allowedHosts: hosts,
          allowedOrigins: origins,
        })
        t.onclose = () => {
          if (t!.sessionId) sessions.delete(t!.sessionId)
        }
        await createMcpServer(ctx).connect(t)
      }
      return t.handleRequest(req, res, body)
    }
    if (req.method === "GET" || req.method === "DELETE") {
      const t = sid ? sessions.get(sid) : undefined
      if (!t) return rpcError(res, sid ? 404 : 400, "unknown or missing session")
      return t.handleRequest(req, res)
    }
    res.writeHead(405, { allow: "GET, POST, DELETE" }).end()
  }

  async function demo(req: IncomingMessage, res: ServerResponse, path: string) {
    if (!o.demo) return send(res, 404, { error: "demo helpers are off: start with --demo" })
    // Same-origin only: these endpoints change the local file.
    const origin = req.headers.origin
    if (origin && !origins.includes(origin)) return send(res, 403, { error: "cross-origin request refused" })
    if (path === "/demo/client-file.json" && req.method === "GET") return send(res, 200, await o.demo.clientFile())
    if (req.method !== "POST") return send(res, 405, { error: "POST only" })
    const body = ((await readBody(req)) ?? {}) as { run_id?: string; step?: number }
    if (path === "/demo/tamper") return send(res, 200, await o.demo.tamper(body))
    if (path === "/demo/reset") return send(res, 200, await o.demo.reset())
    return send(res, 404, { error: "unknown demo endpoint" })
  }

  async function web(res: ServerResponse, path: string) {
    const rel = normalize(path === "/" ? "index.html" : decodeURIComponent(path.slice(1)))
    if (rel.startsWith("..") || rel.includes("\0")) return send(res, 400, { error: "bad path" })
    try {
      const body = await readFile(join(WEB, rel))
      res.writeHead(200, {
        "content-type": TYPES[extname(rel)] ?? "application/octet-stream",
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
        // The sandbox page hosts MCP App views: inline code allowed, no network at all (the view's
        // declared connect domains are empty). It is framed with sandbox="allow-scripts" (opaque origin).
        "content-security-policy":
          rel === "sandbox.html"
            ? "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; frame-ancestors 'self'"
            : "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; frame-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'",
      })
      res.end(body)
    } catch {
      send(res, 404, { error: "not found" })
    }
  }

  const server = createServer(async (req, res) => {
    const path = new URL(req.url ?? "/", "http://x").pathname
    try {
      if (path === "/mcp") return await mcp(req, res)
      if (path.startsWith("/demo/")) return await demo(req, res, path)
      if (path === "/healthz") return send(res, 200, { ok: true, sessions: sessions.size, write: ctx.writeTo, arkiv: Boolean(ctx.stores.arkiv), demo: Boolean(o.demo), tz: ctx.defaultTz })
      if (req.method === "GET") return await web(res, path)
      send(res, 404, { error: "not found" })
    } catch (err) {
      const status = (err as { status?: number }).status ?? 500
      if (!res.headersSent) send(res, status, { error: String((err as Error).message ?? err) })
      else res.end()
    }
  })
  return new Promise((resolve) => server.listen(o.port, o.host, () => resolve(server)))
}

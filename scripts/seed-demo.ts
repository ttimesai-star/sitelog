// Writes yesterday's demo runs into the local store (same data as `npm run demo`).
//   npm run seed            add them if missing
//   npm run seed -- --force rewrite them from scratch
import { resolve } from "node:path"
import { buildCtx } from "../src/ctx.ts"
import { seedDemo } from "../src/demo.ts"

const { ctx, local } = buildCtx({ dataDir: resolve(process.env.AGENTLOG_DATA ?? ".agentlog-mcp"), tz: process.env.AGENTLOG_TZ, arkiv: false })
const ids = await seedDemo(local, ctx.keys, ctx.defaultTz, Date.now(), process.argv.includes("--force"))
console.log(`demo runs for yesterday (${ctx.defaultTz}) in ${local.path}:\n  ${ids.join("\n  ")}`)
local.close()

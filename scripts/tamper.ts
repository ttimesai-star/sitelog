// The attacker, from the command line: rewrites a step of a demo run directly in the SQLite file.
//   npm run tamper                          edit step 2 of yesterday's afternoon run (503 -> 200)
//   npm run tamper -- --mode forge          ...and re-sign it with an intruder's key
//   npm run tamper -- --mode delete --step 3
//   npm run tamper -- --mode evidence       the operator rewrites only its own raw evidence (for diff_versions)
//   npm run tamper -- --run <run_id> --step <n>
import { resolve } from "node:path"
import { parseArgs } from "node:util"
import { buildCtx } from "../src/ctx.ts"
import { tamperDemo } from "../src/demo.ts"
import type { TamperMode } from "../src/demo.ts"

const { values } = parseArgs({ options: { mode: { type: "string" }, step: { type: "string" }, run: { type: "string" } } })
const { local } = buildCtx({ dataDir: resolve(process.env.AGENTLOG_DATA ?? ".agentlog-mcp"), arkiv: false })
const r = await tamperDemo(local, { mode: values.mode as TamperMode | undefined, step: values.step ? Number(values.step) : undefined, run_id: values.run })
console.log(r.actor === "operator"
  ? `The operator ${r.what} in ${r.run_id}. Now ask: "who is right about the afternoon release, the client or the operator?"`
  : `Attacker ${r.what} in ${r.run_id}. Now ask: "what did my agent do yesterday, and has its log been tampered with?"`)
local.close()

// Verifies every AgentLog run behind the scores, and exports a run as a signed bundle on request.
// Usage: node src/verify.mjs                 -> verify all runs, print counts
//        node src/verify.mjs --export RUN_ID  -> write data/export/<RUN_ID>.json (entries + raw evidence)
import { writeFile, mkdir } from "node:fs/promises"
import { verifyStored } from "agentlog"
import { SqliteStore } from "agentlog/sqlite"
import { secret } from "./lib.mjs"

const store = new SqliteStore(process.argv.includes("--db") ? process.argv[process.argv.indexOf("--db") + 1] : "data/agentlog.db")
const signer = process.env.DS_AGENT_ADDRESS ?? secret("delivery_score_agent.json").address
const agentOf = (run) => (run.startsWith("buy-") ? "delivery-score-buyer" : "delivery-score-probe")

if (process.argv.includes("--export")) {
  const run = process.argv[process.argv.indexOf("--export") + 1]
  const agent = agentOf(run)
  const { bundle, report, explain } = await verifyStored(store, agent, run, signer)
  const evidence = Object.fromEntries(await store.evidence(agent, run))
  await mkdir("data/export", { recursive: true })
  await writeFile(`data/export/${run}.json`, JSON.stringify({ ...bundle, evidence }, null, 1))
  console.log(report.verdict, explain.sentence, `-> data/export/${run}.json`)
} else {
  const counts = {}
  let entries = 0
  for (const agent of ["delivery-score-probe", "delivery-score-buyer"]) {
    for (const ri of await store.listRuns({ agentId: agent })) {
      const { report } = await verifyStored(store, agent, ri.run_id, signer)
      counts[report.verdict] = (counts[report.verdict] ?? 0) + 1
      entries += ri.entries ?? 0
      if (report.verdict !== "intact") console.log(agent, ri.run_id, report.verdict)
    }
  }
  console.log(JSON.stringify({ signer, runs: counts, entries }))
}

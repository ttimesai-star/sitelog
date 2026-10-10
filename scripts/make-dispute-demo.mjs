// Builds the two party files of the demo dispute from the published evidence of the demo run.
// No network, no keys. Run: node scripts/make-dispute-demo.mjs
//
// Story: the client says the release checker approved a release without checking the live page,
// which (says the client) was down. The operator says the agent checked the page, got 200, and its
// final report approved the release.
//   - operator file: the operator's full evidence, except that the final report (step 8 output) was
//     edited afterwards to add "approved for release";
//   - client file: three steps it holds copies of (the commit check it agrees with, its own version of
//     the live page check with HTTP 503, and the report it actually received), with claims.
// Expected verdicts: step 2 both, step 4 operator, step 8 client.
import { readFileSync, writeFileSync } from "node:fs"

const RUN = "run-20261009T152956"
const ev = JSON.parse(readFileSync(`public/demo/runs/${RUN}.evidence.json`, "utf8"))
const clone = (v) => JSON.parse(JSON.stringify(v))
const raw = (s) => clone(ev.entries.find((x) => x.entry.step === s).raw)

const operatorEntries = ev.entries.map((x) => ({ step: x.entry.step, raw: clone(x.raw) }))
const op8 = operatorEntries.find((x) => x.step === 8)
op8.raw.output = { report: `${op8.raw.output.report}  \nVerdict: all checks passed, approved for release.` }
op8.claim = "The agent's final report approved the release."
operatorEntries.find((x) => x.step === 4).claim = "The agent fetched the live page and got HTTP 200."

const operator = {
  format: "agentlog-party/v1",
  party: "operator",
  agent_id: ev.agent_id,
  run_id: RUN,
  description: "Demo: the operator's evidence file, with the final report edited after the run.",
  entries: operatorEntries,
}

const c4 = raw(4)
c4.output = { ...c4.output, status: 503, excerpt: "<html><body>503 Service Unavailable</body></html>", body_sha256: "0x" + "00".repeat(32) }
const client = {
  format: "agentlog-party/v1",
  party: "client",
  agent_id: ev.agent_id,
  run_id: RUN,
  description: "Demo: the client's copies of three steps, with its claims.",
  entries: [
    { step: 2, raw: raw(2), claim: "We agree the agent checked commit 6a84438." },
    { step: 4, raw: c4, claim: "The live page was down (HTTP 503); the agent never got a 200." },
    { step: 8, raw: raw(8), claim: "The report we received did not approve the release." },
  ],
}

for (const [name, v] of [["operator", operator], ["client", client]]) {
  const f = `public/demo/runs/${RUN}.dispute-${name}.json`
  writeFileSync(f, JSON.stringify(v, null, 1) + "\n")
  console.log(f)
}

---
name: agentlog-audit
description: Keep a tamper-evident log of your own actions through the agentlog MCP server, and answer a user who asks what an agent did and whether its log was changed. Use when you run tools on a user's behalf and the user may later need proof of what happened, or when the user asks "what did my agent do (yesterday)?", "was the log tampered with?", or two parties dispute what an agent did.
---

# agentlog-audit

The agentlog MCP server (tools `log_action`, `verify_run`, `audit_day`, `list_runs`, `get_run`, `diff_versions`) keeps every step of an agent run as a signed, hash-chained entry. Editing, deleting or re-signing any step afterwards is detected, and the server says at which step.

## When you are the agent doing the work

1. Pick a stable `agent_id` (for example `release-checker`). Call `log_action` with `action: "run.start"` and the task in `note`. Keep the returned `run_id`.
2. After every tool call or model call that matters, call `log_action` with the same `run_id`:
   - `action: "tool.call"`, `tool`: the tool name, `input`: its arguments, `output`: its result;
   - `action: "llm.call"` for a model call, `tool`: the model name;
   - `action: "tool.error"` when a call failed, with the error as `output`.
3. When done, call `log_action` with `action: "run.end"` and the final result as `output`. The run is then sealed: a run without a seal shows as "open", so nobody can pass a cut-off run as complete.
4. Never put secrets or personal data in `note`, `agent_id` or `run_id`: they are public labels. Raw `input` and `output` stay on the server as private evidence; only their hashes enter the chain.

## When the user asks about an agent

- "What did my agent do yesterday, and was the log changed?" → call `audit_day` (default date is yesterday; pass `tz` with the user's IANA time zone when you know it). Read the returned text as is: it leads with the verdict.
- "Is run X intact?" → `verify_run`.
- "Who is right about run X?" → `diff_versions` with the client's copy of the disputed steps.
- Never say a log is intact unless `verify_run` or `audit_day` said so in this conversation. "open" is not "intact": say the run never finished.

## Verdicts

| Verdict | Meaning |
|---|---|
| intact | every step signed by the agent's key, linked from step 0, sealed |
| open | everything checks out so far, but the run was never sealed |
| broken | at least one step was edited, deleted, re-signed by another key, or written after the seal; `explain.first_break` says which step and how |

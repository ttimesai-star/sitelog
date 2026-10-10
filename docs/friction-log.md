# Friction log (draft for the Devpost submission)

Kept while building agentlog-mcp for the Alexa+ track, 10 October 2026. Each entry: task, steps, expected vs actual, severity, workaround, suggestion.

## F1. Connecting a self-hosted MCP server to Alexa+

- **Task:** see the server answer a question on a real Alexa+ device or in the Alexa+ developer console.
- **Steps:** read the Alexa+ track text on the hackathon page ("Build a self-hosted MCP server (spec 2025-11-25 or later, Streamable HTTP)"), followed the Resources links (Agent Skills, Streamable HTTP transport), looked for an Alexa+ setup guide that takes an MCP endpoint URL.
- **Expected:** a way, even a sandboxed one, to register an MCP endpoint and talk to it through Alexa+.
- **Actual:** the Alexa+ Add-on tools (Category SDK, MCP Toolkit, CLI, Web Simulator) are preview, select partners only. This is stated in the hackathon FAQ and on the add-on docs home page, but not on every setup-guide page, so the guides read as if they apply.
- **Severity:** high (the track's target device cannot be used by any participant).
- **Workaround:** built a web page that is a real MCP client (the simulated-experience path the FAQ allows), with voice in and voice out.
- **Suggestion:** a public, rate-limited "Alexa+ MCP sandbox": paste an HTTPS MCP URL, type or speak a request, see which tools Alexa+ chose and what it said. Put the preview notice on every setup-guide page.

## F2. MCP Apps SDK and the core MCP SDK on different major versions

- **Task:** add an MCP App view (a card) to the tools, using the official `@modelcontextprotocol/ext-apps` server helpers.
- **Steps:** `npm install @modelcontextprotocol/sdk@1.32.1 @modelcontextprotocol/ext-apps@2.0.3`, opened the README.
- **Expected:** helpers that work with the SDK the rules point to (`@modelcontextprotocol/sdk`).
- **Actual:** ext-apps 2.x expects the split v2 packages (`@modelcontextprotocol/server`, `client`, `node`, `express` ^2.0.0) as peers; `@modelcontextprotocol/sdk` 1.x is a different package line.
- **Severity:** medium.
- **Workaround:** implemented the MCP Apps wire protocol directly: `_meta.ui.resourceUri` on the tools, a `text/html;profile=mcp-app` resource, and `ui/initialize`, `ui/notifications/tool-result`, `ui/notifications/size-changed` over `postMessage` in the view and in the simulator's host.
- **Suggestion:** say in the Alexa+ docs which MCP SDK line and which MCP Apps protocol version Alexa+ supports, and whether Echo Show renders MCP App views, APL, or neither.

## F3. No user context (time zone, locale) in tool calls

- **Task:** answer "what did my agent do *yesterday*?" correctly for the person asking.
- **Expected:** the user's time zone and locale reach the MCP server, as an Alexa+ device knows them.
- **Actual:** the MCP request carries no such context; "yesterday" depends on the server's clock.
- **Severity:** medium (wrong answers around midnight and for users far from the server).
- **Workaround:** every date-aware tool takes an optional IANA `tz`; the simulator sends the browser's.
- **Suggestion:** document whether Alexa+ passes device time zone and locale to MCP tools (for example in request `_meta`) and under which key.

## F4. Export condition named `source` collides with a dependency of the MCP SDK

- **Task:** run the workspace library from TypeScript source with Node's type stripping, selected by a custom export condition.
- **Steps:** named the condition `source` and ran `node --conditions=source`.
- **Actual:** `ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING` for `node_modules/eventsource-parser/src/stream.ts`: that package, pulled in by the SDK's Streamable HTTP client, also exports a `source` condition pointing at `.ts` files.
- **Severity:** low.
- **Workaround:** renamed the condition to `agentlog-source`.
- **Suggestion:** none for Amazon; noted for other builders who run MCP servers from TypeScript source.

## F5. AWS credits ran out before the second half of the hackathon

- **Task:** request the $150 AWS promotional credit to host the MCP server on Lambda.
- **Actual:** the Resources page says credit codes ran out on 7 October.
- **Severity:** low for this project (local run plus video is accepted for the Alexa+ track).
- **Workaround:** no hosting; the repository runs locally with one command.

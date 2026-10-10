# Product feedback (draft for the Devpost submission)

## Model Context Protocol, spec 2025-11-25, Streamable HTTP

- **Used for:** the whole server: six tools with input schemas and annotations, structured results, a resource template, a prompt, server instructions, stateful sessions over Streamable HTTP.
- **Worked well:** the transport is simple enough that the web simulator implements the client side by hand in under a hundred lines (POST, `Mcp-Session-Id`, `MCP-Protocol-Version`, SSE parsing), which makes the protocol visible in a demo. `structuredContent` next to a plain-text `content` block fits voice well: the text is what gets spoken, the structure feeds the card.
- **Needs work:** nothing in the protocol says where per-user context such as time zone and locale goes; every server invents a parameter.
- **Would build with it again:** yes.

## `@modelcontextprotocol/sdk` 1.32.1 (TypeScript)

- **Used for:** `McpServer` and `StreamableHTTPServerTransport` in the server; `Client` and `StreamableHTTPClientTransport` in the end-to-end tests.
- **Worked well:** DNS-rebinding protection (`allowedHosts`, `allowedOrigins`) built into the transport; protocol negotiation of 2025-11-25 out of the box; testing a server through the SDK's own client over real HTTP took one file.
- **Needs work:** the v1 and v2 package lines coexist and the MCP Apps SDK only targets v2 (see friction log F2).
- **Would build with it again:** yes.

## MCP Apps (ext-apps protocol 2026-01-26)

- **Used for:** the audit card: `_meta.ui.resourceUri` on `audit_day` and `verify_run`, a `text/html;profile=mcp-app` resource, and a minimal host in the simulator (sandboxed frame, `ui/initialize`, tool input and result notifications, size changes).
- **Worked well:** a view is one self-contained HTML file; the protocol is small enough to implement without the SDK.
- **Needs work:** it is not stated whether Alexa+ (and Echo Show) renders MCP App views. For a voice-first product this decides whether a server author builds a card at all.

## Alexa+ developer experience

- **Used for:** nothing directly: the Alexa+ tools are preview, select partners only (friction log F1). The project follows the simulated-experience path.
- **Onboarding:** the hackathon FAQ answered the question; the Alexa+ setup guides alone did not.
- **Feature requests:**
  - **Critical:** a public sandbox to try a self-hosted MCP server against Alexa+ (paste a URL, speak or type, see the tool calls and the spoken answer).
  - **Important:** device time zone and locale passed to MCP tools.
  - **Important:** a statement on MCP Apps support on Echo Show, or a mapping from MCP App views to APL.
  - **Nice-to-have:** a voice-response guideline for MCP tool authors (length, verdict first, how to read identifiers and hashes aloud).

## Other tools

- **Web Speech API** (Chrome, Edge): recognition and synthesis worked with no setup; Firefox has no recognition, so the page falls back to typing.
- **Arkiv SDK 0.8.1**: read-only verification of a real run on the Tiramisu testnet from the public RPC, no key needed.
- **Node.js 22.18+ type stripping and `node:sqlite`**: no build step and no native add-on, so `npm install && npm run demo` is the whole setup.
- **AWS:** not used.

---
title: "Adding Paid Tools to an MCP Server"
description: "How the Model Context Protocol exposes tools, where payment fits, and three workable patterns for charging per tool call: API keys, x402 inside the tool, and x402 on HTTP transport."
slug: paid-tools-in-mcp-servers
date: 2026-10-16
keywords: [MCP server paid tools, monetize MCP server, MCP x402, Model Context Protocol tools, MCP registry]
---

# Adding paid tools to an MCP server

The [Model Context Protocol](https://modelcontextprotocol.io/) (MCP) is an open protocol that lets AI applications (hosts such as IDEs, chat apps, and agent runtimes) connect to external **servers** that provide tools, resources, and prompts. If your server's tools cost you money to run, such as extraction, OCR, or embeddings, you need a way to charge for them. MCP doesn't define payments. This post covers the patterns that work with the protocol as it is.

## MCP in two minutes
From the [specification](https://modelcontextprotocol.io/specification):

- Messages are **JSON-RPC 2.0**.
- **Transports:** `stdio` (the server runs as a local subprocess) and **Streamable HTTP** (the server is a remote HTTP endpoint).
- Servers advertise tools via `tools/list`. Each tool has a `name`, a `description`, and an `inputSchema` (JSON Schema). Clients invoke tools with `tools/call`.
- Remote servers can use the spec's [authorization framework](https://modelcontextprotocol.io/specification/2025-06-18/basic/authorization), which is based on OAuth 2.1.

A minimal tool definition:

```json
{
  "name": "extract_markdown",
  "description": "Fetch a public web page and return clean markdown with title and metadata. Costs $0.003 per successful call.",
  "inputSchema": {
    "type": "object",
    "properties": { "url": { "type": "string", "format": "uri" } },
    "required": ["url"]
  }
}
```

Put the price **in the description**. The model reads tool descriptions when it plans, and price is information it can use.

## Pattern 1: API key in server config
The simplest pattern. The user puts an API key into the MCP server's environment (for local `stdio` servers) or completes an OAuth flow (for remote servers). The server calls your billing backend for each tool call.

- ✅ Works with every MCP client today.
- ✅ No crypto required.
- ❌ Needs signup, so an agent can't adopt the tool on its own.

## Pattern 2: x402 inside the tool (local server with a wallet)
A local MCP server holds an agent wallet (see [paying for APIs from an agent](/blog/pay-for-apis-from-an-ai-agent)). When a tool runs, the server calls an x402-protected HTTP API, handles the 402 with an x402 client library, and returns the result.

```ts
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { wrapFetchWithPayment } from "@x402/fetch";

const payFetch = wrapFetchWithPayment(fetch, agentAccount); // budget-enforced, see below
const server = new McpServer({ name: "Assay", version: "0.1.0" });

server.tool("extract_markdown", { url: z.string().url() }, async ({ url }) => {
  const r = await payFetch(`{{ORIGIN}}/v1/extract?url=${encodeURIComponent(url)}`);
  if (!r.ok) return { isError: true, content: [{ type: "text", text: `Failed: ${r.status}` }] };
  const doc = await r.json();
  return { content: [{ type: "text", text: doc.markdown }] };
});

await server.connect(new StdioServerTransport());
```

SDK method names change between versions, so check the [TypeScript SDK README](https://github.com/modelcontextprotocol/typescript-sdk).

- ✅ Zero signup with the provider. The wallet *is* the account.
- ✅ The spend policy lives in the server code, out of the model's reach.
- ❌ The user has to fund a wallet.

**Return errors as tool results** (`isError: true`) rather than throwing protocol errors, so the model can see what failed and adapt ([tools spec](https://modelcontextprotocol.io/specification/2025-06-18/server/tools)).

## Pattern 3: x402 at the HTTP transport (remote server)
A remote MCP server on Streamable HTTP could, in principle, answer an HTTP request with `402` and x402 requirements. Whether that works depends on the **client** understanding x402 at the transport layer, and most MCP clients don't today. The x402 ecosystem has published experimental MCP integrations. Check the [x402 repository](https://github.com/x402-foundation/x402) for current examples before you rely on this, and offer Pattern 1 as a fallback.

## Designing paid tools well
- **Charge only for success.** Validate inputs before charging. If the upstream page is blocked or the PDF is encrypted, return an error and don't settle.
- **Make costs predictable.** A flat price per call is easier for a model to reason about than "per token of output." If you price per page, also expose `estimate_cost(input)`.
- **Make tools coarse-grained.** One `get_10k_sections(cik)` call beats five chatty calls, each paid and each adding latency.
- **Mark idempotency.** Tool [annotations](https://modelcontextprotocol.io/specification/2025-06-18/server/tools) such as `readOnlyHint` and `idempotentHint` help clients decide when a retry is safe. Treat them as hints, not guarantees.
- **Cap spend server-side** per session and per day, and report the remaining budget in tool results so the model can plan.
- **Treat tool output as untrusted.** Content you fetched from the web may contain prompt injections. Label it as untrusted in the result text.

## Getting discovered
MCP has an official registry effort ([modelcontextprotocol/registry](https://github.com/modelcontextprotocol/registry)), and several community directories exist. x402 resources can also be listed in x402 discovery services ("Bazaar"). Listing in both reaches both audiences: MCP users who install servers, and agents that find paid HTTP endpoints at runtime.

## Assay and MCP
Assay does not ship a packaged MCP server yet. The Pattern 2 snippet above works against the live `/v1/extract` endpoint today (on Base Sepolia testnet), and the same approach works for `/v1/pdf/text`. A packaged server with a daily budget setting is on the roadmap.

### Sources
- MCP specification: https://modelcontextprotocol.io/specification
- MCP tools: https://modelcontextprotocol.io/specification/2025-06-18/server/tools
- MCP authorization: https://modelcontextprotocol.io/specification/2025-06-18/basic/authorization
- MCP TypeScript SDK: https://github.com/modelcontextprotocol/typescript-sdk
- MCP registry: https://github.com/modelcontextprotocol/registry
- x402: https://github.com/x402-foundation/x402

---
title: "x402 Bazaar: How Discovery Works, and What It Takes to Get an API Listed"
description: "The x402 Bazaar lets agents find paid APIs at runtime. How the bazaar extension rides in the 402 response, how the CDP catalog gets indexed by a settled payment, the public search and validate endpoints, a working declareDiscoveryExtension setup for @x402/hono, and why Assay is not listed yet."
slug: x402-bazaar-discovery
date: 2026-11-10
keywords: [x402 bazaar, x402 discovery, declareDiscoveryExtension, bazaar extension, discovery/search, x402 validate endpoint, monetize api for agents]
---

# x402 Bazaar: how discovery works, and what it takes to get an API listed

The **x402 Bazaar** is how an agent finds a paid API it has never seen before. A 402 response tells a client how to pay. It does not help anyone find the endpoint in the first place. Bazaar fills that gap: the server describes its inputs and outputs inside the 402 challenge, a facilitator catalogs that description when a payment settles, and agents query the catalog by intent. Here is the protocol side, the CDP catalog you can query today without an API key, a server setup we checked against `@x402/hono`, and an honest account of why Assay is not in the catalog yet.

```js
// Find a paid tool at runtime in the CDP x402 Bazaar (public, no API key). Node 18+.
const BAZAAR = "https://api.cdp.coinbase.com/platform/v2/x402/discovery";
const USDC_BASE = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913"; // USDC on Base mainnet

const q = new URLSearchParams({ query: "convert a web page to markdown", network: "eip155:8453", limit: "5" });
const { resources } = await (await fetch(`${BAZAAR}/search?${q}`)).json();

for (const r of resources) {
  const offer = r.accepts.find((a) => a.network === "eip155:8453" && a.scheme === "exact" && a.asset.toLowerCase() === USDC_BASE);
  if (!offer) continue;
  const input = r.extensions?.bazaar?.info?.input; // how to call it: method + example query or body
  console.log(r.resource, `${Number(offer.amount) / 1e6} USDC`, input?.method, Object.keys(input?.queryParams ?? input?.body ?? {}));
}
// e.g. https://…/markdown 0.002 USDC GET [ 'url' ]
```

## Where discovery data lives: the `bazaar` extension

Bazaar is an x402 v2 **extension**, specified in [`specs/extensions/bazaar.md`](https://github.com/coinbase/x402/blob/main/specs/extensions/bazaar.md). A resource server puts an `extensions.bazaar` object in its `PaymentRequired` body (the same JSON that travels Base64-encoded in the `PAYMENT-REQUIRED` header, covered in [x402 v2 headers](/blog/x402-v2-headers-payment-signature)). The object has two parts:

- **`info`** holds the discovery data. `info.input` says how to call the resource. For HTTP that is `type: "http"`, a `method`, and example `queryParams` (GET, HEAD, DELETE) or a `bodyType` plus example `body` (POST, PUT, PATCH). For MCP tools it is `type: "mcp"`, a `toolName`, and an `inputSchema`. `info.output` optionally gives a response `type` and an `example`.
- **`schema`** is a JSON Schema (Draft 2020-12) that validates `info`. The spec says facilitators **must** validate `info` against it before cataloging, and **must not** resolve external `$ref`s while doing so, because the schema comes from an untrusted server.

Provider-level metadata sits on the top-level `resource` object instead: `serviceName`, `tags`, and `iconUrl`. These have strict soft-drop rules. A `serviceName` must be printable ASCII of 32 characters or fewer, you get at most 5 tags, and an `iconUrl` cannot be an IP literal or `localhost`. A field that breaks a rule is dropped silently, so check your 402 against the spec rather than assuming it was accepted.

The client's role is small but easy to miss. The spec says clients are expected to **echo** the `bazaar` extension from `PaymentRequired` into their `PaymentPayload`. The facilitator only ever sees the payment, so if the client drops the extension, nothing gets cataloged. The TypeScript client in `@x402/core` (which `@x402/fetch` uses) copies `paymentRequired.extensions` into the payload for you. A hand-rolled client has to do it explicitly.

## How the CDP Bazaar gets populated

There is no registration form. Coinbase's [Get discovered](https://docs.cdp.coinbase.com/x402/seller/get-discovered) guide describes the flow for the CDP catalog:

1. Your 402 advertises a valid `extensions.bazaar` block.
2. A buyer completes a **settled paid call through the CDP facilitator**. Indexing runs after settlement and, per the guide, takes up to 15 minutes.
3. The facilitator reports the outcome to your server in an `EXTENSION-RESPONSES` header (Base64 JSON). `bazaar.status` is `success`, `processing`, or `rejected` with a `rejectedReason`. This header goes to the resource server only and is never forwarded to the buyer.

Some rules from the same guide are worth knowing before you plan around the catalog:

- **Indexing hits your endpoint with your own example.** For HTTP, Bazaar sends the example from `info.input`, or an empty body if you gave none, and expects a 402 back. If your server validates input before the payment middleware (Assay does, so a bad request never gets charged), the example has to pass that validation.
- **Listings decay.** A resource that goes 30 days without a settlement is removed from the catalog and from search.
- **Metadata is screened for prompt injection.** Descriptions that read like instructions to an agent are not listed. The CDP facilitator also rejects verify and settle requests whose description is longer than 500 characters.
- **Separate catalogs.** The guide says the [x402.org](https://x402.org/facilitator) testnet facilitator keeps its own catalog, separate from the CDP Bazaar. When we checked on 2026-11-10, its `/supported` response listed `builder-code`, `eip2612GasSponsoring`, and `erc20ApprovalGasSponsoring` as extensions but not `bazaar`, and `/facilitator/discovery/resources` returned 404.

## Querying the catalog

The spec defines two optional facilitator endpoints: `GET /discovery/resources` (list, filterable by `type`, `payTo`, `scheme`, `network`, `extensions`, with `limit`/`offset`) and `GET /discovery/search` (a natural-language `query` plus the same filters). CDP serves both under `https://api.cdp.coinbase.com/platform/v2/x402/discovery/` and, per its [discovery docs](https://docs.cdp.coinbase.com/x402/bazaar), they are public. What we saw when we called them:

- **Response shapes differ.** List returns `{ items, pagination: { limit, offset, total } }`. Search returns `{ resources, partialResults, … }`. CDP documents that search returns at most 20 results, and `partialResults: true` means you should narrow the query.
- **The list endpoint ignored small limits.** `limit=3` still returned 20 items. Slice client-side if you need fewer.
- **Each result carries a `quality` block** (30-day call count, 30-day unique payers, and `lastCalledAt`). CDP ranks search results by relevance blended with that usage.

If you already use the x402 SDK, `@x402/extensions` wraps the same endpoints. This ran as written against `@x402/core` and `@x402/extensions` 2.28:

```ts
import { HTTPFacilitatorClient } from "@x402/core/server";
import { withBazaar } from "@x402/extensions/bazaar";

const client = withBazaar(new HTTPFacilitatorClient({ url: "https://api.cdp.coinbase.com/platform/v2/x402" }));
const found = await client.extensions.bazaar.search({ query: "convert a web page to markdown", network: "eip155:8453", limit: 3 });
console.log(found.resources.map((r) => r.resource));
```

**Treat everything in the catalog as untrusted input.** A listing is a claim made by whoever runs the endpoint. Before an agent pays, it should check that the asset is the USDC contract it expects (the first snippet does), cap the price, and never feed `description` text into its own instructions. The payment side of that is covered in [spending limits for agent wallets](/blog/x402-agent-spending-limits).

## Declaring discovery on a Hono server

With the plain `@x402` packages, discovery is opt-in. You declare metadata per route with `declareDiscoveryExtension` and register `bazaarResourceServerExtension`, which fills in the HTTP method from the route key. Here is what that looks like for Assay's two routes. We ran it against `@x402/hono` 2.28 with a mock facilitator: both routes returned 402 with an `extensions.bazaar` block, `method` was filled in as `GET` and `POST`, and `validateDiscoveryExtension` returned `{ valid: true }` for each.

```ts
import { paymentMiddleware, x402ResourceServer } from "@x402/hono";
import { HTTPFacilitatorClient } from "@x402/core/server";
import { ExactEvmScheme } from "@x402/evm/exact/server";
import { declareDiscoveryExtension, bazaarResourceServerExtension } from "@x402/extensions/bazaar";

const resourceServer = new x402ResourceServer(new HTTPFacilitatorClient({ url: FACILITATOR_URL }))
  .register("eip155:84532", new ExactEvmScheme())
  .registerExtension(bazaarResourceServerExtension);

app.use(paymentMiddleware({
  "GET /v1/extract": {
    accepts: { scheme: "exact", price: "$0.003", network: "eip155:84532", payTo: PAY_TO },
    description: "Fetch a public web page and return its main article as clean markdown plus JSON metadata.",
    mimeType: "application/json",
    extensions: {
      ...declareDiscoveryExtension({
        input: { url: "https://example.com/" }, // must pass input validation, or indexing gets a 400
        inputSchema: {
          properties: { url: { type: "string" }, format: { type: "string", enum: ["json", "markdown"] } },
          required: ["url"],
        },
        output: { example: { title: "Example Domain", markdown: "This domain is for use in documentation examples…", word_count: 25 } },
      }),
    },
  },
  "POST /v1/pdf/text": {
    accepts: { scheme: "exact", price: "$0.01", network: "eip155:84532", payTo: PAY_TO },
    description: "Extract the embedded text layer of a PDF, page by page. No OCR.",
    mimeType: "application/json",
    extensions: {
      ...declareDiscoveryExtension({
        bodyType: "json",
        input: { url: "https://www.w3.org/WAI/ER/tests/xhtml/testfiles/resources/pdf/dummy.pdf" },
        inputSchema: { properties: { url: { type: "string" } }, required: ["url"] },
        output: { example: { pages: 1, text_layer_empty_pages: [], content: [{ page: 1, text: "Dummy PDF file", chars: 14 }] } },
      }),
    },
  },
}, resourceServer));
```

The output examples are real. The extract example is what Assay's Readability + Turndown code returns for `example.com` (Readability takes the `<h1>` as `title`, so the markdown starts at the paragraph). The PDF example is what Assay's PDF.js extraction returns for that W3C test file. One small trap: adding `format: "uri"` to the schema works, but the SDK's validator logs an "unknown format" warning for each one, so we left it out.

If you build with the CDP SDK's `createX402Server` instead, the guide says it adds a minimal `bazaar` declaration to every `"METHOD /path"` route automatically. Use the plain `@x402` packages if you have a paid route you want to keep out of the catalog.

## Validate before you wait

CDP runs a public preflight check: `POST https://api.cdp.coinbase.com/platform/v2/x402/validate`. It needs no API key, it fetches your URL, and it reports each check with `passed` and a severity. We ran it against Assay's live endpoint:

```bash
curl -s -X POST https://api.cdp.coinbase.com/platform/v2/x402/validate \
  -H "Content-Type: application/json" \
  -d '{"resource":"{{ORIGIN}}/v1/extract?url=https://example.com/","method":"GET"}'
# "valid": false
# passed: returns_402, payment_required_header, accepts[0].network (eip155:84532), accepts[0].asset (USDC), amount 3000 >= 1000 minimum
# failed: has_bazaar_extension — "No bazaar extension in top-level extensions object"
# "simulation": { "outcome": "rejected", "rejectionReason": "no bazaar discovery extension found" }
```

Two useful findings. First, every payment check passed, including the `$0.001` minimum. Second, when we sent the bare `/v1/extract` without `?url=`, the validator reported `Endpoint returned HTTP 400 instead of 402`. That is the validate-before-pay ordering from [402 vs 401 vs 403 vs 429](/blog/http-402-vs-401-403-429) showing up in a crawler, and it is why the declared example input matters.

## Where Assay stands today

Assay is **not listed in any Bazaar**. The reasons, plainly:

- Its routes do not declare `extensions.bazaar` yet. The 402 already carries `resource.serviceName` ("Assay") and `tags`, but those alone do not get a route indexed.
- It settles through the public x402.org testnet facilitator, not the CDP facilitator, so even a declared route would not reach the CDP catalog. Switching needs CDP API credentials.
- It runs on **Base Sepolia testnet only**, and the `payTo` is still a placeholder address. CDP's curated tier also requires live mainnet payments.

Until then, Assay publishes its own machine-readable discovery: [`/.well-known/x402`]({{ORIGIN}}/.well-known/x402) (the resource list plus pricing, network, and charge policy), [`/openapi.json`]({{ORIGIN}}/openapi.json), [`/pricing.json`]({{ORIGIN}}/pricing.json), and [`/llms.txt`]({{ORIGIN}}/llms.txt) (see [what is llms.txt](/blog/what-is-llms-txt)). These are files an agent fetches from a host it already knows about. Bazaar solves the harder problem of finding a host you have never heard of, and listing there is on the roadmap once Assay accepts mainnet payments.

**Related:** [What is x402?](/blog/what-is-x402-http-402) · [x402 facilitator /verify and /settle](/blog/x402-facilitator-verify-settle) · [x402 Hono middleware](/blog/x402-hono-middleware) · [Adding paid tools to an MCP server](/blog/paid-tools-in-mcp-servers) · [@x402/fetch example](/blog/x402-fetch-typescript) · [Payments docs](/docs/payments/)

### Sources
- x402 `bazaar` extension specification: https://github.com/coinbase/x402/blob/main/specs/extensions/bazaar.md
- x402 v2 specification (extensions, EXTENSION-RESPONSES sidechannel): https://github.com/coinbase/x402/blob/main/specs/x402-specification-v2.md
- `@x402/extensions` Bazaar README: https://github.com/coinbase/x402/blob/main/typescript/packages/extensions/src/bazaar/README.md
- CDP, Get discovered (Bazaar): https://docs.cdp.coinbase.com/x402/seller/get-discovered
- CDP, Discover services (Bazaar): https://docs.cdp.coinbase.com/x402/bazaar
- x402.org facilitator supported kinds: https://x402.org/facilitator/supported
- Assay source (route config in src/app.ts): https://github.com/Anateghi/assay402

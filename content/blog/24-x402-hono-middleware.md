---
title: "How to Charge Per API Call with the x402 Hono Middleware (@x402/hono)"
description: "Build a pay-per-call API with the x402 Hono middleware: a working @x402/hono server that answers 402, verifies USDC payments through a facilitator, and settles only when the handler succeeds. Plus middleware ordering, replay protection, what happens when settlement fails, and tests that need no wallet."
slug: x402-hono-middleware
date: 2026-10-30
keywords: [x402 hono middleware, @x402/hono paymentMiddleware, x402 server typescript, monetize API with x402, x402 settle on success, x402 replay protection]
---

# How to charge per API call with the x402 Hono middleware

The **x402 Hono middleware** (`@x402/hono`) turns any Hono route into a pay-per-call endpoint. A request without payment gets `402 Payment Required` and a price. A request with a valid USDC authorization runs your handler, and the payment settles only if the handler succeeds. This is the whole server:

```ts
// npm i hono @hono/node-server @x402/hono @x402/core @x402/evm
import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { paymentMiddleware, x402ResourceServer } from "@x402/hono";
import { ExactEvmScheme } from "@x402/evm/exact/server";
import { HTTPFacilitatorClient } from "@x402/core/server";

const NETWORK = "eip155:84532"; // Base Sepolia (CAIP-2)
const PAY_TO = process.env.PAY_TO ?? "0xYourAddress";

const facilitator = new HTTPFacilitatorClient({ url: "https://x402.org/facilitator" });
const server = new x402ResourceServer(facilitator).register(NETWORK, new ExactEvmScheme());

const app = new Hono();
app.use(paymentMiddleware({
  "GET /v1/quote": {
    accepts: { scheme: "exact", price: "$0.002", network: NETWORK, payTo: PAY_TO, maxTimeoutSeconds: 120 },
    description: "One quote, paid per call",
    mimeType: "application/json",
  },
}, server));

app.get("/v1/quote", (c) => c.json({ quote: "Measure twice, settle once." }));

serve({ fetch: app.fetch, port: 3000 });
```

We ran this with `@x402/hono` 2.28.0 (the version Assay pins; 2.29.0 is the current npm release) against the public testnet facilitator. `curl -i localhost:3000/v1/quote` returns `402` with a `PAYMENT-REQUIRED` header, and that header decodes to:

```json
{"x402Version": 2, "error": "Payment required",
 "resource": {"url": "http://localhost:3000/v1/quote", "description": "One quote, paid per call", "mimeType": "application/json"},
 "accepts": [{"scheme": "exact", "network": "eip155:84532", "amount": "2000",
   "asset": "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
   "payTo": "0x1111…1111", "maxTimeoutSeconds": 120,
   "extra": {"name": "USDC", "version": "2"}}]}
```

You wrote `"$0.002"`. The scheme filled in the rest: the USDC contract on Base Sepolia, the amount in atomic units (USDC has 6 decimals, so `2000` is $0.002), and the token's EIP-712 domain in `extra`, which clients need for signing. This is the same middleware Assay runs in production for [`/v1/extract`](/docs/extract/) and [`/v1/pdf/text`](/docs/pdf-text/). The rest of this post covers what it does on each request, and the parts you have to add yourself.

This post belongs to the [designing pay-per-call pricing](/blog/designing-pay-per-call-pricing) guide, which covers what to charge. This one covers how to collect it.

## What the middleware does on each request

The [Hono middleware guide](https://hono.dev/docs/guides/middleware) describes the onion model: code before `await next()` runs on the way in, and code after it runs on the way out. `paymentMiddleware` uses both sides. We read its source in 2.28.0 and exercised each branch:

1. **Route match.** Keys look like `"GET /v1/quote"`, and wildcards such as `"GET /api/premium/*"` work too (per the [package README](https://github.com/x402-foundation/x402/tree/main/typescript/packages/http/hono)). Unmatched requests pass straight through, free.
2. **No payment header** (`PAYMENT-SIGNATURE`, or the legacy `X-PAYMENT`): the middleware answers `402` with `Cache-Control: no-store`. The JSON body is `{}` unless you configure one (see below). If the request looks like a browser (an `Accept` header containing `text/html` and a user agent containing `Mozilla`), you get an HTML paywall page instead.
3. **Payment header present:** the middleware decodes it and asks the facilitator's `/verify` whether the signature, amount, recipient, timing and balance all check out. If not, it answers `402` again, and the `error` field in the new `PAYMENT-REQUIRED` header says why. Your handler never runs.
4. **Verified:** it calls `next()`, and your handler runs.
5. **Handler status below 400:** it buffers your response body, calls `/settle`, and returns your response with a `PAYMENT-RESPONSE` header (Base64 JSON with `success`, `transaction`, `network`, `payer`) and `Cache-Control: private`.
6. **Handler status 400 or above:** it does **not** settle. Your error response goes out unchanged and the payer is not charged. A thrown exception counts too: Hono turns it into a `500` before the middleware sees it, so no settlement happens.

Step 3 is easy to see with a real but empty wallet. We pointed an `@x402/fetch` client with a fresh, unfunded key at the server above. The x402.org facilitator rejected the authorization at `/verify` with `invalid_exact_evm_insufficient_balance`, and the handler was never called. Funding the key with [test USDC](https://faucet.circle.com/) is the only change needed for a `200`.

> **Note:** step 5 means the response is buffered in full before it is sent. A route that streams (server-sent events, large downloads) loses streaming once it sits behind this middleware. Keep paid routes request/response.

## Give unpaid callers a readable 402

An empty `{}` body is legal, but an agent or a human reading logs gets nothing from it. The route config takes an `unpaidResponseBody` function. Assay uses one on both routes, and we checked it against the live server:

```ts
"GET /v1/extract": {
  accepts: { scheme: "exact", price: "$0.003", network: NETWORK, payTo: PAY_TO, maxTimeoutSeconds: 120 },
  resource: `${PUBLIC_URL}/v1/extract`,
  description: "Web page to clean markdown + JSON metadata (robots.txt-aware)",
  mimeType: "application/json",
  unpaidResponseBody: () => ({ contentType: "application/json", body: {
    error: "payment_required",
    message: "Pay with x402 v2 (exact, USDC on Base Sepolia testnet). Price: $0.003 per successful call.",
    docs: `${PUBLIC_URL}/docs/payments` } }),
},
```

Set `resource` explicitly when you run behind a proxy. Otherwise the URL in the challenge is built from the request, and behind a TLS-terminating proxy that can be your internal host and scheme rather than the public URL.

## Order your middleware: the cheap checks go first

Hono runs middleware in registration order, so where you `app.use(paymentMiddleware(...))` decides what a caller pays for. Assay's [`src/app.ts`](https://github.com/Anateghi/assay402/blob/main/src/app.ts) registers, in this order:

| # | Middleware | Answers | Why it sits here |
|---|---|---|---|
| 1 | CORS on `/v1/*` | adds headers | Browser agents can only read `PAYMENT-REQUIRED` and `PAYMENT-RESPONSE` if they are listed in `Access-Control-Expose-Headers` ([Fetch standard](https://fetch.spec.whatwg.org/#http-access-control-expose-headers)) |
| 2 | Per-IP token bucket | `429` + `Retry-After` | Cheapest rejection, so it goes before any facilitator round trip ([RFC 6585 §4](https://www.rfc-editor.org/rfc/rfc6585#section-4)) |
| 3 | Concurrency cap on heavy routes | `503 busy` | Protects the extractor and the PDF parser |
| 4 | Input validation | `400`, `413`, `415` | A malformed or blocked URL should never be offered a price |
| 5 | Replay guard | `409 payment_replayed` | One authorization, one result (next section) |
| 6 | `paymentMiddleware` | `402` | Verify, then run the handler, then settle on success |

Row 4 is the one most first versions get wrong. If validation lives in the handler, a caller with a typo first receives a `402`, signs a payment, and only then learns the URL was bad. The payment isn't settled, because the handler returns a 4xx, but the caller made two round trips and a signature for nothing. Assay validates in a middleware that runs before payment. A pre-payment check stores its result with `c.set()`, so the handler doesn't parse the input twice:

```ts
app.use("/v1/extract", async (c, next) => {
  try { c.set("targetUrl", validateUrl(c.req.query("url"))); }
  catch (e) { return errorResponse(c, e); }   // 400 with charged: false, no 402
  await next();
});
```

You can check this on the live gateway. `GET {{ORIGIN}}/v1/extract?url=http://127.0.0.1/` returns `400 {"error":"blocked_host",…,"charged":false}`, not a `402`. The address checks behind `validateUrl` are covered in [SSRF protection for AI agent fetch tools](/blog/ssrf-protection-for-ai-agent-fetch-tools).

## Replay protection: one authorization, one result

An [EIP-3009](https://eips.ethereum.org/EIPS/eip-3009) authorization carries a nonce, and the token contract refuses to execute the same nonce twice. That protects the **payer**: they can never be charged twice. It does not protect the **server**. Settlement happens after the handler runs, so two copies of the same `PAYMENT-SIGNATURE` sent at the same moment can both pass `/verify` and both run your handler, and only one of them will ever settle.

Assay closes that gap with a small middleware ([`src/replay.ts`](https://github.com/Anateghi/assay402/blob/main/src/replay.ts)) placed before `paymentMiddleware`:

- It derives an ID from the decoded header, `network:payer:nonce`, and falls back to the signature, or a hash of the whole header, for payloads without an authorization.
- If the ID is **in flight**, the second request gets `409 payment_replayed` immediately.
- When the response carries `PAYMENT-RESPONSE` with a status below 400, the ID is marked **used**, and every later copy also gets `409`.
- If the handler failed and nothing settled, the ID is **released**, so the caller can retry with the same signature while it is still valid.

That store lives in memory on a single instance, like Assay's rate limits ([limits and errors](/docs/limits/)). If you run several replicas, move it to a shared store with an atomic set-if-absent, or the guard only covers requests that land on the same replica.

## When settlement fails after the work is done

Verification is a check and settlement is a transaction, and the two are separated by however long your handler takes. In between, the payer can move the funds or the authorization can reach its `validBefore` time. We forced a settlement failure with a stub facilitator and got this back from the middleware:

- Status `402`, body `{}`, `Cache-Control: no-store`.
- A `PAYMENT-RESPONSE` header decoding to `{"success":false,"errorReason":"invalid_exact_evm_insufficient_balance","transaction":"","network":"eip155:84532"}`.
- The handler's `200` body is thrown away. The caller doesn't get the result, and you don't get paid for the work.

Two consequences. First, `maxTimeoutSeconds` should cover your slowest successful handler with some margin. Assay uses 120 seconds because PDF parsing can be slow. Second, a handler with side effects (sending an email, writing to a database) can run without being paid for. The `exact` scheme is a poor fit for those. Look at the `upto` and batch-settlement schemes in the [seller quickstart](https://docs.x402.org/getting-started/quickstart-for-sellers), or make the side effect idempotent. The [facilitator post](/blog/x402-facilitator-verify-settle) covers `/verify` and `/settle` on the wire.

## Test it without a wallet or a network

`x402ResourceServer` accepts any object that implements the `FacilitatorClient` interface (`getSupported`, `verify`, `settle`), so tests can swap in a stub and count the calls. The real `@x402/fetch` client signs with a throwaway key, so the payload is genuine. Only the facilitator is fake. This passes with vitest:

```ts
import { describe, it, expect } from "vitest";
import { x402Client, wrapFetchWithPayment } from "@x402/fetch";
import { ExactEvmScheme } from "@x402/evm/exact/client";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import { createApp } from "./app"; // returns the Hono app; GET /v1/quote?fail=1 answers 502

function fakeFacilitator() {
  const calls = { verify: 0, settle: 0 };
  const f: any = {
    getSupported: async () => ({ kinds: [{ x402Version: 2, scheme: "exact", network: "eip155:84532" }], extensions: [], signers: {} }),
    verify: async (p: any) => (calls.verify++, { isValid: true, payer: p.payload.authorization.from }),
    settle: async (p: any) => (calls.settle++, { success: true, transaction: "0x" + "ab".repeat(32), network: "eip155:84532", payer: p.payload.authorization.from }),
  };
  return { f, calls };
}

describe("paid /v1/quote", () => {
  const { f, calls } = fakeFacilitator();
  const app = createApp(f);
  const client = new x402Client().register("eip155:84532", new ExactEvmScheme(privateKeyToAccount(generatePrivateKey())));
  const pay = wrapFetchWithPayment((url, init) => app.fetch(new Request(url, init)), client);

  it("asks for payment", async () => {
    expect((await app.request("/v1/quote")).status).toBe(402);
  });
  it("settles a successful call", async () => {
    const r = await pay("http://local/v1/quote");
    expect(r.status).toBe(200);
    expect(r.headers.get("payment-response")).toBeTruthy();
    expect(calls).toEqual({ verify: 1, settle: 1 });
  });
  it("does not settle a failed call", async () => {
    const r = await pay("http://local/v1/quote?fail=1");
    expect(r.status).toBe(502);
    expect(calls).toEqual({ verify: 2, settle: 1 });
  });
});
```

Assay's own suite ([`test/payment.test.ts`](https://github.com/Anateghi/assay402/blob/main/test/payment.test.ts)) uses the same pattern for settle-on-success, replays, and validation before payment.

## Before you point it at mainnet

- **Facilitator.** The x402 docs say `https://x402.org/facilitator` is for testnet development only. Mainnet needs a production facilitator ([seller quickstart, "Running on Mainnet"](https://docs.x402.org/getting-started/quickstart-for-sellers)).
- **Network and asset.** Change `eip155:84532` to `eip155:8453` and check that the asset resolves to [Circle's Base USDC](https://developers.circle.com/stablecoins/usdc-contract-addresses). The differences are covered in [x402 on Base Sepolia](/blog/x402-base-sepolia-usdc).
- **`payTo`.** Use an address you control and have tested receiving on. Assay's server refuses to start on any network other than Base Sepolia, which is a cheap guard worth copying until you mean it.
- **Startup.** `paymentMiddleware` calls the facilitator's `/supported` to learn what it can settle (the fifth argument, `syncFacilitatorOnStart`, defaults to `true`). If the facilitator is unreachable at that moment, paid routes return an error instead of a `402`. Watch for it in your health checks.

## Assay's version, in production

Assay is this pattern with two real handlers: [`GET /v1/extract`](/docs/extract/) (a web page as clean markdown plus metadata, **$0.003** per call) and [`POST /v1/pdf/text`](/docs/pdf-text/) (per-page PDF text, **$0.01** per call). Both run on **Base Sepolia testnet** only for now. Payment is x402 only, and prepaid API keys are planned but not live. The full exchange, including the 409 replay rule and the settlement-failure case, is documented in [payments (x402)](/docs/payments/). Prices are published at [`/pricing.json`]({{ORIGIN}}/pricing.json) and [`/.well-known/x402`]({{ORIGIN}}/.well-known/x402), and the source is MIT-licensed [on GitHub](https://github.com/Anateghi/assay402).

**Related:** [What is x402?](/blog/what-is-x402-http-402) · [x402 v2 headers](/blog/x402-v2-headers-payment-signature) · [The x402 exact scheme on EVM](/blog/x402-exact-scheme-evm) · [x402 vs API keys](/blog/x402-vs-api-keys) · [x402 Python client](/blog/x402-python-client)

### Sources
- x402 seller quickstart (Hono setup, RouteConfig, schemes, mainnet facilitator note): https://docs.x402.org/getting-started/quickstart-for-sellers
- `@x402/hono` README and source: https://github.com/x402-foundation/x402/tree/main/typescript/packages/http/hono
- `@x402/hono` on npm: https://www.npmjs.com/package/@x402/hono
- Hono middleware guide (execution order, errors converted before `next()` returns): https://hono.dev/docs/guides/middleware
- RFC 9110 §15.5.3, 402 Payment Required: https://www.rfc-editor.org/rfc/rfc9110#section-15.5.3
- RFC 9111 §5.2.2.7, Cache-Control `private`: https://www.rfc-editor.org/rfc/rfc9111#section-5.2.2.7
- RFC 6585 §4, 429 Too Many Requests: https://www.rfc-editor.org/rfc/rfc6585#section-4
- Fetch standard, `Access-Control-Expose-Headers`: https://fetch.spec.whatwg.org/#http-access-control-expose-headers
- EIP-3009, Transfer With Authorization: https://eips.ethereum.org/EIPS/eip-3009
- Circle, USDC contract addresses: https://developers.circle.com/stablecoins/usdc-contract-addresses

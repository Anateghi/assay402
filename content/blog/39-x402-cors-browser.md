---
title: "x402 CORS: Why the Paid Retry Fails in the Browser, and the One-Header Fix"
description: "In a browser, @x402/fetch adds an Access-Control-Expose-Headers request header to the paid retry. If your preflight doesn't allow it, Chrome blocks the request before the payment is sent. We reproduced it against Assay in headless Chrome, fixed it, and wrote down the CORS rules for x402 servers."
slug: x402-cors-browser
date: 2026-11-14
keywords: [x402 cors, x402 browser client, Access-Control-Allow-Headers PAYMENT-SIGNATURE, Access-Control-Expose-Headers PAYMENT-REQUIRED, CORS preflight custom header, hono cors x402]
---

# x402 CORS: why the paid retry fails in the browser, and the one-header fix

x402 CORS takes two things: the `402` has to expose `PAYMENT-REQUIRED`, and the preflight has to allow every header the client adds to the paid retry. The second one is easy to miss. `@x402/fetch` sets `PAYMENT-SIGNATURE` on the retry, and it also sets a request header named `Access-Control-Expose-Headers`. If your preflight response doesn't list that header, the browser blocks the paid request and the payment is never sent. Here is a preflight that passes for x402 v2 clients:

```http
OPTIONS /v1/extract?url=https://example.com/ HTTP/1.1
Origin: http://localhost:8000
Access-Control-Request-Method: GET
Access-Control-Request-Headers: access-control-expose-headers,payment-signature

HTTP/1.1 204 No Content
Access-Control-Allow-Origin: *
Access-Control-Allow-Methods: GET, POST, OPTIONS
Access-Control-Allow-Headers: Content-Type, PAYMENT-SIGNATURE, X-PAYMENT, Access-Control-Expose-Headers
Access-Control-Max-Age: 86400
```

And every response on a paid route, the `402` included, needs:

```http
Access-Control-Allow-Origin: *
Access-Control-Expose-Headers: PAYMENT-REQUIRED, PAYMENT-RESPONSE, Retry-After
```

Until today, Assay's preflight allowed only `Content-Type, PAYMENT-SIGNATURE, X-PAYMENT`. That passes a hand-written test that sends only `PAYMENT-SIGNATURE`, and it fails with the official client. This post shows the failure, the cause, and the fix we shipped.

## The test: @x402/fetch in headless Chrome

We bundled `@x402/fetch` 2.28.0 with esbuild into a page served from `http://localhost:8000`, a different origin from the API, so the browser applies CORS. The page wraps the browser's `fetch` in a spy that logs each request's header names and status, then calls Assay with an **unfunded throwaway key**. No real or test money can move: the most a valid signature from that key can do is fail verification.

```ts
import { wrapFetchWithPaymentFromConfig } from "@x402/fetch";
import { ExactEvmScheme } from "@x402/evm";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";

const spy: typeof fetch = async (input, init) => {
  const req = new Request(input as any, init);
  log(`-> ${req.method} headers: ${[...req.headers.keys()].join(", ") || "(none)"}`);
  try {
    const r = await fetch(req);
    log(`<- ${r.status} PAYMENT-REQUIRED readable: ${r.headers.get("PAYMENT-REQUIRED") ? "yes" : "no"}`);
    return r;
  } catch (e) { log(`<- network error: ${e}`); throw e; }
};

const account = privateKeyToAccount(generatePrivateKey()); // unfunded
const pay = wrapFetchWithPaymentFromConfig(spy, {
  schemes: [{ network: "eip155:84532", client: new ExactEvmScheme(account) }],
});
await pay(`${BASE}/v1/extract?url=https://example.com/`);
```

We loaded it with Chrome 156 headless (`--headless=new --virtual-time-budget=20000 --dump-dom`) on 2026-11-14. Against the live Assay deployment, before the fix:

```text
origin http://localhost:8000 -> https://assay-production-9cf9.up.railway.app
-> GET headers: (none)
<- 402 PAYMENT-REQUIRED readable: yes
-> GET headers: access-control-expose-headers, payment-signature
<- network error: TypeError: Failed to fetch
RESULT threw: TypeError: Failed to fetch
```

The first half works: the unpaid `GET` sends no custom headers, so no preflight is needed, and since the `402` exposes `PAYMENT-REQUIRED`, the client can read the challenge and sign. The paid retry dies. Chrome's console says why:

```text
Access to fetch at 'https://assay-production-9cf9.up.railway.app/v1/extract?url=https://example.com/'
from origin 'http://localhost:8000' has been blocked by CORS policy: Request header field
access-control-expose-headers is not allowed by Access-Control-Allow-Headers in preflight response.
```

The page only sees `TypeError: Failed to fetch`. Scripts can't read CORS failure details, so a browser agent that logs only the exception has nothing to go on.

## Why @x402/fetch sends a response header in a request

`Access-Control-Expose-Headers` is a response header. Per the [Fetch standard](https://fetch.spec.whatwg.org/#http-access-control-expose-headers), the server uses it to tell the browser which response headers page scripts may read. Sending it in a request has no effect on what the browser exposes. Even so, the x402 fetch wrapper sets it on the paid retry (and on its recovery retry). This is from `typescript/packages/http/fetch/src/index.ts` on `main` as of [commit 0e6e8c5](https://github.com/coinbase/x402/blob/0e6e8c55d86b4f14234fb6e49a4052074fb93e57/typescript/packages/http/fetch/src/index.ts), and the same lines ship in the 2.28.0 and 2.31.0 npm builds we checked:

```ts
clonedRequest.headers.set(
  "Access-Control-Expose-Headers",
  "PAYMENT-RESPONSE,X-PAYMENT-RESPONSE",
);
```

The header isn't on the Fetch standard's [forbidden request-header](https://fetch.spec.whatwg.org/#forbidden-request-header) list, so the browser lets the script set it. It isn't a [CORS-safelisted request-header](https://fetch.spec.whatwg.org/#cors-safelisted-request-header) either (that list is `Accept`, `Accept-Language`, `Content-Language`, `Content-Type` with restrictions, and `Range`), so it's one of the [CORS-unsafe request-header names](https://fetch.spec.whatwg.org/#cors-unsafe-request-header-names) that go into `Access-Control-Request-Headers` on the preflight. A preflight is only successful if every one of those names is allowed. In Node there's no CORS, so the same request goes through and server-side tests never catch it.

`PAYMENT-SIGNATURE` itself has the same property, which is why every x402 server that wants browser clients has to answer preflights at all. The extra header just means the allowlist has two entries, not one.

## The fix

You can do it three ways. Any of them works for x402, because the paid request carries no cookies or HTTP auth.

**1. Add the header to an explicit allowlist.** This is what Assay now does, in [`src/app.ts`](https://github.com/Anateghi/assay402/blob/main/src/app.ts):

```ts
app.options("/v1/*", (c) => new Response(null, { status: 204, headers: {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  // @x402/fetch sets an Access-Control-Expose-Headers *request* header on the paid retry.
  "Access-Control-Allow-Headers": "Content-Type, PAYMENT-SIGNATURE, X-PAYMENT, Access-Control-Expose-Headers",
  "Access-Control-Max-Age": "86400" } }));
```

**2. Use the wildcard.** `Access-Control-Allow-Headers: *` allows any header name, but only for requests without credentials. MDN's [Access-Control-Allow-Headers page](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Access-Control-Allow-Headers) notes that `*` is treated as a literal header name on credentialed requests, and that `Authorization` always has to be listed explicitly.

**3. Use Hono's `cors()` with no `allowHeaders`.** In Hono 4.13.13, when `allowHeaders` is empty (the default), the middleware echoes the preflight's `Access-Control-Request-Headers` back and adds `Vary: Access-Control-Request-Headers`. That passes. Once you pass your own `allowHeaders` list, which is what the [Hono CORS docs](https://hono.dev/docs/middleware/builtin/cors) show, you're back to option 1 and have to include the header yourself.

Whichever you pick, don't forget the other half: `exposeHeaders` (or a hand-set `Access-Control-Expose-Headers`) has to name `PAYMENT-REQUIRED` and `PAYMENT-RESPONSE`, and `Retry-After` if you rate limit. It also has to be set on **every** response, not only on `200`. In Assay the CORS middleware is registered before the rate limiter and the payment middleware, and it sets headers after `await next()`, so `400`, `402`, `409`, and `429` responses all get it. We covered that ordering in [the Hono middleware post](/blog/x402-hono-middleware).

## After the fix

We started the patched server locally on port 3000 and loaded the same page against it from port 8000 (still cross-origin):

```text
origin http://localhost:8000 -> http://localhost:3000
-> GET headers: (none)
<- 402 PAYMENT-REQUIRED readable: yes
-> GET headers: access-control-expose-headers, payment-signature
<- 402 PAYMENT-REQUIRED readable: yes
RESULT status 402: {}
```

This time the preflight passed and the signed request reached the server (the server log shows `OPTIONS 204`, then `GET 402`). The second `402` is the expected result for an empty wallet: we ran the same flow from Node, decoded the `PAYMENT-REQUIRED` header, and got `"error": "invalid_exact_evm_insufficient_balance"` from the facilitator's verify step. With a funded Base Sepolia wallet, this is where you'd get `200` and a readable `PAYMENT-RESPONSE`.

We also added a regression test to Assay's suite. It records every non-safelisted header `@x402/fetch` actually sends during a paid call, sends a preflight listing them, and asserts each one is in `Access-Control-Allow-Headers`. Against the old allowlist it fails with `expected [ 'content-type', …(2) ] to include 'access-control-expose-headers'`, and it passes now. Because it reads the header names from the real client instead of a hard-coded list, it should also fail if a future `@x402/fetch` adds another header.

## Is a blocked retry a lost payment?

No. When a preflight fails, the browser never sends the actual request, so the signed `PAYMENT-SIGNATURE` never left the page. The authorization was never verified or settled, and it expires after the challenge's `maxTimeoutSeconds` (120 on Assay). The cost is a broken call, not money. The risk is on the server side: if your logs show a steady stream of `402`s from browser origins and no paid calls, check your preflight before you check your pricing.

## Checklist for x402 servers with browser clients

- Answer `OPTIONS` on paid routes with `204` (or `200`) before rate limiting or payment logic gets a chance to return something else. The Fetch standard only accepts an [ok status](https://fetch.spec.whatwg.org/#http-access-control-expose-headers) for a preflight.
- `Access-Control-Allow-Headers` must include `PAYMENT-SIGNATURE`, `Access-Control-Expose-Headers`, and `X-PAYMENT` if you still accept v1 clients, plus `Content-Type` for JSON bodies.
- `Access-Control-Expose-Headers` on every response must include `PAYMENT-REQUIRED` and `PAYMENT-RESPONSE`, so the browser can read the challenge and the receipt.
- Test with the real client in a real browser, from a different origin. A server-side test or a `curl` preflight only checks what you think the client sends.

Assay runs on **Base Sepolia testnet only**. Its CORS setup is described in the [payments docs](/docs/payments/), and the Node version of this client is in [the @x402/fetch TypeScript example](/blog/x402-fetch-typescript). For the bigger picture, start with [how to pay for APIs from an AI agent](/blog/pay-for-apis-from-an-ai-agent).

**Related:** [x402 v2 headers: PAYMENT-SIGNATURE and PAYMENT-REQUIRED](/blog/x402-v2-headers-payment-signature) · [x402 Hono middleware](/blog/x402-hono-middleware) · [@x402/fetch TypeScript example](/blog/x402-fetch-typescript) · [Payments docs](/docs/payments/)

### Sources
- WHATWG Fetch standard (CORS protocol, safelisted and forbidden request-headers, CORS-unsafe request-header names): https://fetch.spec.whatwg.org/
- MDN, Access-Control-Allow-Headers: https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Access-Control-Allow-Headers
- MDN, Access-Control-Expose-Headers: https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Access-Control-Expose-Headers
- coinbase/x402, `@x402/fetch` source (typescript/packages/http/fetch/src/index.ts): https://github.com/coinbase/x402/blob/0e6e8c55d86b4f14234fb6e49a4052074fb93e57/typescript/packages/http/fetch/src/index.ts
- Hono docs, CORS middleware: https://hono.dev/docs/middleware/builtin/cors
- Assay source (src/app.ts, test/payment.test.ts): https://github.com/Anateghi/assay402

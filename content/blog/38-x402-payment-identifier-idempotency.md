---
title: "x402 Idempotency: Retrying Paid Requests with the payment-identifier Extension"
description: "A lost response on a paid x402 call leaves the agent stuck: resend the same signature and the server may refuse it, sign a new one and you pay twice. The payment-identifier extension fixes that with a client-chosen id. Here is how it works, a tested client hook, a server-side sketch, and what Assay does today."
slug: x402-payment-identifier-idempotency
date: 2026-11-13
keywords: [x402 idempotency, x402 payment-identifier, x402 retry payment, idempotency key paid api, appendPaymentIdentifierToExtensions, @x402/extensions]
---

# x402 idempotency: retrying paid requests with the payment-identifier extension

x402 idempotency comes from an optional extension called `payment-identifier`: the client attaches its own `id` to the payment, reuses it on every retry of the same operation, and a server that supports it returns the cached response instead of running and charging the call again. Here is a client hook that does that with `@x402/core` and `@x402/extensions` 2.30.0. We ran it with `tsx` and a throwaway key (signing happens offline):

```ts
import { x402Client } from "@x402/core/client";
import { ExactEvmScheme } from "@x402/evm/exact/client";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import {
  PAYMENT_IDENTIFIER, appendPaymentIdentifierToExtensions,
  declarePaymentIdentifierExtension, extractPaymentIdentifier,
} from "@x402/extensions/payment-identifier";

// One id per logical operation; reuse it on every retry of that operation.
function withPaymentId(id: string) {
  return {
    key: PAYMENT_IDENTIFIER,
    enrichPaymentPayload: async (payload: any, paymentRequired: any) => {
      const ext = { ...(paymentRequired.extensions ?? {}) };
      appendPaymentIdentifierToExtensions(ext, id); // no-op if the server did not declare it
      return { ...payload, extensions: ext };
    },
  };
}

const client = new x402Client();
client.register("eip155:*", new ExactEvmScheme(privateKeyToAccount(generatePrivateKey())));
client.registerExtension(withPaymentId("pay_extract_2026_11_13_0001"));

// A 402 challenge that declares the extension (normally decoded from PAYMENT-REQUIRED).
const paymentRequired: any = {
  x402Version: 2,
  resource: { url: "https://api.example.com/v1/extract", description: "demo", mimeType: "application/json" },
  accepts: [{ scheme: "exact", network: "eip155:84532", asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
    amount: "3000", payTo: "0x000000000000000000000000000000000000dEaD", maxTimeoutSeconds: 120,
    extra: { name: "USDC", version: "2" } }],
  extensions: { [PAYMENT_IDENTIFIER]: declarePaymentIdentifierExtension() },
};

const a = await client.createPaymentPayload(paymentRequired);
const b = await client.createPaymentPayload(paymentRequired);
console.log(extractPaymentIdentifier(a)); // pay_extract_2026_11_13_0001
console.log(extractPaymentIdentifier(b)); // pay_extract_2026_11_13_0001
console.log((a.payload as any).authorization.nonce === (b.payload as any).authorization.nonce); // false
```

The last line is the whole point. Each signed payment gets a fresh [EIP-3009](https://eips.ethereum.org/EIPS/eip-3009) nonce, so two signatures are two separate payments as far as the token contract is concerned. The `id` is what tells a server "these two are the same request".

## The problem: a paid call whose response never arrives

An agent pays for a call, the server does the work and settles, and then the connection drops before the `200` reaches the agent. What should it do?

- **Resend the same `PAYMENT-SIGNATURE`.** The nonce is already used on-chain, so it can never be charged twice. But a server with replay protection may refuse it. Assay does exactly that: its replay guard returns `409 payment_replayed` for any authorization that already settled (see [the Hono middleware post](/blog/x402-hono-middleware) and [payments docs](/docs/payments/)). Safe for the payer, but the result is gone.
- **Sign a new payment.** New nonce, new authorization, so the server sees a new request, runs it again, and settles again. The agent pays twice for one result.

Neither is good. Ordinary HTTP APIs solve this with an idempotency key, which the IETF is standardizing as the [`Idempotency-Key` header](https://datatracker.ietf.org/doc/draft-ietf-httpapi-idempotency-key-header/) (still an Internet-Draft, not an RFC). x402 puts the same idea inside the payment itself.

## How the extension works

The [payment-identifier spec](https://github.com/x402-foundation/x402/blob/main/specs/extensions/payment_identifier.md) has three moving parts:

1. **The server declares it** in the 402 challenge, under `extensions["payment-identifier"]`, with `info.required` set to `false` (optional) or `true` (required) plus a JSON Schema for the id. `declarePaymentIdentifierExtension(true)` builds the required form.
2. **The client echoes it** in its `PaymentPayload` and adds `info.id`: 16 to 128 characters, letters, digits, hyphens and underscores only. The spec recommends a prefixed UUID v4, and `generatePaymentId()` returns ids like `pay_51535865c8514cd0bd7bac88fd80e6bd`.
3. **The server deduplicates** on that id. The spec's table:

| Scenario | Server response |
|---|---|
| New `id` | Process the request normally |
| Same `id`, same payload | Return the cached response |
| Same `id`, different payload | `409 Conflict` |
| `required: true` and no `id` | `400 Bad Request` |

Facilitators may also use the id to make `/verify` and `/settle` idempotent, so the same rule can protect both layers.

A few things we confirmed by running the 2.30.0 helpers rather than reading the README:

- `appendPaymentIdentifierToExtensions()` does nothing when the server did not declare the extension, so the hook above is safe to register globally.
- `validatePaymentIdentifierRequirement(payload, true)` on a payload with no id returns `{"valid":false,"errors":["Server requires a payment identifier but none was provided"]}`.
- `isValidPaymentId("abc")` is `false` (too short), and so is an id containing `!@#`.
- `x402Client` merges the server's declaration with what your hook returns, and server-declared fields win on conflict. Our `id` survived because the server never sets one.

## The client side: one id per operation, not per request

The spec says the client "generates unique `id`, reuses same `id` on retries". The hard part is deciding what counts as the same operation. Generate the id where the work is decided, not inside the HTTP call:

- An agent step like "extract this URL for task 42" gets one id, stored with the task, and every retry of that step reuses it.
- A new step, even one that hits the same URL, gets a new id. Reusing an id across different requests is what produces the `409`.

Note that `@x402/extensions` 2.30.0 ships no ready-made client extension for this one, so you register a small `enrichPaymentPayload` hook like `withPaymentId()` above. Construct the client (or swap the hook) per operation so the id does not leak into unrelated calls.

## The server side: bind the id to a fingerprint

The package helps you parse the id (`extractPaymentIdentifier`), but storing and replaying responses is your job. In 2.30.0, `paymentIdentifierResourceServerExtension` is an object with only a `key` and a source comment saying "No enrichment needed - the declaration is static". The [extensions overview](https://docs.x402.org/extensions/overview) lists hooks for it, but the code we installed has none, so do not expect registering it to deduplicate anything.

The spec is specific about what the store must check: bind each id to a fingerprint of the paid operation (scheme, network, asset, amount, `payTo`, the resource path and method, and any application-level operation id), and scope the key by route or tenant rather than using the id alone. A minimal store:

```ts
import { createHash } from "node:crypto";

type Stored = { fingerprint: string; status: number; body: string; headers: Record<string, string> };

function fingerprint(method: string, path: string, query: string, accepted: any): string {
  const { scheme, network, asset, amount, payTo } = accepted;
  return createHash("sha256")
    .update(JSON.stringify([method, path, query, scheme, network, asset, amount, String(payTo).toLowerCase()]))
    .digest("hex");
}

class IdempotencyStore {
  private m = new Map<string, Stored>();
  lookup(key: string, fp: string) {
    const hit = this.m.get(key);
    if (!hit) return { kind: "new" as const };
    return hit.fingerprint === fp ? { kind: "cached" as const, hit } : { kind: "conflict" as const };
  }
  save(key: string, v: Stored) { this.m.set(key, v); }
}

const store = new IdempotencyStore();
const accepted = { scheme: "exact", network: "eip155:84532", asset: "0x036C...", amount: "3000", payTo: "0xdEaD" };
const key = "GET /v1/extract:pay_extract_2026_11_13_0001"; // scoped by route
const fp1 = fingerprint("GET", "/v1/extract", "url=https://example.com", accepted);
console.log(store.lookup(key, fp1).kind); // new
store.save(key, { fingerprint: fp1, status: 200, body: "{...}", headers: { "payment-response": "eyJ..." } });
console.log(store.lookup(key, fp1).kind); // cached
console.log(store.lookup(key, fingerprint("GET", "/v1/extract", "url=https://example.org", accepted)).kind); // conflict
```

We ran that and got the three outputs in the comments. To use it in a gateway, look the id up **before** the payment middleware verifies anything: on `cached`, return the stored status, body and `PAYMENT-RESPONSE` header without verifying or settling the new signature (so the retry is never charged); on `conflict`, return `409`; on `new`, let the request through and save the response only once it settled. Three cautions:

- **Only cache settled successes.** If the handler failed, nothing was charged, so let the retry run.
- **Handle concurrency.** Two retries can arrive together. Mark the id in flight the way Assay's replay guard marks a nonce, and make the second one wait or get a `409`.
- **Use shared storage with a TTL.** A `Map` forgets everything on restart and is not shared between replicas, which is the same limit our [in-memory rate limiter](/blog/token-bucket-rate-limiter-typescript) has.

## What Assay does today

Assay does **not** support payment-identifier yet. Its 402 challenges do not declare the extension, and an id in your payload is ignored. What it does have is the replay guard in [`src/replay.ts`](https://github.com/Anateghi/assay402/blob/main/src/replay.ts): each authorization (network, payer, nonce) is single-use, a concurrent duplicate gets `409`, and a failed call releases the nonce so you can retry the same signature without paying. That covers double-spend and failed calls, but not the lost-response case above: a retry after a successful but undelivered response gets `409` with the same signature, and a second charge with a new one. Adding the extension means a response cache keyed as described here, and we would also need it to survive restarts, which the current in-memory stores do not.

Until then, the practical advice for Assay clients is to keep timeouts generous (both endpoints allow `maxTimeoutSeconds: 120`) and log the `PAYMENT-RESPONSE` header of every success. Assay runs on **Base Sepolia testnet only** with test USDC, so a double charge there costs test tokens. Start with the [quickstart](/docs/quickstart/) or the [TypeScript client post](/blog/x402-fetch-typescript).

**Related:** [What is x402?](/blog/what-is-x402-http-402) · [x402 Hono middleware](/blog/x402-hono-middleware) · [x402 facilitator verify and settle](/blog/x402-facilitator-verify-settle) · [x402 exact scheme on EVM](/blog/x402-exact-scheme-evm) · [Payments (x402)](/docs/payments/)

### Sources
- x402 payment-identifier extension spec: https://github.com/x402-foundation/x402/blob/main/specs/extensions/payment_identifier.md
- `@x402/extensions` payment-identifier README: https://github.com/x402-foundation/x402/tree/main/typescript/packages/extensions/src/payment-identifier
- x402 docs, Extensions overview: https://docs.x402.org/extensions/overview
- `@x402/extensions` on npm (2.30.0 used here): https://www.npmjs.com/package/@x402/extensions
- IETF Internet-Draft, The Idempotency-Key HTTP Header Field: https://datatracker.ietf.org/doc/draft-ietf-httpapi-idempotency-key-header/
- EIP-3009, Transfer With Authorization: https://eips.ethereum.org/EIPS/eip-3009
- Assay source (src/replay.ts): https://github.com/Anateghi/assay402

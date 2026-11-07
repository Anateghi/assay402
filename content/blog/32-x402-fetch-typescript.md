---
title: "@x402/fetch Example: Pay for HTTP 402 APIs from TypeScript"
description: "A working @x402/fetch TypeScript example: wrapFetchWithPaymentFromConfig + ExactEvmScheme + viem, call Assay GET /v1/extract on Base Sepolia, decode PAYMENT-RESPONSE, cap spend with onBeforePaymentCreation, and debug the errors you will actually see."
slug: x402-fetch-typescript
date: 2026-11-07
keywords: [@x402/fetch example, wrapFetchWithPaymentFromConfig, ExactEvmScheme, x402 typescript client, pay for HTTP 402 from node, decodePaymentResponseHeader]
---

# @x402/fetch example: pay for HTTP 402 APIs from TypeScript

An **@x402/fetch example** turns a bare `fetch` into a client that pays for `HTTP 402 Payment Required` responses in USDC and retries once — without you writing EIP-712 code. The official `@x402/fetch` package wraps the global `fetch`. This script calls Assay's `/v1/extract` endpoint on Base Sepolia testnet and prints the extracted title plus the settlement receipt:

```ts
// npm i @x402/fetch @x402/evm viem
import { wrapFetchWithPaymentFromConfig, decodePaymentResponseHeader } from "@x402/fetch";
import { ExactEvmScheme } from "@x402/evm";
import { privateKeyToAccount } from "viem/accounts";

const URL =
  "{{ORIGIN}}/v1/extract?url=https://www.rfc-editor.org/rfc/rfc9110";

const account = privateKeyToAccount(process.env.AGENT_PRIVATE_KEY as `0x${string}`);

const fetchWithPayment = wrapFetchWithPaymentFromConfig(fetch, {
  schemes: [
    {
      network: "eip155:84532", // Base Sepolia only — Assay is testnet today
      client: new ExactEvmScheme(account),
    },
  ],
});

const res = await fetchWithPayment(URL); // 402 → sign → retry with PAYMENT-SIGNATURE
if (!res.ok) {
  console.error(res.status, await res.text());
  process.exit(1);
}

const doc = await res.json();
console.log(doc.title, doc.markdown.slice(0, 120));

const paymentResponse = res.headers.get("PAYMENT-RESPONSE");
if (paymentResponse) {
  console.log("settled:", decodePaymentResponseHeader(paymentResponse));
}
```

Challenge-only sanity check (no wallet needed — expect `402`):

```bash
curl -i "{{ORIGIN}}/v1/extract?url=https://www.rfc-editor.org/rfc/rfc9110"
```

This post is the TypeScript counterpart to the [x402 Python client](/blog/x402-python-client). Pillar context: [How to pay for APIs from an AI agent](/blog/pay-for-apis-from-an-ai-agent). Docs: [`GET /v1/extract`](/docs/extract/). Related: [x402 Hono middleware](/blog/x402-hono-middleware) · [Spending limits for agent wallets](/blog/x402-agent-spending-limits) · [x402 vs API keys](/blog/x402-vs-api-keys).

## What `@x402/fetch` does on a 402

The x402 v2 flow ([docs](https://docs.x402.org/), [spec](https://github.com/coinbase/x402/blob/main/specs/x402-specification-v2.md), [package README](https://www.npmjs.com/package/@x402/fetch)) takes two round trips. The wrapped `fetch` handles both inside one call:

1. **First request** goes out with no payment. The server answers `402` with a `PAYMENT-REQUIRED` header: Base64 JSON with an `accepts` list. Assay's live challenge for `/v1/extract` currently decodes to this shape:

   ```json
   {"scheme": "exact", "network": "eip155:84532", "amount": "3000",
    "asset": "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
    "payTo": "{{PAY_TO}}", "maxTimeoutSeconds": 120,
    "extra": {"name": "USDC", "version": "2"}}
   ```

   `amount` is in atomic units. USDC has 6 decimals, so `3000` is $0.003. The `asset` is Circle's [USDC contract on Base Sepolia](https://developers.circle.com/stablecoins/usdc-contract-addresses).

2. **Selection.** The client drops options it has no scheme registered for, applies spend controls and hooks (below), and picks one.

3. **Signing.** `ExactEvmScheme` builds an [EIP-3009](https://eips.ethereum.org/EIPS/eip-3009) `TransferWithAuthorization` message from the token's EIP-712 domain in `extra`, and signs it with your viem account. Nothing goes on-chain at this step, and the wallet needs no ETH: the facilitator submits the transfer and pays gas.

4. **Retry** with the payload in a `PAYMENT-SIGNATURE` header. The server verifies, does the work, settles, and returns `200` with a `PAYMENT-RESPONSE` header. `decodePaymentResponseHeader` turns that header into a settle object with fields such as `success`, `transaction`, `network`, and `payer`.

The transport retries **once**. If the paid retry also gets a `402`, you receive that response as-is — check `res.ok` / `res.status` before parsing the body. Header names and v1/v2 differences are covered in [x402 v2 headers](/blog/x402-v2-headers-payment-signature).

## Install

```bash
npm i @x402/fetch @x402/evm viem
# Node 20+ (Assay pins ^2.28.0; npm current is in the 2.30.x line)
```

You need three packages:

| Package | Role |
|---|---|
| `@x402/fetch` | `wrapFetchWithPaymentFromConfig` / `wrapFetchWithPayment`, header decoders |
| `@x402/evm` | `ExactEvmScheme` (client signer for the `exact` scheme on EVM) |
| `viem` | `privateKeyToAccount` for the agent key |

Assay itself depends on `@x402/core`, `@x402/evm`, and `@x402/hono` on the server side. `@x402/fetch` is the buyer-side mirror: the same protocol, the other direction.

## Two ways to wrap `fetch`

### 1. Config helper (shortest)

`wrapFetchWithPaymentFromConfig(fetch, config)` builds an `x402Client` for you. The `schemes` array is required; optional fields include `x402Version` (defaults to 2), `paymentRequirementsSelector`, and `spendControls` (same shape as the builder — see the [advanced client examples](https://github.com/coinbase/x402/blob/main/examples/typescript/clients/advanced/README.md)):

```ts
import { wrapFetchWithPaymentFromConfig } from "@x402/fetch";
import { ExactEvmScheme } from "@x402/evm";

const fetchWithPayment = wrapFetchWithPaymentFromConfig(fetch, {
  schemes: [{ network: "eip155:84532", client: new ExactEvmScheme(account) }],
  spendControls: { maxAmountPerPayment: "$0.01" },
});
```

### 2. Builder + `wrapFetchWithPayment` (hooks and policies)

When you need lifecycle hooks or a payee allowlist, construct the client yourself and pass it to `wrapFetchWithPayment`:

```ts
import { wrapFetchWithPayment, x402Client } from "@x402/fetch";
import { ExactEvmScheme } from "@x402/evm/exact/client";
import { privateKeyToAccount } from "viem/accounts";

const account = privateKeyToAccount(process.env.AGENT_PRIVATE_KEY as `0x${string}`);
const ALLOWED_PAY_TO = new Set(["{{PAY_TO}}".toLowerCase()]);

const client = new x402Client()
  .register("eip155:84532", new ExactEvmScheme(account))
  .setSpendControls({ maxAmountPerPayment: "$0.01" })
  .onBeforePaymentCreation(async ({ selectedRequirements: r }) => {
    if (!ALLOWED_PAY_TO.has(r.payTo.toLowerCase())) {
      return { abort: true, reason: `payTo ${r.payTo} not allowlisted` };
    }
  });

const fetchWithPayment = wrapFetchWithPayment(fetch, client);
```

`onBeforePaymentCreation` runs **before** anything is signed. Returning `{ abort: true, reason }` refuses the payment. Pair it with `onAfterPaymentCreation` for audit logs and `onPaymentCreationFailure` to release reservations — the pattern in [spending limits for agent wallets](/blog/x402-agent-spending-limits).

Register the exact CAIP-2 network Assay advertises (`eip155:84532`). A wildcard like `"eip155:*"` works for multi-chain agents, but a dedicated agent wallet should only be able to pay where you funded it. Assay is **Base Sepolia testnet only** today; mainnet (`eip155:8453`) is not enabled.

## Reading `PAYMENT-REQUIRED` and `PAYMENT-RESPONSE`

You usually do not need the challenge header yourself — the wrapper parses it. Useful when debugging an unpaid call or logging receipts:

```ts
import {
  decodePaymentResponseHeader,
} from "@x402/fetch";

// After a paid 200:
const receiptHdr = res.headers.get("PAYMENT-RESPONSE");
if (receiptHdr) {
  const receipt = decodePaymentResponseHeader(receiptHdr);
  console.log(receipt.success, receipt.transaction, receipt.network);
}

// After a bare 402 (unwrapped fetch), decode the challenge yourself:
const required = JSON.parse(
  Buffer.from(res.headers.get("PAYMENT-REQUIRED")!, "base64").toString("utf8"),
);
console.log(required.accepts[0]);
```

Assay exposes `PAYMENT-REQUIRED`, `PAYMENT-RESPONSE`, and `Retry-After` to browsers via CORS (`Access-Control-Expose-Headers`). The [v2 headers post](/blog/x402-v2-headers-payment-signature) covers the wire format end to end.

## Failure modes you will actually see

| Symptom | Cause | Fix |
|---|---|---|
| Paid retry still `402`; facilitator reason like insufficient balance | Signature is valid but the wallet holds too little USDC on Base Sepolia | Fund from [Circle's faucet](https://faucet.circle.com/) (Base Sepolia) |
| Error about `spendControls.maxAmountPerPayment` | Price is above your cap | Raise the cap deliberately, or leave the default `$1` |
| `Payment creation aborted: …` | Your `onBeforePaymentCreation` returned `{ abort: true }` | Working as intended — log and refuse |
| No matching scheme / network | You registered `eip155:8453` (mainnet) but Assay only offers `eip155:84532` | Register `eip155:84532` |
| Final `409` with `payment_replayed` | Same authorization (network + payer + nonce) reused | Fresh nonce per call — do not cache `PAYMENT-SIGNATURE` |
| Final `429` with `rate_limited` | More than 30 requests/min to `/v1/*` from one IP | Back off; honor `Retry-After` ([limits](/docs/limits/)) |

Assay settles only when the handler succeeds (HTTP status below 400). Failed extracts are not charged. Replay protection and settle-on-success are documented in [payments (x402)](/docs/payments/).

## Keys: do this before you fund anything

- Generate a **dedicated** key for the agent. `viem`'s `generatePrivateKey()` / `privateKeyToAccount` pair is enough. Store the key in a secrets manager, not in the repository.
- Fund it with only what you are prepared to lose, and stay on Base Sepolia (`eip155:84532`) first. Network IDs and the mainnet switch are covered in [x402 on Base Sepolia](/blog/x402-base-sepolia-usdc).
- Keep the wallet behind a narrow tool such as `extractMarkdown(url)`. The model never sees the key and never chooses a payee.

## Calling Assay from TypeScript

Assay's two paid endpoints work with the client above as-is. Both run on **Base Sepolia testnet** only for now, and payment is settled only when the call succeeds:

- [`GET /v1/extract`](/docs/extract/): a web page as clean markdown plus JSON metadata (`title`, `byline`, `canonical`, `links`, `robots`, `cached`, …), **$0.003** per call.
- [`POST /v1/pdf/text`](/docs/pdf-text/): a PDF as per-page plain text via PDF.js, **$0.01** per call. Send `{"url":"https://…/file.pdf"}` as JSON, or the raw bytes with `content-type: application/pdf`. No OCR and no table extraction.

Payment is x402 only. Prepaid API keys are planned but not available yet. Prices are published at [`/pricing.json`]({{ORIGIN}}/pricing.json) and [`/.well-known/x402`]({{ORIGIN}}/.well-known/x402). For the Python equivalent of this wrapper, see [x402 Python client](/blog/x402-python-client). For the seller-side Hono middleware Assay runs, see [x402 Hono middleware](/blog/x402-hono-middleware).

**Related:** [How to pay for APIs from an AI agent](/blog/pay-for-apis-from-an-ai-agent) · [What is x402?](/blog/what-is-x402-http-402) · [The x402 exact scheme on EVM](/blog/x402-exact-scheme-evm) · [x402 vs API keys](/blog/x402-vs-api-keys)

### Sources
- `@x402/fetch` on npm (API, `wrapFetchWithPaymentFromConfig`, `decodePaymentResponseHeader`): https://www.npmjs.com/package/@x402/fetch
- `@x402/fetch` README (source tree): https://github.com/coinbase/x402/blob/main/typescript/packages/http/fetch/README.md
- Advanced TypeScript client examples (hooks, spend controls, builder): https://github.com/coinbase/x402/blob/main/examples/typescript/clients/advanced/README.md
- x402 documentation: https://docs.x402.org/
- x402 v2 specification: https://github.com/coinbase/x402/blob/main/specs/x402-specification-v2.md
- EIP-3009, Transfer With Authorization: https://eips.ethereum.org/EIPS/eip-3009
- Circle, USDC contract addresses (Base Sepolia): https://developers.circle.com/stablecoins/usdc-contract-addresses
- Circle testnet faucet: https://faucet.circle.com/
- viem accounts: https://viem.sh/docs/accounts/local/privateKeyToAccount

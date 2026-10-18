---
title: "x402 v2 Headers: PAYMENT-REQUIRED, PAYMENT-SIGNATURE, and PAYMENT-RESPONSE (and What Changed from v1)"
description: "x402 v2 moves every payment message into three base64 JSON headers. Here is what each one carries, how to decode them, and a field-by-field map from the v1 X-PAYMENT format for anyone migrating a client or server."
slug: x402-v2-headers-payment-signature
date: 2026-10-18
keywords: [x402 v2 headers, PAYMENT-SIGNATURE header, PAYMENT-REQUIRED header, X-PAYMENT vs PAYMENT-SIGNATURE, x402 v1 to v2 migration]
---

# x402 v2 headers: PAYMENT-REQUIRED, PAYMENT-SIGNATURE, and PAYMENT-RESPONSE

In **x402 v2, every payment message travels in one of three HTTP headers**: `PAYMENT-REQUIRED` (server to client), `PAYMENT-SIGNATURE` (client to server), and `PAYMENT-RESPONSE` (server to client). Each one holds a base64-encoded JSON object, so you can inspect any of them with standard tools. Here is a live one from Assay:

```bash
# Ask for a paid resource without paying, then decode the PAYMENT-REQUIRED header
curl -si "{{ORIGIN}}/v1/extract?url=https://example.com" \
  | grep -i '^payment-required:' | cut -d' ' -f2 | tr -d '\r' | base64 -d | jq .

# Same idea in Node, for any of the three headers
node -e 'console.log(JSON.parse(Buffer.from(process.argv[1], "base64").toString()))' "<header value>"
```

This post walks through what each header contains, then maps the v1 format (`X-PAYMENT`, requirements in the response body) to v2 field by field, because a lot of the tutorials you will find still show v1. For the protocol basics, start with [What is x402?](/blog/what-is-x402-http-402).

## The three headers at a glance

The [x402 v2 HTTP transport spec](https://github.com/coinbase/x402/blob/main/specs/transports-v2/http.md) defines exactly three headers and says that "all x402 protocol information is communicated through headers." The response body is left to the server.

| Header | Direction | Carries (base64 JSON) | Typical status |
|---|---|---|---|
| `PAYMENT-REQUIRED` | Server to client | `PaymentRequired`: what to pay, to whom, on which network | `402` |
| `PAYMENT-SIGNATURE` | Client to server | `PaymentPayload`: the signed payment for one chosen option | (request) |
| `PAYMENT-RESPONSE` | Server to client | `SettlementResponse`: the settlement result and transaction hash | `200`, or `402` on failure |

HTTP field names are case-insensitive ([RFC 9110, section 5.1](https://www.rfc-editor.org/rfc/rfc9110#section-5.1)), so `payment-required` in curl's output and `PAYMENT-REQUIRED` in the spec are the same header.

## PAYMENT-REQUIRED: the challenge

When a request arrives without a valid payment, the server answers `402 Payment Required` and puts a `PaymentRequired` object in this header. Decoded, Assay's challenge for `/v1/extract` looked like this when we ran the command above on 18 October 2026 (`payTo` shortened):

```json
{
  "x402Version": 2,
  "error": "Payment required",
  "resource": {
    "url": "{{ORIGIN}}/v1/extract",
    "description": "Web page to clean markdown + JSON metadata (robots.txt-aware)",
    "mimeType": "application/json",
    "serviceName": "Assay",
    "tags": ["extract", "markdown", "web"]
  },
  "accepts": [
    {
      "scheme": "exact",
      "network": "eip155:84532",
      "amount": "3000",
      "asset": "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
      "payTo": "0x…",
      "maxTimeoutSeconds": 120,
      "extra": { "name": "USDC", "version": "2" }
    }
  ]
}
```

What to notice:

- **`resource` is a single top-level object.** It describes the thing being sold once, no matter how many payment options are offered. The spec's `ResourceInfo` also defines the optional `serviceName` and `tags` fields, which are meant for discovery filtering, and an optional `iconUrl`.
- **`accepts` is a list of options.** A server can offer several schemes, networks, or assets, and the client picks one.
- **`amount` is in atomic units.** USDC has 6 decimals, so `"3000"` means 0.003 USDC.
- **`network` is a [CAIP-2](https://github.com/ChainAgnostic/CAIPs/blob/main/CAIPs/caip-2.md) identifier.** `eip155:84532` is Base Sepolia, and `eip155:8453` is Base mainnet.
- **`extra` is scheme-specific.** For EVM `exact`, the token's EIP-712 domain name and version let the client sign without looking them up on-chain.

## PAYMENT-SIGNATURE: the payment

The client picks one entry from `accepts`, signs it, and retries the same request with a `PaymentPayload` in `PAYMENT-SIGNATURE`. Following the example in the [v2 specification](https://github.com/coinbase/x402/blob/main/specs/x402-specification-v2.md) (section 5.2), the decoded payload for EVM `exact` has this shape:

```json
{
  "x402Version": 2,
  "resource": { "url": "https://api.example.com/premium-data" },
  "accepted": {
    "scheme": "exact",
    "network": "eip155:84532",
    "amount": "10000",
    "asset": "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
    "payTo": "0x209693Bc6afc0C5328bA36FaF03C514EF312287C",
    "maxTimeoutSeconds": 60,
    "extra": { "name": "USDC", "version": "2" }
  },
  "payload": {
    "signature": "0x…",
    "authorization": {
      "from": "0x857b…6b66",
      "to": "0x2096…287C",
      "value": "10000",
      "validAfter": "1740672089",
      "validBefore": "1740672154",
      "nonce": "0xf374…3480"
    }
  }
}
```

`accepted` is a full copy of the option the client chose, so the server can match it against what it actually advertised. `payload` is scheme-specific. For EVM `exact`, it holds an [EIP-3009](https://eips.ethereum.org/EIPS/eip-3009) `transferWithAuthorization` signed with EIP-712. That signature lets the facilitator move exactly `value` from `from` to `to` between `validAfter` and `validBefore`, and it can be used only once, because the token contract records the nonce. The client never sends a private key or a transaction, only this authorization.

## PAYMENT-RESPONSE: the receipt

After the server settles the payment (usually through a [facilitator](/blog/x402-facilitator-verify-settle)), it attaches a `SettlementResponse` to its response:

```json
{ "success": true, "transaction": "0x…", "network": "eip155:84532", "payer": "0x…" }
```

On failure, the spec's example returns `402` with `success: false` and an `errorReason` such as `insufficient_funds`, and `transaction` is an empty string because nothing was broadcast. The exception is `settlement_pending`. There, the spec requires a non-empty transaction hash, because the transaction was sent and may still confirm. Log it and reconcile on-chain before you retry.

Clients should keep `transaction`: it is the payer's proof of what was charged for which request.

## What changed from v1

v2.0 is listed in the spec's changelog as dated 2025-12-9, with "CAIP-2 networks, restructured PaymentPayload/Required, ResourceInfo separation, extensions support." Comparing the [v1 HTTP transport](https://github.com/coinbase/x402/blob/main/specs/transports-v1/http.md) with v2, these are the differences that break code:

| | v1 | v2 |
|---|---|---|
| Where the requirements go | JSON **response body** of the 402 | Base64 **`PAYMENT-REQUIRED` header** |
| Client payment header | `X-PAYMENT` | `PAYMENT-SIGNATURE` |
| Settlement header | `X-PAYMENT-RESPONSE` | `PAYMENT-RESPONSE` |
| Network names | Strings like `base-sepolia` | CAIP-2 like `eip155:84532` |
| Price field | `maxAmountRequired` | `amount` |
| Resource description | `resource`, `description`, `mimeType`, `outputSchema` repeated in **each** `accepts` entry | One top-level `resource` object |
| Payment payload | Top-level `scheme` and `network` next to `payload` | `accepted`: the full chosen requirements object |
| Extensions | None | Optional `extensions` in `PaymentRequired`, `PaymentPayload`, and `SettlementResponse` |

The EVM `exact` payload itself (the EIP-3009 `signature` plus `authorization`) is the same in both versions' examples. Most of the migration work is in the envelope around it.

## Migration checklist

If you maintain a client or server that predates v2, these are the places to check:

1. **Read the challenge from the header, not only the body.** The official TypeScript SDK's HTTP client (`@x402/core`, used by `@x402/fetch`) looks for `PAYMENT-REQUIRED` first and falls back to the body only when the body says `x402Version: 1`.
2. **Pick the header name by version.** The same SDK sends `PAYMENT-SIGNATURE` for a v2 payload and `X-PAYMENT` for a v1 payload. When reading the receipt, it tries `PAYMENT-RESPONSE` and then `X-PAYMENT-RESPONSE`.
3. **Update your network table.** Anywhere you match on `base` or `base-sepolia`, switch to CAIP-2 strings.
4. **Rename `maxAmountRequired` to `amount`** in pricing code, logs, and dashboards.
5. **Fix CORS for browser clients.** A browser script can read only safelisted response headers unless the server lists the others in `Access-Control-Expose-Headers`, and a custom request header such as `PAYMENT-SIGNATURE` triggers a preflight that the server must allow in `Access-Control-Allow-Headers` ([MDN on CORS](https://developer.mozilla.org/en-US/docs/Web/HTTP/Guides/CORS)). If you forget this, browser clients will see a 402 but never be able to read the challenge.
6. **Watch header sizes.** Base64 makes data about a third larger, and the payload now repeats the full `accepted` object. If a proxy or CDN sits in front of your API, check its request-header size limit before you add many `extensions`.
7. **Key idempotency on the payment, not the header string.** The same authorization can be re-encoded with different whitespace or field order. Deduplicate on something stable, such as the signature or the payer plus nonce.

## How Assay handles these headers

Assay's [`/v1/extract`](/docs/extract/) and [`/v1/pdf/text`](/docs/pdf-text/) endpoints issue x402 v2 challenges only, using the `exact` scheme with USDC on **Base Sepolia testnet** (`eip155:84532`). Mainnet isn't enabled. The gateway reads the payment from `PAYMENT-SIGNATURE` and also accepts the legacy `X-PAYMENT` header name, but the payload has to match the v2 requirements it advertised. Every `/v1/*` response exposes `PAYMENT-REQUIRED`, `PAYMENT-RESPONSE`, and `Retry-After` to browsers, and the preflight allows `PAYMENT-SIGNATURE`. A replay guard keyed on the network, payer, and nonce returns `409 payment_replayed` for a reused authorization, and settlement runs only when the handler succeeds. The full exchange is documented in [Payments](/docs/payments/), and the [quickstart](/docs/quickstart/) walks through a test call with free testnet USDC.

**Related:** [What is an x402 facilitator?](/blog/x402-facilitator-verify-settle) · [How to pay for APIs from an AI agent](/blog/pay-for-apis-from-an-ai-agent)

### Sources
- x402 HTTP transport v2: https://github.com/coinbase/x402/blob/main/specs/transports-v2/http.md
- x402 HTTP transport v1: https://github.com/coinbase/x402/blob/main/specs/transports-v1/http.md
- x402 v2 specification (sections 5 and 9, and the version history): https://github.com/coinbase/x402/blob/main/specs/x402-specification-v2.md
- x402 TypeScript SDK (`@x402/core` HTTP client): https://github.com/coinbase/x402/tree/main/typescript
- EIP-3009, Transfer With Authorization: https://eips.ethereum.org/EIPS/eip-3009
- CAIP-2, Blockchain ID Specification: https://github.com/ChainAgnostic/CAIPs/blob/main/CAIPs/caip-2.md
- RFC 9110, HTTP Semantics (section 5.1, field names): https://www.rfc-editor.org/rfc/rfc9110#section-5.1
- MDN, Cross-Origin Resource Sharing: https://developer.mozilla.org/en-US/docs/Web/HTTP/Guides/CORS

---
title: "Payments: the x402 v2 exchange"
description: "How Assay uses x402 v2: the 402 challenge, PAYMENT-SIGNATURE, verify, settle-on-success, PAYMENT-RESPONSE, and replay protection."
order: 3
nav: "Payments (x402)"
---

# Payments: the x402 v2 exchange

Payment is part of the API contract, so here it is in full.

## 1. The challenge

A request without payment gets `402` and a `PAYMENT-REQUIRED` header with Base64 JSON. Decoded, Assay's challenge for `/v1/extract` is:

```json
{
  "x402Version": 2,
  "error": "Payment required",
  "resource": {
    "url": "{{ORIGIN}}/v1/extract",
    "description": "Web page to clean markdown + JSON metadata (robots.txt-aware)",
    "mimeType": "application/json"
  },
  "accepts": [{
    "scheme": "exact",
    "network": "eip155:84532",
    "amount": "3000",
    "asset": "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
    "payTo": "{{PAY_TO}}",
    "maxTimeoutSeconds": 120,
    "extra": { "name": "USDC", "version": "2" }
  }]
}
```

> **Cost:** `amount` is in USDC atomic units (6 decimals). `3000` = `$0.003`. `10000` = `$0.01`.

The response body is also JSON, for humans reading logs:

```json
{ "error": "payment_required", "message": "Pay with x402 v2 (exact, USDC on Base Sepolia testnet). Price: $0.003 per successful call.", "docs": "{{ORIGIN}}/docs/payments" }
```

## 2. The retry

Your client signs an EIP-3009 `transferWithAuthorization` for exactly `amount` to `payTo` and retries the same request with a `PAYMENT-SIGNATURE` header (Base64 JSON). The official `@x402/fetch` and `@x402/axios` wrappers do this for you. Assay also accepts the legacy `X-PAYMENT` header name.

## 3. What Assay does with it

1. **Rate limit and validate.** Malformed input is rejected with `400` before any payment is looked at.
2. **Replay guard.** Each authorization (payer + nonce) may be used once. A second request with the same authorization gets `409 payment_replayed`, both while the first is in flight and after it settled.
3. **Verify** with the facilitator (`https://x402.org/facilitator`).
4. **Run the handler.**
5. **Settle only on success.** If the handler returns a status below 400, Assay settles the payment and returns `200` with a `PAYMENT-RESPONSE` header (Base64 JSON with `success`, `transaction`, `network`, `payer`). If the handler fails, Assay does **not** settle. Your authorization expires unused, and you are not charged.

> **Gotcha:** settlement can fail after the work is done (for example, if the payer spent the balance in between). In that case you get a `402` with the settlement error instead of the result.

## Network and asset

| | Value |
|---|---|
| Network | Base Sepolia, `eip155:84532` (testnet) |
| Asset | USDC, `0x036CbD53842c5426634e7929541eC2318f3dCF7e` |
| Facilitator | `https://x402.org/facilitator` |
| Pay-to | `{{PAY_TO}}` (testnet) |

Mainnet is not enabled. The server refuses to start with any network other than Base Sepolia.

---
title: "What Is x402? HTTP 402 Payment Required, Explained for API Builders"
description: "A precise walkthrough of x402: how the dormant HTTP 402 status code became a payment protocol for agents, what the headers contain, and how settlement works with USDC on Base."
slug: what-is-x402-http-402
date: 2026-10-16
keywords: [x402, HTTP 402, payment required, x402 facilitator, USDC on Base, agent payments]
---

# What is x402? HTTP 402 Payment Required, explained for API builders

HTTP has had a status code for "you need to pay" since the 1990s. For most of that time nobody used it. x402 is an open protocol that finally puts `402 Payment Required` to work, so any HTTP client, including an autonomous AI agent, can pay for one request without first creating an account, storing a credit card, or managing an API key. This post covers what the protocol does, what goes over the wire, and where its limits are. It is the background for how Assay sells endpoints per call.

## A status code that waited 25 years

The current HTTP semantics specification, [RFC 9110 §15.5.3](https://www.rfc-editor.org/rfc/rfc9110#section-15.5.3), defines 402 in one sentence: it is "reserved for future use." Earlier HTTP/1.1 specifications said the same. The code existed, but nobody standardized what a client should do when it received one. A few services returned 402 for "your subscription lapsed," each in its own way, and generic clients treated it as an error.

There were two missing pieces: a machine-readable way to say *how* to pay, and a payment method cheap and fast enough for a single HTTP request. Card networks charge fixed fees per transaction, which makes sub-cent charges impractical. Stablecoins on low-fee networks changed that cost picture.

## What x402 adds

[x402](https://docs.x402.org/) was first published by Coinbase and is now developed in the open ([x402-foundation/x402 on GitHub](https://github.com/x402-foundation/x402)). It defines:

1. A **payment requirements** object that a server returns with a 402.
2. A **payment payload** that a client attaches when it retries.
3. A **settlement response** that the server returns with the paid result.
4. **Schemes** (how the money moves, e.g. `exact`) and **networks**, named with [CAIP-2](https://github.com/ChainAgnostic/CAIPs/blob/main/CAIPs/caip-2.md) identifiers such as `eip155:8453` for Base mainnet.
5. An optional **facilitator** role: a service that verifies and settles payments for the server, so the server does not need to run blockchain infrastructure.

## The wire format (v2)

In x402 version 2, all protocol data travels in three headers, each containing Base64-encoded JSON ([HTTP transport spec](https://github.com/coinbase/x402/blob/main/specs/transports-v2/http.md), [docs](https://docs.x402.org/core-concepts/http-402)):

| Header | Direction | Contents |
|---|---|---|
| `PAYMENT-REQUIRED` | server → client | `PaymentRequired` object |
| `PAYMENT-SIGNATURE` | client → server | `PaymentPayload` object |
| `PAYMENT-RESPONSE` | server → client | `SettlementResponse` object |

(Version 1 used `X-PAYMENT` and `X-PAYMENT-RESPONSE`, and put requirements in the response body. If you read older tutorials, keep that difference in mind.)

A first request without payment looks like this:

```http
GET /v1/extract?url=https://example.com HTTP/1.1
Host: {{HOST}}

HTTP/1.1 402 Payment Required
PAYMENT-REQUIRED: eyJ4NDAyVmVyc2lvbiI6Mi...
```

Decoded, the header carries something like this (structure from the [v2 specification](https://github.com/coinbase/x402/blob/main/specs/x402-specification-v2.md)):

```json
{
  "x402Version": 2,
  "error": "PAYMENT-SIGNATURE header is required",
  "resource": {
    "url": "{{ORIGIN}}/v1/extract",
    "description": "Web page to clean markdown",
    "mimeType": "application/json"
  },
  "accepts": [{
    "scheme": "exact",
    "network": "eip155:8453",
    "amount": "3000",
    "asset": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    "payTo": "0xYourReceivingAddress",
    "maxTimeoutSeconds": 60,
    "extra": { "name": "USD Coin", "version": "2" }
  }]
}
```

Notes on the fields:

- `amount` is in **atomic units** of the token. USDC has 6 decimals, so `"3000"` is $0.003.
- `asset` is the token contract. `0x8335…2913` is Circle's native USDC on Base, as listed in [Circle's USDC contract addresses](https://developers.circle.com/stablecoins/usdc-contract-addresses).
- `accepts` is an **array**. A server can offer several networks or assets, and the client picks one.
- `extra` carries the EIP-712 domain details that the client needs to sign correctly.

> **Note:** the example above shows Base mainnet values. Assay's live deployment currently runs on **Base Sepolia testnet**, so its real challenge says `"network": "eip155:84532"` with the testnet USDC contract `0x036CbD53842c5426634e7929541eC2318f3dCF7e`. You can see it yourself with `curl -i "{{ORIGIN}}/v1/extract?url=https://example.com"`.

## How the `exact` scheme pays without a gas-paying client

On EVM chains, the `exact` scheme relies on [EIP-3009 `transferWithAuthorization`](https://eips.ethereum.org/EIPS/eip-3009), which USDC implements. Instead of sending a transaction, the client signs an off-chain authorization: "move *amount* from me to *payTo*, valid between these times, with this nonce." It sends that signature in `PAYMENT-SIGNATURE`.

The server (or its facilitator) then:

1. **Verifies** that the signature is valid, that the amount and recipient match the requirements, that the time window is open, and that the payer has the balance.
2. **Settles** by submitting the authorization on-chain. Whoever submits it pays the gas. With a hosted facilitator, that is the facilitator.
3. Returns the resource with `200 OK` and a `PAYMENT-RESPONSE` header that includes the transaction reference.

Because the authorization carries a unique nonce, it cannot be replayed. The payer never needs ETH for gas, which matters a lot for agent wallets that only hold USDC.

## Facilitators: hosted or self-run

A facilitator exposes `verify` and `settle` operations. Coinbase runs one as part of its developer platform ([CDP x402 docs](https://docs.cdp.coinbase.com/x402/welcome)). Open-source implementations also exist, such as [x402-rs](https://github.com/x402-rs/x402-rs), so you can run your own and pay only gas. The facilitator never holds your funds: the authorization moves USDC directly from the payer to your `payTo` address.

There are trade-offs. A hosted facilitator has terms of service and possibly eligibility requirements. A self-hosted facilitator means you manage a hot wallet for gas, RPC reliability, and nonce handling.

## Why this matters for agents

An agent that finds a new tool in the middle of a task cannot fill in a signup form, verify an email address, or wait for a sales call. With x402, the 402 response *is* the onboarding: price, asset, network, and recipient are all machine-readable. If the agent's policy allows the spend, it signs and retries. Discovery directories such as the x402 Bazaar list x402-enabled resources so agents can find them.

## Honest limits

- **Volume is still small.** Public trackers such as [402radar](https://402radar.io/stats) show x402 payment volume that is real but modest. Treat x402 as an extra rail, not a business on its own.
- **Stablecoin issuers can freeze addresses.** Read the [USDC terms](https://www.circle.com/legal/usdc-terms).
- **Refunds are not built in.** A settled `exact` payment is final. Good servers verify first, do the work, and settle only on success, or they publish a clear refund policy.
- **Compliance still applies.** Screening payer addresses against sanctions lists is the server operator's responsibility.

## How Assay uses it

Both Assay endpoints (`/v1/extract` and `/v1/pdf/text`) accept x402 v2 `exact` payments in USDC. Today that is on **Base Sepolia testnet only** (`eip155:84532`), settled through the public x402.org facilitator, so you can try the whole flow with free test USDC. Mainnet and prepaid API keys are planned, not live. The 402 challenge is documented on each [endpoint page](/docs/), so you can see exactly what your agent will be asked to sign before it signs anything, and Assay settles only after the handler succeeds.

**Next:** [How to pay for APIs from an AI agent](/blog/pay-for-apis-from-an-ai-agent).

### Sources
- RFC 9110, HTTP Semantics, §15.5.3: https://www.rfc-editor.org/rfc/rfc9110#section-15.5.3
- x402 v2 specification: https://github.com/coinbase/x402/blob/main/specs/x402-specification-v2.md
- x402 HTTP transport v2: https://github.com/coinbase/x402/blob/main/specs/transports-v2/http.md
- EIP-3009: https://eips.ethereum.org/EIPS/eip-3009
- Circle USDC contract addresses: https://developers.circle.com/stablecoins/usdc-contract-addresses
- CAIP-2: https://github.com/ChainAgnostic/CAIPs/blob/main/CAIPs/caip-2.md

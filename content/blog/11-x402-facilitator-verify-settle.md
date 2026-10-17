---
title: "What Is an x402 Facilitator? /verify, /settle, and /supported Explained"
description: "An x402 facilitator verifies and settles payments so an API server doesn't have to run blockchain infrastructure. Here is what its three endpoints do, what goes over the wire, and how to choose between a hosted and a self-run facilitator."
slug: x402-facilitator-verify-settle
date: 2026-10-17
keywords: [x402 facilitator, x402 verify settle, x402 supported endpoint, self-hosted x402 facilitator, x402 payment flow]
---

# What is an x402 facilitator? /verify, /settle, and /supported explained

An **x402 facilitator** is the service that checks and executes payments on behalf of an API server. The server stays a plain HTTP app: it asks the facilitator "is this signed payment good?" before doing the work, and "please execute it" afterwards. You can see a live one right now, because the public facilitator at `x402.org` answers without any credentials:

```bash
# Which schemes and networks does this facilitator handle? (x402 v2 entries only)
curl -s https://x402.org/facilitator/supported \
  | jq -c '.kinds[] | select(.x402Version==2) | {scheme, network}'

# And what does a paid endpoint ask for? (Assay's live 402 challenge, decoded)
curl -si "{{ORIGIN}}/v1/extract?url=https://example.com" \
  | grep -i '^payment-required:' | cut -d' ' -f2 | tr -d '\r' | base64 -d | jq .
```

This post explains the facilitator's three endpoints, the order in which a server calls them, and the trade-offs between a hosted facilitator and one you run yourself. If you are new to the protocol, start with [What is x402?](/blog/what-is-x402-http-402).

## Where the facilitator sits

x402 has three parties: the **client** (often an AI agent with a wallet), the **resource server** (your API), and the **facilitator**. The [x402 v2 specification](https://github.com/coinbase/x402/blob/main/specs/x402-specification-v2.md) describes the facilitator as a service that "handles payment verification and blockchain settlement," and standardizes its interface as HTTP endpoints so that "resource servers [can] delegate blockchain operations to trusted third parties or host the endpoints themselves."

The client never talks to the facilitator. It only sees your API's `402` challenge, signs a payment, and retries with a `PAYMENT-SIGNATURE` header. Everything after that is between your server and the facilitator.

## The three endpoints

### `POST /verify`: is this payment valid?

The server sends the client's decoded payment payload together with the payment requirements it advertised:

```json
{
  "x402Version": 2,
  "paymentPayload": { "...": "what the client sent in PAYMENT-SIGNATURE, decoded" },
  "paymentRequirements": { "...": "the accepts[] entry the client chose" }
}
```

The spec is strict that `/verify` is **read-only**: it "MUST NOT commit payment state or write onchain state." For the EVM `exact` scheme, verification means checking the [EIP-3009](https://eips.ethereum.org/EIPS/eip-3009) authorization: the signature, the amount, the recipient, the validity window, and the payer's balance. A good answer is `{"isValid": true, "payer": "0x…"}`. A bad one carries an `invalidReason` such as `insufficient_funds`, `invalid_exact_evm_payload_signature`, or `invalid_exact_evm_payload_recipient_mismatch` (the full list is in section 9 of the spec).

### `POST /settle`: make it final

The request body has the same shape as `/verify`. Settlement "durably commits payment state," which for EVM `exact` means submitting the signed `transferWithAuthorization` on-chain. The facilitator submits the transaction and pays its gas, which is why a paying client only needs USDC and no ETH. A successful response looks like:

```json
{ "success": true, "payer": "0x…", "transaction": "0x…", "network": "eip155:84532" }
```

Your server then encodes that result into the `PAYMENT-RESPONSE` header on its `200` response, so the client gets a transaction reference it can check on a block explorer.

One error code deserves special handling: `settlement_pending`. The spec defines it as **non-terminal**: the transaction was broadcast but its confirmation couldn't be established, so it "may still confirm on chain." The response must include the transaction hash, and you should reconcile on-chain before you retry or refund anything.

### `GET /supported`: what can this facilitator do?

`/supported` returns `kinds` (each a combination of `x402Version`, `scheme`, and CAIP-2 `network`), the `extensions` it implements, and the `signers` it uses per network family. The official TypeScript SDK's facilitator client fetches it, so the server knows which payment kinds its facilitator can actually handle before advertising them.

When we ran the command above on 17 October 2026, `x402.org/facilitator` listed v2 `exact` support on Base Sepolia (`eip155:84532`) plus several other testnets, and also the `upto` and `batch-settlement` schemes on Base Sepolia. That list changes over time, so query it rather than trusting any blog post, including this one.

## The order of calls depends on the payment flow

The v2 spec defines three payment flows, and the flow decides which facilitator endpoints run and when:

| Flow | Order | When it's used |
|---|---|---|
| `authorization` (default) | verify → run handler → settle → respond | Funds move only after the handler succeeds |
| `upfront` | settle → run handler → respond | Networks with no way to "pull" a signed payment later |
| `escrow` | settle → run handler → settle → respond | A deposit or ceiling first, then the final charge |

The spec's invariant is that at least one check must happen before the resource executes: "The resource never executes with nothing checked." When a server offers both `authorization` and a pre-payment flow for the same request, clients should prefer `authorization`.

The `authorization` flow is what makes "charge only on success" possible. If your handler fails after `/verify`, you simply never call `/settle`. The client's signed authorization expires unused and no money moves.

## Hosted or self-run?

**Hosted facilitators** are the quickest start. The public `https://x402.org/facilitator` needs no account and handles testnet payments, which makes it a good place to develop. Coinbase runs the [CDP facilitator](https://docs.cdp.coinbase.com/x402/welcome) as part of its developer platform. Using it means signing up for CDP, and its documentation covers supported networks, pricing, and eligibility. With either one, you keep custody: an EIP-3009 authorization moves USDC straight from the payer to your `payTo` address, and the facilitator only relays it.

**Self-run facilitators** remove the third-party dependency. [x402-rs](https://github.com/x402-rs/x402-rs) provides a facilitator server binary (with a container image on GHCR) supporting EVM chains, Solana, and Aptos across protocol v1 and v2. The cost is operational. You fund and secure a hot wallet that pays settlement gas, you depend on reliable RPC endpoints, and you handle transactions that get stuck or dropped yourself.

Questions worth answering before you choose:

1. **Does `/supported` list your exact scheme, network, and version?** If it doesn't, payments on that combination can't be verified or settled.
2. **Whose terms apply?** A hosted facilitator is a counterparty with its own terms of service and restrictions on who can use it.
3. **Who pays gas, and how is that budgeted?** On a self-run facilitator, you do.
4. **What happens on `settlement_pending` or a timeout?** Make sure your server logs the transaction hash and can reconcile it.
5. **Can you swap facilitators without changing clients?** You should be able to. Clients only see your `402` challenge, never the facilitator URL.

## A replay note

EIP-3009 nonces are recorded in the token contract, so the same authorization can't be settled twice on-chain. That protects your money, but it doesn't stop a client from sending the same `PAYMENT-SIGNATURE` to your API twice while the first request is still running, which would get the work done twice for one payment. Add your own once-only check on payer plus nonce in front of the handler.

## How Assay uses a facilitator

Assay's two endpoints, [`/v1/extract`](/docs/extract/) and [`/v1/pdf/text`](/docs/pdf-text/), use the `@x402/hono` middleware with an HTTP facilitator client pointed at `https://x402.org/facilitator`. They run the `authorization` flow on **Base Sepolia testnet only** (`eip155:84532`). Each paid request goes through rate limiting and input validation, a replay guard (a reused authorization gets `409 payment_replayed`), facilitator `/verify`, the handler, and finally `/settle`, which runs only if the handler returned a status below 400. Mainnet isn't enabled yet, and the server refuses to start on any other network. The full exchange is documented in [Payments](/docs/payments/), and you can make a test call with free testnet USDC by following the [quickstart](/docs/quickstart/).

**Related:** [How to pay for APIs from an AI agent](/blog/pay-for-apis-from-an-ai-agent) · [Designing pay-per-call pricing](/blog/designing-pay-per-call-pricing)

### Sources
- x402 v2 specification (sections 6.1, 7, and 9): https://github.com/coinbase/x402/blob/main/specs/x402-specification-v2.md
- x402 HTTP transport v2: https://github.com/coinbase/x402/blob/main/specs/transports-v2/http.md
- EIP-3009, Transfer With Authorization: https://eips.ethereum.org/EIPS/eip-3009
- Coinbase Developer Platform x402 docs: https://docs.cdp.coinbase.com/x402/welcome
- x402-rs: https://github.com/x402-rs/x402-rs
- Public facilitator capabilities (live): https://x402.org/facilitator/supported

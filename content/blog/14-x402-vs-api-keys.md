---
title: "x402 vs API Keys: Paying Per Request Instead of Holding a Shared Secret"
description: "API keys identify an account and bill it later. x402 puts a signed, single-use payment on the request itself. A precise comparison of onboarding, leak exposure, replay, per-call overhead, and identity, plus how the two combine in x402 v2."
slug: x402-vs-api-keys
date: 2026-10-20
keywords: [x402 vs API keys, API key alternative for AI agents, bearer token vs signed payment, x402 authentication, sign-in-with-x, pay per request without signup]
---

# x402 vs API keys: paying per request instead of holding a shared secret

**x402 vs API keys** is less a contest than a question about where trust lives. An API key is a long-lived secret that says "this request belongs to account 1234, bill it later." An x402 payment is a signed authorization that says "this request is paid for, here is the money." The difference shows up on the very first request. With a key-based API you can't get started without the key. With x402 you get the price:

```bash
# No account, no key, no Authorization header. The answer is terms, not a 401.
curl -s -o /dev/null -w '%{http_code}\n' "{{ORIGIN}}/v1/extract?url=https://example.com"
# → 402

curl -si "{{ORIGIN}}/v1/extract?url=https://example.com" \
  | grep -i '^payment-required:' | cut -d' ' -f2 | tr -d '\r' | base64 -d \
  | jq '.accepts[] | {scheme, network, amount, asset, payTo}'
```

This post compares the two models property by property, shows where API keys are still the better tool, and explains how x402 v2 lets a server use both on the same endpoint. For the protocol itself, start with [What is x402?](/blog/what-is-x402-http-402).

## Two different questions

An API key answers **who is calling**. The server looks the key up, finds an account, checks its quota, and records usage against it. Payment happens somewhere else, usually on a card, on an invoice, or out of a prepaid balance.

An x402 payment answers **has this request been paid for**. The server doesn't need to know who you are. It needs a valid signature over the amount it asked for, sent to the address it named, inside a time window.

The x402 project states this separation directly. Its [`auth-hints` extension](https://github.com/coinbase/x402/blob/main/specs/extensions/extension-auth-hints.md) describes authentication and payment as "parallel concerns": "authentication identifies the client, payment authorizes the transfer of value." Keep that distinction in mind and most of the comparison follows from it.

## Side by side

| | API key | x402 (`exact` scheme on EVM) |
|---|---|---|
| Before the first call | Sign up, verify an email, often add a card, copy the key | Hold a funded wallet. The `402` challenge carries the price |
| What travels on each request | The same secret, every time | A fresh signed authorization for one payment |
| What the credential is bound to | An account | An amount, a recipient, a validity window, and a nonce |
| If the credential leaks | Anyone can call as you until the key is revoked | The authorization can be redeemed at most once, for that amount, to that recipient |
| Replay | Not applicable: the key is meant to be reused | Rejected: each nonce settles once on-chain |
| Billing | Metered by the provider, settled later | Settled per request, on-chain, through a facilitator |
| Per-call overhead | A key lookup and a usage counter | A signature, a facilitator `/verify`, and a `/settle` transaction |
| Identity and relationship | Built in: account, dashboard, support, SLAs | None by default. A wallet address is all the server sees |
| Works for an agent that found you a minute ago | Only if it can complete your signup | Yes, if its payment policy allows the price |

The rest of this post goes through the rows that matter most in practice.

## A leaked key and a leaked payment are different problems

Most API keys behave like what [RFC 6750](https://www.rfc-editor.org/rfc/rfc6750.html) calls a bearer token: "any party in possession of the token (a 'bearer') can use the token in any way that any other party in possession of it can," without proving "possession of cryptographic key material." That is why the RFC's first security recommendation is that clients "MUST ensure that bearer tokens are not leaked to unintended parties." It is also why services like [GitHub secret scanning](https://docs.github.com/en/code-security/secret-scanning/introduction/about-secret-scanning) exist: credentials such as API keys get committed to repositories, and the remedy GitHub recommends is to rotate them immediately. An agent makes this harder, not easier. Its key lives in a process that also reads untrusted web pages and tool output, writes logs, and sometimes echoes its own context.

An x402 `exact` payment on EVM is an [EIP-3009](https://eips.ethereum.org/EIPS/eip-3009) `transferWithAuthorization`. The payer signs `from`, `to`, `value`, `validAfter`, `validBefore`, and a random 32-byte `nonce`. If that `PAYMENT-SIGNATURE` header ends up in a log, the worst case is narrow: someone can redeem it once, for exactly that amount, to exactly the server's `payTo`, before `validBefore` passes. The token contract records the nonce, so it cannot be spent twice. The [v2 specification](https://github.com/coinbase/x402/blob/main/specs/x402-specification-v2.md) (section 10.1) lists these layers: the nonce, contract-level nonce enforcement, "explicit valid time windows," and signature verification.

That is not the same as "x402 has no secrets." The agent's **wallet private key** signs every payment, and if it leaks, the whole balance is exposed. Treat it like any other key. The practical difference is that you can cap the damage by funding the agent wallet with only what you are willing to lose, which our guide to [paying for APIs from an agent](/blog/pay-for-apis-from-an-ai-agent) covers along with client-side spend limits.

## Where API keys still win

x402 is not a drop-in replacement for every keyed API. Be honest about the costs:

- **Steady, high-volume traffic to one provider.** A key costs a lookup per call. x402 costs a client signature, a facilitator verification, and an on-chain settlement per paid call. If you make many calls a day to one service, a prepaid balance behind a key is simpler and avoids the per-payment overhead. Our [pricing post](/blog/designing-pay-per-call-pricing) works through why per-payment overhead dominates at very small prices.
- **Identity you actually need.** Account-level quotas, usage dashboards, support tickets, contracts, and invoices all assume a known customer. A bare wallet address gives you none of that.
- **Fiat and procurement.** Many organizations can pay an invoice and cannot hold stablecoins. x402 aims to support fiat networks too, but the reference implementations today are on-chain.
- **Refunds and disputes.** The x402 spec defines how a payment is verified and settled, not how it is reversed. With a keyed account, a provider can credit your balance. With x402, a refund is a separate transfer someone has to choose to make. This is why the spec recommends verifying before the handler runs and settling after it, so that a failed call is never charged in the first place (see [the exact scheme](/blog/x402-exact-scheme-evm)).

## Where x402 wins

- **No signup to reach the first call.** An agent can discover an endpoint, read the price from the `402` challenge, decide against its own policy, and pay, without a human creating an account. This is the case API keys handle worst.
- **The price is part of the protocol.** The `PAYMENT-REQUIRED` header states `amount`, `asset`, `network`, and `payTo` in a format any client can parse (see [x402 v2 headers](/blog/x402-v2-headers-payment-signature)). There is no pricing page to scrape and no plan to choose.
- **Sporadic use across many providers.** One wallet can pay many services, so there is no stack of keys and accounts to provision, store, and rotate.
- **Smaller blast radius per request**, as above: a leaked payment is single-use and bounded. Your wallet key still needs care.

## Using both on the same endpoint

x402 v2 doesn't force a choice. The specification's section 10.2 says the protocol "supports integration with authentication systems (e.g., Sign-In with Ethereum - SIWE) to enable authenticated pricing models where verified users receive discounted rates or special access terms." Two extensions in the spec repository make that concrete.

**Standard HTTP auth alongside payment.** The `auth-hints` extension notes that x402 "is fully compatible with existing authentication mechanisms." A `402` response can carry a [`WWW-Authenticate`](https://www.rfc-editor.org/rfc/rfc9110.html#name-www-authenticate) challenge when the resource needs authentication, and the retry then carries both credentials and the payment. The extension's own example uses an OAuth DPoP token:

```http
GET /premium-data HTTP/1.1
Host: api.example.com
Authorization: DPoP <access-token>
DPoP: <proof-jwt>
PAYMENT-SIGNATURE: <base64-encoded-payment-payload>
```

What the extension adds are hints inside the `402` challenge, so a client can tell which `accepts[]` entries require authentication before it picks one, saving a round trip.

**Wallet sign-in instead of a key.** The [`sign-in-with-x`](https://github.com/coinbase/x402/blob/main/specs/extensions/sign-in-with-x.md) extension (SIWX) lets a client "prove control of a wallet address by signing a challenge message, allowing servers to identify returning users and skip payment for addresses that have previously paid." On EVM the message format is [EIP-4361 (Sign-In with Ethereum)](https://eips.ethereum.org/EIPS/eip-4361), and the signed proof travels in a `SIGN-IN-WITH-X` header. The server generates the nonce, and the challenge expires after five minutes by default. In effect, the wallet becomes the identity, and the server can grant access without a key ever being issued.

This also explains the status codes. [RFC 9110](https://www.rfc-editor.org/rfc/rfc9110.html#name-402-payment-required) still says `402` "is reserved for future use," while `401 Unauthorized` means the request "lacks valid authentication credentials" and must come with a `WWW-Authenticate` challenge. x402 puts `402` to work for payment and leaves `401` to authentication. A server can send either, or a `402` that also asks for credentials.

## A short decision guide

- **Your callers are agents meeting your API for the first time, or making occasional calls:** x402.
- **Your callers are a few known customers with steady volume:** API keys, or prepaid balances behind keys.
- **You need both reach and relationships:** accept x402 for anonymous callers, and add SIWX or ordinary auth for returning customers who get different terms.
- **You must reverse charges, invoice in fiat, or meet procurement rules:** keys, an account, and conventional billing, at least for those customers.

Whichever you choose, keep the price the same on every rail so no caller is penalized for picking one.

## What Assay does today

Assay is x402-only. It doesn't issue API keys, and there is no account to create. Prepaid keys are planned, not live. Both paid endpoints, [`/v1/extract`](/docs/extract/) (`$0.003` per successful call) and [`/v1/pdf/text`](/docs/pdf-text/) (`$0.01`), take x402 v2 `exact` payments in USDC on **Base Sepolia testnet** (`eip155:84532`) only. Mainnet isn't enabled, so no real funds move. Assay doesn't implement the SIWX or `auth-hints` extensions, and it ignores an `Authorization` header: a request with one still gets the same `402`.

Without keys, a few things work differently:

- **Rate limits are per IP**, not per key: 30 requests per minute across `/v1/*`, with `429` and `Retry-After` beyond that ([limits](/docs/limits/)).
- **Replay protection is per payment.** A reused authorization (same network, payer, and nonce) gets `409 payment_replayed`.
- **Failed calls are not charged.** Assay verifies the payment, runs the handler, and settles only if the handler returns a status below 400.

The [Payments docs](/docs/payments/) show the full exchange, and the [quickstart](/docs/quickstart/) walks through a paid call with free testnet USDC.

**Related:** [What is x402?](/blog/what-is-x402-http-402) · [How to pay for APIs from an AI agent](/blog/pay-for-apis-from-an-ai-agent) · [Designing pay-per-call pricing](/blog/designing-pay-per-call-pricing) · [Paid tools in MCP servers](/blog/paid-tools-in-mcp-servers)

### Sources
- x402 v2 specification (sections 10.1 and 10.2): https://github.com/coinbase/x402/blob/main/specs/x402-specification-v2.md
- x402 HTTP transport v2: https://github.com/coinbase/x402/blob/main/specs/transports-v2/http.md
- x402 extension `auth-hints`: https://github.com/coinbase/x402/blob/main/specs/extensions/extension-auth-hints.md
- x402 extension `sign-in-with-x`: https://github.com/coinbase/x402/blob/main/specs/extensions/sign-in-with-x.md
- RFC 9110, HTTP Semantics (401, 402, WWW-Authenticate, Authorization): https://www.rfc-editor.org/rfc/rfc9110.html
- RFC 6750, OAuth 2.0 Bearer Token Usage: https://www.rfc-editor.org/rfc/rfc6750.html
- EIP-3009, Transfer With Authorization: https://eips.ethereum.org/EIPS/eip-3009
- ERC-4361, Sign-In with Ethereum: https://eips.ethereum.org/EIPS/eip-4361
- GitHub Docs, About secret scanning: https://docs.github.com/en/code-security/secret-scanning/introduction/about-secret-scanning

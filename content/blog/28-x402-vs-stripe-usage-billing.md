---
title: "x402 vs Stripe Usage Billing: Micropayments Per Request vs Metered Invoices"
description: "Stripe usage-based billing meters usage and invoices in arrears. x402 settles a signed USDC payment on each request. Compare onboarding, when money moves, identity, agent fit, refunds, and fiat procurement — plus where Stripe's own x402 docs fit."
slug: x402-vs-stripe-usage-billing
date: 2026-11-03
keywords: [x402 vs stripe usage billing, usage-based billing API, Stripe metered billing vs micropayments, pay per call USDC, agent API billing, HTTP 402 vs invoice billing]
---

# x402 vs Stripe usage billing: micropayments per request vs metered invoices

**x402 vs Stripe usage billing** is a choice about when money moves and who has to exist before the first call. Stripe's usage-based path creates a Customer, attaches a PaymentMethod, opens a Subscription with a metered Price, and reports usage as meter events that land on an invoice at the end of the period. x402 returns [HTTP 402 Payment Required](https://www.rfc-editor.org/rfc/rfc9110.html#name-402-payment-required) with the price on the first request; the client signs a one-shot USDC authorization and retries. The difference is visible above the fold:

```bash
# x402: no Customer, no Subscription. The first response is a price challenge.
curl -s -o /dev/null -w '%{http_code}\n' "{{ORIGIN}}/v1/extract?url=https://example.com"
# → 402

# Stripe usage-based (sketch): Customer + metered Price + Subscription, then report usage.
# New integrations: Stripe recommends Metronome over Billing Meters.
curl https://api.stripe.com/v1/customers -u "$STRIPE_SECRET_KEY:" -d email=agent@example.com
curl https://api.stripe.com/v1/subscriptions -u "$STRIPE_SECRET_KEY:" \
  -d customer=cus_... -d "items[0][price]=price_..."
curl https://api.stripe.com/v1/billing/meter_events -u "$STRIPE_SECRET_KEY:" \
  -d event_name=api_calls -d "payload[stripe_customer_id]=cus_..." -d "payload[value]=1"
# Money moves later, on the invoice — not on this request.
```

This post compares the two models on the axes that matter for API gateways and agents. It is not a replacement for [x402 vs API keys](/blog/x402-vs-api-keys) (credentials and identity) or [designing pay-per-call pricing](/blog/designing-pay-per-call-pricing) (units, floors, failed-call policy). For the protocol itself, see [What is x402?](/blog/what-is-x402-http-402).

## Two clocks: invoice in arrears vs settle per request

Stripe's [usage-based billing](https://docs.stripe.com/billing/usage-based) and the [pay-as-you-go implementation guide](https://docs.stripe.com/billing/subscriptions/usage-based/implementation-guide) describe the same shape: you meter what the customer did, then invoice them for that usage. You [create a billing meter](https://docs.stripe.com/api/billing/meter/create), attach it to a metered Price, put the customer on a Subscription, and [send meter events](https://docs.stripe.com/api/v2/meter-events) as they use the API. Those events are processed asynchronously; they may not show up on an upcoming invoice immediately. Stripe now points **new** usage-based integrations at **Metronome** (real-time visibility, prepaid credits, enterprise contracts) and keeps **Billing Meters** for existing integrations. Either way, the commercial unit is still an invoice in fiat, charged to a saved payment method.

x402's [`exact` scheme](https://docs.x402.org/schemes/exact) advertises one amount; the buyer signs for that amount; a facilitator verifies and settles on-chain for that request ([how x402 works](https://docs.cdp.coinbase.com/x402/core-concepts/how-it-works)). With the default `authorization` flow, verify runs before the handler and settle after — so a failed call need never move funds. There is no billing period and no usage counter waiting for month-end.

| | Stripe usage-based (meters / Metronome) | x402 (`exact` on EVM) |
|---|---|---|
| Before the first paid call | Customer, PaymentMethod, Product/Price, Subscription (or Metronome equivalent) | Funded wallet that can sign for the quoted amount |
| When money moves | Invoice in arrears for aggregated usage | Per request, on-chain USDC settlement via a facilitator |
| What the request carries | Usually an API key or session tied to the Customer | A fresh signed payment authorization |
| Identity | Stripe Customer (email, payment method, tax, invoices) | Wallet address (or none beyond the payer) |
| Unit of commercial record | Invoice line items | On-chain transfer + facilitator receipt |
| Agent that cannot complete card signup | Blocked until a human finishes Checkout / Customer Portal | Can pay if its spend policy allows the `402` price |

## Onboarding and agent fit

Stripe's path assumes a relationship. Someone creates a Customer, collects a card or other PaymentMethod, and starts a Subscription. That is the right model for known B2B accounts, procurement teams that need invoices, and dashboards that show usage by customer. It is a poor fit for an agent that discovered your endpoint a minute ago and has no email, no KYC flow, and no human to click Checkout.

x402 flips that: the `402` challenge is the onboarding. The agent reads `amount`, `asset`, `network`, and `payTo`, decides against its own policy, and pays. The cost is that the caller must hold a funded wallet on the right network, and the seller must accept stablecoin settlement (and facilitator economics) instead of card rails. Our [pricing design post](/blog/designing-pay-per-call-pricing) covers why per-payment overhead matters at sub-cent prices; check current L2 gas and facilitator terms rather than assuming a constant.

For **agent API billing**, the practical test is: can the caller complete payment without a browser and without a previously provisioned Stripe Customer? If the answer must be yes, HTTP 402 with a signed payment beats invoice billing. If the answer is "a human already signed a contract and we bill monthly," Stripe (or any meter-then-invoice system) is the clearer fit.

## Micropayment economics (without inventing fee %)

Do not paste yesterday's Stripe percentage into a design doc. Stripe's pricing pages change; invoice minimums, metered billing fees, and card processing costs depend on your country and product mix. Read the current Stripe pricing pages for your account. The structural point is simpler: **invoice billing amortizes fixed costs across a period**, while **per-request settlement pays a settlement cost on every successful call**. At $0.003-class prices, that structural difference dominates any specific fee table. x402 on an L2 with USDC can make sub-cent charges economically plausible; Stripe usage billing is built for aggregating many events into one collectible invoice, not for charging three tenths of a cent as a standalone card charge.

That is also why "Stripe metered billing vs micropayments" is not a pure substitute comparison. Metered billing *is* usage-based, but the money still moves as an invoice. Micropayments in the x402 sense move value on the request path. Pick the clock you want, then pick the rail.

## Identity, refunds, fiat, and compliance

- **Identity.** Stripe Customers unlock tax IDs, receipts, support, and account-level quotas. A bare x402 payer is a wallet. If you need named accounts, you still need auth (or a planned prepaid key) alongside payment — see [x402 vs API keys](/blog/x402-vs-api-keys).
- **Refunds and disputes.** Stripe can credit an invoice or issue a refund against a PaymentIntent. x402 specifies verify and settle, not reverse; a refund is a separate transfer you choose to make. Prefer charge-on-success so failed work never settles.
- **Fiat and procurement.** Many orgs can pay an invoice and cannot hold USDC. Stripe wins there today. x402 wins where the caller is a wallet-native agent and fiat onboarding is the bottleneck.
- **KYC / compliance.** Card and bank rails come with Stripe's merchant and sanctions stack. On-chain USDC still needs your own screening of payer addresses and treasury receipts; issuer freezes and OFAC lists apply either way.

## Stripe also documents x402 — keep the products distinct

Stripe's [machine payments x402 guide](https://docs.stripe.com/payments/machine/x402) shows a server returning HTTP `402`, settling via a facilitator, then recording the on-chain transfer as a Stripe PaymentIntent (`crypto` + `transaction_verification`). That is Stripe wrapping **x402 settlement** into Stripe's payment ledger — useful if you want Dashboard reconciliation and crypto PaymentIntents. It is **not** the same as Stripe Billing Meters / Metronome usage invoices, and **Assay does not use Stripe's x402 product**. Assay speaks the open x402 protocol directly; Stripe's guide is cited here so you do not confuse "Stripe can record an x402 settle" with "usage billing via meters."

## A short decision guide

- **Sporadic agent calls, no signup, pay per call USDC:** x402.
- **Known customers, monthly invoices, card/ACH, procurement:** Stripe usage-based (Metronome for new builds; Billing Meters if you already run them).
- **High steady volume to one provider in fiat:** metered subscription or prepaid balance behind an account — not a card charge per $0.003 call.
- **You want both reach and relationships:** accept x402 for anonymous agents; keep Stripe (or prepaid keys, when you offer them) for named customers who need invoices.

Keep the **list price per successful call** the same across rails so no caller is punished for the payment method they can actually complete.

## What Assay does today

Assay is **x402-only**. There is no Stripe Customer, no Billing Meter, no Metronome integration, and no live prepaid API keys (planned, not built). Paid endpoints such as [`/v1/extract`](/docs/extract/) (`$0.003`) and [`/v1/pdf/text`](/docs/pdf-text/) (`$0.01`) take x402 v2 `exact` payments in USDC on **Base Sepolia** (`eip155:84532`) only — testnet, so no real funds move. Assay verifies, runs the handler, and settles only on success (status below 400). See [Payments](/docs/payments/), [Pricing](/pricing/), and the [quickstart](/docs/quickstart/).

**Related:** [Designing pay-per-call pricing](/blog/designing-pay-per-call-pricing) · [x402 vs API keys](/blog/x402-vs-api-keys) · [What is x402?](/blog/what-is-x402-http-402) · [x402 exact scheme on EVM](/blog/x402-exact-scheme-evm)

### Sources
- Stripe Docs, Usage-based billing: https://docs.stripe.com/billing/usage-based
- Stripe Docs, Set up a pay-as-you-go pricing model (Billing Meters; Metronome for new integrations): https://docs.stripe.com/billing/subscriptions/usage-based/implementation-guide
- Stripe API, Billing meters create: https://docs.stripe.com/api/billing/meter/create
- Stripe API, Meter events (async processing): https://docs.stripe.com/api/v2/meter-events
- Stripe Docs, x402 (machine payments; PaymentIntent recording): https://docs.stripe.com/payments/machine/x402
- Coinbase CDP, x402 how it works: https://docs.cdp.coinbase.com/x402/core-concepts/how-it-works
- x402 Docs, Exact scheme: https://docs.x402.org/schemes/exact
- RFC 9110, HTTP Semantics (402 Payment Required): https://www.rfc-editor.org/rfc/rfc9110.html#name-402-payment-required

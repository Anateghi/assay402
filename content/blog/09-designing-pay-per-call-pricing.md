---
title: "Designing Pay-Per-Call Pricing for APIs That Agents Use"
description: "How to price API calls in fractions of a cent: cost floors, units, failed-call policy, x402 versus prepaid keys, and the stablecoin details that affect your margins."
slug: designing-pay-per-call-pricing
date: 2026-10-16
keywords: [API pricing per call, micropayments API, stablecoin API billing, x402 vs API keys, usage-based pricing]
---

# Designing pay-per-call pricing for APIs that agents use

Agents are unusual customers. They don't read pricing pages for fun, they don't negotiate, and they may call your API ten thousand times or once. Pay-per-call pricing fits them well, but only if the price is easy to predict, cheap to settle, and fair when things fail. These are the principles we used for Assay.

## 1. Start from a cost floor, not a competitor's page
For each endpoint, write down the **marginal cost per call**:

- compute (CPU-seconds or GPU-seconds × your hourly rate),
- egress bandwidth,
- upstream costs (zero for open data, which is the point),
- cache hit rate (a cached SEC filing costs almost nothing to serve again),
- **settlement cost** per payment (see section 4).

Price is then roughly `max(floor × margin, perceived value)`. Value-added processing on open data, such as clean extraction, normalized filings, or entity resolution, saves the buyer engineering time. Raw data doesn't, and it is free elsewhere anyway.

## 2. Pick a unit the model can reason about
Agents plan better with **flat per-call prices** than with formulas.

| Endpoint type | Unit | Why |
|---|---|---|
| Extraction, lookup, resolve | per call | Predictable and comparable |
| PDF | per page | Cost scales with pages, and page count is known up front |
| Embeddings | per 1k input tokens | Matches the cost driver, and token count is computable client-side |

When a variable unit is unavoidable, give the agent a free `estimate` endpoint and put the maximum charge in the 402 requirements. With x402's `exact` scheme the amount is fixed per request, so the price has to be known before the work is done. The x402 docs describe an `upto` scheme for usage-based amounts ([docs](https://docs.x402.org/core-concepts/http-402)). Check which networks and facilitators support it before you design around it.

## 3. Charge for success only
This policy matters more for trust than the price level does:

- **Validate before charging:** malformed inputs, robots-disallowed URLs, and encrypted PDFs get a `4xx` with no payment requested, or no settlement.
- **Verify, work, then settle:** with x402, the server can call the facilitator's verify step, do the work, and then settle. If the work fails, don't settle, because the payer's authorization expires unused (`validBefore`).
- **Document the edge cases:** a successfully extracted but empty page is a success. A timeout is a failure. Write these rules down.

## 4. Settlement math
On x402 with USDC:

- **Amounts are in atomic units** (USDC has 6 decimals), so the smallest expressible charge is $0.000001.
- **Gas** on an L2 such as Base is typically a small fraction of a cent, but it varies with network load. Check current fees on a block explorer such as [basescan](https://basescan.org/gastracker) and don't assume a constant.
- **Facilitator fees:** hosted facilitators may have free tiers and per-transaction fees above them. Read the current [CDP x402 pricing](https://docs.cdp.coinbase.com/x402/welcome) or the terms of whichever facilitator you use.
- **Per-payment overhead dominates at tiny prices.** If a settlement costs a meaningful fraction of a $0.001 call, either raise the price, sell prepaid bundles, or use a scheme that batches settlement.

This is why we offer **two rails**:

| | x402 per call | Prepaid API key |
|---|---|---|
| Signup | none | email or wallet top-up |
| Best for | discovery, sporadic agent calls | steady workloads |
| Per-call overhead | one signed authorization + settlement | a ledger decrement |
| Latency | extra round trip on first call | none |

The price per call is the same on both rails, so no one is penalized for choosing either.

## 5. Make the price machine-readable everywhere
- In the **402 response**: `amount`, `asset`, `network`, and `payTo`, as x402 requires.
- In **tool descriptions** for MCP servers ("Costs $0.003 per successful call").
- In an **OpenAPI** extension or a public `/pricing.json`, so directories and agents can compare.
- In **response headers** on keyed calls, e.g. `X-Cost-USD: 0.003` and `X-Balance-USD: 4.217`, so agents can track their budgets.

## 6. Don't do these
- **Surprise prices.** Changing a price without notice breaks agents that hard-coded budgets. Version your price list and announce changes in advance.
- **Prices that depend on the caller.** Agents can't negotiate, and inconsistent quotes look like fraud.
- **Minimums disguised as per-call pricing.** If there is a minimum top-up, say so.
- **Charging for retries caused by your own errors.**

## 7. Stablecoin realities
- **Issuer controls:** USDC can be frozen by its issuer under [Circle's terms](https://www.circle.com/legal/usdc-terms). Sweep receipts to a treasury address regularly.
- **Sanctions:** screen payer addresses. The US Treasury publishes the [OFAC SDN list](https://ofac.treasury.gov/specially-designated-nationals-and-blocked-persons-list-sdn-human-readable-lists), which includes digital currency addresses.
- **Accounting:** each settlement is an on-chain transfer with a transaction hash. Record it next to the request ID so refunds and audits are straightforward.

## 8. Measure, then adjust
Track per endpoint: calls, distinct payers, success rate, cache hit rate, cost per call, and revenue per call. Change one price at a time and watch distinct payers, not only revenue. Early on, repeat payers tell you whether the endpoint is actually useful.

## Our launch prices
Assay launches with flat prices per endpoint (`$0.003` for extract, `$0.01` for PDF text), published at [`/pricing`](/pricing/) and [`/pricing.json`](/pricing.json), with no charge on failed calls. Payments run on Base Sepolia testnet for now; when prepaid API keys ship they will carry the same prices. We will publish real usage data after the first month, not projections.

### Sources
- x402 docs (HTTP 402, schemes): https://docs.x402.org/core-concepts/http-402
- x402 v2 spec: https://github.com/coinbase/x402/blob/main/specs/x402-specification-v2.md
- Coinbase CDP x402: https://docs.cdp.coinbase.com/x402/welcome
- Circle USDC terms: https://www.circle.com/legal/usdc-terms
- OFAC SDN list: https://ofac.treasury.gov/specially-designated-nationals-and-blocked-persons-list-sdn-human-readable-lists

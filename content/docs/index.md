---
title: "Assay docs"
description: "Pay-per-call endpoints for AI agents: web page to markdown and PDF to text, paid per call with x402 v2 on Base Sepolia testnet."
order: 1
nav: "Overview"
---

# Assay docs

Assay sells small, useful operations to AI agents, one HTTP call at a time. There is no signup and no API key: your agent asks for a resource, gets a `402 Payment Required` with a price, signs a USDC authorization, and retries.

> **Note:** Assay currently runs on **Base Sepolia testnet only** (`eip155:84532`). Payments use free test USDC and the public facilitator at `https://x402.org/facilitator`. Nothing here moves real money yet.

## What you can call

| Endpoint | What it does | Price |
|---|---|---|
| [`GET /v1/extract`](/docs/extract/) | Web page → clean markdown + JSON metadata | `$0.003 / call` |
| [`POST /v1/pdf/text`](/docs/pdf-text/) | PDF (URL or upload) → plain text per page | `$0.01 / call` |

## How payment works, in one paragraph

You are charged only when a call succeeds. Assay verifies your payment with the facilitator first, runs the handler, and settles on-chain only if the response is a success (HTTP status below 400). If the page is blocked by robots.txt, the PDF is encrypted, or anything else fails, the payment is never settled and your authorization simply expires. Each authorization works once: replays get `409`. Read [payments](/docs/payments/) for the full exchange.

## Machine-readable entry points

- [`/llms.txt`](/llms.txt): an index of these docs for LLMs
- [`/openapi.json`](/openapi.json): OpenAPI 3.1
- [`/pricing.json`](/pricing.json) and [`/.well-known/x402`](/.well-known/x402): prices, network, and pay-to address
- Every docs page and blog post has a markdown twin: add `.md` to the path, e.g. [`/docs/extract.md`](/docs/extract.md)

Next: [quickstart](/docs/quickstart/).

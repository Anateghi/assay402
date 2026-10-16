---
title: "Rate limits and errors"
description: "Assay's rate limits, concurrency caps, error format, and charge policy."
order: 6
nav: "Limits and errors"
---

# Rate limits and errors

## Limits

- **Per IP:** 30 requests per minute across `/v1/*` (token bucket). Over the limit you get `429` with `Retry-After`.
- **Concurrency:** heavy routes share a small global cap. When it is full you get `503 busy` with `Retry-After: 2`.
- **Sizes:** pages up to 5 MB, PDFs up to 10 MB and 200 pages, markdown output capped at 200,000 characters.

These limits are in-memory on a single instance during the MVP, so they reset on deploy.

## Error format

```json
{ "error": "robots_disallowed", "message": "robots.txt disallows assay-fetch for this path (Disallow: /private/)", "charged": false }
```

## Charge policy

You pay only for a successful response. Assay settles your payment after the handler returns a status below 400, and never otherwise. Any error listed on an endpoint page means your authorization was not settled.

> **Note:** for a call that succeeded but returned something useless to you, open an issue on [GitHub](https://github.com/Anateghi/assay402/issues). On testnet this is about feedback, not money.

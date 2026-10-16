---
title: "GET /v1/extract: web page to markdown"
description: "Turn any public web page into clean markdown plus JSON metadata (title, byline, canonical, links). $0.003 per successful call via x402."
order: 4
nav: "/v1/extract"
specimen: "SPECIMEN 01 · /v1/extract"
---

# GET /v1/extract

## What it does

Fetches a public web page as `assay-fetch`, checks robots.txt first, pulls out the main content with Mozilla Readability, and converts it to markdown. You get the markdown plus structured metadata: title, byline, published date, language, canonical URL, and outbound links. Results are cached for one hour.

It does not run JavaScript, so pages that render their content client-side may come back thin.

## Price

`$0.003 / call`, charged only when the call succeeds. Same price for cached results.

## Request

| Parameter | Required | Description |
|---|---|---|
| `url` | yes | Absolute `http(s)` URL, ports 80/443 only, public hosts only |
| `format` | no | `json` (default) or `markdown` for a `text/markdown` body |

**curl** (shows the 402 challenge):

```bash
curl -i "{{ORIGIN}}/v1/extract?url=https://www.rfc-editor.org/rfc/rfc9309"
```

**TypeScript** with `@x402/fetch`:

```ts
import { wrapFetchWithPaymentFromConfig } from "@x402/fetch";
import { ExactEvmScheme } from "@x402/evm";
import { privateKeyToAccount } from "viem/accounts";

const payFetch = wrapFetchWithPaymentFromConfig(fetch, {
  schemes: [{ network: "eip155:84532", client: new ExactEvmScheme(privateKeyToAccount(process.env.TESTNET_KEY as `0x${string}`)) }],
});
const url = "https://www.rfc-editor.org/rfc/rfc9309";
const res = await payFetch(`{{ORIGIN}}/v1/extract?url=${encodeURIComponent(url)}`);
console.log((await res.json()).markdown.slice(0, 500));
```

**Python** (the x402 Python SDK, `pip install x402`, wraps `httpx`/`requests`; check its README for the current API). Without a wallet you can still read the challenge:

```python
import base64, json, httpx
r = httpx.get("{{ORIGIN}}/v1/extract", params={"url": "https://example.com"})
assert r.status_code == 402
print(json.loads(base64.b64decode(r.headers["PAYMENT-REQUIRED"]))["accepts"][0])
```

## Response

```json
{
  "url": "https://www.rfc-editor.org/rfc/rfc9309",
  "source_url": "https://www.rfc-editor.org/rfc/rfc9309",
  "canonical": "https://www.rfc-editor.org/rfc/rfc9309",
  "title": "RFC 9309: Robots Exclusion Protocol",
  "byline": null,
  "published": null,
  "lang": "en",
  "excerpt": "…",
  "markdown": "# RFC 9309: Robots Exclusion Protocol\n\n…",
  "links": [{ "text": "RFC 9110", "href": "https://www.rfc-editor.org/rfc/rfc9110" }],
  "word_count": 4210,
  "truncated": false,
  "fetched_at": "2026-10-16T18:00:00.000Z",
  "robots": { "allowed": true, "rule": null },
  "cached": false
}
```

The field set is exact; the values above are shortened for illustration. `markdown` is capped at 200,000 characters (`truncated: true` when cut).

## Errors and limits

| Status | `error` | Charged |
|---|---|---|
| 400 | `invalid_url`, `blocked_host` | no (no payment requested) |
| 402 | payment required / invalid payment | no |
| 409 | `payment_replayed` | no |
| 413 | `too_large` (page over 5 MB) | no |
| 415 | `unsupported_content_type` (not HTML) | no |
| 422 | `empty_content` | no |
| 429 | `rate_limited` (see `Retry-After`) | no |
| 451 | `robots_disallowed` | no |
| 502 | `fetch_failed`, `upstream_status`, `dns_failed` | no |
| 503 | `busy` | no |

Every error body looks like `{ "error": "robots_disallowed", "message": "…", "charged": false }`.

> **Note:** Assay refuses private, loopback, and link-local addresses, checks every redirect hop, and follows at most 5 redirects.

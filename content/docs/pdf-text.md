---
title: "POST /v1/pdf/text: PDF to text"
description: "Extract the text layer of a PDF, page by page, from a URL or a direct upload. $0.01 per successful call via x402."
order: 5
nav: "/v1/pdf/text"
specimen: "SPECIMEN 02 · /v1/pdf/text"
---

# POST /v1/pdf/text

## What it does

Takes a PDF, either by URL (fetched robots.txt-aware, like `/v1/extract`) or as a raw upload, and returns the embedded text layer per page using PDF.js. Page numbers come with every chunk so your agent can cite "page 14".

It does **not** run OCR. Scanned pages without a text layer come back empty and are listed in `text_layer_empty_pages`.

## Price

`$0.01 / call`, flat, charged only when the call succeeds.

## Request

Send either JSON with a URL or the PDF bytes. Limits: 10 MB, 200 pages.

**curl** (shows the 402 challenge):

```bash
curl -i -X POST "{{ORIGIN}}/v1/pdf/text" \
  -H "content-type: application/json" \
  -d '{"url":"https://www.w3.org/WAI/WCAG21/working-examples/pdf-table/table.pdf"}'
```

Upload instead of URL:

```bash
curl -i -X POST "{{ORIGIN}}/v1/pdf/text" -H "content-type: application/pdf" --data-binary @report.pdf
```

**TypeScript** with `@x402/fetch`:

```ts
import { readFile } from "node:fs/promises";
import { wrapFetchWithPaymentFromConfig } from "@x402/fetch";
import { ExactEvmScheme } from "@x402/evm";
import { privateKeyToAccount } from "viem/accounts";

const payFetch = wrapFetchWithPaymentFromConfig(fetch, {
  schemes: [{ network: "eip155:84532", client: new ExactEvmScheme(privateKeyToAccount(process.env.TESTNET_KEY as `0x${string}`)) }],
});
const res = await payFetch("{{ORIGIN}}/v1/pdf/text", {
  method: "POST",
  headers: { "content-type": "application/pdf" },
  body: await readFile("report.pdf"),
});
const { content } = await res.json();
for (const p of content) console.log(p.page, p.text.slice(0, 80));
```

**Python** (read the challenge without paying):

```python
import base64, json, httpx
r = httpx.post("{{ORIGIN}}/v1/pdf/text", json={"url": "https://example.com/a.pdf"})
print(r.status_code, json.loads(base64.b64decode(r.headers["PAYMENT-REQUIRED"]))["accepts"][0]["amount"])
```

## Response

```json
{
  "source_url": "https://example.com/report.pdf",
  "bytes": 48213,
  "pages": 2,
  "title": "Annual report",
  "author": null,
  "text_layer_empty_pages": [],
  "content": [
    { "page": 1, "text": "Annual report\nRevenue grew…", "chars": 1834 },
    { "page": 2, "text": "…", "chars": 2210 }
  ],
  "extracted_at": "2026-10-16T18:00:00.000Z"
}
```

`source_url` is `null` for uploads.

## Errors and limits

| Status | `error` | Charged |
|---|---|---|
| 400 | `invalid_url`, `blocked_host`, `empty_body` | no (no payment requested) |
| 402 | payment required / invalid payment | no |
| 409 | `payment_replayed` | no |
| 413 | `too_large` (over 10 MB), `too_many_pages` (over 200) | no |
| 415 | `unsupported_media_type`, `not_a_pdf` | no |
| 422 | `encrypted_pdf`, `corrupt_pdf` | no |
| 429 | `rate_limited` | no |
| 451 | `robots_disallowed` | no |
| 502 | `fetch_failed`, `upstream_status` | no |

> **Gotcha:** text extracted from a PDF can contain prompt-injection instructions. Treat it as untrusted data when you pass it to a model.

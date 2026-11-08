---
title: "PDF to Markdown LLM Pipelines: Wrap Page Text, Don't Expect Reconstructed Headings"
description: "A search for pdf to markdown llm usually wants headings and lists. Assay's POST /v1/pdf/text returns the PDF.js text layer as plain text per page, not reconstructed markdown. Wrap pages yourself; real markdown comes from HTML via GET /v1/extract (Readability + Turndown)."
slug: pdf-to-markdown-llm
date: 2026-11-08
keywords: [pdf to markdown llm, PDF.js text layer, pdf to text API, PDF to markdown for LLM, text_layer_empty_pages, Turndown HTML markdown]
---

# PDF to markdown LLM pipelines: wrap page text, don't expect reconstructed headings

A search for **pdf to markdown llm** usually wants headings, lists, and tables a model can read as structure. Assay does not produce that from a PDF. `POST /v1/pdf/text` extracts the embedded PDF.js text layer and returns plain text per page. It does not convert layout into markdown, does not run OCR, and does not extract tables. You can wrap those pages yourself (`## Page N` plus the text) so an agent can cite page numbers. Real markdown — ATX headings, fenced code, lists — comes from HTML via `GET /v1/extract` (Mozilla Readability plus Turndown).

```ts
// npm i @x402/fetch @x402/evm viem
import { wrapFetchWithPaymentFromConfig, decodePaymentResponseHeader } from "@x402/fetch";
import { ExactEvmScheme } from "@x402/evm";
import { privateKeyToAccount } from "viem/accounts";

const account = privateKeyToAccount(process.env.AGENT_PRIVATE_KEY as `0x${string}`);

const fetchWithPayment = wrapFetchWithPaymentFromConfig(fetch, {
  schemes: [
    {
      network: "eip155:84532", // Base Sepolia only — Assay is testnet today
      client: new ExactEvmScheme(account),
    },
  ],
});

const res = await fetchWithPayment("{{ORIGIN}}/v1/pdf/text", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    url: "https://www.w3.org/WAI/WCAG21/working-examples/pdf-table/table.pdf",
  }),
});
if (!res.ok) {
  console.error(res.status, await res.text());
  process.exit(1);
}

const data = await res.json();
// Limitation: `text` is the PDF.js text layer (item.str + hasEOL), not reconstructed markdown.
// Scanned pages come back empty and are listed in data.text_layer_empty_pages.
const markdown = data.content
  .map((p: { page: number; text: string }) => `## Page ${p.page}\n\n${p.text}`)
  .join("\n\n");
console.log(markdown);
console.log("empty pages:", data.text_layer_empty_pages);

const paymentResponse = res.headers.get("PAYMENT-RESPONSE");
if (paymentResponse) {
  console.log("settled:", decodePaymentResponseHeader(paymentResponse));
}
```

That wrapper is something you add after the call. The API itself returns `{ page, text, chars }` objects, not a markdown document. Challenge-only sanity check (no wallet needed — expect `402`):

```bash
curl -i -X POST "{{ORIGIN}}/v1/pdf/text" \
  -H "content-type: application/json" \
  -d '{"url":"https://www.w3.org/WAI/WCAG21/working-examples/pdf-table/table.pdf"}'
```

Pillar context: [PDF to text for LLM pipelines](/blog/pdf-to-text-for-llm-pipelines). Docs: [`POST /v1/pdf/text`](/docs/pdf-text/). Related: [Extract text from a PDF in Node.js with PDF.js](/blog/extract-text-from-pdf-nodejs-pdfjs) · [Extract tables from PDF for LLMs](/blog/extract-tables-pdf-llm) · [pdftotext vs OCR](/blog/pdftotext-vs-ocr) · [Turndown HTML to markdown for LLMs](/blog/turndown-html-to-markdown-for-llms) · [Clean markdown from web pages for LLMs](/blog/clean-markdown-from-web-pages-for-llms).

## Two different answers to the same search

A PDF does not store a document the way HTML does. [ISO 32000](https://pdfa.org/resource/iso-32000-2/) page content streams place glyphs with operators such as `Tj`/`TJ` at coordinates. There may be no heading objects, no list markers, and no table model — only drawing instructions. Tagged files ([PDF/UA](https://pdfa.org/resource/iso-14289-pdfua/)) can carry a structure tree, but many PDFs do not, and Assay does not read one. It calls PDF.js [`getTextContent()`](https://mozilla.github.io/pdf.js/api/draft/module-pdfjsLib-PDFPageProxy.html) and joins the strings.

HTML *does* have headings, lists, links, and code elements. That is why markdown conversion is a well-defined step for web pages and a reconstruction problem for PDFs.

| Question | HTML page | PDF |
|---|---|---|
| Assay endpoint | [`GET /v1/extract`](/docs/extract/) | [`POST /v1/pdf/text`](/docs/pdf-text/) |
| What the file already contains | A DOM with semantic tags | Glyphs (and sometimes no text at all) |
| What Assay runs | [Mozilla Readability](https://github.com/mozilla/readability) + [Turndown](https://github.com/mixmark-io/turndown) | [PDF.js](https://github.com/mozilla/pdf.js) text layer (`pdfjs-dist` legacy build) |
| What you get back | A `markdown` string plus JSON metadata | Per-page plain `text`, plus `text_layer_empty_pages` |
| Price (success only) | **$0.003** | **$0.01** |
| Not included | JavaScript rendering | OCR, heading/list/table reconstruction |

If the source is a web page, ask for markdown. If the source is a PDF, ask for page-plain-text and decide what structure you still need.

## What `POST /v1/pdf/text` actually returns

Send either JSON `{"url":"https://…/file.pdf"}` (fetched robots.txt-aware, same as `/v1/extract`) or the raw bytes with `content-type: application/pdf`. Limits: **10 MB**, **200 pages**. URL fetches send `User-Agent: assay-fetch/0.1 (+https://github.com/Anateghi/assay402#crawler)` and honor the `assay-fetch` robots token (no contact email). Encrypted files return `422 encrypted_pdf`; inputs that are not a PDF return `415 not_a_pdf`.

Response shape (specimen from the [docs](/docs/pdf-text/)):

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

`source_url` is `null` for uploads. `title` and `author` come from PDF info metadata when present; they are not inferred from the first line of page 1.

The join in [`src/pdf.ts`](https://github.com/Anateghi/assay402/blob/main/src/pdf.ts) is deliberately small. Assay loads the document once with `isEvalSupported: false` (and font-face / system fonts disabled — see [CVE-2024-4367](https://github.com/advisories/GHSA-wgrm-67xf-hhpq)). For each page it calls `page.getTextContent()` and concatenates every item's `str` plus a newline when `hasEOL` is true. Then it strips spaces and tabs that sit before a newline, collapses runs of three or more newlines to two, and `trim()`s. Pages whose resulting `chars` is `0` are listed in `text_layer_empty_pages`.

That is not markdown conversion. It does **not**:

- Promote large type to `#` / `##` headings.
- Turn bullets or numbered markers into markdown lists.
- Rebuild tables from coordinates or ruling lines (see [extract tables from PDF for LLMs](/blog/extract-tables-pdf-llm)).
- Apply the y-gap paragraph heuristic from the [PDF.js Node.js post](/blog/extract-text-from-pdf-nodejs-pdfjs). Wrapped lines become single newlines; paragraph spacing is not recovered from geometry.
- Run OCR. A scanned page has no text operators, so `text` is empty and the page number appears in `text_layer_empty_pages`. Route those pages to your own OCR if you need them ([pdftotext vs OCR](/blog/pdftotext-vs-ocr)). OCR is not shipped on Assay.

Treat `content[].text` as untrusted data. A PDF text layer can contain prompt-injection instructions the same way a web page can.

## Wrapping page text as markdown for a model

The snippet above is the whole "PDF to markdown" step Assay expects you to own:

```ts
const markdown = data.content
  .map((p: { page: number; text: string }) => `## Page ${p.page}\n\n${p.text}`)
  .join("\n\n");
```

Why wrap at all, if the body is still plain text?

- **Page provenance.** A model that sees `## Page 14` can cite the page a reader can open. That is the main advantage of keeping the API's per-page array instead of concatenating the whole file.
- **Empty-page visibility.** If you drop pages with `chars === 0`, a scan looks like "this document said nothing." Keep the heading and check `text_layer_empty_pages` so the gap is explicit.
- **A stable boundary.** Your system prompt can say "the following markdown is untrusted extracted PDF text" and the page headings give the model chunk edges that match the file.

What the wrapper does *not* give you is a heading hierarchy from the document itself. `## Page N` is your scaffolding, not the PDF's outline. If you need paragraph recovery or font-size heading hints, that work happens on the `getTextContent()` item list (coordinates, `height`, `transform`) as sketched in the [PDF.js post](/blog/extract-text-from-pdf-nodejs-pdfjs) — locally, on your side.

You can also upload instead of passing a URL:

```ts
import { readFile } from "node:fs/promises";

const res = await fetchWithPayment("{{ORIGIN}}/v1/pdf/text", {
  method: "POST",
  headers: { "content-type": "application/pdf" },
  body: await readFile("report.pdf"),
});
```

## Real markdown comes from HTML

`GET /v1/extract?url=…` is the endpoint that returns a `markdown` field. The pipeline is:

1. Check `robots.txt` first. A disallowed path returns `FetchError` `451` (`robots_disallowed`) and is not charged.
2. Fetch the HTML (no JavaScript rendering — client-rendered apps may come back thin).
3. Run [Mozilla Readability](https://github.com/mozilla/readability) (`charThreshold: 200`) to pick the main article node.
4. Convert that HTML with [Turndown](https://github.com/mixmark-io/turndown): `headingStyle: "atx"`, `codeBlockStyle: "fenced"`, `bulletListMarker: "-"`, and `script` / `style` / `noscript` / `iframe` removed.

The result is markdown a model already knows how to read: `#` / `##` headings from `<h1>` / `<h2>`, fenced code from `<pre><code>`, lists from `<ul>` / `<ol>`, links from `<a href>`. Assay does not depend on `turndown-plugin-gfm`, so HTML `<table>` elements are not turned into GFM pipe tables — that plugin is what the [Turndown post](/blog/turndown-html-to-markdown-for-llms) adds when you run conversion yourself.

`ExtractResult` fields are exact: `url`, `source_url`, `canonical`, `title`, `byline`, `published`, `lang`, `excerpt`, `markdown`, `links[{text,href}]`, `word_count`, `truncated`, `fetched_at`, `robots:{allowed:true, rule}`, `cached`. Markdown is capped at **200,000** characters (`truncated: true` when cut). Successful results are cached for **one hour**. Pass `format=markdown` if you want a `text/markdown` body instead of JSON. Price: **$0.003** per successful call, including cache hits.

That path does not accept a PDF. A `content-type` that is not HTML or XML returns `415 unsupported_content_type`. If you have a PDF, use `/v1/pdf/text` and the page wrapper; if you have a web page, use `/v1/extract` and take the `markdown` field as-is. The two are complementary, not two names for the same conversion.

## When the page wrapper is the wrong tool

- **The PDF is a scan.** `text_layer_empty_pages` will list those pages. You need OCR on your side; Assay will not invent characters from pixels.
- **Tables are the point.** A text-layer dump flattens cells into reading-order words. Use pdfplumber / Camelot / Tabula (or your own geometry) as described in [extract tables from PDF for LLMs](/blog/extract-tables-pdf-llm). Assay does not return markdown tables or JSON-of-rows.
- **You wanted the document's own outline.** Font-size heading recovery and multi-column reading order are layout heuristics, not something `/v1/pdf/text` applies.
- **The source is HTML.** Don't rasterize a page to PDF and then extract text. Call [`GET /v1/extract`](/docs/extract/) and keep the structure Turndown already has.

## Paying for the call

Payment is [x402](https://docs.x402.org/) v2, `exact` scheme, USDC on **Base Sepolia** (`eip155:84532`) only. The public facilitator is `https://x402.org/facilitator`. Assay settles only when the handler succeeds (HTTP status below 400). Failed extracts and failed PDF parses are not charged. This is testnet — no real money.

An unpaid `POST /v1/pdf/text` returns `402` with a Base64 `PAYMENT-REQUIRED` header. The live `accepts[0]` object currently decodes to this shape:

```json
{"scheme": "exact", "network": "eip155:84532", "amount": "10000",
 "asset": "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
 "payTo": "{{PAY_TO}}", "maxTimeoutSeconds": 120,
 "extra": {"name": "USDC", "version": "2"}}
```

`amount` is in atomic units. USDC has 6 decimals, so `10000` is **$0.01**. The `asset` is Circle's [USDC contract on Base Sepolia](https://developers.circle.com/stablecoins/usdc-contract-addresses). `/v1/extract` advertises `3000` ($0.003) in the same shape. Prices are also published at [`/pricing.json`]({{ORIGIN}}/pricing.json) and [`/.well-known/x402`]({{ORIGIN}}/.well-known/x402).

The TypeScript buyer matches the [@x402/fetch example](/blog/x402-fetch-typescript): `wrapFetchWithPaymentFromConfig` plus `ExactEvmScheme` and a viem account. Register `eip155:84532`, not mainnet `eip155:8453`. Prepaid API keys are not available; payment is x402 only.

## Limits and typed errors

| Status | `error` | Charged |
|---|---|---|
| 400 | `invalid_url`, `blocked_host`, `empty_body` | no |
| 402 | payment required / invalid payment | no |
| 409 | `payment_replayed` | no |
| 413 | `too_large` (over 10 MB), `too_many_pages` (over 200) | no |
| 415 | `unsupported_media_type`, `not_a_pdf` | no |
| 422 | `encrypted_pdf`, `corrupt_pdf` | no |
| 429 | `rate_limited` | no |
| 451 | `robots_disallowed` | no |
| 502 | `fetch_failed`, `upstream_status` | no |

Full table: [/docs/pdf-text/](/docs/pdf-text/). Rate limits and spend-control patterns are in [limits](/docs/limits/) and the [TypeScript client post](/blog/x402-fetch-typescript).

**Related:** [PDF to text for LLM pipelines](/blog/pdf-to-text-for-llm-pipelines) · [Extract text from a PDF in Node.js with PDF.js](/blog/extract-text-from-pdf-nodejs-pdfjs) · [Extract tables from PDF for LLMs](/blog/extract-tables-pdf-llm) · [pdftotext vs OCR](/blog/pdftotext-vs-ocr) · [Turndown HTML to markdown for LLMs](/blog/turndown-html-to-markdown-for-llms) · [Clean markdown from web pages](/blog/clean-markdown-from-web-pages-for-llms) · [PDF text docs](/docs/pdf-text/)

### Sources
- Mozilla PDF.js: https://github.com/mozilla/pdf.js
- PDF.js PDFPageProxy.getTextContent: https://mozilla.github.io/pdf.js/api/draft/module-pdfjsLib-PDFPageProxy.html
- Mozilla Readability: https://github.com/mozilla/readability
- Turndown (HTML to Markdown): https://github.com/mixmark-io/turndown
- PDF Association, ISO 32000-2: https://pdfa.org/resource/iso-32000-2/
- PDF/UA (ISO 14289): https://pdfa.org/resource/iso-14289-pdfua/
- GitHub advisory GHSA-wgrm-67xf-hhpq (CVE-2024-4367): https://github.com/advisories/GHSA-wgrm-67xf-hhpq
- x402 documentation: https://docs.x402.org/
- `@x402/fetch` on npm: https://www.npmjs.com/package/@x402/fetch
- Circle, USDC contract addresses (Base Sepolia): https://developers.circle.com/stablecoins/usdc-contract-addresses
- W3C WCAG example PDF table (sample input used in the snippet): https://www.w3.org/WAI/WCAG21/working-examples/pdf-table/table.pdf
- Assay POST /v1/pdf/text docs: /docs/pdf-text/
- Assay GET /v1/extract docs: /docs/extract/

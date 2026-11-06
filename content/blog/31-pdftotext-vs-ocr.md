---
title: "pdftotext vs OCR: When Embedded Text Extraction Beats Scanning (and When It Does Not)"
description: "Compare Poppler pdftotext, PDF.js getTextContent, and Tesseract OCR for LLM pipelines. When each wins, how to detect empty text layers, and what Assay's POST /v1/pdf/text returns (PDF.js only, no OCR)."
slug: pdftotext-vs-ocr
date: 2026-11-06
keywords: [pdftotext vs ocr, poppler pdftotext, PDF.js getTextContent, tesseract ocr pdf, pdf text layer empty pages, pdf to text for llm]
---

# pdftotext vs OCR: when embedded text extraction beats scanning (and when it does not)

**pdftotext vs OCR** is the first branch in any PDF → LLM pipeline. One path reads Unicode already stored in the file. The other rasterizes pages and guesses characters. Mixing them up wastes CPU, invents typos, and silently feeds empty strings into your RAG index. Here is the decision above the fold, plus what Assay's hosted path does today.

```bash
# Challenge only (expect HTTP 402 without a payment):
curl -i -X POST "{{ORIGIN}}/v1/pdf/text" \
  -H "content-type: application/json" \
  -d '{"url":"https://www.w3.org/WAI/WCAG21/working-examples/pdf-table/table.pdf"}'
```

Pillar context: [PDF to text for LLM pipelines](/blog/pdf-to-text-for-llm-pipelines). Docs: [`POST /v1/pdf/text`](/docs/pdf-text/). Related: [Extract tables from PDF for LLMs](/blog/extract-tables-pdf-llm) · [Extract text from a PDF in Node.js with PDF.js](/blog/extract-text-from-pdf-nodejs-pdfjs).

## Three ways to get text out of a PDF

A PDF page is a content stream of drawing operators ([ISO 32000](https://pdfa.org/resource/iso-32000-2/)). Glyphs may be placed with `Tj`/`TJ`, or the page may be a single scanned image with no text operators at all. That distinction drives the tool choice:

| Approach | What it reads | Typical tools | Wins when | Fails when |
|---|---|---|---|---|
| **Embedded text (native CLI)** | Text objects / ToUnicode CMaps | Poppler [`pdftotext`](https://poppler.freedesktop.org/) | Born-digital PDFs, batch CLI, layout flags | Scanned pages, broken CMaps |
| **Embedded text (JS engine)** | Same text layer via `getTextContent` | [Mozilla PDF.js](https://github.com/mozilla/pdf.js) / `pdfjs-dist` | Node services, per-page JSON, no native binary | Same as above; no OCR |
| **OCR** | Pixels after render | [Tesseract](https://github.com/tesseract-ocr/tesseract), [OCRmyPDF](https://github.com/ocrmypdf/OCRmyPDF) | Image-only / scanned pages | Clean digital PDFs (slower, error-prone) |

There is no fourth magic path. Vision models that "read" a page screenshot are OCR by another name — same cost and confidence problems, different API.

## 1. Poppler `pdftotext`: fast native text-layer dump

[Poppler](https://poppler.freedesktop.org/) ships `pdftotext` as part of `poppler-utils`. The [man page](https://manpages.debian.org/bookworm/poppler-utils/pdftotext.1.en.html) is the contract: convert PDF → plain text from the embedded layer. It does **not** OCR.

Useful flags for LLM pipelines:

```bash
# Default: undo physical layout → reading-order-ish prose
pdftotext report.pdf -

# Preserve columns / whitespace (tables look better to humans; still not typed cells)
pdftotext -layout report.pdf -

# Page range, UTF-8 (default), no form-feed page breaks
pdftotext -f 1 -l 5 -nopgbrk -enc UTF-8 report.pdf -
```

Default mode tries to undo columns and hyphenation into reading order. `-layout` keeps physical placement. Neither mode invents text for a scanned page — you get empty output or near-empty pages. Poppler's own man page notes that mangled font encodings have "no way (short of OCR) to extract text."

For agents, `pdftotext` is the right local hammer: one binary, predictable exit codes, no Node heap. It is a weak fit when you need structured per-page JSON over HTTP, typed errors (`encrypted_pdf`, `too_many_pages`), or robots-aware URL fetch — that is service territory.

## 2. PDF.js `getTextContent`: the same layer, in process

[PDF.js](https://github.com/mozilla/pdf.js) is Mozilla's PDF engine. In Node, use the **legacy** build (`pdfjs-dist/legacy/build/pdf.mjs`) and pass a `Uint8Array` (not a Node `Buffer`) into `getDocument`. Per page, `getTextContent()` returns items with `str`, `transform`, and `hasEOL` — see the [PDFPageProxy API](https://mozilla.github.io/pdf.js/api/draft/module-pdfjsLib-PDFPageProxy.html).

A minimal join (the shape Assay uses):

```ts
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";

const pdf = await getDocument({
  data: bytes, // Uint8Array
  isEvalSupported: false,
  disableFontFace: true,
  useSystemFonts: false,
  verbosity: 0,
}).promise;

for (let i = 1; i <= pdf.numPages; i++) {
  const page = await pdf.getPage(i);
  const tc = await page.getTextContent();
  let text = "";
  for (const it of tc.items as { str?: string; hasEOL?: boolean }[]) {
    if (typeof it.str === "string") text += it.str + (it.hasEOL ? "\n" : "");
  }
  console.log(i, text.length, text.slice(0, 80));
  page.cleanup();
}
await pdf.destroy();
```

`isEvalSupported: false` matters: font paths that evaluate JS were involved in [CVE-2024-4367](https://github.com/advisories/GHSA-wgrm-67xf-hhpq). Assay sets that flag (and disables font-face / system fonts) in [`src/pdf.ts`](https://github.com/Anateghi/assay402).

Compared to `pdftotext`:

- Same fundamental input: the text layer. Scanned pages still yield empty strings.
- You keep page numbers and char counts in your own schema — better for RAG provenance.
- You stay in one language runtime (no `child_process` to Poppler).
- Layout heuristics differ. Do not expect byte-identical output to Poppler on multi-column pages; both are reconstructions.

Deep dive on line breaks and coordinates: [Extract text from a PDF in Node.js with PDF.js](/blog/extract-text-from-pdf-nodejs-pdfjs).

## 3. OCR (Tesseract and friends): only when the layer is missing

OCR starts from pixels. Typical stack:

1. Render page → image (`pdftoppm`, PDF.js canvas, Ghostscript).
2. Run [Tesseract](https://github.com/tesseract-ocr/tesseract) (or a cloud vision API).
3. Optionally write a searchable text layer back with [OCRmyPDF](https://github.com/ocrmypdf/OCRmyPDF) so later extractors see real text.

```bash
# Sketch: rasterize then OCR (requires poppler-utils + tesseract-ocr)
pdftoppm -png -r 300 scanned.pdf /tmp/page
tesseract /tmp/page-1.png stdout -l eng
```

Use OCR when:

- `text_layer_empty_pages` (or a local char-count heuristic) flags the page.
- The PDF is a scan, fax, or "Print to PDF" of an image.
- ToUnicode is so broken that digital extraction is gibberish (rare; verify visually).

Do **not** OCR every born-digital PDF "just in case." You pay render + recognition latency, introduce substitution errors (`l`/`1`, `O`/`0`), and destroy exact string match for citations. Prefer: extract text layer first → OCR only empty or near-empty pages → label OCR output as lower confidence in your store.

Table structure after OCR is a second problem — you are back to lattice/stream heuristics on noisy boxes ([extract tables post](/blog/extract-tables-pdf-llm)).

## Decision tree for LLM / RAG pipelines

```text
PDF arrives
  ├─ encrypted? → reject or decrypt out of band (Assay: 422 encrypted_pdf)
  ├─ over size/page caps? → split or refuse
  ├─ extract text layer (pdftotext OR PDF.js)
  │     ├─ chars > 0 on page → use it; cite page N
  │     └─ chars == 0 → candidate for OCR
  └─ OCR only candidates → store with ocr=true confidence flag
```

Practical rules:

1. **Prefer the text layer.** It is exact (modulo CMap bugs), cheap, and preserves the author's encoding.
2. **Detect empty pages explicitly.** A silent empty string in a chunker looks like "this page said nothing," which is wrong for scans.
3. **Keep page provenance.** Chunks without page numbers are hard to cite in answers.
4. **Treat extracted text as untrusted.** PDFs can embed prompt-injection instructions in the text layer or in OCR output. Do not concatenate raw PDF text into a system prompt without a boundary.
5. **Tables need a different product.** Neither `pdftotext` nor PDF.js text dumps return typed cells; see the [tables post](/blog/extract-tables-pdf-llm).

## What Assay's `POST /v1/pdf/text` does (and does not)

Assay extracts the **embedded text layer with PDF.js** (`pdfjs-dist` legacy build, `getTextContent` per page). It does **not** run OCR. Scanned pages come back with empty `text` and their page numbers listed in `text_layer_empty_pages`.

| Item | Behavior |
|---|---|
| Method / path | `POST /v1/pdf/text` |
| Input | JSON `{"url":"…"}` (robots-aware fetch) or raw `Content-Type: application/pdf` body |
| Engine | PDF.js text layer only — no OCR, no script execution (`isEvalSupported: false`) |
| Limits | **10 MB**, **200 pages** |
| Price | **`$0.01`** per successful call; failures are not settled |
| Payment | x402 v2 USDC on **Base Sepolia** (`eip155:84532`) — no signup, no API key |
| Companion | [`GET /v1/extract`](/docs/extract/) at **`$0.003`** for HTML → markdown/JSON |

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

`source_url` is `null` for uploads. Errors you should handle: `too_large`, `too_many_pages`, `encrypted_pdf`, `corrupt_pdf`, `not_a_pdf`, `robots_disallowed`, plus the usual payment / rate-limit codes. Full table: [/docs/pdf-text/](/docs/pdf-text/).

Typical agent flow with Assay:

1. Call `/v1/pdf/text` for page-level text and `text_layer_empty_pages`.
2. If empty pages matter, OCR those pages locally (Tesseract / OCRmyPDF / vision) and merge by page number.
3. For tables, run pdfplumber / Camelot / Tabula on the original file — Assay does not reconstruct cells today.

```ts
import { wrapFetchWithPaymentFromConfig } from "@x402/fetch";
import { ExactEvmScheme } from "@x402/evm";
import { privateKeyToAccount } from "viem/accounts";

const payFetch = wrapFetchWithPaymentFromConfig(fetch, {
  schemes: [{
    network: "eip155:84532",
    client: new ExactEvmScheme(privateKeyToAccount(process.env.TESTNET_KEY as `0x${string}`)),
  }],
});

const res = await payFetch("{{ORIGIN}}/v1/pdf/text", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    url: "https://www.w3.org/WAI/WCAG21/working-examples/pdf-table/table.pdf",
  }),
});
const data = await res.json();
console.log(data.pages, data.text_layer_empty_pages);
for (const p of data.content) {
  // Treat p.text as untrusted before it enters a model context
  console.log(p.page, p.chars);
}
```

## Quick chooser

| Your constraint | Reach for |
|---|---|
| Local batch, digital PDFs, shell scripts | Poppler `pdftotext` (`-layout` if columns matter visually) |
| Node service, per-page JSON, no native deps | PDF.js / Assay `/v1/pdf/text` |
| Scanned or image-only pages | OCR (Tesseract / OCRmyPDF), only on empty pages |
| Typed table cells for RAG | pdfplumber / Camelot / Tabula — not plain text dumps |
| Hosted pay-per-call, robots-aware URL fetch | Assay `/v1/pdf/text` ($0.01, x402 on Base Sepolia) |

**pdftotext vs OCR** is not a rivalry — they solve different failure modes of the same format. Read the layer when it exists. Rasterize only when it does not. Wire `text_layer_empty_pages` (or your own char heuristic) so the handoff is automatic instead of tribal knowledge.

**Related:** [PDF to text for LLM pipelines](/blog/pdf-to-text-for-llm-pipelines) · [Extract text from a PDF in Node.js with PDF.js](/blog/extract-text-from-pdf-nodejs-pdfjs) · [Extract tables from PDF for LLMs](/blog/extract-tables-pdf-llm) · [PDF text docs](/docs/pdf-text/) · [SSRF protection for agent fetch tools](/blog/ssrf-protection-for-ai-agent-fetch-tools)

### Sources
- Poppler project: https://poppler.freedesktop.org/
- pdftotext(1) Debian man page: https://manpages.debian.org/bookworm/poppler-utils/pdftotext.1.en.html
- Mozilla PDF.js: https://github.com/mozilla/pdf.js
- PDF.js PDFPageProxy.getTextContent: https://mozilla.github.io/pdf.js/api/draft/module-pdfjsLib-PDFPageProxy.html
- PDF.js Node getinfo example: https://github.com/mozilla/pdf.js/blob/master/examples/node/getinfo.mjs
- Tesseract OCR: https://github.com/tesseract-ocr/tesseract
- OCRmyPDF: https://github.com/ocrmypdf/OCRmyPDF
- PDF Association, ISO 32000-2: https://pdfa.org/resource/iso-32000-2/
- GitHub advisory GHSA-wgrm-67xf-hhpq (CVE-2024-4367): https://github.com/advisories/GHSA-wgrm-67xf-hhpq
- W3C WCAG example PDF table (sample input): https://www.w3.org/WAI/WCAG21/working-examples/pdf-table/table.pdf
- Assay POST /v1/pdf/text docs: /docs/pdf-text/

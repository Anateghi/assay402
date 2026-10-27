---
title: "Extract Text from a PDF in Node.js with PDF.js (pdfjs-dist): Line Breaks, Paragraphs, and Failure Modes"
description: "How to extract text from a PDF in Node.js with pdfjs-dist: a working example, why you need the legacy build and a Uint8Array, what hasEOL does and doesn't tell you, rebuilding paragraphs from coordinates, detecting scanned pages, typed errors for encrypted and broken files, and the isEvalSupported setting behind CVE-2024-4367."
slug: extract-text-from-pdf-nodejs-pdfjs
date: 2026-10-27
keywords: [extract text from pdf nodejs, pdfjs-dist getTextContent, pdf.js text extraction, pdfjs-dist legacy build node, pdf to text for LLM, isEvalSupported CVE-2024-4367]
---

# Extract text from a PDF in Node.js with PDF.js: line breaks, paragraphs, and failure modes

[PDF.js](https://github.com/mozilla/pdf.js) is Mozilla's PDF engine, and its npm package `pdfjs-dist` is a dependable way to **extract text from a PDF in Node.js** without shelling out to a native binary. Here is a minimal, working script:

```ts
// npm i pdfjs-dist   (run with: npx tsx extract.mts file.pdf)
import { readFile } from "node:fs/promises";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";

const bytes = new Uint8Array(await readFile(process.argv[2])); // Uint8Array, not Buffer
const pdf = await getDocument({ data: bytes, isEvalSupported: false, verbosity: 0 }).promise;

for (let n = 1; n <= pdf.numPages; n++) {
  const page = await pdf.getPage(n);
  const { items } = await page.getTextContent();
  let text = "";
  for (const item of items) {
    if (!("str" in item)) continue;               // skip marked-content markers
    text += item.str + (item.hasEOL ? "\n" : "");
  }
  console.log(`--- page ${n} ---\n${text.trim()}`);
  page.cleanup();
}
await pdf.destroy();
```

Everything below was checked by running it against `pdfjs-dist` 4.10.38 on Node.js 20, using small test PDFs we generated with LibreOffice (a two-page document with a heading, paragraphs and a table, a four-page text document, and a page that holds only an image). On the two-page test file, the script printed:

```text
--- page 1 ---
Quarterly Report
This is the first paragraph of a test document. It is long enough that it should wrap across more than one
line in the rendered PDF output, which lets us see how line ends are reported by the text layer.
Name Value
alpha 1.5
beta 2.25
Second paragraph after the table.
--- page 2 ---
Page two text.
```

The words are all there and in reading order, but the breaks between paragraphs are gone. That's the main thing to fix before the text goes to a model, and there's a section on it below. First, three setup details that trip people up.

## Use the legacy build in Node.js

`pdfjs-dist` ships two builds. The default `pdfjs-dist/build/pdf.mjs` targets current browsers. Importing it in Node.js worked in our test, but loading a document logged `Warning: Please use the legacy build in Node.js environments.` Import from `pdfjs-dist/legacy/build/pdf.mjs` instead, as in the example. It's built for older and non-browser JavaScript environments, and the warning itself is PDF.js telling you it's the one to use in Node.js.

## Pass a `Uint8Array`, and pass a copy

Two errors we hit while loading data:

- **A Node.js `Buffer` is refused.** `getDocument({ data: buf })` with the `Buffer` from `readFile` rejected with `Please provide binary data as Uint8Array, rather than Buffer.` Wrap it: `new Uint8Array(buf)`.
- **The array is transferred, so you can't reuse it.** After the first `getDocument` call, our `Uint8Array` had a `length` of 0, because its memory had been handed to the PDF.js worker. Calling `getDocument` again with the same array failed with `Unable to deserialize cloned data.` If you need the bytes afterwards (to hash them, store them, or retry), pass `new Uint8Array(bytes)`, which is a copy.

## What `getTextContent()` returns

Each page gives you `items` and `styles`. A text item has `str`, `dir`, `width`, `height`, `transform`, `fontName` and `hasEOL`. The `transform` is a 6-number matrix, and `transform[4]` and `transform[5]` are the x and y position of the text in PDF units (points, with y growing **upward** from the bottom of the page). For unrotated text, `height` is close to the font size: 24 for our heading and 12 for body text.

Three things to know when you join items into text:

- **Line ends are their own items.** In our files, each line break showed up as an item with `str: ""` and `hasEOL: true`, so a loop that only appends `str` runs every line together. Append `"\n"` when `hasEOL` is true, as the example does.
- **Spaces can be separate items.** Table cells came back as `"Name"`, `" "`, `"Value"`, with the space as an item of its own (and a `height` of 0). Don't add your own space between items, or you'll get double spaces.
- **Marked content is opt-in.** With `getTextContent({ includeMarkedContent: true })` the list also contains items like `{ type: "beginMarkedContentProps" }` and `{ type: "endMarkedContent" }` that come from the PDF's structure tags. They have no `str`, which is why the example checks `"str" in item`. That check keeps the loop correct whichever option you use.

## Rebuilding paragraphs from coordinates

`hasEOL` marks the end of every line, including lines that end only because the text wrapped. Nothing in the item list says "this is a new paragraph". The y positions do, though. In our four-page test file, lines inside a paragraph were 13.8 points apart, and the gap between paragraphs was 28 points. A simple rule, "start a new paragraph when the gap is much larger than the line's font size", recovers the structure:

```ts
import type { TextItem } from "pdfjs-dist/types/src/display/api";

function pageText(items: TextItem[]) {
  const lines: { y: number; h: number; text: string }[] = [];
  let cur = "", y = NaN, h = 0;
  for (const it of items) {
    if (cur === "" && it.str !== "") { y = it.transform[5]; h = it.height; }
    cur += it.str;
    if (it.hasEOL) { if (cur.trim()) lines.push({ y, h, text: cur.trim() }); cur = ""; }
  }
  if (cur.trim()) lines.push({ y, h, text: cur.trim() });

  let out = lines[0]?.text ?? "";
  for (let i = 1; i < lines.length; i++) {
    const gap = lines[i - 1].y - lines[i].y;      // y grows upward
    out += (gap > 1.6 * lines[i].h ? "\n\n" : "\n") + lines[i].text;
  }
  return out;
}
// usage: pageText(items.filter((i): i is TextItem => "str" in i))
```

On the test files this put a blank line after the heading and between every paragraph, and kept wrapped lines together. It's a heuristic, and it has limits you should know about:

- **Table rows are spaced like paragraphs.** Our table's rows came out separated by blank lines, because cell padding makes the row gap larger than normal line spacing. PDF has no table object. If tables matter, you need a layout-aware extractor; plain text extraction won't give you rows and columns back.
- **The 1.6 factor is tuned to normal body text.** Documents with large line spacing need a higher factor, and dense documents a lower one. Measure a few pages from your real sources before relying on it.
- **It assumes one column of horizontal text.** Multi-column layouts, rotated pages, and text whose `transform` includes rotation need sorting by x as well as y, which is more work than this sketch does.

## Scanned pages have no text to extract

A page that is only an image returns an empty `items` array, and `pdftotext` (from Poppler) gave us nothing for it either. PDF.js reads the text layer that's already in the file; it doesn't do OCR. Check each page's character count, and send the empty ones to an OCR step such as Tesseract. Empty pages are also the most common reason a "PDF to text" pipeline quietly returns less than the user expected, so report them rather than dropping them.

## Typed errors for encrypted and broken files

`getDocument(...).promise` rejects with named errors you can map to clear responses:

| Input | Error `name` | Notes |
|---|---|---|
| Password-protected, no password given | `PasswordException` | `code` is 1 (`PasswordResponses.NEED_PASSWORD`). A wrong password gives code 2 (`INCORRECT_PASSWORD`). Passing `password` in the `getDocument` options opened our test file. |
| Starts with `%PDF` but the structure is garbage | `InvalidPDFException` | Message `Invalid PDF structure.` |

Checking the first four bytes for `%PDF` before you call `getDocument` lets you reject HTML error pages and other non-PDF responses early, with a clearer message.

`getMetadata()` returns an `info` object with fields such as `Title`, `Author`, `Producer` and `CreationDate` (as a PDF date string, like `D:20261027090259+03'30'`). Any of them can be missing, so treat them as optional.

## Set `isEvalSupported: false`

PDF.js uses `eval`-style code generation to speed up some font rendering, and the `isEvalSupported` option controls it. Its documented default is `true`. In 2024 that path turned out to be exploitable: [CVE-2024-4367](https://github.com/advisories/GHSA-wgrm-67xf-hhpq) let a malicious PDF run arbitrary JavaScript when `isEvalSupported` was `true`. It affects `pdfjs-dist` up to 4.1.392 and was fixed in 4.2.67, and the advisory's workaround is to set `isEvalSupported: false`. Upgrade, **and** set the option anyway when you process PDFs from people you don't trust. It costs nothing for text extraction.

Two more limits worth setting when the input is untrusted: a maximum file size before you parse, and a maximum page count (check `pdf.numPages` before the loop). Call `page.cleanup()` after each page and `pdf.destroy()` in a `finally` block so a failure halfway through doesn't keep the document in memory.

## What Assay does today

Assay's [`POST /v1/pdf/text`](/docs/pdf-text/) endpoint (0.01 USDC per successful call, paid with x402 on **Base Sepolia testnet** only) uses this approach. It loads the PDF with the `pdfjs-dist` legacy build and `isEvalSupported: false`, checks the `%PDF` header first, accepts up to 10 MB and 200 pages, and returns the text of each page with its page number. Encrypted, corrupt, and non-PDF inputs come back as typed errors (`encrypted_pdf`, `corrupt_pdf`, `not_a_pdf`). Pages with no text layer are listed in `text_layer_empty_pages`, so you can route them to OCR. It does **not** do OCR or table reconstruction, and it doesn't yet apply the paragraph heuristic from this post: lines are joined with single newlines. When you fetch by URL, it checks robots.txt first. The [quickstart](/docs/quickstart/) walks through a first paid call with free testnet USDC.

**Related:** [PDF to text for LLM pipelines](/blog/pdf-to-text-for-llm-pipelines) · [Extract article text with Mozilla Readability](/blog/extract-article-text-mozilla-readability) · [Turndown HTML to markdown for LLMs](/blog/turndown-html-to-markdown-for-llms) · [Responsible extraction](/blog/responsible-extraction-robots-txt-licenses)

### Sources
- PDF.js repository and examples: https://github.com/mozilla/pdf.js
- `pdfjs-dist` API options (`isEvalSupported`, `password`, `verbosity`), from the package's `types/src/display/api.d.ts`: https://github.com/mozilla/pdf.js/blob/master/src/display/api.js
- GitHub advisory GHSA-wgrm-67xf-hhpq (CVE-2024-4367): https://github.com/advisories/GHSA-wgrm-67xf-hhpq
- PDF.js fix removing `eval` from font rendering: https://github.com/mozilla/pdf.js/pull/18015
- PDF 2.0 specification (ISO 32000-2), via the PDF Association: https://pdfa.org/resource/iso-32000-2/
- Tesseract OCR: https://github.com/tesseract-ocr/tesseract

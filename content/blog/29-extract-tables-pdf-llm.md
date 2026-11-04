---
title: "Extract Tables from PDF for LLMs: Lattice vs Stream, Markdown vs JSON, and Why Text Dumps Flatten Cells"
description: "How to extract tables from PDFs for LLM and RAG pipelines: why text-layer dumps flatten cells, lattice vs stream strategies (pdfplumber, Camelot, Tabula), markdown vs JSON-of-rows, page provenance, OCR limits, and what Assay's /v1/pdf/text returns today."
slug: extract-tables-pdf-llm
date: 2026-11-04
keywords: [extract tables pdf llm, pdf table extraction for RAG, pdfplumber extract_tables, camelot lattice stream, pdf table to markdown json, PDF.js table coordinates]
---

# Extract tables from PDF for LLMs: lattice vs stream, markdown vs JSON, and why text dumps flatten cells

**Extract tables PDF LLM** pipelines fail in a predictable way: you dump the text layer, feed it to a model, and the cells become a bag of tokens. A PDF does not store a table object the way HTML stores `<table>` — [ISO 32000](https://pdfa.org/resource/iso-32000-2/) page content streams place glyphs at coordinates. Unless the file is tagged ([PDF/UA](https://pdfa.org/resource/iso-14289-pdfua/)), "rows" and "columns" are reconstructed by layout heuristics. Here is the failure mode above the fold, on a three-column ruled table we generated with ReportLab and read with Poppler and PDF.js:

```bash
# Poppler without -layout: cells run together on each line (no column structure).
pdftotext simple-table.pdf -
# → Name Value Unit
# → alpha 1.5 kg
# → beta 2.25 kg

# Poppler with -layout: whitespace columns are preserved (still not typed cells).
pdftotext -layout simple-table.pdf -
# →                     Name               Value   Unit
# →                     alpha              1.5     kg
# →                     beta               2.25    kg
```

That is useful for humans reading a terminal. It is not a table for an LLM. For RAG you want either a markdown table the model can read as structure, or a JSON array of rows you can cite and filter. This post covers how to get there, which open-source tools to reach for, and what Assay does (and does not) return today.

Pillar context: [PDF to text for LLM pipelines](/blog/pdf-to-text-for-llm-pipelines). Node text-layer details: [Extract text from a PDF in Node.js with PDF.js](/blog/extract-text-from-pdf-nodejs-pdfjs).

## Why a plain text dump flattens cells

PDF.js `getTextContent()` (and Assay's join of `item.str` + `hasEOL`) returns reading-order strings. On the same sample file:

```text
# Assay-style / PDF.js flatten (verified against pdfjs-dist legacy build)
Quarterly Report
Sample metrics for extraction demos.
Name Value Unit
alpha 1.5 kg
beta 2.25 kg
gamma 0.75 kg
```

The words are correct and in order. There is no column boundary, no header/body distinction, and no way for a chunker to know that `1.5` belongs under `Value` rather than next to `alpha` as prose. Post 21 already noted that table row gaps look like paragraph gaps when you rebuild lines from y-coordinates alone. **If tables matter, plain text extraction is the wrong final format.**

## Two families of reconstruction: ruled vs whitespace

Open-source table extractors mostly descend from the same idea as [Tabula](https://tabula.technology/) (and Anssi Nurminen's thesis): find vertical and horizontal separators, intersect them into cells, assign text into those cells.

| Strategy | Signal | Typical tools | Best on |
|---|---|---|---|
| **Lattice / lines** | Drawn rules, rectangle edges | pdfplumber `"lines"`, Camelot `flavor="lattice"`, Tabula lattice | Spreadsheet-style tables with visible borders |
| **Stream / text** | Aligned whitespace / word columns | pdfplumber `"text"`, Camelot `flavor="stream"` / `"network"`, Tabula stream | Borderless financial and scientific tables |

### pdfplumber (Python)

[pdfplumber](https://github.com/jsvine/pdfplumber) exposes character and line geometry from pdfminer.six and ships `Page.extract_tables()`. Defaults use the page's vertical and horizontal lines (`"vertical_strategy": "lines"`, `"horizontal_strategy": "lines"`). For borderless tables, switch both axes to `"text"`. On our ruled sample:

```python
# pip install pdfplumber
import pdfplumber

with pdfplumber.open("simple-table.pdf") as pdf:
    page = pdf.pages[0]
    # Default: line/rectangle edges as cell separators (lattice-like).
    rows = page.extract_tables()[0]
    # → [['Name', 'Value', 'Unit'],
    #    ['alpha', '1.5', 'kg'],
    #    ['beta', '2.25', 'kg'],
    #    ['gamma', '0.75', 'kg']]

    # Borderless pages: infer separators from word alignment instead.
    rows = page.extract_tables({
        "vertical_strategy": "text",
        "horizontal_strategy": "text",
    })[0]
```

That list-of-rows output is what you want before you serialize for a model. Merged header cells (common in accessibility demos and annual reports) still need cleanup — pdfplumber returns `None` for empty geometric cells — so always inspect `find_tables()` / `debug_tablefinder()` on a few real pages before you batch.

### Camelot and Tabula

[Camelot](https://camelot-py.readthedocs.io/en/latest/user/how-it-works.html) names the same split explicitly: `flavor="lattice"` (default) looks for demarcated lines (rasterized via an image backend, optionally combined with native vector rules); `flavor="stream"` groups words into rows by y-overlap and guesses column x-ranges from whitespace. Newer flavors (`network`, `hybrid`, optional `ml`) extend the borderless path; use the docs for your installed version rather than assuming one flavor wins everywhere.

```python
import camelot

tables = camelot.read_pdf("report.pdf", flavor="lattice", pages="1-3")
df = tables[0].df  # pandas DataFrame of cell text
# Borderless:
tables = camelot.read_pdf("report.pdf", flavor="stream", pages="all")
```

[tabula-py](https://tabula-py.readthedocs.io/en/latest/) wraps the Java [tabula-java](https://github.com/tabulapdf/tabula-java) library (`tabula.read_pdf(...)` → DataFrames). Same lattice/stream intuition; it needs a JRE. Prefer one stack end-to-end rather than mixing Camelot and Tabula on the same page without comparing outputs.

## Markdown vs JSON-of-rows for LLM / RAG

Once you have `list[list[str]]`, pick a serialization by how the model will use it:

```python
def to_markdown(rows: list[list[str | None]]) -> str:
    clean = [[("" if c is None else str(c).replace("\n", " ").strip()) for c in r] for r in rows]
    header, body = clean[0], clean[1:]
    sep = "|".join("---" for _ in header)
    lines = ["|" + "|".join(header) + "|", "|" + sep + "|"]
    lines += ["|" + "|".join(r) + "|" for r in body]
    return "\n".join(lines)

def to_records(rows: list[list[str | None]]) -> list[dict[str, str]]:
    header = [str(h or f"col_{i}") for i, h in enumerate(rows[0])]
    return [
        {header[i]: ("" if c is None else str(c).strip()) for i, c in enumerate(r)}
        for r in rows[1:]
    ]
```

| Format | Strength | Weakness |
|---|---|---|
| **Markdown table** | Models read it well in-context; cheap to paste into prompts | Breaks on colspan/rowspan; wide tables explode token count |
| **JSON array of row objects** | Stable for tools, filters, and citations; easy to chunk one row | More tokens than tight markdown for the same cells |
| **CSV** | Compact | Ambiguous quoting; weaker structure signal for LLMs than markdown fences |

Keep **page provenance** on every chunk. A good unit looks like:

```json
{
  "page": 1,
  "type": "table",
  "bbox": [72.0, 500.0, 540.0, 640.0],
  "rows": [
    {"Name": "alpha", "Value": "1.5", "Unit": "kg"},
    {"Name": "beta", "Value": "2.25", "Unit": "kg"}
  ]
}
```

When a model says "page 1, beta is 2.25 kg", a human can open the PDF and check. Flattened prose loses that audit trail.

## Sketch: clustering PDF.js items into rough columns

If you stay in Node and only need a coarse grid (not production table extraction), group `getTextContent()` items by rounded y, then sort by x within each band. Verified on the same sample with Assay's `pdfjs-dist` legacy import:

```ts
// Conceptual sketch — not a replacement for pdfplumber/Camelot on messy pages.
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";

const pdf = await getDocument({ data: bytes, isEvalSupported: false, verbosity: 0 }).promise;
const { items } = await (await pdf.getPage(1)).getTextContent();
const bands = new Map<number, { x: number; str: string }[]>();
for (const it of items as { str?: string; transform: number[] }[]) {
  if (typeof it.str !== "string" || !it.str.trim()) continue;
  const y = Math.round(it.transform[5]!); // PDF y grows upward
  const row = bands.get(y) ?? [];
  row.push({ x: it.transform[4]!, str: it.str });
  bands.set(y, row);
}
for (const y of [...bands.keys()].sort((a, b) => b - a)) {
  console.log(bands.get(y)!.sort((a, b) => a.x - b.x).map((c) => c.str).join(" | "));
}
// → Name |   | Value |   | Unit
// → alpha |   | 1.5 |   | kg
// → beta |   | 2.25 |   | kg
```

Spaces show up as their own items (as post 21 documented), and merged headers, multi-column layouts, and rotated text all break a naive y-bucket. Treat this as a diagnostic, not your production parser.

## When OCR is required

Text-layer tools cannot invent cells that were never encoded as text. Scanned pages, image-only exports, and broken `ToUnicode` CMaps need OCR (for example [Tesseract](https://github.com/tesseract-ocr/tesseract) via [OCRmyPDF](https://github.com/ocrmypdf/OCRmyPDF), or a vision model on hard pages). Run OCR only on pages that fail a character-count heuristic; keep confidence scores; label model-transcribed cells as such so you do not treat hallucinations as spreadsheet facts. Structure recovery after OCR is a second problem — you are back to lattice/stream on noisy boxes.

## Security and sandboxing

PDFs are a hostile input class. Cap bytes and pages, refuse encrypted files unless you have a password, disable JS/font `eval` paths (`isEvalSupported: false` in PDF.js; see [CVE-2024-4367](https://github.com/advisories/GHSA-wgrm-67xf-hhpq)), and run native extractors (Poppler, Camelot's image backend, Tabula's JVM) under CPU/memory/time limits. Extracted cell text can carry prompt-injection instructions — mark it untrusted when it enters an LLM context, same as any other fetched document.

## What Assay does today

Assay's [`POST /v1/pdf/text`](/docs/pdf-text/) extracts the **embedded text layer** with PDF.js (`pdfjs-dist` legacy build, `isEvalSupported: false`). It returns plain text per page with page numbers, plus `text_layer_empty_pages` for pages with no extractable text. Limits: **10 MB**, **200 pages**. Price: **`$0.01` / successful call** over x402 on **Base Sepolia** (`eip155:84532`) testnet only.

It does **not** run OCR, does **not** reconstruct tables, and does **not** return markdown or JSON tables. For real table structure, post-process the PDF yourself (pdfplumber, Camelot, Tabula, or your own geometry) or wait for a future tables endpoint — nothing in the current API implies one. Typical flow: call Assay for page-level text and empty-page detection, then run a local lattice/stream extractor on pages that need structure.

```bash
# Challenge only (expect HTTP 402 without a payment):
curl -i -X POST "{{ORIGIN}}/v1/pdf/text" \
  -H "content-type: application/json" \
  -d '{"url":"https://www.w3.org/WAI/WCAG21/working-examples/pdf-table/table.pdf"}'
```

**Related:** [PDF to text for LLM pipelines](/blog/pdf-to-text-for-llm-pipelines) · [Extract text from a PDF in Node.js with PDF.js](/blog/extract-text-from-pdf-nodejs-pdfjs) · [PDF text docs](/docs/pdf-text/) · [SSRF protection for agent fetch tools](/blog/ssrf-protection-for-ai-agent-fetch-tools)

### Sources
- PDF Association, ISO 32000-2 (PDF 2.0): https://pdfa.org/resource/iso-32000-2/
- PDF/UA (ISO 14289): https://pdfa.org/resource/iso-14289-pdfua/
- Poppler / `pdftotext`: https://poppler.freedesktop.org/
- pdfplumber table extraction (`extract_tables`, strategy settings): https://github.com/jsvine/pdfplumber
- Camelot, How it works (lattice vs stream): https://camelot-py.readthedocs.io/en/latest/user/how-it-works.html
- Camelot quickstart: https://camelot-py.readthedocs.io/en/latest/user/quickstart.html
- Tabula (desktop): https://tabula.technology/
- tabula-py getting started: https://tabula-py.readthedocs.io/en/latest/getting_started.html
- PDF.js: https://github.com/mozilla/pdf.js
- GitHub advisory GHSA-wgrm-67xf-hhpq (CVE-2024-4367): https://github.com/advisories/GHSA-wgrm-67xf-hhpq
- W3C WCAG example PDF table (sample input): https://www.w3.org/WAI/WCAG21/working-examples/pdf-table/table.pdf
- Tesseract: https://github.com/tesseract-ocr/tesseract
- OCRmyPDF: https://github.com/ocrmypdf/OCRmyPDF

---
title: "PDF to Text for LLM Pipelines: What Actually Works"
description: "Why PDFs are hard to extract, how to choose between text-layer extraction and OCR, and how to keep reading order, tables, and page provenance intact for LLMs."
slug: pdf-to-text-for-llm-pipelines
date: 2026-10-16
keywords: [PDF to text API, PDF to markdown for LLM, pdftotext, OCR, extract tables from PDF, RAG documents]
---

# PDF to text for LLM pipelines: what actually works

A PDF does not store a document in the way a word processor does. It stores instructions for drawing glyphs at coordinates on a page. There may be no "paragraphs" and no "reading order" in the file, and sometimes no text at all, only an image of text. Every extraction tool is reconstructing structure from those drawing instructions. Understanding this tells you which tool to use for which job.

## What is in a PDF
Per the PDF specification ([ISO 32000-2](https://www.iso.org/standard/75839.html); the PDF Association hosts a [free copy of the 2.0 spec](https://pdfa.org/sponsored-standards/)), page content streams contain operators such as `Tj`/`TJ` that show strings in a font at the current text position. Getting text out depends on:

- **A text layer existing.** Scanned documents often have none, and need OCR.
- **The font's mapping to Unicode** (`ToUnicode` CMaps). If it's missing or wrong, you get gibberish even though the page looks fine.
- **Tagged PDF.** Accessible PDFs (e.g. [PDF/UA](https://pdfa.org/resource/iso-14289-pdfua/)) carry a structure tree with real headings, paragraphs, and table cells. When it exists, it is the best source of structure. Many PDFs don't have one.

## Step 1: classify the document
Before extracting, decide which path a document takes:

1. **Born-digital with a good text layer.** Use text extraction. It is fast and cheap.
2. **Born-digital with broken encoding.** Extracted text has a very high ratio of non-dictionary tokens or replacement characters. Use OCR.
3. **Scanned / image-only.** There are no text operators, or very few characters per page. Use OCR.
4. **Mixed.** Classify page by page.

A simple per-page heuristic: extract text, then compute characters per page and the fraction of alphabetic tokens. Pages that fall below the thresholds go to OCR.

## Step 2: text-layer extraction
Good open-source options:

- **Poppler `pdftotext`** ([docs](https://poppler.freedesktop.org/)). It is fast and battle-tested. `-layout` keeps the physical layout, which is good for tables and bad for multi-column prose. Without it, Poppler tries to follow reading order.
- **pdfminer.six** / **pdfplumber** (Python). These give character-level boxes, so you can do your own column and table logic. pdfplumber has [table extraction](https://github.com/jsvine/pdfplumber#extracting-tables) with tunable strategies.
- **PDF.js** ([Mozilla](https://github.com/mozilla/pdf.js)). Use it in JavaScript environments.
- **PyMuPDF**. It is fast with good layout output, but note its **AGPL** license (or a commercial license from Artifex). That matters if you run it inside a hosted service.

```bash
pdftotext -enc UTF-8 report.pdf - | head
pdftotext -layout -f 3 -l 3 report.pdf -   # page 3, layout-preserving
```

## Step 3: OCR when needed
[Tesseract](https://github.com/tesseract-ocr/tesseract) (Apache-2.0) is the standard open-source engine. [OCRmyPDF](https://github.com/ocrmypdf/OCRmyPDF) wraps it and adds a text layer to scanned PDFs. Best practices:

- Rasterize at around 300 DPI. Lower resolutions hurt accuracy noticeably on small fonts.
- Set the right language packs (`-l eng+fra`).
- Deskew and remove noise before OCR.
- Keep the per-word confidence scores and surface low-confidence pages.

Newer vision-language models can transcribe complex layouts well, but they cost much more per page and can *hallucinate* plausible text. For auditable pipelines, run deterministic OCR first and send only the hard pages to a model, labeled as model-generated.

## Step 4: reconstruct structure
- **Reading order in multi-column layouts:** cluster text blocks by x-coordinate into columns, then read top to bottom within each column. Headers and footers that repeat on every page (same text, same position) should be removed.
- **Headings:** infer them from font size and weight relative to the body text's median size.
- **Hyphenation:** join `exam-\nple` when the result is a dictionary word, and keep real hyphens.
- **Tables:** detect ruling lines or aligned whitespace columns. Output them as markdown tables when simple, or as JSON arrays of rows when cells span. Never flatten a table into prose.
- **Footnotes:** move them to the end of the section and keep their markers.

## Step 5: keep provenance
Every chunk you give a model should carry `page` (and ideally a bounding box). When a model cites "page 14", a user can check it. That is the main advantage of a PDF pipeline over pasting text into a prompt.

```json
{ "page": 14, "type": "table", "markdown": "| Year | Revenue |\n|---|---|\n| 2023 | … |" }
```

## Security
PDFs are a common attack surface. Run extraction in a sandbox with CPU, memory, and time limits. Refuse encrypted files unless you have the password, and cap page counts. Never execute embedded JavaScript, and treat embedded files and links as untrusted. Text extracted from a PDF can also contain prompt-injection instructions, so mark it clearly as untrusted data when you pass it to a model.

## The Assay endpoint
`POST /v1/pdf/text` (JSON `{"url": …}` or a raw `application/pdf` upload, up to 10 MB and 200 pages) extracts the embedded text layer with PDF.js (`pdfjs-dist`) and returns plain text per page, with `page` numbers for provenance. It does **not** do OCR or table reconstruction yet: pages with no text layer are listed in `text_layer_empty_pages` so you can route them to your own OCR step. It costs a flat `$0.01 / call` over x402 (currently Base Sepolia testnet), and encrypted, corrupt, or non-PDF inputs return a typed error with no charge. See the [PDF docs](/docs/pdf-text/).

### Sources
- ISO 32000-2 (PDF 2.0): https://www.iso.org/standard/75839.html
- PDF/UA: https://pdfa.org/resource/iso-14289-pdfua/
- Poppler: https://poppler.freedesktop.org/
- pdfplumber: https://github.com/jsvine/pdfplumber
- PDF.js: https://github.com/mozilla/pdf.js
- Tesseract: https://github.com/tesseract-ocr/tesseract
- OCRmyPDF: https://github.com/ocrmypdf/OCRmyPDF
- PyMuPDF license: https://pymupdf.readthedocs.io/en/latest/about.html#license-and-copyright

---
title: "How to Extract Clean Markdown from Web Pages for LLMs"
description: "Why raw HTML wastes context, how readability-style extraction works, how to convert to markdown without losing structure, and the edge cases that break naive scrapers."
slug: clean-markdown-from-web-pages-for-llms
date: 2026-10-16
keywords: [html to markdown for LLM, web page to markdown, readability, content extraction API, llms.txt, RAG preprocessing]
---

# How to extract clean markdown from web pages for LLMs

If you give a model raw HTML, most of what it reads is navigation, inline scripts, tracking attributes, and cookie banners. Markdown keeps what the model actually needs: headings, paragraphs, lists, links, tables, and code. Its syntax is light, and LLMs have seen a lot of it in training. This post walks through a solid extraction pipeline, and the places where it usually breaks.

## Measure, don't guess

Token savings depend on the page, so measure them on your own data. Count tokens for the raw HTML and for your extracted markdown with the same tokenizer (for example [tiktoken](https://github.com/openai/tiktoken) for OpenAI models). The gap is usually large on news and docs sites, and small on pages that are already minimal. Publish your own numbers instead of quoting someone else's.

## The pipeline

```
fetch → decode → (render?) → main-content extraction → clean → HTML→markdown → metadata → chunk
```

### 1. Fetch politely
- Check `robots.txt` first. Its semantics are standardized in [RFC 9309](https://www.rfc-editor.org/rfc/rfc9309). Respect `Disallow` for your user agent.
- Send an honest `User-Agent` with a contact URL.
- Follow redirects with a cap, set timeouts, limit body size, and refuse non-HTML content types (or route them to a PDF extractor; see [PDF to text](/blog/pdf-to-text-for-llm-pipelines)).
- Cache by URL with `ETag`/`Last-Modified` revalidation ([RFC 9111](https://www.rfc-editor.org/rfc/rfc9111)) so you don't refetch pages that haven't changed.

### 2. Decode correctly
Charset bugs lead to garbled text in outputs. Use the `charset` from the `Content-Type` header if present, otherwise the `<meta charset>`, otherwise detect it. The [WHATWG Encoding standard](https://encoding.spec.whatwg.org/) defines the rules browsers follow.

### 3. Decide whether to render JavaScript
Many pages ship their content in the initial HTML. Single-page apps don't. A practical heuristic: if extraction from the static HTML yields fewer than a few hundred characters of body text but the page has a large script bundle, retry in a headless browser (e.g. Playwright). Rendering costs far more, so make it a fallback rather than the default.

### 4. Extract the main content
This is the core step. Mozilla's [Readability](https://github.com/mozilla/readability), the library behind Firefox Reader View, scores DOM nodes by text density, link density, and class/id hints (`article`, `content` vs. `comment`, `sidebar`). It returns the most likely article container. Alternatives include [Trafilatura](https://github.com/adbar/trafilatura) in Python, which also extracts metadata and performs well in published comparisons. Read its [evaluation page](https://trafilatura.readthedocs.io/en/latest/evaluation.html) for the methodology.

```ts
import { JSDOM } from "jsdom";
import { Readability } from "@mozilla/readability";

const dom = new JSDOM(html, { url });
const article = new Readability(dom.window.document).parse();
// article.title, article.content (HTML), article.byline, article.publishedTime
```

Readability is tuned for articles. On docs pages, product pages, and forums it can drop sidebars that actually hold useful content (API parameter tables, for instance). Keep a fallback mode that removes only known boilerplate (`nav`, `header`, `footer`, `aside`, `[role=navigation]`) and keeps everything else.

### 5. Clean
- Turn relative URLs into absolute ones (keep links, since models use them for citations).
- Remove tracking query parameters (`utm_*`, `fbclid`).
- Drop empty elements, decorative images, and `<svg>` blobs.
- Keep `alt` text for images that carry meaning.

### 6. Convert HTML to markdown
[Turndown](https://github.com/mixmark-io/turndown) (JS) with the GFM plugin handles tables and strikethrough. Rules that matter for LLMs:

- **Headings:** preserve the hierarchy. Chunkers and models both rely on it.
- **Tables:** convert simple tables to GFM pipe tables. For tables with `rowspan`/`colspan`, emit HTML or a JSON array instead of a broken pipe table.
- **Code:** keep fenced blocks and carry over the language from `class="language-x"`.
- **Links:** use inline `[text](url)`, or reference-style links for link-heavy pages, which reads cleaner and uses fewer tokens.
- **Whitespace:** collapse runs of blank lines.

```ts
import TurndownService from "turndown";
import { gfm } from "turndown-plugin-gfm";
const td = new TurndownService({ headingStyle: "atx", codeBlockStyle: "fenced" });
td.use(gfm);
const markdown = td.turndown(article.content);
```

### 7. Metadata
Agents need provenance. Extract `title`, `canonical` URL, author, published and modified dates, and language. Sources in order of reliability: JSON-LD (`schema.org/Article`), [Open Graph](https://ogp.me/) tags, `<meta>` tags, then heuristics. Return them as structured fields, not as text mixed into the markdown.

### 8. Chunk (optional)
For retrieval, split on headings first, then on paragraph boundaries within a token budget. Repeat the heading path in each chunk (`# Guide > ## Install`) so a chunk makes sense on its own.

## Edge cases that break naive extractors
- **Cookie and consent walls** that replace the content. Detect them and report it instead of returning the banner text.
- **Paywalls.** Don't bypass them. Return what is publicly visible and flag it as truncated.
- **Infinite scroll and "load more."** Static HTML has only the first page.
- **Content split across pages** (`rel="next"`).
- **Non-English pages.** Readability's heuristics work across languages, but check right-to-left scripts and CJK spacing.
- **Hostile HTML.** Deeply nested DOMs and huge inline data URIs. Enforce limits.

## llms.txt: when the site already did the work
Some sites publish an [`/llms.txt`](https://llmstxt.org/) file that points to markdown versions of their pages. It is a proposal, not a standard, but when it is present it is the cleanest source available. Check for it before you extract.

## The Assay endpoint
`GET /v1/extract?url=…` runs a lean version of this pipeline: a robots.txt-aware fetch (no JavaScript rendering yet), Mozilla Readability with a full-body fallback, markdown via Turndown, and structured metadata. It returns:

```json
{
  "url": "https://…",
  "source_url": "https://…",
  "canonical": "https://…",
  "title": "…",
  "byline": "…",
  "published": "2026-…",
  "lang": "en",
  "excerpt": "…",
  "markdown": "# …",
  "links": [{ "text": "…", "href": "https://…" }],
  "word_count": 1234,
  "truncated": false,
  "fetched_at": "2026-…",
  "robots": { "allowed": true, "rule": null },
  "cached": false
}
```

It costs `$0.003 / call`, paid through x402 (currently Base Sepolia testnet). If the page fails to extract because of a block, a robots disallow, a non-HTML response, or an empty page, you get a typed error and **no charge**: the payment is verified up front but only settled after a successful response. See the [extract docs](/docs/extract/).

### Sources
- RFC 9309 (Robots Exclusion Protocol): https://www.rfc-editor.org/rfc/rfc9309
- RFC 9111 (HTTP Caching): https://www.rfc-editor.org/rfc/rfc9111
- Mozilla Readability: https://github.com/mozilla/readability
- Trafilatura and its evaluation: https://trafilatura.readthedocs.io/en/latest/evaluation.html
- Turndown: https://github.com/mixmark-io/turndown
- llms.txt proposal: https://llmstxt.org/
- WHATWG Encoding: https://encoding.spec.whatwg.org/

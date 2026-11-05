---
title: "Web Page to JSON API: What Agents Need Beyond Bare Markdown"
description: "A web page to JSON API should return title, byline, canonical, links, word_count, robots, and cache flags — not only a markdown string. Field checklist for RAG/tools, Readability + Turndown pipeline notes, and what Assay's GET /v1/extract returns today (format=json)."
slug: web-page-to-json-api
date: 2026-11-05
keywords: [web page to json api, extract article text api, readability api, html to markdown for llm, structured page extraction for RAG, web page metadata json]
---

# Web page to JSON API: what agents need beyond bare markdown

A **web page to JSON API** is what most agents actually want: not a bare markdown dump, but a typed object they can store, cite, and pass to tools. Markdown is the body. The envelope around it — title, byline, canonical URL, outbound links, word count, robots decision, cache hit — is what makes the result usable in RAG indexes and tool schemas. This post walks through the fields that matter, how to shape them for models, and what Assay's [`GET /v1/extract`](/docs/extract/) returns today when `format=json` (the default).

```bash
# Challenge only (expect HTTP 402 without a payment):
curl -i "{{ORIGIN}}/v1/extract?url=https://www.rfc-editor.org/rfc/rfc9309"
# Optional: format=json (default) or format=markdown for a text/markdown body
```

Pillar context: [Clean markdown from web pages for LLMs](/blog/clean-markdown-from-web-pages-for-llms). Pipeline details: [Mozilla Readability](/blog/extract-article-text-mozilla-readability) · [Turndown](/blog/turndown-html-to-markdown-for-llms).

## Why markdown alone is not enough

Markdown is the right *content* format for LLMs: headings, lists, links, and code survive with little markup cost (see the [token measurements on six public pages](/blog/reduce-html-tokens-for-llms)). But an agent that only gets a string cannot answer:

- Which URL did this come from after redirects?
- What is the human title vs. the `<title>` tag noise?
- Who wrote it, and when was it published?
- Which outbound links should I follow or cite?
- Did robots.txt allow this fetch?
- Is this a fresh fetch or a cached copy?

Those answers belong in JSON fields next to the markdown, not stuffed into a prompt preamble the model has to re-parse.

## Field checklist for a useful extract object

A practical schema for agent tooling looks like this. Values below are the shortened specimen from Assay's [extract docs](/docs/extract/) (RFC 9309); treat them as illustration, not a live measurement.

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

| Field | Why an agent needs it |
|---|---|
| `url` / `source_url` | Requested URL vs. final URL after redirects — citation and dedupe keys |
| `canonical` | Prefer this for storage when the page publishes `rel=canonical` |
| `title`, `byline`, `published`, `lang` | Metadata for indexes, filters, and display without re-scraping |
| `excerpt` | Short summary (often meta description or Readability excerpt) for list UIs |
| `markdown` | Main content for the model / chunker |
| `links[]` | Absolute outbound links with anchor text — follow, cite, or strip from text |
| `word_count` | Cheap size signal before you burn context |
| `truncated` | True when markdown hit a size cap — do not treat as complete |
| `fetched_at` | Freshness for cache and revalidation decisions |
| `robots` | Proof the fetch respected robots.txt ([RFC 9309](https://www.rfc-editor.org/rfc/rfc9309)) |
| `cached` | Whether the response came from a server-side cache |

Anything beyond this (DOM screenshots, rendered DOM, OCR, structured tables) is a different product. Keep the contract narrow so clients can depend on it.

## Shaping the JSON for RAG and tools

Once you have the object, do not dump the whole thing into the prompt. Split roles:

```ts
// Pseudocode: one extract → retrieval chunks + tool-safe metadata
type Chunk = {
  id: string;
  text: string;           // markdown section
  source_url: string;
  canonical: string | null;
  title: string | null;
  fetched_at: string;
};

function toChunks(r: ExtractResult): Chunk[] {
  // Split on ATX headings; keep provenance on every chunk.
  const parts = r.markdown.split(/(?=^#{1,3} )/m).filter(Boolean);
  return parts.map((text, i) => ({
    id: `${r.canonical ?? r.source_url}#${i}`,
    text,
    source_url: r.source_url,
    canonical: r.canonical,
    title: r.title,
    fetched_at: r.fetched_at,
  }));
}

// For tool schemas: expose metadata without the full body when the model only needs to decide "fetch more?"
function toolSummary(r: ExtractResult) {
  return {
    title: r.title,
    canonical: r.canonical,
    word_count: r.word_count,
    truncated: r.truncated,
    link_count: r.links.length,
    cached: r.cached,
    robots_allowed: r.robots.allowed,
  };
}
```

Two practical rules from earlier Assay posts:

1. **Link URLs are expensive tokens.** Keep `links[]` in the JSON; strip or footnote targets in the markdown you send to the model when the model does not need to follow them ([measured on Wikipedia and RFCs](/blog/reduce-html-tokens-for-llms)).
2. **Provenance beats clever chunking.** Every chunk should carry `source_url` / `canonical` / `fetched_at` so a citation can be checked by a human.

## How the HTML becomes that JSON

The common open-source path (and the one Assay runs) is:

1. **Fetch** HTML with timeouts, size caps, redirect limits, and SSRF blocks (no private/loopback/link-local targets).
2. **Check robots.txt** for your user agent before the body fetch ([RFC 9309](https://www.rfc-editor.org/rfc/rfc9309)).
3. **Main-content extraction** with [Mozilla Readability](https://github.com/mozilla/readability) (Firefox Reader View). It scores DOM nodes by text density and class/id hints; it is not a full browser.
4. **HTML → markdown** with [Turndown](https://github.com/mixmark-io/turndown) (ATX headings, fenced code).
5. **Metadata** from the document *before* or alongside Readability: `link[rel=canonical]`, `lang`, `article:published_time` / `meta[name=date]` / `<time datetime>`, author meta, and Readability's title/byline/excerpt when present.
6. **Links** collected as absolute `https?` URLs from the article fragment, deduped, capped.

```ts
// Same libraries Assay uses (linkedom + Readability + Turndown). Local sketch only.
import { parseHTML } from "linkedom";
import { Readability } from "@mozilla/readability";
import TurndownService from "turndown";

const { document } = parseHTML(html);
const article = new Readability(document as unknown as Document, { charThreshold: 200 }).parse();
const td = new TurndownService({ headingStyle: "atx", codeBlockStyle: "fenced", bulletListMarker: "-" });
td.remove(["script", "style", "noscript", "iframe"]);
const markdown = td.turndown(article?.content ?? "").replace(/\n{3,}/g, "\n\n").trim();
```

Readability is heuristic. It can drop a lead paragraph on custom layouts (we hit that on MDN's HTTP 402 page in the [token post](/blog/reduce-html-tokens-for-llms)), and it does not execute JavaScript — client-rendered SPAs can return nearly empty content. Spot-check the sites you depend on.

## What Assay's GET /v1/extract returns today

[`GET /v1/extract`](/docs/extract/) is Assay's web-page-to-JSON endpoint. Defaults and limits you can rely on:

| Item | Behavior |
|---|---|
| Method / path | `GET /v1/extract?url=…` |
| `format` | `json` (default) or `markdown` (`text/markdown` body) |
| Price | **`$0.003`** per successful call; failed calls are not settled |
| Payment | x402 v2 USDC on **Base Sepolia** (`eip155:84532`) only — no signup, no API key |
| Pipeline | robots.txt → safe fetch → Readability (`charThreshold: 200`, body fallback) → Turndown → JSON fields above |
| Cache | **1 hour** in-process; `cached: true` on hit; same price on cache hits |
| Markdown cap | **200,000** characters; `truncated: true` when cut |
| Links | Up to **200** absolute `http(s)` links from the article fragment |
| Body limit | HTML over **5 MB** → `413 too_large` (not charged) |
| Safety | SSRF blocks, redirect hop checks (max 5), ports 80/443 only |

Honest limits, same as the docs:

- **No JavaScript rendering.** SPA-only pages can yield `422 empty_content` or thin markdown.
- **Markdown still lives inside the JSON** as the `markdown` string — `format=json` does not parse the article into sections or entities for you.
- **Readability quirks apply** (lead-paragraph drops, site-chrome misses). Meta `excerpt` sometimes preserves text the article body lost.
- **Tables** from HTML are not GFM-normalized yet in Turndown (see the [Turndown post](/blog/turndown-html-to-markdown-for-llms)); do not assume grid structure in `markdown`.
- Only two paid endpoints exist today: `/v1/extract` and [`POST /v1/pdf/text`](/docs/pdf-text/) (`$0.01`). PDF text is a separate text-layer product, not this JSON envelope.

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
const page = "https://www.rfc-editor.org/rfc/rfc9309";
const res = await payFetch(`{{ORIGIN}}/v1/extract?url=${encodeURIComponent(page)}`);
const data = await res.json();
// data.title, data.canonical, data.markdown, data.links, data.word_count, data.cached, …
console.log(data.title, data.word_count, data.links.length);
```

If you already run Node, the local sketch above does the same extraction without a network hop. Use the hosted API when you want robots-aware fetch, SSRF protection, and a stable JSON contract paid per successful call.

**Related:** [Clean markdown from web pages for LLMs](/blog/clean-markdown-from-web-pages-for-llms) · [Extract article text with Mozilla Readability](/blog/extract-article-text-mozilla-readability) · [Turndown HTML to markdown for LLMs](/blog/turndown-html-to-markdown-for-llms) · [Reduce HTML tokens for LLMs](/blog/reduce-html-tokens-for-llms) · [SSRF protection for agent fetch tools](/blog/ssrf-protection-for-ai-agent-fetch-tools) · [Extract docs](/docs/extract/)

### Sources
- Mozilla Readability: https://github.com/mozilla/readability
- Turndown: https://github.com/mixmark-io/turndown
- linkedom: https://github.com/WebReflection/linkedom
- RFC 9309, Robots Exclusion Protocol: https://www.rfc-editor.org/rfc/rfc9309
- RFC 9111, HTTP Caching: https://www.rfc-editor.org/rfc/rfc9111
- Assay GET /v1/extract docs (field specimen): /docs/extract/

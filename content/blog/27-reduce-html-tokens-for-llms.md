---
title: "Reduce HTML Tokens for LLMs: What We Measured on Six Real Pages"
description: "How much does converting a web page to markdown actually cut LLM tokens? We counted o200k_base tokens for raw HTML, script-stripped HTML, body text, and Readability + Turndown markdown on six public pages, with the script, the numbers, and the two failure modes we hit."
slug: reduce-html-tokens-for-llms
date: 2026-11-02
keywords: [reduce tokens html, html to markdown token count, html tokens for llm, readability turndown tokens, o200k_base token count, web page to markdown for llm]
---

# Reduce HTML tokens for LLMs: what we measured on six real pages

If you want to **reduce HTML tokens** before a page goes into a model, the usual advice is "convert it to markdown." We wanted numbers instead of advice, so we counted. This script fetches a page and counts tokens at four stages with the `o200k_base` encoding (the tokenizer OpenAI's GPT-4o family uses):

```ts
// npm i linkedom @mozilla/readability turndown gpt-tokenizer   (run with: npx tsx count.mts <url>)
import { parseHTML } from "linkedom";
import { Readability } from "@mozilla/readability";
import TurndownService from "turndown";
import { countTokens } from "gpt-tokenizer/encoding/o200k_base";

const url = process.argv[2];
const html = await (await fetch(url, { headers: { "user-agent": "my-agent/1.0 (+https://example.com/bot)" } })).text();

// 1. raw HTML as served
// 2. HTML with <script>, <style>, <noscript>, <svg>, <template> and comments removed (string level)
const stripped = html
  .replace(/<(script|style|noscript|svg|template)\b[\s\S]*?<\/\1\s*>/gi, "")
  .replace(/<!--[\s\S]*?-->/g, "");

// 3. all visible body text, whitespace collapsed (includes nav, footers, sidebars)
const { document } = parseHTML(html);
document.querySelectorAll("script,style,noscript,svg,template").forEach((el) => el.remove());
const bodyText = (document.body?.textContent ?? "").replace(/\s+/g, " ").trim();

// 4. main content only: Readability, then Turndown to markdown
const article = new Readability(parseHTML(html).document as unknown as Document, { charThreshold: 200 }).parse();
const td = new TurndownService({ headingStyle: "atx", codeBlockStyle: "fenced", bulletListMarker: "-" });
td.remove(["script", "style", "noscript", "iframe"]);
const markdown = td.turndown(article?.content ?? "").replace(/\n{3,}/g, "\n\n").trim();

// 5. same markdown with link and image targets dropped, anchor text kept
const noLinks = markdown.replace(/!\[([^\]]*)\]\([^)]*\)/g, "").replace(/\[([^\]]*)\]\([^)]*\)/g, "$1");

for (const [name, s] of Object.entries({ raw: html, stripped, bodyText, markdown, noLinks }))
  console.log(name.padEnd(9), String(countTokens(s)).padStart(7));
```

Stage 4 is the same pipeline Assay's [`/v1/extract`](/docs/extract/) endpoint runs (Readability with `charThreshold: 200`, then Turndown with ATX headings and fenced code). The numbers below came from running it on 2 November 2026 with `gpt-tokenizer` 4.1.0.

## The numbers

Token counts, `o200k_base`. The percentage is the share of the raw HTML that remains.

| Page | Raw HTML | Scripts/styles stripped | Body text | Markdown | Markdown, no link URLs |
|---|---:|---:|---:|---:|---:|
| [RFC 9309](https://www.rfc-editor.org/rfc/rfc9309.html) (rfc-editor.org) | 24,923 | 17,665 (70.9%) | 5,327 | 7,768 (31.2%) | 5,817 (23.3%) |
| [Robots.txt](https://en.wikipedia.org/wiki/Robots.txt) (Wikipedia) | 100,720 | 93,755 (93.1%) | 6,808 | 12,907 (12.8%) | 7,026 (7.0%) |
| [402 Payment Required](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Status/402) (MDN) | 56,609 | 32,723 (57.8%) | 2,435 | 609 (1.1%) | 501 (0.9%) |
| [urllib.robotparser](https://docs.python.org/3/library/urllib.robotparser.html) (Python docs) | 7,622 | 6,798 (89.2%) | 767 | 902 (11.8%) | 642 (8.4%) |
| [SPARQL 1.1 Query](https://www.w3.org/TR/sparql11-query/) (W3C) | 153,335 | 153,010 (99.8%) | 65,266 | 56,604* (36.9%) | 51,180* (33.4%) |
| [mozilla/readability](https://github.com/mozilla/readability) (GitHub) | 120,266 | 44,615 (37.1%) | 2,055 | 1,756 (1.5%) | 1,555 (1.3%) |

\* The W3C spec's markdown hit our 200,000-character cap, so those two cells are a lower bound for the full document.

Six pages is a small sample, and these are documentation pages, not news or shopping pages. Treat the table as a description of these six pages on that day, not a benchmark. Pages change, and so will the counts. Run the script on your own URLs.

## What the numbers say

**Stripping scripts and styles is not enough.** On Wikipedia it removed under 7% of tokens, and on the W3C spec almost nothing, because those pages carry little inline JavaScript. The cost is in the markup itself: attributes, class names, navigation, and footers. On GitHub and MDN, stripping did more (down to 37% and 58%), but the result was still tens of thousands of tokens for a page whose content fits in under 2,000.

**Main-content extraction is where most of the savings come from.** Going from raw HTML to Readability + Turndown markdown left between 1.1% and 36.9% of the original tokens across these six pages. The biggest cuts were on pages with heavy site chrome (GitHub, MDN). The smallest were on pages that are almost all content (the RFC, the W3C spec).

**Markdown can cost more than plain text, and links are why.** On the RFC, Wikipedia, and Python pages, the markdown had more tokens than the whole page's flattened body text, even though the body text also includes navigation. Every `[text](url)` keeps its URL, and URLs tokenize badly. Dropping link targets cut the markdown by 10% to 46%; on Wikipedia, with its hundreds of reference and cross-links, it nearly halved it (12,907 to 7,026). If the model doesn't need to follow or cite links, drop the targets. If it does, keep them and accept the cost, or move them to a numbered list at the end. Assay's `/v1/extract` keeps inline links in `markdown` and also returns them separately in a `links` array, so a client can strip them from the text without losing them.

**Structure is cheap.** Headings, list markers, and code fences add only a few tokens, and the model can use them to tell sections apart. That's why "convert to markdown" beats "convert to plain text" once links are handled.

## Two failure modes we hit

The measurement exposed two problems worth knowing about before you rely on any extractor:

1. **Readability dropped MDN's lead paragraph.** The raw HTML starts the article with "The HTTP **402 Payment Required** client error response status code is a nonstandard response status code reserved for future use", but the extracted markdown starts at the "Status" heading. That paragraph is the definition, and it's gone. Part of the 1.1% figure is a real loss, not just savings. (The same sentence survives in the page's meta description, which Assay returns as `excerpt`.) Always spot-check extraction on the sites you depend on.
2. **Code-block language labels leak in as stray text.** MDN shows a language label ("http") above each example, and it came through as a bare `http` line above each fenced block. It's harmless but noisy. A Turndown rule that reads the language into the fence (```` ```http ````) and drops the label element fixes it; see our [Turndown guide](/blog/turndown-html-to-markdown-for-llms) for how to add rules.

Also note what this pipeline can't do. It doesn't run JavaScript, so a page that renders its content client-side can come back nearly empty. That shows up as a suspiciously low token count, not as an error.

## A practical checklist

- Count before and after with the tokenizer of the model you actually call. Token counts differ between encodings, so `o200k_base` numbers are a guide for other models, not a measurement of them.
- Extract the main content first, then convert. Stripping tags alone leaves most of the cost.
- Decide about link URLs on purpose. They were the single largest piece of the markdown on link-heavy pages.
- Cap the output. A long spec can still produce 50,000+ tokens after extraction. Chunk it on headings instead of sending it all.
- Spot-check that the lead paragraph and tables survived, especially on docs sites with custom layouts.
- Respect `robots.txt` and the site's terms before fetching at scale ([how we handle that](/blog/responsible-extraction-robots-txt-licenses)).

## Where Assay fits, honestly

[`GET /v1/extract`](/docs/extract/) runs stage 4 of the script above as a hosted call: robots.txt-aware fetch, Readability, Turndown, a one-hour cache, and JSON metadata (title, byline, canonical, excerpt, links). It costs $0.003 per successful call, paid per call with x402 in USDC on Base Sepolia testnet, and failed calls are never settled ([limits and charge policy](/docs/limits/)). It doesn't strip link targets for you, doesn't run JavaScript, and has the same Readability behavior we measured here, including the MDN lead-paragraph miss. If you already run Node, the script above does the same work locally for free.

**Related:** [Clean markdown from web pages for LLMs](/blog/clean-markdown-from-web-pages-for-llms) · [Extract article text with Mozilla Readability](/blog/extract-article-text-mozilla-readability) · [Turndown HTML to markdown for LLMs](/blog/turndown-html-to-markdown-for-llms) · [What is llms.txt?](/blog/what-is-llms-txt)

### Sources
- Mozilla Readability: https://github.com/mozilla/readability
- Turndown: https://github.com/mixmark-io/turndown
- linkedom: https://github.com/WebReflection/linkedom
- gpt-tokenizer (o200k_base encoding): https://github.com/niieani/gpt-tokenizer
- OpenAI tiktoken (encodings, o200k_base for GPT-4o): https://github.com/openai/tiktoken
- Pages measured (fetched 2 November 2026): https://www.rfc-editor.org/rfc/rfc9309.html · https://en.wikipedia.org/wiki/Robots.txt · https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Status/402 · https://docs.python.org/3/library/urllib.robotparser.html · https://www.w3.org/TR/sparql11-query/ · https://github.com/mozilla/readability

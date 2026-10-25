---
title: "Extract Article Text with Mozilla Readability: Options, Output, and Failure Modes"
description: "How to extract article text from any web page with Mozilla Readability in Node.js: a working example with linkedom, what parse() returns, every option worth tuning, how the retry passes work, when it returns null, and how to handle pages that aren't articles."
slug: extract-article-text-mozilla-readability
date: 2026-10-25
keywords: [extract article text, readability api, mozilla readability node, isProbablyReaderable, charThreshold, article extraction for LLM]
---

# Extract article text with Mozilla Readability: options, output, and failure modes

To **extract article text** from a web page, most JavaScript pipelines reach for [Mozilla Readability](https://github.com/mozilla/readability), the standalone version of the library behind Firefox Reader View. Here is a complete Node.js example that fetches a page, checks whether it looks like an article, and pulls out the main text and metadata:

```ts
// npm i @mozilla/readability linkedom   (run with: npx tsx extract.mts)
import { parseHTML } from "linkedom";
import { Readability, isProbablyReaderable } from "@mozilla/readability";

const url = "https://www.rfc-editor.org/rfc/rfc9309.html";
const html = await (await fetch(url)).text();
const { document } = parseHTML(html);

if (!isProbablyReaderable(document as any)) console.warn("probably not an article");

const article = new Readability(document as any, { charThreshold: 200 }).parse();
if (!article) throw new Error("no article content found");

console.log(article.title);      // "RFC 9309: Robots Exclusion Protocol"
console.log(article.lang);       // "en"
console.log(article.length);     // characters of plain text
console.log(article.textContent.slice(0, 300));
```

We ran this against @mozilla/readability 0.6.0: `isProbablyReaderable` returned `true`, and `parse()` returned the RFC's title, `lang: "en"`, and the document text. The rest of this post explains what each piece does and where it goes wrong.

## What `parse()` returns

`parse()` returns either `null` or an object with these fields (from the [README](https://github.com/mozilla/readability#parse)):

| Field | What it holds |
|---|---|
| `title` | Article title |
| `content` | HTML string of the cleaned article |
| `textContent` | The same content with all tags removed |
| `length` | Length of `textContent` in characters |
| `excerpt` | Description from metadata, or the first paragraph |
| `byline` | Author metadata |
| `dir` | Text direction |
| `siteName` | Site name |
| `lang` | Content language |
| `publishedTime` | Published time, when the page declares one |

For LLM work you usually want `content` (keeps headings, lists, tables, and links, so you can convert it to markdown) rather than `textContent` (flat text that loses structure). Metadata comes partly from JSON-LD: Readability gives precedence to Schema.org fields in JSON-LD unless you pass `disableJSONLD: true`. In the example above `siteName` came back `null`, so don't assume every field is filled.

## A DOM is required in Node.js

Readability works on a DOM `Document`, not a string, and Node.js has no DOM built in. The README uses [jsdom](https://github.com/jsdom/jsdom). The example here uses [linkedom](https://github.com/WebReflection/linkedom), a lighter DOM implementation (the `as any` casts are there because its types differ from the browser's `Document`). Two points from the README apply either way:

- **Relative URLs.** With jsdom, pass the page URL as the `url` option of the `JSDOM` constructor so Readability can make relative links and image URLs absolute. With other DOMs, resolve links yourself against the final URL after redirects.
- **Don't run page scripts.** jsdom disables script execution by default, and the README strongly recommends keeping it that way.

## `parse()` changes the document

`parse()` works by modifying the DOM it was given: it removes scripts and elements it considers boilerplate. If you need anything else from the page afterwards, such as `<link rel="canonical">`, Open Graph tags, or the full link list, read it **before** calling `parse()`, or pass a clone with `document.cloneNode(true)`.

## How the extraction works, briefly

Readability scores candidate container elements and picks the best one. Two kinds of signals matter most, and both are visible in the source:

- **Class and id hints.** Names matching patterns like `article`, `content`, `entry`, `main`, `post`, or `story` score up. Names like `comment`, `footer`, `sidebar`, `sponsor`, `share`, or `widget` score down. Elements whose class or id looks like `banner`, `menu`, `sidebar`, `related`, or `social` are stripped as unlikely candidates, unless they also match something like `article`, `content`, or `main`.
- **Text and link density.** Containers with lots of text, commas, and paragraphs win. Containers that are mostly links get penalized as navigation.

### The retry passes, and why `charThreshold` matters

The first pass runs with three behaviors on: stripping unlikely candidates, weighting by class names, and conditionally cleaning tables, lists, and forms that look like junk. If the extracted text is shorter than `charThreshold` (default 500 characters), Readability restores the page and tries again with the first behavior turned off, then the second, then the third. If every pass comes in under the threshold, it returns the longest text it found. It returns `null` only when even that is empty.

So a short page doesn't fail outright, but it does run up to four passes. Lowering `charThreshold` (Assay uses 200) makes a short but valid page, like a release note or a brief announcement, succeed on the first pass instead of falling through to looser passes that keep more boilerplate.

## Options worth knowing

All options are optional. The ones that matter in a pipeline:

- `charThreshold` (default `500`): minimum article length before Readability stops retrying, as described above.
- `nbTopCandidates` (default `5`): how many top-scoring candidates to compare when deciding whether sibling content belongs to the article.
- `maxElemsToParse` (default `0`, no limit): if set and the page has more elements, `parse()` **throws** `Aborting parsing document; N elements found` rather than returning `null`. Wrap it in `try`/`catch`. This is a cheap guard against huge pages.
- `keepClasses` (default `false`) and `classesToPreserve`: by default classes are stripped from the output. Preserve the ones your converter needs, such as `language-*` hints on code blocks.
- `disableJSONLD` (default `false`): skip JSON-LD when metadata from it is wrong for your use.
- `serializer` (default `el => el.innerHTML`): pass `el => el` to get a DOM element in `content` instead of a string, if you post-process the DOM.
- `linkDensityModifier` (default `0`): shifts the link-density threshold used to drop link-heavy blocks.

## `isProbablyReaderable` is a hint, not a gate

`isProbablyReaderable(document, { minContentLength, minScore })` is a fast pre-check (defaults `140` and `20`). The README says plainly that it produces both false positives and false negatives. It exists to avoid running the full algorithm in latency-sensitive places like a browser. In a backend pipeline, use it to choose a mode rather than to refuse a page: when it says no, try a full-body fallback (below) instead of returning nothing.

## Where Readability struggles

Readability is tuned for articles. Expect weaker results on:

- **Documentation and reference pages**, where the parameter table may sit in a sidebar or a container that looks like navigation.
- **Product pages, search results, and forums**, which have no single main container.
- **JavaScript-rendered pages**, where the fetched HTML is a shell. Readability only sees what's in the HTML you give it.
- **Untrusted output.** Readability does not sanitize. The README recommends a sanitizer such as [DOMPurify](https://github.com/cure53/DOMPurify) before rendering `content` as HTML anywhere.

The usual fix for the first two is a fallback: if `parse()` returns `null` or very little text, use `document.body` after removing obvious boilerplate (`nav`, `header`, `footer`, `aside`, scripts, styles), then convert that. Our [clean markdown for LLMs](/blog/clean-markdown-from-web-pages-for-llms) post walks through the whole pipeline, from polite fetching to chunking.

## What Assay does with it

Assay's [`/v1/extract`](/docs/extract/) endpoint (0.003 USDC per successful call, paid with x402 on **Base Sepolia testnet** only) runs this approach on the server: a robots.txt-aware fetch with no JavaScript rendering, metadata read from the page **before** parsing (canonical URL, `lang`, published time from `article:published_time`, `meta[name=date]`, or `<time datetime>`), Mozilla Readability on linkedom with `charThreshold: 200`, and, when Readability returns `null`, the full `<body>` as a fallback. The HTML is converted to markdown with Turndown (ATX headings, fenced code), and the response includes up to 200 absolute links, a word count, and a `truncated` flag for markdown over 200,000 characters. If nothing extractable is left, it returns a 422 and you aren't charged, because Assay settles payment only for responses below 400. The [quickstart](/docs/quickstart/) shows a first paid call with free testnet USDC.

**Related:** [Clean markdown from web pages for LLMs](/blog/clean-markdown-from-web-pages-for-llms) · [What is llms.txt](/blog/what-is-llms-txt) · [robots.txt for AI crawlers](/blog/robots-txt-for-ai-crawlers) · [PDF to text for LLM pipelines](/blog/pdf-to-text-for-llm-pipelines)

### Sources
- Mozilla Readability README (options, `parse()` fields, `isProbablyReaderable`, security): https://github.com/mozilla/readability
- Readability.js source (scoring regexes, retry flags, `maxElemsToParse`): https://github.com/mozilla/readability/blob/main/Readability.js
- Firefox Reader View: https://support.mozilla.org/kb/firefox-reader-view-clutter-free-web-pages
- linkedom: https://github.com/WebReflection/linkedom
- jsdom: https://github.com/jsdom/jsdom
- DOMPurify: https://github.com/cure53/DOMPurify

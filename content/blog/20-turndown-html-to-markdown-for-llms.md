---
title: "Turndown HTML to Markdown for LLMs: Options, Tables, and the Gotchas We Measured"
description: "How to convert HTML to markdown with Turndown for LLM input: a working Node.js example, the options worth changing from their defaults, why script text leaks unless you remove it, what the GFM plugin does to tables (and where it breaks), and custom rules for links and images."
slug: turndown-html-to-markdown-for-llms
date: 2026-10-26
keywords: [turndown html to markdown, html to markdown for LLM, turndown-plugin-gfm tables, turndown options, turndown addRule, markdown for RAG]
---

# Turndown HTML to markdown for LLMs: options, tables, and the gotchas we measured

[Turndown](https://github.com/mixmark-io/turndown) is the most common way to do **Turndown HTML to markdown** conversion in JavaScript, and it's a good last step before text goes into a model's context. Here is a configuration that works well for LLM input:

```ts
// npm i turndown turndown-plugin-gfm   (run with: npx tsx convert.mts)
import TurndownService from "turndown";
import { gfm } from "turndown-plugin-gfm";

const td = new TurndownService({
  headingStyle: "atx",        // "## Title" instead of underlined headings
  codeBlockStyle: "fenced",   // ``` blocks instead of 4-space indents
  bulletListMarker: "-",
});
td.use(gfm);                                          // pipe tables, ~strikethrough~, task lists
td.remove(["script", "style", "noscript", "iframe"]); // drop these elements AND their text

const html = `<h2>Params</h2><p>Use <code>url</code>, not <b>uri</b>.</p>
<table><thead><tr><th>Name</th><th>Type</th></tr></thead>
<tbody><tr><td>url</td><td>string</td></tr></tbody></table>
<pre><code class="language-ts">const x = 1;</code></pre>`;

console.log(td.turndown(html));
```

Everything in this post was checked by running it against turndown 7.2.4 and turndown-plugin-gfm 1.0.2 in Node.js. The output of the example above is:

````md
## Params

Use `url`, not **uri**.

| Name | Type |
| --- | --- |
| url | string |

```ts
const x = 1;
```
````

Turndown kept the `language-ts` class as the fence's info string. That matters if your HTML came out of [Mozilla Readability](/blog/extract-article-text-mozilla-readability), which strips classes unless you set `keepClasses` or `classesToPreserve`.

## The defaults are built for humans, not for tokens

Turndown's [default options](https://github.com/mixmark-io/turndown#options) produce valid markdown, but three of them are worth changing for model input:

| Option | Default | Change to | Why |
|---|---|---|---|
| `headingStyle` | `setext` | `atx` | Setext only has two levels (`===` and `---` underlines). ATX (`#` to `######`) keeps all six and is easier to split on when you chunk by heading. |
| `codeBlockStyle` | `indented` | `fenced` | Indented blocks can't carry a language, and the indent is easy to lose when text gets re-wrapped. |
| `bulletListMarker` | `*` | `-` | A matter of taste, but `-` can't be confused with emphasis. |

The others (`emDelimiter` `_`, `strongDelimiter` `**`, `fence`, `hr`) are fine as they are. `linkStyle: "referenced"` moves URLs into numbered definitions at the end, like `[A][1]` with `[1]: https://a.example/` below. That keeps long tracking URLs from breaking up sentences, but it also puts each link's target far from its text. For retrieval, where a chunk may be cut off from the definitions at the end, inline links are usually safer.

## Script and style text leaks unless you call `remove()`

This one surprised us. With no `remove()` call, Turndown doesn't drop `<script>` or `<style>`. It outputs their **text content**, so the markdown ends up with something like `alert(1)p{}` jammed onto the end of a paragraph. Turndown's rule for elements it has no rule for is to keep their content, which is exactly the wrong thing for code and CSS.

`td.remove([...])` takes a tag name, an array of names, or a filter function, and removes the element **and** everything inside it. Inline `<svg>` and `<video>` fallback text also came through as plain text in our test, so add those if your pages use them. If you run Readability first, most scripts are already gone, but the full-body fallback path (when Readability returns `null`) usually still has them, so keep the `remove()` call anyway.

`keep([...])` does the opposite: it outputs the element as raw HTML. That's useful for markup that has no markdown equivalent, but nothing is sanitized. Never render model-bound markdown as HTML without a sanitizer.

## Tables: core Turndown flattens them

Core Turndown has no table rule. Without the GFM plugin, our two-row table came out as four separate paragraphs, `Name`, `Type`, `url`, `string`, with the rows and columns gone. A model can sometimes guess the structure back, but often it can't.

The [turndown-plugin-gfm](https://github.com/mixmark-io/turndown-plugin-gfm) plugin adds pipe tables, strikethrough, and task lists. `use(gfm)` turns on all of them, or import `tables`, `strikethrough`, and `taskListItems` one by one. Three limits showed up in our tests:

- **Tables without a header row are kept as raw HTML.** The plugin only converts a table when its first row is a heading row (`<th>` cells or a `<thead>`). A `<table>` made only of `<td>` rows came out unchanged as `<table><tbody>…`. That's still readable, but it costs more tokens than a pipe table.
- **A `|` inside a cell isn't escaped.** A cell containing `string | null` produced `| url | string | null |`, a row with three cells under a two-column header. Any GFM parser reads that as the wrong table. Escape pipes in cell text yourself (a custom rule for `td` and `th`, or a pass over the text nodes before converting).
- **`colspan` and `rowspan` aren't expanded.** A header cell with `colspan="2"` produced a one-column header over a two-cell row. For tables that span rows or columns, it's better to keep the HTML (`keep`) or turn the table into JSON yourself than to send a pipe table that's quietly wrong.

Strikethrough comes out as a single tilde (`~old~`). GitHub accepts that, but some other parsers only accept `~~`. Task lists turn a checkbox inside an `<li>` into `[x]` or `[ ]`. A checkbox outside a list item, such as one in a plain paragraph, is dropped.

## Custom rules with `addRule`

A rule is a `filter` (a tag name, an array, or a function of the node) and a `replacement(content, node, options)` that returns markdown. Rules you add take priority over the built-in rules. Two that help with LLM input:

```ts
// Drop link targets but keep the anchor text (saves tokens when URLs don't matter)
td.addRule("textOnlyLinks", {
  filter: "a",
  replacement: (content) => content,
});

// Replace images with their alt text, or nothing
td.addRule("altOnlyImages", {
  filter: "img",
  replacement: (_content, node) => {
    const alt = (node as HTMLElement).getAttribute("alt")?.trim();
    return alt ? `[image: ${alt}]` : "";
  },
});
```

With the first rule, `<p>See <a href="/x">the docs</a></p>` becomes `See the docs`. Keep links when the model needs to cite or follow them; drop them when it only needs to read.

## Escaping and whitespace

Turndown escapes text that would otherwise turn into markdown syntax. In our run a paragraph starting `1. starts with number` came out as `1\. starts with number`, and `# hash` and `- dash` got backslashes too. Mid-line `*` and `_` are escaped as well (`\* star \_under\_`). That's correct, but it adds characters. If you're sure the output only goes to a model and never through a markdown renderer, you can override `td.escape = (s) => s`. Most pipelines should leave it alone.

Whitespace is collapsed the way a browser would collapse it: `lots   of   space` becomes `lots of space`, and leading and trailing spaces disappear. A `<br>` becomes two trailing spaces and a newline (a markdown hard break). `<pre>` with no `<code>` inside keeps its whitespace but **isn't fenced**, since the fenced rule matches `<pre><code>`, so a bare `<pre>` reads like normal text. If your sources use bare `<pre>`, add a rule for it.

## Where Turndown runs

In Node.js, Turndown parses HTML strings with its own bundled DOM ([@mixmark-io/domino](https://github.com/mixmark-io/domino) in 7.2.4). You can also pass it a DOM node you already have, such as Readability's output with `serializer: el => el`, and skip a second parse.

## What Assay does today

Assay's [`/v1/extract`](/docs/extract/) endpoint (0.003 USDC per successful call, paid with x402 on **Base Sepolia testnet** only) uses Turndown as its last step, after a robots.txt-aware fetch and Mozilla Readability. It uses `atx` headings, fenced code, `-` bullets, and removes `script`, `style`, `noscript`, and `iframe`. Then it collapses runs of blank lines and caps the markdown at 200,000 characters, with a `truncated` flag. It does **not** use the GFM plugin yet, so tables in `/v1/extract` output currently come out flattened, as described above. Adding it, along with the pipe escaping and header-less handling from this post, is on our list. Until then, if a page's tables matter to you, check the `markdown` field before relying on them. The [quickstart](/docs/quickstart/) walks through a first paid call with free testnet USDC.

**Related:** [Extract article text with Mozilla Readability](/blog/extract-article-text-mozilla-readability) · [Clean markdown from web pages for LLMs](/blog/clean-markdown-from-web-pages-for-llms) · [What is llms.txt](/blog/what-is-llms-txt) · [PDF to text for LLM pipelines](/blog/pdf-to-text-for-llm-pipelines)

### Sources
- Turndown README (options, `addRule`, `keep`, `remove`, `escape`): https://github.com/mixmark-io/turndown
- turndown-plugin-gfm (tables, strikethrough, task lists): https://github.com/mixmark-io/turndown-plugin-gfm
- CommonMark spec (ATX and setext headings, code blocks, hard line breaks): https://spec.commonmark.org/
- GitHub Flavored Markdown spec (tables, strikethrough, task lists): https://github.github.com/gfm/
- Mozilla Readability (`keepClasses`, `serializer`): https://github.com/mozilla/readability

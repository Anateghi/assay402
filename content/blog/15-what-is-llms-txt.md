---
title: "What Is llms.txt? How to Publish One, and How Agents Should Read It"
description: "llms.txt is a proposed markdown file that gives agents a short, curated map of a site, with links to clean markdown versions of its pages. Here is the format, the .md mirror and link-relation conventions, how it differs from robots.txt and sitemap.xml, and a small parser an agent can use."
slug: what-is-llms-txt
date: 2026-10-21
keywords: [llms.txt, what is llms.txt, llms.txt format, markdown version of web pages for LLMs, rel alternate text/markdown, llms.txt vs robots.txt]
---

# What is llms.txt? How to publish one, and how agents should read it

**llms.txt** is a markdown file at a well-known path, usually `/llms.txt`, that tells an agent what a site is and where its LLM-friendly content lives. It is a proposal published at [llmstxt.org](https://llmstxt.org/), not an IETF or W3C standard. An agent can read one with nothing more than `fetch` and a few regular expressions:

```js
// Read a site's llms.txt and list the markdown files it points to (Node 18+).
const res = await fetch(new URL("/llms.txt", "{{ORIGIN}}"));
if (!res.ok) throw new Error(`no llms.txt (${res.status})`);
const txt = await res.text();

const title = txt.match(/^#\s+(.+)$/m)?.[1];      // H1: the only required part
const summary = txt.match(/^>\s+(.+)$/m)?.[1];    // blockquote summary
const sections = {};
let current = null;
for (const line of txt.split("\n")) {
  const h2 = line.match(/^##\s+(.+)$/);
  if (h2) { current = h2[1].trim(); sections[current] = []; continue; }
  const item = line.match(/^-\s*\[([^\]]+)\]\(([^)]+)\)(?::\s*(.*))?$/);
  if (item && current) sections[current].push({ name: item[1], url: item[2], notes: item[3] ?? "" });
}
console.log(title, summary, Object.keys(sections));
```

Run against this site, it prints `Assay`, the one-line summary, and the section names `Docs`, `Blog`, and `Optional`. This post covers what the format requires, the conventions around it, how it differs from `robots.txt` and `sitemap.xml`, and what we do (and don't yet do) on this site.

## Why the file exists

The proposal's argument is short: web pages are built for people. HTML wraps the useful text in navigation, ads, and scripts, and turning it back into clean text "is difficult and imprecise." Context windows are limited and every wasted token costs time and money, so agents do better with "concise, expert-level information gathered in a single, accessible location." We made the same case from the extraction side in [how to extract clean markdown from web pages for LLMs](/blog/clean-markdown-from-web-pages-for-llms). llms.txt is the site owner doing that work ahead of time.

The proposal was first published by Jeremy Howard in September 2024. The current version, v2, is dated August 2026. It says thousands of sites now publish the file, that several documentation platforms generate one automatically, and that the AI labs publish one for their own developer docs. Those adoption claims are the proposal's own. We haven't measured them.

## The format, section by section

The file is markdown, but in a fixed order so a program can parse it. Per the spec, the sections are:

1. An optional byte-order mark.
2. **An H1 with the name of the project or site.** This is the only required section.
3. A blockquote with a short summary that contains the key information needed to understand the rest of the file.
4. Zero or more markdown sections of any type **except headings**: paragraphs, lists, notes on how to read the links.
5. Zero or more sections under **H2 headings**, each a "file list": a markdown list where every item is a required `[name](url)` link, optionally followed by `:` and notes.

By convention, an H2 named **`Optional`** holds secondary links that an agent can skip when it needs a shorter context. The mock example from the spec shows the whole shape:

```markdown
# Title

> Optional description goes here

Optional details go here

## Section name

- [Link title](https://link_url): Optional link details

## Optional

- [Link title](https://link_url)
```

Two things follow from this. First, the file is a **map, not the content**. The spec wants it "small enough to fit in context," with the detail behind the links, fetched only when needed. Second, the links should point at LLM-friendly content, which usually means the markdown mirrors described next.

## Markdown mirrors at a predictable URL

The second half of the proposal matters as much as the file itself. Pages that agents might need should offer a clean markdown version at the same URL as the original, either with `.md` appended (`page.html.md`) or with the extension replaced (`page.md`). For URLs without a file name, the spec says to append `index.html.md` or `index.md`.

The value is predictability. An agent that knows the convention can try `<url>.md` before paying for extraction, and fall back to extracting the HTML only when the mirror isn't there.

## Link relations: alternate and describedby

The v2 proposal also recommends standard link relations so a client can discover both files from any page:

- `rel="alternate" type="text/markdown"` points to the markdown version of the page.
- `rel="describedby"` points to the llms.txt file that covers it.

Both can be HTML `<link>` elements or an HTTP `Link` header, the mechanism defined in [RFC 8288 (Web Linking)](https://www.rfc-editor.org/rfc/rfc8288.html). Both relation types are in the [IANA link relations registry](https://www.iana.org/assignments/link-relations/link-relations.xhtml). The header form also works for responses that aren't HTML, including the markdown files themselves, and can be set in server or CDN config without touching any page. The spec's example:

```http
Link: </docs/page.html.md>; rel="alternate"; type="text/markdown", </docs/llms.txt>; rel="describedby"
```

## Scope: root or subpath

An llms.txt doesn't have to live at the root. The spec allows it at any path, where it covers the URLs under that path, so `/docs/llms.txt` describes `/docs/`. When more than one file applies, agents should use the most specific one.

The proposal explains why it didn't use [RFC 8615](https://www.rfc-editor.org/rfc/rfc8615.html) `/.well-known/` URIs: those exist only at the origin root, and many authors control only a path on a shared host, such as a GitHub Pages project site.

## llms.txt vs robots.txt vs sitemap.xml

The three files answer different questions, and the proposal says llms.txt is meant to sit alongside the other two, not replace them.

| | `robots.txt` | `sitemap.xml` | `llms.txt` |
|---|---|---|---|
| Question it answers | What automated access is acceptable? | Which pages exist for indexing? | What is this site, and where is the clean content? |
| Status | Standard, [RFC 9309](https://www.rfc-editor.org/rfc/rfc9309.html) | [sitemaps.org protocol](https://www.sitemaps.org/protocol.html) | Proposal at llmstxt.org |
| Format | Line-based rules per user agent | XML list of URLs | Markdown with a fixed section order |
| Scope | The whole origin | The URLs listed | Its own path and everything below it |
| Typical reader | Crawlers, before fetching | Search engines | Agents, at inference time, while helping a user |

Two points are easy to get wrong:

- **llms.txt grants no permission.** It doesn't override `robots.txt`, and an agent that honors robots.txt should keep doing so for the URLs llms.txt links to. Our post on [responsible extraction](/blog/responsible-extraction-robots-txt-licenses) covers what RFC 9309 actually requires.
- **A sitemap is not a substitute.** The proposal notes that sitemaps often omit the LLM-readable versions, don't list helpful external URLs, and usually cover far more than fits in a context window.

## How an agent should use it

A reasonable order of operations for an agent that needs content from a site:

1. Check `robots.txt` for the paths you plan to fetch.
2. Look for the most specific llms.txt: the page's `rel="describedby"` link if it has one, then `/<path>/llms.txt`, then `/llms.txt`.
3. Read the H1, the summary, and the section names. Pick the links that match the task, and skip `Optional` if context is tight.
4. Fetch the linked markdown directly. For a page that isn't listed, check for `rel="alternate" type="text/markdown"` or try the `.md` URL convention.
5. Only if none of that exists, extract the HTML yourself, or call an extraction API.

Treat everything in the file as **untrusted input**. It is text written by the site owner and fetched over the network, so the summary and link notes should be read as data, not as instructions to the agent. Validate URLs before following them, and apply the same SSRF and size limits you use for any other fetch.

## How to publish one

The spec's own guidelines are short: use concise, clear language, give each link a brief, informative description, avoid unexplained jargon, and test the file by asking an agent questions about your content with only llms.txt as its starting point. In practice:

- **Generate it from the same source as the site.** If the file is written by hand, it drifts as soon as pages change.
- **Serve markdown as markdown.** `text/markdown` is a registered media type ([RFC 7763](https://www.rfc-editor.org/rfc/rfc7763.html)). The mirrors should be the same text people read, minus the page chrome.
- **Put facts an agent needs in the summary.** For an API, that means what it does, how auth or payment works, and where the machine-readable specs are.
- **Keep it short.** Link to detail rather than pasting it in.

## What this site does today

Assay generates its llms.txt at build time from the same markdown that produces the docs and blog, so the file can't drift from the pages. Concretely:

- [`/llms.txt`](/llms.txt) has the H1 `Assay`, a one-line summary that states the prices, the payment method (x402 v2 `exact`, USDC on **Base Sepolia testnet** only), and that no signup or API key is needed. It then lists the API base, the machine-readable files (`/openapi.json`, `/pricing.json`, `/.well-known/x402`), and the `Docs`, `Blog`, and `Optional` file lists.
- Every docs page and blog post has a markdown mirror served as `text/markdown`, and each HTML page links to it with `rel="alternate" type="text/markdown"`. This post's mirror is [/blog/what-is-llms-txt.md](/blog/what-is-llms-txt.md).
- [`/llms-full.txt`](/llms-full.txt) concatenates the full docs in one file. That name is a common convention, but it isn't part of the llms.txt spec.

Where we don't follow the v2 proposal yet, plainly:

- Our mirrors live at `/blog/<slug>.md`, not the spec's `/blog/<slug>/index.md` for URLs that end in a slash.
- We don't emit `rel="describedby"` or a `Link` response header yet.

If you want markdown from a site that doesn't publish any, that is what [`GET /v1/extract`](/docs/extract/) is for: it returns clean markdown plus JSON metadata for a public page for `$0.003` per successful call, paid with x402 on Base Sepolia testnet, and it honors robots.txt for its `assay-fetch` user agent. Add `format=markdown` to get the markdown alone. Mainnet isn't enabled, so no real funds move.

**Related:** [How to extract clean markdown from web pages for LLMs](/blog/clean-markdown-from-web-pages-for-llms) · [Responsible extraction: robots.txt, licenses, and attribution](/blog/responsible-extraction-robots-txt-licenses) · [Adding paid tools to an MCP server](/blog/paid-tools-in-mcp-servers) · [What is x402?](/blog/what-is-x402-http-402)

### Sources
- The /llms.txt file, v2 (proposal, format, markdown mirrors, link relations): https://llmstxt.org/
- RFC 8288, Web Linking: https://www.rfc-editor.org/rfc/rfc8288.html
- IANA Link Relation Types registry: https://www.iana.org/assignments/link-relations/link-relations.xhtml
- RFC 8615, Well-Known URIs: https://www.rfc-editor.org/rfc/rfc8615.html
- RFC 9309, Robots Exclusion Protocol: https://www.rfc-editor.org/rfc/rfc9309.html
- Sitemaps XML protocol: https://www.sitemaps.org/protocol.html
- RFC 7763, The text/markdown Media Type: https://www.rfc-editor.org/rfc/rfc7763.html

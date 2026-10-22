---
title: "robots.txt for AI Crawlers: User-Agent Tokens, Rules That Work, and How Agents Should Check Them"
description: "A practical guide to robots.txt for AI crawlers: the tokens OpenAI, Anthropic, Google, Apple, and Common Crawl document (GPTBot, ClaudeBot, Google-Extended, Applebot-Extended, CCBot and more), how RFC 9309 picks a group and a rule, mistakes that silently break opt-outs, and how an agent should check robots.txt before it fetches."
slug: robots-txt-for-ai-crawlers
date: 2026-10-22
keywords: [robots.txt for AI crawlers, block GPTBot robots.txt, ClaudeBot robots.txt, Google-Extended, Applebot-Extended, RFC 9309 matching rules]
---

# robots.txt for AI crawlers: user-agent tokens, rules that work, and how agents should check them

**robots.txt for AI crawlers** works exactly like robots.txt for search engines: one file at the root of each host, groups that start with `User-agent:` lines, and `Allow` / `Disallow` rules matched by path. What's different is the number of tokens and what each one controls. This file keeps a site in search and in AI answers while opting out of model training, using only tokens the operators themselves document:

```text
# Training crawlers and training-control tokens: opt out
User-agent: GPTBot
User-agent: ClaudeBot
User-agent: Google-Extended
User-agent: Applebot-Extended
User-agent: CCBot
Disallow: /

# Search and answer crawlers: allowed, except private paths
User-agent: OAI-SearchBot
User-agent: Claude-SearchBot
User-agent: Googlebot
User-agent: Applebot
Allow: /
Disallow: /account/

# Everyone else
User-agent: *
Disallow: /account/

Sitemap: https://example.com/sitemap.xml
```

The rest of this post explains what each token means according to its operator, how [RFC 9309](https://www.rfc-editor.org/rfc/rfc9309.html) decides which group and rule apply, the mistakes that quietly undo an opt-out, and how an agent or extraction service should check the file before fetching. For licenses, attribution, and politeness beyond robots.txt, see [responsible extraction: robots.txt, licenses, and attribution](/blog/responsible-extraction-robots-txt-licenses).

## The tokens operators document

Each row below comes from the operator's own documentation (linked under Sources). Operators add and rename agents, so check those pages before relying on this table.

| Token | Operator | What it controls, per the operator |
|---|---|---|
| `GPTBot` | OpenAI | Crawls content that may be used to train OpenAI's generative foundation models. Disallowing it signals the content shouldn't be used for training. |
| `OAI-SearchBot` | OpenAI | Surfaces sites in ChatGPT's search features. Opted-out sites aren't shown in ChatGPT search answers, though they can still appear as navigational links. |
| `ChatGPT-User` | OpenAI | Fetches made for user actions in ChatGPT and Custom GPTs. Not an automatic crawler, and OpenAI says robots.txt rules "may not apply" because the actions are user-initiated. |
| `ClaudeBot` | Anthropic | Collects content that could contribute to model training. Restricting it signals that future materials should be excluded from training datasets. |
| `Claude-SearchBot` | Anthropic | Indexes content to improve search results. Disabling it may reduce visibility in user search results. |
| `Claude-User` | Anthropic | Fetches pages when a user asks Claude a question. Anthropic lets site owners control it through robots.txt. |
| `Google-Extended` | Google | A control token with no crawler of its own. It governs whether content Google crawls may be used to train future Gemini models and for grounding in Gemini Apps and Vertex AI. It doesn't affect inclusion or ranking in Google Search. |
| `Googlebot` | Google | Google Search and related products such as Images, News, and Discover. |
| `Applebot` | Apple | Search in Spotlight, Siri, and Safari. Apple says its crawled data may also be used for model training unless `Applebot-Extended` is disallowed. |
| `Applebot-Extended` | Apple | A control token that doesn't crawl. Disallowing it opts content out of training Apple's foundation models; pages can still appear in search. |
| `CCBot` | Common Crawl | Builds the open Common Crawl corpus, which many third parties download. |

Three things in that table matter more than any single token:

1. **Training and search are separate switches.** OpenAI says the two bots are independent, so you can allow `OAI-SearchBot` and disallow `GPTBot`. Anthropic splits its bots the same way. Blocking everything with `User-agent: *` also removes you from the search and answer products.
2. **Some tokens are policies, not crawlers.** `Google-Extended` and `Applebot-Extended` never appear in your access logs. The fetch happens as `Googlebot` or `Applebot`, and the token only says how the result may be used. Blocking `Googlebot` to stop training also removes you from Google Search.
3. **User-initiated fetchers are a gray area.** OpenAI says robots.txt "may not apply" to `ChatGPT-User`. Anthropic says `Claude-User` can be controlled with robots.txt. If you need a hard block, robots.txt isn't access control, and you need authentication or server-side rules.

## How RFC 9309 picks the rules

Most robots.txt surprises come from not knowing how a compliant crawler reads the file. RFC 9309, published in 2022, standardized the behavior that had been informal since 1994:

- **Exactly one group applies.** A crawler finds the group whose `User-agent` line matches its product token, compared case-insensitively. If several groups name the same token, their rules are combined. Only if no group matches does it fall back to `User-agent: *`. A crawler with its own group **ignores the `*` group completely**.
- **Consecutive `User-agent` lines share one group.** That's why the example above lists five tokens over a single `Disallow: /`.
- **The most specific rule wins.** Among `Allow` and `Disallow` rules that match the path, the one with the most octets wins. If an `Allow` and a `Disallow` are equivalent, the `Allow` should win.
- **Two special characters.** `*` matches any sequence of characters and `$` anchors the end of the path. Paths are case-sensitive.
- **Errors have defined meanings.** If the file returns a 4xx, such as a 404, the crawler may access everything. If it is unreachable, for example because of a 5xx, the crawler must assume a complete disallow. Crawlers should follow at least five redirects, must parse at least 500 KiB, and shouldn't use a cached copy for more than 24 hours unless the file is unreachable.
- **Nothing else is standardized.** `Crawl-delay` isn't in RFC 9309. Anthropic says it supports it as a non-standard extension; Apple says Applebot doesn't follow it.

## Mistakes that silently break an opt-out

- **Expecting `*` rules to stack.** Suppose `User-agent: *` disallows `/private/`, and `User-agent: GPTBot` disallows `/drafts/`. GPTBot uses only its own group, so it may fetch `/private/`. Repeat shared rules in every named group.
- **A blank `Disallow:`.** An empty value matches nothing, so `Disallow:` with no path allows everything. Use `Disallow: /` to block the whole site.
- **One file for many hosts.** robots.txt applies per host, scheme, and port. `blog.example.com` needs its own file, and Anthropic's page says the same for subdomains.
- **Blocking by IP instead.** Anthropic warns that blocking its IP addresses may not work persistently, because it then can't read your robots.txt file.
- **Trusting the User-Agent header.** Google and Common Crawl both warn that user-agent strings get spoofed. To verify a request, use reverse DNS or the IP ranges the operators publish, such as `openai.com/gptbot.json`, Google's `common-crawlers.json`, and `index.commoncrawl.org/ccbot.json`.
- **Blocking CSS and JavaScript.** Apple notes that Applebot may render pages, and that blocked resources can stop it from rendering them properly.

## How an agent should check robots.txt before it fetches

If your agent fetches pages on its own, it is a crawler for robots.txt purposes, and it should behave like one: pick a stable product token, link it to a page that explains who you are, and check rules before each fetch. Assay's checker is about 40 lines of TypeScript, and it's in the open repository at [`src/robots.ts`](https://github.com/Anateghi/assay402/blob/main/src/robots.ts). Here is the core of the RFC 9309 selection logic, lightly condensed:

```ts
// Pick our group (else "*"), longest match wins, Allow wins ties.
export function isAllowed(txt: string, pathWithQuery: string, token = "assay-fetch") {
  const groups = parseRobots(txt); // [{ agents: string[], rules: { allow, path }[] }]
  const ours = groups.filter((g) => g.agents.some((a) => a !== "*" && token.toLowerCase().startsWith(a)));
  const pick = ours.length ? ours : groups.filter((g) => g.agents.includes("*"));
  let best: { allow: boolean; path: string } | null = null;
  for (const g of pick) for (const r of g.rules) {
    if (!matches(r.path, pathWithQuery)) continue; // supports * and $
    if (!best || r.path.length > best.path.length || (r.path.length === best.path.length && r.allow)) best = r;
  }
  return best ? { allowed: best.allow, rule: `${best.allow ? "Allow" : "Disallow"}: ${best.path}` } : { allowed: true, rule: null };
}
```

Beyond the matching itself, a well-behaved agent fetcher should:

1. **Check before every fetch and cache per origin.** Fetching robots.txt for every page is wasteful, but a cache that never expires ignores changes. RFC 9309 sets the ceiling at 24 hours; we use one hour.
2. **Fail closed on server errors.** A 5xx on robots.txt means "assume disallow", not "assume allowed".
3. **Return the reason.** When a fetch is blocked, tell the caller which rule blocked it so a developer can see why, instead of getting an empty page.
4. **Treat robots.txt as the floor.** It says nothing about licenses, paywalls, or terms of service. Those still apply.

## What Assay does today

[`GET /v1/extract`](/docs/extract/) (web page to clean markdown and JSON metadata) and the PDF endpoint fetch as `assay-fetch/0.1` and check robots.txt for the `assay-fetch` token, falling back to `*`, before every fetch:

- A disallowed path returns **HTTP 451** with the matching rule in the error message, and **you aren't charged**: x402 payment settles only on a successful response.
- A successful response includes a `robots` object with `allowed: true` and the rule that matched, if any, so your pipeline can record why the fetch was permitted.
- A 4xx on robots.txt is treated as "allowed" and a 5xx as a full disallow, per RFC 9309. Rules are cached per origin for one hour.
- Site owners can opt out of all Assay fetches with `User-agent: assay-fetch` and `Disallow: /`. The token is documented in the [repository README](https://github.com/Anateghi/assay402#crawler).

Extraction costs `$0.003` per successful call, paid with x402 v2 in USDC on **Base Sepolia testnet**. Mainnet isn't enabled yet, so no real funds move. If you're new to the payment flow, start with [what is x402?](/blog/what-is-x402-http-402).

**Related:** [How to extract clean markdown from web pages for LLMs](/blog/clean-markdown-from-web-pages-for-llms) · [What is llms.txt?](/blog/what-is-llms-txt) · [Responsible extraction: robots.txt, licenses, and attribution](/blog/responsible-extraction-robots-txt-licenses) · [How to pay for APIs from an AI agent](/blog/pay-for-apis-from-an-ai-agent)

### Sources
- RFC 9309, Robots Exclusion Protocol: https://www.rfc-editor.org/rfc/rfc9309.html
- OpenAI, Overview of OpenAI Crawlers: https://platform.openai.com/docs/bots
- Anthropic, Does Anthropic crawl data from the web, and how can site owners block the crawler?: https://support.anthropic.com/en/articles/8896518-does-anthropic-crawl-data-from-the-web-and-how-can-site-owners-block-the-crawler
- Google, List of Google's common crawlers (including Google-Extended): https://developers.google.com/search/docs/crawling-indexing/google-common-crawlers
- Apple, About Applebot (including Applebot-Extended): https://support.apple.com/en-us/119829
- Common Crawl, CCBot: https://commoncrawl.org/ccbot

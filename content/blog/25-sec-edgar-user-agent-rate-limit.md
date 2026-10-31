---
title: "SEC EDGAR User-Agent and Rate Limit: How to Declare Your Bot and Stay Under 10 Requests per Second"
description: "The SEC EDGAR User-Agent and rate limit rules for scripts and AI agents: what a declared User-Agent looks like, what the 'Undeclared Automated Tool' 403 means, how the 10 requests/second ceiling and 10-minute cool-down work, and a shared Node.js limiter you can drop in."
slug: sec-edgar-user-agent-rate-limit
date: 2026-10-31
keywords: [SEC EDGAR user-agent rate limit, Undeclared Automated Tool 403, data.sec.gov 10 requests per second, SEC fair access policy, EDGAR API User-Agent header]
---

# SEC EDGAR User-Agent and rate limit: declare your bot, stay under 10 requests per second

The **SEC EDGAR User-Agent and rate limit** rules come down to two things. Send a `User-Agent` that names your company and gives a contact email, and keep every machine you run, combined, under **10 requests per second**. If you skip the first, `data.sec.gov` and `www.sec.gov` answer `403` with a page titled "Your Request Originates from an Undeclared Automated Tool". If you break the second, the SEC may limit your IP until your rate has stayed below the threshold for 10 minutes. This client handles both (Node 20+):

```js
// edgar.mjs: one limiter per process. Share it across every worker and tool call.
const UA = process.env.SEC_USER_AGENT; // e.g. "ExampleCo Research research@example.com"
if (!UA || !/@/.test(UA)) throw new Error("Set SEC_USER_AGENT to 'Company Name contact@email'");

const MAX_PER_SEC = 8; // SEC's ceiling is 10/s across all your machines; keep headroom
const gap = 1000 / MAX_PER_SEC;
let next = 0;
const slot = () => {
  const now = Date.now(), at = Math.max(now, next);
  next = at + gap;
  return new Promise((r) => setTimeout(r, at - now));
};

export async function secGet(url) {
  await slot();
  const res = await fetch(url, { headers: { "User-Agent": UA, "Accept-Encoding": "gzip, deflate" } });
  if (res.status === 403 || res.status === 429) {
    // Undeclared-tool block or rate limiting: stop, don't retry in a loop.
    throw new Error(`SEC refused (${res.status}). Check User-Agent; pause >= 10 min if you were over 10 req/s.`);
  }
  if (!res.ok) throw new Error(`SEC HTTP ${res.status} for ${url}`);
  return res.json();
}

const cik = "320193"; // Apple Inc.
const sub = await secGet(`https://data.sec.gov/submissions/CIK${cik.padStart(10, "0")}.json`);
console.log(sub.name, sub.filings.recent.form.slice(0, 5));
```

Run it with `SEC_USER_AGENT="ExampleCo Research research@example.com" node edgar.mjs`. We ran it on 2026-10-31. It printed `Apple Inc.` and the five most recent form types. Five parallel `secGet` calls finished spaced out by the limiter, not all at once.

This post covers the access rules. For the data itself (submissions, `companyfacts`, XBRL frames, and filing documents), see the pillar post, [SEC EDGAR as JSON for AI agents](/blog/sec-edgar-json-for-ai-agents).

## What the SEC actually requires

There are three primary sources, and they agree:

- **[Accessing EDGAR Data](https://www.sec.gov/search-filings/edgar-search-assistance/accessing-edgar-data)**, under "Fair access", says: "Current max request rate: 10 requests/second." It asks you to "declare your user agent in request headers" and gives this sample:

  ```http
  User-Agent: Sample Company Name AdminContact@<sample company domain>.com
  Accept-Encoding: gzip, deflate
  Host: www.sec.gov
  ```

- **The [Internet Security Policy](https://www.sec.gov/about/privacy-information#security)** sets the scope and the penalty: "no more than 10 requests per second, regardless of the number of machines used to submit requests". Above that, "further requests from the IP address(es) may be limited for a brief period. Once the rate of requests has dropped below the threshold for 10 minutes, the user may resume accessing content on SEC.gov." It also says the SEC "does not allow 'unclassified' bots or automated tools to crawl the site."
- **The [EDGAR API page](https://www.sec.gov/search-filings/edgar-application-programming-interfaces)** says the `data.sec.gov` APIs "do not require any authentication or API keys," that the site "does not support Cross Origin Resource Scripting (CORS)," and that automated access must follow the same Privacy and Security Policy.

So you don't need a key or a signup. Your User-Agent is your identity, and the limit is per user, not per connection or per worker.

## What a 403 "Undeclared Automated Tool" looks like

We sent the same request (`GET https://data.sec.gov/submissions/CIK0000320193.json`) from one IP with different `User-Agent` values on 2026-10-31:

| User-Agent sent | Status |
|---|---|
| *(empty)* | `403`, "Undeclared Automated Tool" page |
| `curl/8.5.0` | `403` |
| `python-requests/2.32.3` | `403` |
| `AssayResearch research@example.com` | `200`, JSON |

The 403 comes from Akamai (`server: AkamaiGHost`) as `text/html`. It is not JSON, so a client that calls `res.json()` blindly fails with a parse error that hides the real cause. The page says: "Please declare your traffic by updating your user agent to include company specific information." It also includes a `Reference ID` and points to `opendata@sec.gov`.

These four requests are a spot check, not a map of SEC's filtering. The SEC doesn't publish its rules, and they can change. Don't try to find the shortest string that gets through. Send what the SEC asks for: a real organization name and a real, monitored contact address.

Two practical consequences:

- **Library defaults get blocked.** Default user agents from `curl`, `python-requests`, and similar tools identify the tool, not you. Always set the header explicitly.
- **Browsers are the wrong place for this.** The SEC says `data.sec.gov` does not support CORS, and you can't count on a browser letting page scripts set their own `User-Agent`. Call EDGAR from a server, a worker, or the agent's tool runtime.

## How to stay under 10 requests per second

The limit covers everything you run, "regardless of the number of machines." That changes how agents should be built:

1. **One limiter per identity, not per worker.** Eight workers that each allow 10 req/s add up to 80 req/s. In a single process, share one module-level limiter, as in the snippet above. Across processes or machines, put the limiter in shared storage (a Redis token bucket, for example) or send all EDGAR traffic through one service.
2. **Leave headroom.** The snippet uses 8/s. Retries, redirects, and a second job someone starts later all count toward the same 10.
3. **Space requests out, don't burst.** The limiter gives each request its own time slot, `gap` ms after the last one. A burst of 10 in the first 50 ms of a second technically stays at 10/s, but it is exactly the traffic pattern rate limiters dislike.
4. **Cache by URL.** Filing documents under `/Archives/edgar/data/` don't change after dissemination, except for rare post-acceptance corrections. The [submissions API is updated](https://www.sec.gov/search-filings/edgar-application-programming-interfaces) "in real-time" as filings arrive, so cache it for minutes, not forever.
5. **Use bulk files for bulk work.** For more than a handful of companies, the SEC publishes nightly `companyfacts.zip` and `submissions.zip` archives, and calls them "the most efficient means to fetch large amounts of API data." A single download replaces thousands of calls.

## What to do when you get blocked

- **`403` with the Undeclared Automated Tool page:** fix the User-Agent. Retrying with the same header won't help.
- **Refused after a burst:** stop all EDGAR traffic from that IP. The policy says access resumes once your rate "has dropped below the threshold for 10 minutes." Retrying in a tight loop keeps you above the threshold and extends the block. The SEC doesn't document which status code or `Retry-After` header it sends in this case, so the snippet treats both `403` and `429` ([RFC 6585 §4](https://www.rfc-editor.org/rfc/rfc6585#section-4)) as stop signals and doesn't guess.
- **Still blocked with a correct header and a low rate:** the [Webmaster FAQ](https://www.sec.gov/about/webmaster-frequently-asked-questions) says to email `webmaster@sec.gov` with the error text and your IP address. The SEC also says it does not offer technical support for scripted downloads, so include the Reference ID from the 403 page.

For an LLM agent, return a short, clear tool error such as "SEC refused: undeclared User-Agent" or "SEC rate-limited: wait 10 minutes". Don't pass along 4 KB of HTML. Otherwise the model may decide to "try again" ten times.

## A checklist for agent tool authors

- `User-Agent: <Organization> <contact email>`, read from config and checked at startup.
- `Accept-Encoding: gzip, deflate`. Node's `fetch` decompresses gzip responses automatically.
- One shared limiter at 10 req/s or less for all EDGAR traffic from your organization.
- Check `Content-Type` before you parse. The block page is HTML.
- Cache filing documents permanently and API JSON briefly. Use the bulk ZIPs for wide scans.
- Run server-side only.

## Where Assay fits, honestly

Assay does not have an EDGAR endpoint today. It ships [`GET /v1/extract`](/docs/extract/) (web page to markdown, $0.003 per successful call) and [`POST /v1/pdf/text`](/docs/pdf-text/) (PDF to text, $0.01 per successful call), paid per call with x402 on Base Sepolia testnet.

Fetching `sec.gov` pages through `/v1/extract` does **not** work right now. Assay's fetcher identifies itself as `assay-fetch/0.1 (+https://github.com/Anateghi/assay402#crawler)` ([crawler docs](/docs/crawler/)). That string names a tool and a URL, not a company and a contact email. When we sent requests with that exact User-Agent to `www.sec.gov` and `data.sec.gov` on 2026-10-31, they got `403`. An extract call for a SEC URL therefore returns `502 upstream_status` ("Upstream returned HTTP 403"). Under Assay's [charge policy](/docs/limits/), failed calls are never settled, so you aren't charged, but you don't get the document either. Fetch EDGAR yourself with the client above. If you need markdown from a filing's HTML, run the extraction locally. [Clean markdown from web pages](/blog/clean-markdown-from-web-pages-for-llms) shows how. An EDGAR endpoint that follows these rules is on the roadmap, not live.

**Related:** [SEC EDGAR as JSON for AI agents](/blog/sec-edgar-json-for-ai-agents) · [Responsible extraction: robots.txt, licenses, and attribution](/blog/responsible-extraction-robots-txt-licenses) · [robots.txt for AI crawlers](/blog/robots-txt-for-ai-crawlers) · [Rate limits and errors](/docs/limits/)

### Sources
- SEC, Accessing EDGAR Data (fair access, 10 requests/second, sample declared User-Agent): https://www.sec.gov/search-filings/edgar-search-assistance/accessing-edgar-data
- SEC, Privacy Information, Internet Security Policy (all machines combined, 10-minute recovery, unclassified bots): https://www.sec.gov/about/privacy-information#security
- SEC, EDGAR Application Programming Interfaces (no API keys, no CORS, bulk ZIPs, update schedule): https://www.sec.gov/search-filings/edgar-application-programming-interfaces
- SEC, Webmaster Frequently Asked Questions ("Undeclared Automated Tool", programmatic downloads): https://www.sec.gov/about/webmaster-frequently-asked-questions
- SEC, Developer Resources: https://www.sec.gov/about/developer-resources
- RFC 6585 §4, 429 Too Many Requests: https://www.rfc-editor.org/rfc/rfc6585#section-4
- RFC 9110 §10.1.5, User-Agent: https://www.rfc-editor.org/rfc/rfc9110#section-10.1.5

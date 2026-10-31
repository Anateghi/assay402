---
title: "SEC EDGAR as JSON for AI Agents: Submissions, XBRL Facts, and Filings"
description: "How the official data.sec.gov APIs work, the fair-access rules you must follow, and how to turn 10-K and 10-Q filings into agent-ready JSON."
slug: sec-edgar-json-for-ai-agents
date: 2026-10-16
keywords: [SEC EDGAR API JSON, data.sec.gov, XBRL companyfacts, 10-K to JSON, SEC filings for LLM, EDGAR rate limit]
---

# SEC EDGAR as JSON for AI agents

US public company filings are some of the best free data available to agents. They are authoritative and timestamped, and as US government works they are generally not subject to copyright. The SEC publishes official JSON APIs at `data.sec.gov`. This post explains what they offer and where an agent still needs help.

## Fair-access rules first
The SEC's [Accessing EDGAR Data](https://www.sec.gov/os/accessing-edgar-data) page sets two rules that matter in practice:

- **Declare a User-Agent** that identifies you and gives a contact, e.g. `User-Agent: ExampleCo research@example.com`. Requests without one may be blocked.
- **Stay within 10 requests per second** per user, across all of your machines.

Break these rules and your IP can be throttled. Agents running in parallel can hit 10 req/s easily, so use a shared rate limiter, not a per-worker one.

## The official JSON APIs
Documented at [EDGAR Application Programming Interfaces](https://www.sec.gov/search-filings/edgar-application-programming-interfaces):

| Endpoint | Returns |
|---|---|
| `https://data.sec.gov/submissions/CIK##########.json` | Company metadata and recent filing history (form type, accession number, filing and report dates, primary document) |
| `https://data.sec.gov/api/xbrl/companyfacts/CIK##########.json` | Every XBRL fact the company has reported, by taxonomy and concept |
| `https://data.sec.gov/api/xbrl/companyconcept/CIK##########/us-gaap/Revenues.json` | One concept over time for one company |
| `https://data.sec.gov/api/xbrl/frames/us-gaap/Revenues/USD/CY2023.json` | One concept across all companies for one period |

The CIK is **zero-padded to 10 digits**: Apple's CIK 320193 becomes `CIK0000320193`. To map a ticker to a CIK, use the SEC's [company_tickers.json](https://www.sec.gov/files/company_tickers.json).

```bash
curl -s -H "User-Agent: ExampleCo research@example.com" \
  https://data.sec.gov/submissions/CIK0000320193.json | jq '.filings.recent.form[:5]'
```

The SEC also publishes nightly bulk ZIPs (`submissions.zip`, `companyfacts.zip`) for full-dataset work. Use those instead of crawling.

## The parts agents struggle with

### 1. Columnar "recent" filings
`filings.recent` stores data as **parallel arrays** (`form[]`, `accessionNumber[]`, `filingDate[]`, …), not as an array of objects. Models misalign indices easily. Zip the arrays into records before you hand them to a model. Older filings are paginated into separate files listed under `filings.files`.

### 2. XBRL facts need context
A `companyfacts` entry looks like this:

```json
{"end":"2023-09-30","val":383285000000,"accn":"0000320193-23-000106",
 "fy":2023,"fp":"FY","form":"10-K","filed":"2023-11-03","frame":"CY2023"}
```

Things to know:
- **Duration vs. instant:** income-statement items have `start` and `end` dates, while balance-sheet items have only `end`.
- **Duplicates:** the same value appears again in later filings as a comparative figure. Deduplicate on (`end`, `start`, `val`), and prefer the filing where the period is the primary period, or use the `frame` field, which the SEC assigns to one fact per calendar period.
- **Concept drift:** companies switch tags (e.g. `Revenues` vs. `RevenueFromContractWithCustomerExcludingAssessedTax`). "Revenue" in practice means checking several concepts.
- **Units:** facts are keyed by unit (`USD`, `shares`, `USD/shares`). Don't mix them.
- **Fiscal vs. calendar:** `fy`/`fp` describe the *filing's* fiscal period, which can differ from the fact's own period. Rely on `start`/`end`.

### 3. The narrative is not in XBRL
Risk factors, MD&A, and legal proceedings live in the primary HTML document. To build its URL, take the accession number without dashes and the primary document name:

```
https://www.sec.gov/Archives/edgar/data/320193/000032019323000106/aapl-20230930.htm
```

10-K item headings ("Item 1A. Risk Factors", "Item 7. Management's Discussion…") follow [Form 10-K's](https://www.sec.gov/files/form10-k.pdf) required structure, but the HTML varies widely between filers. Split sections by matching item headings in text order, skip the table of contents (its headings appear first, as links), and handle "Item 1A" written as "ITEM 1A." or broken across tags.

### 4. Amendments and restatements
`10-K/A` amends an earlier filing. An agent asking for "the latest annual numbers" should know whether an amendment replaces them.

## A worked agent task: "How did Apple's risk factors change year over year?"
1. Resolve the ticker `AAPL` to CIK `0000320193` through `company_tickers.json`.
2. Read `submissions` and select the two most recent filings where `form == "10-K"` (skip `10-K/A` unless the user asks about amendments).
3. For each filing, fetch the primary document and extract Item 1A.
4. Split each Item 1A into individual risk factors. Most filers use a bold or italic heading sentence per risk.
5. Match the risks across years by heading similarity, then summarize what was added, removed, or reworded, and cite both accession numbers.

Steps 2–4 are deterministic and should not be done by the model. Run them in code (or through an endpoint) and give the model only the two lists of risk factors. You will use fewer tokens and get fewer hallucinated section boundaries.

## What an agent-ready response looks like
Assay does not offer an EDGAR endpoint yet; today it ships web extraction and PDF-to-text. If you build this yourself, an agent-ready response could look like this:

```json
{
  "cik": "0000320193",
  "company": "Apple Inc.",
  "form": "10-K",
  "accession": "0000320193-23-000106",
  "filed": "2023-11-03",
  "period_end": "2023-09-30",
  "source_url": "https://www.sec.gov/Archives/edgar/data/320193/000032019323000106/aapl-20230930.htm",
  "sections": {
    "1": { "title": "Business", "markdown": "…" },
    "1A": { "title": "Risk Factors", "markdown": "…" },
    "7": { "title": "Management's Discussion and Analysis…", "markdown": "…" }
  },
  "financials": {
    "revenue": { "value": 383285000000, "unit": "USD", "concept": "us-gaap:RevenueFromContractWithCustomerExcludingAssessedTax", "start": "2022-09-25", "end": "2023-09-30" }
  }
}
```

The example values come from Apple's FY2023 10-K. Verify them against the [filing index](https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=0000320193&type=10-K) yourself. Every number carries its concept and period, so the agent can cite it, and `source_url` points back to the primary document.

## Do it yourself or call an API
Everything above is doable with free official data, and for a single company it's a good weekend project. Calling an endpoint makes sense when you need the section splitting, fact deduplication, concept mapping, caching, and rate-limit discipline maintained for you, at a price per call. An EDGAR endpoint is on the Assay roadmap, not live. Until then, fetch filings yourself with a declared User-Agent. Assay's [`/v1/extract`](/docs/extract/) fetcher currently gets a `403` from sec.gov (see [SEC EDGAR User-Agent and rate limit](/blog/sec-edgar-user-agent-rate-limit)), so convert the HTML locally and do the section splitting in your own code.

### Disclaimer
This is not investment advice. Filings can contain errors, so always cite the source document.

### Sources
- Accessing EDGAR Data (fair access, User-Agent): https://www.sec.gov/os/accessing-edgar-data
- EDGAR APIs: https://www.sec.gov/search-filings/edgar-application-programming-interfaces
- Ticker→CIK map: https://www.sec.gov/files/company_tickers.json
- Form 10-K instructions: https://www.sec.gov/files/form10-k.pdf

---
title: "Wikidata SPARQL Examples for AI Agents: Tickers to QIDs, CIK Lookups, Type Checks, and Ranks"
description: "Working Wikidata SPARQL examples for agent tools: map stock tickers to QIDs and SEC CIKs with qualifiers, reverse-lookup external IDs, search inside SPARQL with EntitySearch, check types with P31/P279*, and read ranks correctly. Plus the WDQS limits, User-Agent rules, and the query-injection guard an agent needs."
slug: wikidata-sparql-examples-for-agents
date: 2026-11-01
keywords: [wikidata sparql examples, wikidata query service api, wikidata ticker to QID, wikidata CIK P5531, sparql qualifiers p ps pq, WDQS rate limit 429]
---

# Wikidata SPARQL examples for AI agents: tickers to QIDs, CIK lookups, type checks, and ranks

These **Wikidata SPARQL examples** are the queries an agent tool actually needs: turn an identifier you already have (a ticker, a CIK) into a stable QID, check what kind of thing an item is, and read values without tripping over ranks and qualifiers. Start with a complete, runnable tool. It maps stock tickers to Wikidata QIDs and SEC Central Index Keys against the public [Wikidata Query Service](https://query.wikidata.org/) (Node 20+):

```js
// wd.mjs: map stock tickers to Wikidata QIDs and SEC CIKs (Node 20+)
const UA = process.env.WIKIDATA_USER_AGENT; // e.g. "ExampleAgent/0.1 (https://example.com/bot; ops@example.com)"
if (!UA) throw new Error("Set WIKIDATA_USER_AGENT: tool name, URL or email (Wikimedia User-Agent policy)");

export async function sparql(query) {
  const url = "https://query.wikidata.org/sparql?" + new URLSearchParams({ query });
  const res = await fetch(url, { headers: { "User-Agent": UA, Accept: "application/sparql-results+json" } });
  if (res.status === 429) throw new Error(`WDQS throttled; retry after ${res.headers.get("retry-after")}s`);
  if (!res.ok) throw new Error(`WDQS HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return (await res.json()).results.bindings;
}

const lit = (s) => JSON.stringify(String(s)); // safe SPARQL string literal: quotes and backslashes escaped

export async function tickersToQids(tickers, exchangeQid = "Q82059" /* Nasdaq */) {
  const rows = await sparql(`
    SELECT ?ticker ?company ?companyLabel ?cik WHERE {
      VALUES ?ticker { ${tickers.map(lit).join(" ")} }
      ?company p:P414 ?listing .
      ?listing ps:P414 wd:${exchangeQid} ; pq:P249 ?ticker .
      FILTER NOT EXISTS { ?listing pq:P582 ?ended }        # skip delisted/ended listings
      FILTER NOT EXISTS { ?listing wikibase:rank wikibase:DeprecatedRank }
      OPTIONAL { ?company wdt:P5531 ?cik }                  # SEC Central Index Key
      SERVICE wikibase:label { bd:serviceParam wikibase:language "en". }
    }`);
  return rows.map((r) => ({
    ticker: r.ticker.value,
    qid: r.company.value.split("/").pop(),
    label: r.companyLabel.value,
    cik: r.cik?.value ?? null,
  }));
}

console.table(await tickersToQids(["AAPL", "GOOGL", "META", "MSFT"]));
```

Run it with `WIKIDATA_USER_AGENT="ExampleAgent/0.1 (https://example.com/bot; ops@example.com)" node wd.mjs`. When we ran it on 2026-11-01 it printed one row per ticker: `AAPL → Q312` (Apple Inc., CIK `0000320193`), `GOOGL → Q20800404` (Alphabet Inc.), `META → Q380` (Meta Platforms), and `MSFT → Q2283` (Microsoft), each with a 10-digit CIK. Wikidata is edited continuously, so your output can differ. That is the point of querying it live.

The rest of this post explains each piece, then adds four more queries an agent tool commonly needs. For the bigger picture (candidate search, disambiguation, and why agents should store QIDs instead of names), read the pillar post, [Wikidata entity resolution for AI agents](/blog/wikidata-entity-resolution-for-agents).

## How to call the Wikidata Query Service from code

The [WDQS user manual](https://www.mediawiki.org/wiki/Wikidata_Query_Service/User_Manual) documents the endpoint and its limits:

- **Endpoint:** `GET` or `POST` to `https://query.wikidata.org/sparql`. The manual recommends GET for small queries and POST for large ones, and notes that "POST queries are not cached". A POST body must still be `query=<url-encoded SPARQL>`.
- **Format:** the default is XML. Ask for JSON with `Accept: application/sparql-results+json` (or `format=json`). The JSON is the standard [SPARQL 1.1 Query Results JSON format](https://www.w3.org/TR/sparql11-results-json/), which is why the code reads `results.bindings[].<var>.value`.
- **Limits:** every query has a 60-second deadline. One client, meaning user agent plus IP, gets "60 seconds of processing time each 60 seconds" and "30 error queries per minute". Clients over the limit get HTTP `429` with a `Retry-After` header, and clients that keep going "can be temporarily banned". Access is also "limited to 5 parallel queries per IP". The manual says these limits can change.
- **User-Agent:** the [Wikimedia User-Agent policy](https://foundation.wikimedia.org/wiki/Policy:Wikimedia_Foundation_User-Agent_Policy) asks bots for a User-Agent that identifies the tool and gives contact details, in the form `CoolBot/0.0 (https://example.org/coolbot/; coolbot@example.org)`. It says not to use generic agents such as `curl` or `Python-urllib`, and not to copy a browser's string. In a spot check on 2026-11-01, a trivial `ASK {}` to the endpoint returned `403` with an empty User-Agent and with `python-requests/2.32.3`, and `200` with a descriptive one.

One structural change matters if your agent touches research papers. Since 9 May 2025, `query.wikidata.org` serves only the **main graph**. Scholarly articles live in a separate graph at `query-scholarly.wikidata.org`, and queries that need both have to use federation ([WDQS graph split](https://www.wikidata.org/wiki/Wikidata:SPARQL_query_service/WDQS_graph_split)). Companies, places, and people are in the main graph, so none of the queries below are affected.

## Example 1: stock ticker to QID, and why qualifiers matter

On Wikidata a ticker is not a property of the company. It is a **qualifier** (`P249`, ticker symbol) on the company's stock exchange statement (`P414`). That is why the query walks the full statement instead of using the `wdt:` shortcut:

```sparql
?company p:P414 ?listing .                     # company → statement node
?listing ps:P414 wd:Q82059 ; pq:P249 ?ticker . # statement → exchange value, and its ticker qualifier
```

`p:` links an item to a statement node, `ps:` links the statement to its value, and `pq:` links it to a qualifier. This is the [Wikibase RDF format](https://www.mediawiki.org/wiki/Wikibase/Indexing/RDF_Dump_Format), and qualifiers are only reachable this way.

The two filters in the tool are there because of real data we hit. Without pinning the exchange or filtering end dates, the same query returned on 2026-11-01:

| Ticker | Items matched | Why |
|---|---|---|
| `META` | Meta Platforms (Nasdaq), plus Nusantara Infrastructure (Indonesia Stock Exchange) and Meta Corporation (Stock Exchange of Thailand) | Tickers are only unique per exchange |
| `GOOGL` | Alphabet Inc. (Nasdaq), plus Google (Q95), whose Nasdaq listing has an end time of 2016 | Listings move when companies restructure |
| `SHEL` | Shell (Q154950), twice: London Stock Exchange and New York Stock Exchange | One company, several listings |

So a ticker alone is not an identifier. Treat `(exchange, ticker)` as the key, filter out listings with an end time (`pq:P582`), and return every remaining match rather than picking one quietly. If an agent passes just "META" with no exchange, the honest answer is a list of candidates.

## Example 2: external ID to QID (SEC CIK and others)

Wikidata works as a crosswalk between identifier systems, and a reverse lookup is a single triple. Here is an SEC Central Index Key ([`P5531`](https://www.wikidata.org/wiki/Property:P5531)) to an item:

```sparql
SELECT ?cik ?company ?companyLabel WHERE {
  VALUES ?cik { "0000320193" "320193" "0001018724" "1018724" }
  ?company wdt:P5531 ?cik .
  SERVICE wikibase:label { bd:serviceParam wikibase:language "en". }
}
```

On 2026-11-01 this matched only the zero-padded forms: `0000320193 → Q312` (Apple) and `0001018724 → Q3884` (Amazon). SPARQL compares strings exactly, so `"320193"` matches nothing for Apple. Most CIK values on Wikidata are 10 digits, but not all: a `COUNT` over `wdt:P5531` values whose length isn't 10 returned 7 that day. Normalize on your side (`cik.padStart(10, "0")`) and send both forms in `VALUES` if you need to catch the strays. The same pattern works for any external-ID property: ISNI, VIAF, OpenStreetMap, ORCID, and so on.

The CIK is what you need to call SEC EDGAR. That call has its own rules (a declared User-Agent with a contact email and at most 10 requests per second); see [SEC EDGAR User-Agent and rate limit](/blog/sec-edgar-user-agent-rate-limit).

## Example 3: search by name inside SPARQL with EntitySearch

When all you have is a name, you need search, not a triple pattern. Matching `rdfs:label` exactly misses aliases and casing. The [MWAPI service](https://www.mediawiki.org/wiki/Wikidata_Query_Service/User_Manual/MWAPI) lets a SPARQL query call Wikidata's own entity search, and then join the results against the graph in the same request:

```sparql
SELECT ?item ?itemLabel ?itemDescription ?isBusiness WHERE {
  SERVICE wikibase:mwapi {
    bd:serviceParam wikibase:endpoint "www.wikidata.org" ; wikibase:api "EntitySearch" ;
                    mwapi:search "Mercury" ; mwapi:language "en" ;
                    mwapi:limit "8" ; wikibase:limit "once" .
    ?item wikibase:apiOutputItem mwapi:item .
    ?rank wikibase:apiOrdinal true .
  }
  BIND(EXISTS { ?item wdt:P31/wdt:P279* wd:Q4830453 } AS ?isBusiness)
  SERVICE wikibase:label { bd:serviceParam wikibase:language "en". }
} ORDER BY ?rank
```

`wikibase:limit "once"` stops the service from following continuations. The MWAPI docs say the service otherwise "will try to fetch all the results of the query, with continuations". `apiOrdinal` keeps the search engine's ranking.

On 2026-11-01 the eight results included the planet (Q308), the chemical element (Q925), the Roman god (Q1150), a commune in Savoie, Ford's automobile marque (Q613883), and Mercury Records (Q165745). `?isBusiness` was `false` for **all eight**, including the car brand and the record label. Mercury Records is an instance of "record label" (Q18127), and that class did not reach business (Q4830453) or organization (Q43229) through `P31/P279*` when we checked. That leads to the next example.

## Example 4: is this item a company? Type checks with P31/P279*

`ASK` returns a single boolean, which makes it the cheapest way to check a type:

```sparql
ASK { wd:Q312 wdt:P31/wdt:P279* wd:Q4830453 }   # Apple Inc. is a business? → true
ASK { wd:Q89  wdt:P31/wdt:P279* wd:Q4830453 }   # apple (the fruit)?       → false
```

`wdt:P31/wdt:P279*` means "an instance of some class that is, through zero or more subclass steps, the target". It's the standard way to say "is a kind of". But Example 3 shows its limits. Wikidata's class tree is crowd-edited, and a missing `P279` link anywhere in the chain turns a correct answer into `false`. In an agent tool:

- **Use type checks to rank candidates, not to reject them.** A false negative should push a candidate down, not hide it.
- **Check a small set of acceptable roots** (for companies, business Q4830453 and organization Q43229, plus any domain-specific classes you have confirmed) rather than one class.
- **Report which check failed.** "No P31/P279* path to Q4830453" is something a human can fix on Wikidata. "Not a company" is not.

Long `P279*` chains on broad classes are also the classic way to hit the 60-second deadline. Keep the subject bound (a specific QID, or a short `VALUES` list) before you add a path expression.

## Example 5: `wdt:` versus `p:`/`ps:` and statement ranks

`wdt:` is the convenient form, and it hides data. The RDF format docs define it precisely: truthy statements are "statements that have the best non-deprecated rank for a given property". If any statement for a property is **preferred**, only the preferred ones show up under `wdt:`. Otherwise all **normal** ones do, and **deprecated** statements never do.

Apple's employee count (`P1128`) shows the difference:

```sparql
SELECT ?employees ?rank WHERE {
  wd:Q312 p:P1128 ?st .
  ?st ps:P1128 ?employees ; wikibase:rank ?rank .
}
```

On 2026-11-01 this returned seven statements: one `PreferredRank` and six `NormalRank`. `SELECT ?v { wd:Q312 wdt:P1128 ?v }` returned only the preferred one. For "current value" questions, `wdt:` is usually what you want. For history, or for anything that needs qualifiers such as a point in time (`pq:P585`) or an end time (`pq:P582`), use the full `p:`/`ps:`/`pq:` path and read `wikibase:rank` yourself. Example 1 needed the full path for two reasons: it reads a qualifier, and it filters deprecated listings explicitly. An ended listing can still be normal rank: Google's GOOGL listing, with its 2016 end time, was `NormalRank` when we checked, so `wdt:` alone would not drop it. See [Help:Ranking](https://www.wikidata.org/wiki/Help:Ranking) for how editors are expected to use ranks.

## Making SPARQL safe to expose as an agent tool

If a model can influence the query text, a SPARQL tool has the same problem as any query builder. Four rules cover it:

1. **Templates, not free-form SPARQL.** Expose `tickers_to_qids(tickers, exchange)` or `cik_to_qid(cik)`, not `run_sparql(query)`. A model that writes arbitrary SPARQL against a shared public endpoint will eventually write a query that runs for 60 seconds, and against your per-client budget.
2. **Escape and validate every interpolated value.** `JSON.stringify` produces a double-quoted string with `"` and `\` escaped, which is a valid SPARQL string literal for ordinary text (SPARQL 1.1 [string escapes](https://www.w3.org/TR/sparql11-query/#grammarEscapes) cover the same `\"`, `\\`, `\n` forms). Also validate shape before building the query: `/^Q\d+$/` for QIDs, `/^\d{1,10}$/` for CIKs, and a short character class for tickers. Never paste a QID into `wd:${...}` without the regex check. The `exchangeQid` in the snippet is a constant for exactly that reason.
3. **Bound the result.** Bind the subject with `VALUES`, cap rows with `LIMIT`, and cap `VALUES` lists at a size you have tested. Fewer, smaller queries also keep you well inside the processing-time budget.
4. **Turn failures into short tool errors.** A `429` should become "Wikidata throttled, retry after N seconds", using the `Retry-After` value. A syntax error counts toward the 30-errors-per-minute limit, so don't let the model retry a broken query in a loop. Cache GET results by query text. Most of these lookups change rarely.

Wikidata's data is released under [CC0](https://www.wikidata.org/wiki/Wikidata:Licensing), so you can store and reuse the results. Still record the QID and the retrieval date with each fact. For bulk work, such as every company with a CIK, use the [JSON dumps](https://www.wikidata.org/wiki/Wikidata:Database_download) instead of hammering the live endpoint.

## Where Assay fits, honestly

Assay does not have a Wikidata or SPARQL endpoint today. The live paid endpoints are [`GET /v1/extract`](/docs/extract/) (web page to markdown, $0.003 per successful call) and [`POST /v1/pdf/text`](/docs/pdf-text/) (PDF to text, $0.01 per successful call), paid per call with x402 on Base Sepolia testnet. Failed calls are never settled ([charge policy](/docs/limits/)). The queries above go straight to Wikimedia's free public service, and that is the right place to run them. A resolver endpoint that returns QIDs plus crosswalk IDs, built on these rules, is on the roadmap. It is not live.

**Related:** [Wikidata entity resolution for AI agents](/blog/wikidata-entity-resolution-for-agents) · [SEC EDGAR as JSON for AI agents](/blog/sec-edgar-json-for-ai-agents) · [SEC EDGAR User-Agent and rate limit](/blog/sec-edgar-user-agent-rate-limit) · [Responsible extraction: robots.txt, licenses, and attribution](/blog/responsible-extraction-robots-txt-licenses)

### Sources
- Wikidata Query Service user manual (endpoint, GET/POST caching, formats, 60 s deadline, per-client limits, 429 and Retry-After, 5 parallel queries, label service): https://www.mediawiki.org/wiki/Wikidata_Query_Service/User_Manual
- WDQS MWAPI service (EntitySearch, wikibase:limit, continuations): https://www.mediawiki.org/wiki/Wikidata_Query_Service/User_Manual/MWAPI
- Wikibase RDF dump format (p:/ps:/pq: prefixes, truthy wdt: statements, ranks, BestRank): https://www.mediawiki.org/wiki/Wikibase/Indexing/RDF_Dump_Format
- WDQS graph split (main and scholarly graphs, since 9 May 2025): https://www.wikidata.org/wiki/Wikidata:SPARQL_query_service/WDQS_graph_split
- Wikimedia Foundation User-Agent policy: https://foundation.wikimedia.org/wiki/Policy:Wikimedia_Foundation_User-Agent_Policy
- Wikidata properties used: P414 stock exchange https://www.wikidata.org/wiki/Property:P414 · P249 ticker symbol https://www.wikidata.org/wiki/Property:P249 · P582 end time https://www.wikidata.org/wiki/Property:P582 · P5531 SEC CIK https://www.wikidata.org/wiki/Property:P5531
- Wikidata Help:Ranking: https://www.wikidata.org/wiki/Help:Ranking
- W3C SPARQL 1.1 Query Language (string escapes): https://www.w3.org/TR/sparql11-query/#grammarEscapes
- W3C SPARQL 1.1 Query Results JSON Format: https://www.w3.org/TR/sparql11-results-json/
- Wikidata licensing (CC0): https://www.wikidata.org/wiki/Wikidata:Licensing
- Wikidata database download (dumps): https://www.wikidata.org/wiki/Wikidata:Database_download

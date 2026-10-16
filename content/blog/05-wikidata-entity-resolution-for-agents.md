---
title: "Wikidata Entity Resolution for AI Agents"
description: "How to turn ambiguous names into stable Wikidata QIDs with wbsearchentities, wbgetentities, and SPARQL, and how to do it within Wikimedia's usage policies."
slug: wikidata-entity-resolution-for-agents
date: 2026-10-16
keywords: [Wikidata API, entity resolution, entity linking LLM, wbsearchentities, Wikidata SPARQL, QID lookup]
---

# Wikidata entity resolution for AI agents

"Apple", "Paris", "Mercury": agents run into ambiguous names constantly. When an agent guesses, the error carries forward into every later step. Linking each mention to a stable identifier fixes this, and [Wikidata](https://www.wikidata.org/) is the obvious public source. It has over a hundred million items, each with a QID (e.g. `Q312` for Apple Inc.), multilingual labels, and links to other identifier systems (SEC CIK, ISNI, VIAF, OpenStreetMap). Its structured data is released under [CC0](https://www.wikidata.org/wiki/Wikidata:Licensing), so you can reuse it without attribution requirements, although attribution is still good practice.

## Three APIs, three jobs

### 1. Candidate search: `wbsearchentities`
Fast prefix and label search over labels and aliases ([API docs](https://www.wikidata.org/w/api.php?action=help&modules=wbsearchentities)):

```bash
curl -s -A "ExampleAgent/0.1 (ops@example.com)" \
 "https://www.wikidata.org/w/api.php?action=wbsearchentities&search=Apple&language=en&type=item&limit=7&format=json" \
 | jq '.search[] | {id, label, description}'
```

You'll get the fruit, the company, the record label, and others. Each result has a short `description` ("American technology company"). Those descriptions are very useful input for an LLM disambiguation step.

### 2. Entity details: `wbgetentities`
Batch-fetch full entities, up to 50 IDs per request ([docs](https://www.wikidata.org/w/api.php?action=help&modules=wbgetentities)):

```
https://www.wikidata.org/w/api.php?action=wbgetentities&ids=Q312|Q89&props=labels|descriptions|claims|sitelinks&languages=en&format=json
```

Claims are keyed by property ID. Some of the useful ones:

| Property | Meaning |
|---|---|
| `P31` | instance of |
| `P279` | subclass of |
| `P17` | country |
| `P625` | coordinate location |
| `P856` | official website |
| `P5531` | SEC Central Index Key |
| `P414` / `P249` | stock exchange / ticker symbol (ticker is usually a qualifier on P414) |

### 3. Structured queries: SPARQL
The [Wikidata Query Service](https://query.wikidata.org/) answers graph questions:

```sparql
SELECT ?company ?companyLabel ?cik WHERE {
  ?company wdt:P5531 ?cik .
  VALUES ?cik { "0000320193" "320193" }
  SERVICE wikibase:label { bd:serviceParam wikibase:language "en". }
}
```

Note that the CIK format varies between items, which is why the query tries both padded and unpadded forms. Normalize on your side. The query service enforces a 60-second timeout per query ([user manual](https://www.mediawiki.org/wiki/Wikidata_Query_Service/User_Manual)). Expensive queries fail, so keep them selective.

## A resolution algorithm that works

1. **Normalize the mention.** Use Unicode NFKC, trim it, and keep the original casing for display.
2. **Generate candidates** with `wbsearchentities`, in the language of the source text and in English, up to about 10 results.
3. **Filter by type** using `P31`/`P279`. If the context says "company", keep items whose `instance of` is a subclass of business (`Q4830453`). Checking subclass chains needs SPARQL (`wdt:P31/wdt:P279*`) or a cached type hierarchy.
4. **Score** with cheap signals: exact label or alias match, sitelink count (a rough popularity prior), and type match.
5. **Disambiguate with context** only if the top two candidates are close. Give the model the mention, a window of surrounding text, and the candidates' labels and descriptions, and ask it to pick a QID or `NONE`. Constrain the output to that set, and never let the model invent a QID.
6. **Return confidence** and the runner-up so downstream steps can decide whether to ask a human.

Most mentions resolve at steps 2–4 without a model call, which keeps costs low.

## Why identifiers beat names in agent memory
Agents increasingly keep long-term memory: vector stores, knowledge graphs, and scratchpads. If memory is keyed on strings, "Apple", "Apple Inc." and "AAPL" become three different entities, and facts about them never merge. Keying on QIDs gives you:

- **Deduplication across languages.** `Q312` is the same item whether the source text said "Apple", "アップル", or "اپل".
- **Joins to other datasets.** Wikidata's external-identifier properties act as a crosswalk to SEC, OpenStreetMap, ORCID, IMDb, and thousands of others ([list of external identifier properties](https://www.wikidata.org/wiki/Wikidata:Database_reports/List_of_properties/all)).
- **Stable citations.** Entity URIs like `http://www.wikidata.org/entity/Q312` do not change when labels are edited.

Store the QID alongside the surface form the agent saw, so you can always explain why a mention was linked.

## Usage policies you need to follow
- Send a descriptive **User-Agent** with contact information, as required by the [Wikimedia User-Agent policy](https://foundation.wikimedia.org/wiki/Policy:Wikimedia_Foundation_User-Agent_Policy). Generic library user agents may be blocked.
- Respect the [API etiquette](https://www.mediawiki.org/wiki/API:Etiquette): make requests serially rather than in parallel, use `maxlag` on heavy jobs, and batch with `ids=Q1|Q2|…`.
- For bulk work, use the [JSON dumps](https://www.wikidata.org/wiki/Wikidata:Database_download) instead of hammering the API.

## Edge cases
- **Redirects and merges:** `wbgetentities` follows redirects when you request them. Store the final QID.
- **Labels missing in the target language:** fall back through a language chain (`fa → en → mul`).
- **Data quality:** Wikidata is crowd-edited. Use statement ranks (`preferred`/`normal`/`deprecated`), and treat facts as a starting point to verify, not as ground truth.
- **Very new entities** may not exist yet. `NONE` is a valid answer.

## What a resolver should return
Assay does not offer a Wikidata endpoint yet; it is on the roadmap. If you implement the algorithm above yourself, aim for an output shape like this:

```json
{
  "query": "Apple",
  "best": { "qid": "Q312", "label": "Apple Inc.", "description": "American technology company", "confidence": 0.97 },
  "alternatives": [{ "qid": "Q89", "label": "apple", "description": "fruit of the apple tree" }],
  "ids": { "sec_cik": "0000320193", "website": "https://www.apple.com" }
}
```

The `confidence` value above is illustrative; a real resolver should document how it computes the score. The `ids` block is what lets an agent go from a name to an entity to the company's [SEC filings](/blog/sec-edgar-json-for-ai-agents).

### Sources
- Wikidata licensing (CC0): https://www.wikidata.org/wiki/Wikidata:Licensing
- wbsearchentities: https://www.wikidata.org/w/api.php?action=help&modules=wbsearchentities
- wbgetentities: https://www.wikidata.org/w/api.php?action=help&modules=wbgetentities
- WDQS user manual: https://www.mediawiki.org/wiki/Wikidata_Query_Service/User_Manual
- Wikimedia User-Agent policy: https://foundation.wikimedia.org/wiki/Policy:Wikimedia_Foundation_User-Agent_Policy
- API etiquette: https://www.mediawiki.org/wiki/API:Etiquette

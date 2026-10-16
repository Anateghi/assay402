---
title: "Pay-Per-Call Embeddings with Open Models: A Practical Guide for Agents"
description: "What text embeddings are, how to choose an openly licensed embedding model, how to use cosine similarity correctly, and when per-call embeddings beat running your own."
slug: pay-per-call-embeddings
date: 2026-10-16
keywords: [embeddings API pay per use, open source embedding model, bge embeddings, cosine similarity, RAG embeddings, MTEB]
---

# Pay-per-call embeddings with open models

An embedding model maps text to a fixed-length vector, so that texts with similar meanings end up close together. Agents use embeddings for retrieval (RAG), deduplication, clustering, routing, and memory. You don't need a frontier-model subscription for this: several strong embedding models are openly licensed, and you can run them yourself or call them per request. This guide covers the decisions that matter.

## How embeddings are used
1. **Index:** embed each document chunk once and store the vector (in pgvector, SQLite-vec, FAISS, etc.).
2. **Query:** embed the user's or agent's query.
3. **Compare:** compute similarity, usually cosine, and return the top-k chunks.
4. **(Optional) Rerank:** run a cross-encoder over the top-k for better precision.

The one rule you can't break: **the query and the documents must be embedded with the same model** (and the same version and the same prefix convention). Vectors from different models are not comparable.

## Choosing an open model
The [MTEB leaderboard](https://huggingface.co/spaces/mteb/leaderboard) ([paper](https://arxiv.org/abs/2210.07316)) compares embedding models across retrieval, clustering, classification, and other tasks. Use it to make a shortlist, then test on your own data, because leaderboard rank doesn't reliably carry over to a specific domain.

Check the license on each model card. Examples of openly licensed families:

| Model | License (see model card) | Notes |
|---|---|---|
| [BAAI/bge-small-en-v1.5](https://huggingface.co/BAAI/bge-small-en-v1.5) | MIT | 384 dims, small and fast. Recommends a query instruction prefix for retrieval |
| [BAAI/bge-m3](https://huggingface.co/BAAI/bge-m3) | MIT | Multilingual, long inputs, dense + sparse + multi-vector |
| [nomic-ai/nomic-embed-text-v1.5](https://huggingface.co/nomic-ai/nomic-embed-text-v1.5) | Apache-2.0 | Task prefixes (`search_query:` / `search_document:`), Matryoshka dimensions |
| [intfloat/multilingual-e5-large](https://huggingface.co/intfloat/multilingual-e5-large) | MIT | `query:` / `passage:` prefixes |
| [sentence-transformers/all-MiniLM-L6-v2](https://huggingface.co/sentence-transformers/all-MiniLM-L6-v2) | Apache-2.0 | A classic baseline. Short max sequence length |

Licenses and versions change, so re-check the model card before you deploy.

## Details that silently ruin results

### Prefixes
Many retrieval models were trained with instruction prefixes. If you leave them out, or use the query prefix on documents, quality drops. Follow each model card exactly.

### Truncation
Every model has a maximum input length in tokens. Input beyond it is **silently cut off**. Chunk before embedding, at roughly a few hundred tokens with some overlap, splitting on headings and paragraphs (see [clean markdown extraction](/blog/clean-markdown-from-web-pages-for-llms)).

### Normalization and similarity
Cosine similarity is `a·b / (‖a‖‖b‖)`. If you L2-normalize vectors when you store them, the dot product equals the cosine, which is faster in most vector databases. Pick one metric and configure your index to match:

```python
import numpy as np
def normalize(v): return v / np.linalg.norm(v, axis=-1, keepdims=True)
scores = normalize(docs) @ normalize(query)  # cosine
```

### Thresholds aren't portable
A similarity of 0.8 means different things for different models. Calibrate thresholds for deduplication and "no good match" on labeled examples for each model.

### Matryoshka dimensions
Some models (e.g. nomic-embed v1.5) are trained with [Matryoshka Representation Learning](https://arxiv.org/abs/2205.13147), so you can keep only the first N dimensions and renormalize, which saves storage at a modest quality cost. This works only for models trained this way.

## Evaluate on your own data in an afternoon
Leaderboards are a starting point. A small in-domain evaluation tells you more:

1. Collect 50–200 real queries from your agent's logs (or write them by hand).
2. For each query, mark the one or more chunks that answer it.
3. Embed the corpus with each candidate model and compute **recall@k** (did a relevant chunk appear in the top k?) and **MRR** (how high did the first relevant chunk rank?).
4. Record the latency and vector size next to the quality numbers.

Per-call embeddings make this cheap: you can try three models on the same corpus without deploying any of them, then commit to one. When you have chosen, re-embed the whole corpus with that single model. Don't mix models in one index.

## Run your own, or pay per call?
**Run your own** when you have steady high volume, data that can't leave your network, or GPUs sitting idle. [sentence-transformers](https://www.sbert.net/) and [Text Embeddings Inference](https://github.com/huggingface/text-embeddings-inference) make serving straightforward.

**Pay per call** when:
- the agent embeds sporadically (a few thousand texts a day is easy on CPU, but you still have to keep a service running);
- you are prototyping and want to compare models without deploying each one;
- your agent is ephemeral (serverless or a user's laptop) and has no place to keep a model loaded;
- you want zero signup: an x402-paying agent can embed text the first time it needs to.

The cost comparison depends on your volume and hardware. Do the arithmetic with your own numbers instead of relying on vendor claims, ours included.

## A planned Assay endpoint
Embeddings are on the Assay roadmap, not live. This is the shape we intend to ship, shown so you can judge the design:

```http
POST /v1/embed
Content-Type: application/json

{ "model": "bge-small-en-v1.5", "input": ["search_query: what is x402?"], "normalize": true }
```

Response:

```json
{ "model": "bge-small-en-v1.5", "dims": 384, "data": [{ "index": 0, "embedding": [0.0123, -0.0456, …] }],
  "usage": { "tokens": 9 } }
```

- Only openly licensed models, with the license shown on each model's docs page.
- Model versions pinned. We would never silently change the weights behind a model name, because that would make your stored vectors meaningless.
- Pricing would be per 1,000 input tokens, paid through x402.
- `truncated: true` tells you when an input exceeded the model's limit.

### Sources
- MTEB paper: https://arxiv.org/abs/2210.07316 · leaderboard: https://huggingface.co/spaces/mteb/leaderboard
- Matryoshka Representation Learning: https://arxiv.org/abs/2205.13147
- Model cards linked in the table above (licenses as stated there)
- Sentence-Transformers: https://www.sbert.net/
- Text Embeddings Inference: https://github.com/huggingface/text-embeddings-inference

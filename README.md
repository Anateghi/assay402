# assay

**Pay-per-call API for AI agents.** Web page → clean markdown/JSON and PDF → per-page text, paid per call with [x402 v2](https://github.com/x402-foundation/x402) in USDC. No signup, no API key.

> **Testnet only.** This MVP runs on **Base Sepolia** (`eip155:84532`) with the public facilitator at `https://x402.org/facilitator`. The server refuses to start on any other network. No real funds are accepted.

| Endpoint | Price | Docs |
|---|---|---|
| `GET /v1/extract?url=…` | `$0.003 / call` | `/docs/extract/` |
| `POST /v1/pdf/text` (JSON `{url}` or `application/pdf` body) | `$0.01 / call` | `/docs/pdf-text/` |

## How payment works

1. Rate limit (in-memory token bucket per IP) and input validation. Bad input → `400`, never a 402.
2. No `PAYMENT-SIGNATURE` → `402` with a v2 `PAYMENT-REQUIRED` header (`exact`, USDC `0x036CbD53842c5426634e7929541eC2318f3dCF7e`, `payTo = $PAY_TO`).
3. Replay guard: each authorization (network + payer + EIP-3009 nonce) is single-use; duplicates get `409`, in flight or after settlement.
4. `@x402/hono` verifies with the facilitator, runs the handler, and **settles only if the handler returned < 400**. Failures are never settled (= not charged).
5. Success → `200` + `PAYMENT-RESPONSE` (tx hash).

## Packages (verified against npm, v2.28.0)

`@x402/hono`, `@x402/core`, `@x402/evm` (server) · `@x402/fetch` (client, used in tests).

## Run

```bash
npm install
cp .env.example .env   # set PAY_TO to a testnet address
npm test               # 21 tests: 402 challenge, pay+settle, no-settle on failure, replay, rate limit, robots, SSRF, PDF
npm start              # builds the static site into ./public, then serves API + site on $PORT
```

Env: `PAY_TO`, `NETWORK` (must be `eip155:84532`), `FACILITATOR_URL`, `PUBLIC_URL` (falls back to `RAILWAY_PUBLIC_DOMAIN`), `RATE_LIMIT_PER_MIN`, `HEAVY_CONCURRENCY`.

## Layout

- `src/` — Hono gateway (`app.ts`), x402 wiring, replay guard, rate limits, SSRF-safe fetch, robots.txt (RFC 9309), extraction, PDF
- `scripts/build-site.ts` — static site generator (home, pricing, docs, blog, `/llms.txt`, sitemap, robots, RSS, OG/JSON-LD)
- `content/docs`, `content/blog` — markdown sources
- `site/` — CSS/JS/OG image following the "assay lab notebook" brand

## Discovery

`/openapi.json` · `/pricing.json` · `/.well-known/x402` · `/llms.txt` · `/sitemap.xml` · markdown twins (`/docs/extract.md`, `/blog/<slug>.md`)

## Crawler

Fetches identify as `assay-fetch/0.1 (+https://github.com/Anateghi/assay402#crawler)` and honor robots.txt for `assay-fetch` and `*`. Opt out with `User-agent: assay-fetch` / `Disallow: /`.

## Known MVP limits

In-memory state (rate limits, replay set, caches) is per instance and resets on deploy — the facilitator's on-chain nonce check still prevents double settlement. No Postgres ledger, API keys, OCR, or JS rendering yet.

MIT licensed.

---
title: "Token Bucket Rate Limiter in TypeScript for a Pay-Per-Call API"
description: "A token bucket rate limiter in TypeScript, condensed from Assay's real middleware: lazy refill, an honest Retry-After, where to put it relative to an x402 payment challenge, and the client-IP mistakes that make per-IP limits leak."
slug: token-bucket-rate-limiter-typescript
date: 2026-11-11
keywords: [token bucket rate limiter typescript, hono rate limit middleware, retry-after 429, x-forwarded-for rate limiting, ratelimit header fields, api gateway rate limiting]
---

# Token bucket rate limiter in TypeScript for a pay-per-call API

A **token bucket rate limiter in TypeScript** fits in about twenty lines, and it is what Assay runs in front of every paid route. Each client key gets a bucket of tokens. A request spends one token, and tokens refill at a steady rate up to a cap. The cap sets the burst, and the refill rate sets the long-run limit. This post walks through the version Assay uses, where it sits relative to the x402 payment challenge, and the client-IP mistakes that quietly make per-IP limits useless.

```ts
// A per-key token bucket in ~20 lines (Node 18+, no dependencies).
class TokenBucket {
  private buckets = new Map<string, { tokens: number; ts: number }>();
  constructor(private capacity: number, private refillPerSec: number, private now = () => Date.now()) {}
  take(key: string): { ok: boolean; retryAfter: number } {
    const t = this.now();
    const b = this.buckets.get(key) ?? { tokens: this.capacity, ts: t };
    b.tokens = Math.min(this.capacity, b.tokens + ((t - b.ts) / 1000) * this.refillPerSec); // lazy refill
    b.ts = t;
    this.buckets.set(key, b);
    if (b.tokens >= 1) { b.tokens -= 1; return { ok: true, retryAfter: 0 }; }
    return { ok: false, retryAfter: Math.ceil((1 - b.tokens) / this.refillPerSec) }; // seconds until 1 token
  }
}

// 30 requests per minute = burst of 30, refilling 0.5 tokens per second.
let clock = 0;
const bucket = new TokenBucket(30, 30 / 60, () => clock);
const burst = Array.from({ length: 31 }, () => bucket.take("203.0.113.7"));
console.log(burst.filter((r) => r.ok).length, burst[30]); // 30 { ok: false, retryAfter: 2 }
clock += 2000;
console.log(bucket.take("203.0.113.7"));                  // { ok: true, retryAfter: 0 }
```

We ran this snippet with `tsx` and got exactly the output in the comments. It is condensed from [`src/ratelimit.ts`](https://github.com/Anateghi/assay402/blob/main/src/ratelimit.ts) in the Assay repo, which adds a sweep that drops buckets idle for ten minutes once the map passes 50,000 keys.

## Why a token bucket and not a fixed window

A fixed window ("30 requests per calendar minute") is easy to count but lets a client send 30 requests at 12:00:59 and 30 more at 12:01:00, so 60 in two seconds. A token bucket has no window edge. The burst can never exceed `capacity`, and over any longer stretch the rate converges to `refillPerSec`.

Two details in the code above are worth copying:

- **Lazy refill.** There is no timer. Each `take()` adds the tokens earned since the last call, capped at `capacity`. An idle client costs nothing but one map entry.
- **An injectable clock.** The `now` parameter lets tests move time by hand instead of sleeping. Assay's unit test does exactly that: two takes succeed, the third fails, and after the clock moves 1,000 ms one more succeeds.

## A Retry-After that tells the truth

When the bucket is empty, the client needs `1 - tokens` more tokens, which takes `(1 - tokens) / refillPerSec` seconds. Rounding up gives a `Retry-After` the client can trust: wait that long and the next request will pass, as long as nothing else spends the token first. At Assay's default of 30 per minute the refill is 0.5 tokens per second, so a client that just emptied its bucket sees `Retry-After: 2`.

[RFC 6585 §4](https://www.rfc-editor.org/rfc/rfc6585#section-4) says a 429 "MAY include a Retry-After header", and [RFC 9110 §10.2.3](https://www.rfc-editor.org/rfc/rfc9110#section-10.2.3) defines the field as either an HTTP date or a number of seconds. Seconds are the safer choice because they do not depend on the client's clock. Here is the Hono middleware Assay wraps around the bucket, generalized slightly so you can pass in your own key function:

```ts
import type { MiddlewareHandler } from "hono";

export function rateLimit(bucket: TokenBucket, keyOf: (c: any) => string): MiddlewareHandler {
  return async (c, next) => {
    const r = bucket.take(keyOf(c));
    if (!r.ok) {
      c.header("Retry-After", String(r.retryAfter));
      return c.json({ error: "rate_limited", message: "Too many requests", retry_after_s: r.retryAfter }, 429);
    }
    await next();
  };
}
```

Browser-based agents can only read `Retry-After` on a cross-origin response if the server lists it in `Access-Control-Expose-Headers`. Assay exposes it on `/v1/*` next to `PAYMENT-REQUIRED` and `PAYMENT-RESPONSE`.

## Put the limiter before the payment challenge

On a pay-per-call API the order of middleware decides what a client is asked to pay for. Assay runs the token bucket first, then a concurrency cap (four heavy requests in flight, then `503` with `Retry-After: 2`), then input validation, then the replay guard, and only then the x402 payment middleware. The full order is in [HTTP 402 vs 401 vs 403 vs 429](/blog/http-402-vs-401-403-429).

That order has three consequences you should design for:

1. **A rate-limited request never sees a 402.** If over-quota requests got a payment challenge, a client could pay its way past a limit that exists to protect the server. A 429 says "wait", and paying again will not help.
2. **Unpaid probes are throttled too.** Anyone can hammer a paid endpoint for free 402 challenges. Counting those against the bucket keeps the cheapest attack surface bounded.
3. **One paid call spends two tokens.** An x402 client first gets the 402 challenge, then retries with `PAYMENT-SIGNATURE`. Both requests pass through the limiter, so at 30 tokens per minute a client can complete about 15 paid calls a minute, not 30. If you document a rate limit for a paid API, say which number you mean. Assay's [limits page](/docs/limits/) states the raw request limit.

## The part that actually breaks: picking the client key

A per-IP limiter is only as good as the IP it keys on. Behind a reverse proxy the socket address is the proxy, so most apps read `X-Forwarded-For`. [MDN's X-Forwarded-For page](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/X-Forwarded-For) is blunt about the risk: any security-related use, rate limiting included, "must only use IP addresses added by a trusted proxy", and the leftmost values can be spoofed by the client.

Assay's current `clientIp()` takes the **leftmost** entry. We tested what that means on a local instance: 35 requests in a row from one address got 30 `402` responses and then five `429`s, as designed. Five more requests that each carried a made-up `X-Forwarded-For: 1.2.3.4` all got `402`, because the limiter saw a fresh key. Whether that works against the deployed service depends on whether the platform's edge proxy overwrites or appends the header, which we had not verified when this post went out. Treat it as a known weakness in the current code, not a feature. (Update, 12 November 2026: we checked. Railway's edge replaces client-supplied `X-Forwarded-For`, so on the deployed service the leftmost entry is the address the edge saw. Details in [X-Forwarded-For on Railway](/blog/x-forwarded-for-railway).)

The fix MDN describes is to count from the right. With one trusted proxy in front of the app, the rightmost entry is the address that proxy saw:

```ts
// Pick the client IP that your own proxy added: count from the right, not the left.
function clientIpFromRight(xffHeaders: string[], trustedProxies = 1): string | undefined {
  const ips = xffHeaders.join(",").split(",").map((s) => s.trim()).filter(Boolean);
  return ips[ips.length - trustedProxies]; // one trusted proxy: the rightmost entry
}
console.log(clientIpFromRight(["6.6.6.6, 203.0.113.7"]));    // 203.0.113.7 (6.6.6.6 was spoofed by the client)
console.log(clientIpFromRight(["6.6.6.6", "203.0.113.7"]));  // 203.0.113.7 (multiple headers form one list)
```

The count only holds if you know exactly how many proxies sit in front of your app and the app cannot be reached directly. MDN also notes that multiple `X-Forwarded-For` headers must be joined into one list, which the snippet does.

### Per-IP limits leak in the other direction too

Even with a correct key, one IP is not one client. When we load-tested the live gateway from a single machine, Railway's HTTP logs showed the requests arriving from several different source addresses in the same `104.28.x.x` range, because that machine's outbound traffic leaves through a pool of egress IPs. Fifty parallel requests all got `402` and none was rate limited, since no single address had spent 30 tokens. The reverse also happens: many unrelated users behind one corporate NAT share a bucket. Per-IP limits are a floor against accidental floods, not a per-customer quota.

On a pay-per-call API this matters less than on a free one. Every successful call is paid for, so the limiter mainly protects the server from unpaid 402 probes and expensive upstream fetches. A stronger key for paid traffic is the payer address inside the verified payment, which Assay's replay guard already reads to key nonces. That key only exists after the payment header is parsed, so it complements the IP bucket instead of replacing it.

## Single instance, in memory, on purpose

Assay's buckets live in a `Map` in one process. They reset on every deploy, and two replicas would each allow the full rate. For one instance that is the right trade: no network hop on every request and nothing to operate. When you scale out, move the bucket state to a shared store and run the refill-and-take as one atomic operation, otherwise two replicas can both spend the last token.

## Telling clients the limit before they hit it

The IETF HTTPAPI working group's [RateLimit header fields draft](https://datatracker.ietf.org/doc/draft-ietf-httpapi-ratelimit-headers/) (draft 11, May 2026, still an Internet-Draft) defines `RateLimit-Policy` for the quota and `RateLimit` for what is left, for example `RateLimit: "default";r=50;t=30`. It says that when both `RateLimit` and `Retry-After` are present, `Retry-After` takes precedence, and it warns that clients told the same reset time will all come back at once, so add jitter. Assay does not send these fields today. It sends only `Retry-After` on `429` and `503`.

On the client side, an agent should treat `429` and `503` as "wait, then retry the same request", never as a reason to sign another payment. Pair that with a per-agent budget, covered in [spending limits for agent wallets](/blog/x402-agent-spending-limits).

## Where Assay stands today

Assay runs on **Base Sepolia testnet only** with test USDC. The limiter allows 30 requests per minute per client IP across `/v1/*` (configurable with `RATE_LIMIT_PER_MIN`), the heavy-route concurrency cap is 4 (`HEAVY_CONCURRENCY`), and both are in-memory on a single instance. To try a paid call end to end, start with the [quickstart](/docs/quickstart/) or the [@x402/fetch example](/blog/x402-fetch-typescript).

**Related:** [HTTP 402 vs 401 vs 403 vs 429](/blog/http-402-vs-401-403-429) · [x402 Hono middleware](/blog/x402-hono-middleware) · [Designing pay-per-call pricing](/blog/designing-pay-per-call-pricing) · [SSRF protection for agent fetch tools](/blog/ssrf-protection-for-ai-agent-fetch-tools) · [Limits and errors](/docs/limits/)

### Sources
- RFC 6585, Additional HTTP Status Codes (429 Too Many Requests): https://www.rfc-editor.org/rfc/rfc6585#section-4
- RFC 9110, HTTP Semantics (Retry-After, 503): https://www.rfc-editor.org/rfc/rfc9110#section-10.2.3
- IETF draft-ietf-httpapi-ratelimit-headers-11, RateLimit header fields for HTTP: https://datatracker.ietf.org/doc/draft-ietf-httpapi-ratelimit-headers/
- MDN, X-Forwarded-For (security, parsing, and selecting an IP): https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/X-Forwarded-For
- Hono middleware guide: https://hono.dev/docs/guides/middleware
- Assay source (src/ratelimit.ts, src/app.ts): https://github.com/Anateghi/assay402
- Assay rate limits and errors: /docs/limits/

---
title: "X-Forwarded-For on Railway: Which Client IP Header to Trust"
description: "We sent spoofed X-Forwarded-For, X-Real-IP, Forwarded and X-Envoy-External-Address headers through Railway's edge and recorded what reached the app. Here is which client IP header is safe for rate limiting, and why the usual rightmost-entry rule picks the wrong address there."
slug: x-forwarded-for-railway
date: 2026-11-12
keywords: [x-forwarded-for railway, railway x-real-ip, x-forwarded-for spoofing, client ip behind reverse proxy, rate limit by ip behind proxy, forwarded header spoofing]
---

# X-Forwarded-For on Railway: which client IP header to trust

On Railway, the edge proxy **replaces** any `X-Forwarded-For` and `X-Real-IP` a client sends, so for an app reached through a Railway domain, `X-Real-IP` (or the leftmost `X-Forwarded-For` entry) is the client's address. Two other headers are not touched: a client-supplied `Forwarded` or `X-Envoy-External-Address` reaches your app unchanged, so never key a rate limit on them. And the textbook rule of "take the rightmost entry" picks a Railway proxy address on this platform, not the client.

That is what we observed on 12 November 2026. In our [token bucket rate limiter post](/blog/token-bucket-rate-limiter-typescript) we flagged that Assay's limiter keys on the leftmost `X-Forwarded-For` entry and that we had not checked what Railway's edge does with a spoofed header. This post is that check.

## The test

Railway runs a public header echo service, `utilities-us-east.up.railway.app/raw`, which a Railway employee [pointed to as an example of the headers apps receive](https://station.railway.com/questions/x-real-ip-showing-our-google-lb-s-ip-ins-ac9e47d8). It prints the request exactly as the app sees it. We sent it every client-IP header we could think of, with made-up values:

```bash
curl -s https://utilities-us-east.up.railway.app/raw \
  -H "X-Forwarded-For: 1.2.3.4" \
  -H "X-Forwarded-For: 9.9.9.9" \
  -H "X-Real-IP: 5.6.7.8" \
  -H "Forwarded: for=6.6.6.6" \
  -H "X-Envoy-External-Address: 7.7.7.7"
```

One of the three runs came back like this (the other two differed only in the addresses):

```http
Forwarded: for=6.6.6.6
X-Envoy-External-Address: 7.7.7.7
X-Forwarded-For: 104.28.234.184, 152.233.47.67
X-Forwarded-Host: utilities-us-east.up.railway.app
X-Forwarded-Proto: https
X-Railway-Edge: jfk1
X-Real-Ip: 104.28.234.184
```

What that shows, header by header:

- **`X-Forwarded-For`**: both spoofed values are gone. The app gets a fresh list of two entries, the address our request came from and a second address that changed between runs (`152.233.47.67` and `152.233.30.104`), which is a Railway hop, not the client.
- **`X-Real-IP`**: overwritten with the same client address as the leftmost `X-Forwarded-For` entry.
- **`Forwarded`** ([RFC 7239](https://www.rfc-editor.org/rfc/rfc7239)): passed through exactly as the client sent it.
- **`X-Envoy-External-Address`**: also passed through as sent.

A community member [reported the same pattern](https://station.railway.com/questions/supported-way-to-obtain-a-trusted-client-e09bae3b) from a test in EU West: `X-Real-IP` replaced, `X-Forwarded-For` replaced with two entries, `Forwarded` unchanged. Railway's moderators have [said in another thread](https://station.railway.com/questions/which-client-address-headers-does-the-ra-fb9e36d7) that `X-Real-IP`, `X-Forwarded-For`, `X-Forwarded-Proto` and `X-Forwarded-Host` are all overwritten at the edge.

## Why "take the rightmost entry" is wrong here

[MDN's X-Forwarded-For page](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/X-Forwarded-For) gives the general rule: count trusted proxies from the right, because anything to the left could have been written by the client. With one trusted proxy you take the rightmost entry. We showed that function in the previous post.

On Railway that rule breaks in a quiet way. The edge throws away the client's list and writes two entries of its own, so the rightmost one is the Railway hop. Key a limiter on it and every client that passes through the same hop shares one bucket. In our three runs we saw only two distinct hop addresses, so a few busy clients could rate-limit everybody else.

The general lesson from MDN still holds, but "how many trusted proxies" means "how many entries does my platform append", and you only learn that by looking at what reaches your app. On Railway, with nothing else in front, the client is the first of the two entries.

## What to key on, in code

Railway's [Specs and Limits page](https://docs.railway.com/networking/public-networking/specs-and-limits) documents one header for this: "`X-Real-IP` for identifying client's remote IP." It does not document whether incoming copies are overwritten or publish a stable range of proxy addresses, and it says the information "is subject to change at any time". So prefer the documented header and fall back explicitly:

```ts
// Client IP for an app reached only through Railway's public HTTP edge.
// X-Real-IP is the header Railway documents; the leftmost X-Forwarded-For entry matched it in our tests.
// Never read Forwarded or X-Envoy-External-Address here: Railway passes client-supplied copies through.
function railwayClientIp(h: (name: string) => string | undefined): string {
  const real = h("x-real-ip")?.trim();
  if (real) return real;
  const first = h("x-forwarded-for")?.split(",")[0]?.trim();
  return first || "unknown";
}

const seen: Record<string, string> = {
  "x-real-ip": "104.28.234.184",
  "x-forwarded-for": "104.28.234.184, 152.233.47.67",
  forwarded: "for=6.6.6.6",
};
console.log(railwayClientIp((n) => seen[n])); // 104.28.234.184
```

We ran that with `tsx` and got the output in the comment.

This is only safe if the app cannot be reached without going through Railway's HTTP edge. A Railway employee [confirmed](https://station.railway.com/questions/need-authoritative-railway-client-ip-p-b7a7b4bd) that apps behind the HTTP proxy cannot be accessed directly, and a moderator noted the overwrite does not apply over a TCP proxy or private networking. If your service also listens on a TCP proxy, or other services call it over the private network, those requests can carry any header they like.

## When something sits in front of Railway

If you put Cloudflare, a cloud load balancer, or your own proxy in front of a Railway domain, the address that connects to Railway's edge is that proxy, not the visitor. A Railway support reply in [a thread about a Google Cloud load balancer](https://station.railway.com/questions/x-real-ip-showing-our-google-lb-s-ip-ins-ac9e47d8) says the edge sets `X-Real-IP` to the immediate connecting IP, which there was the load balancer. A Railway employee in the same thread suggested having the load balancer add its own client-IP header, the way Cloudflare sends `CF-Connecting-IP`.

Answers in other threads describe the Cloudflare case differently, so check it yourself: deploy a route that echoes request headers, send a spoofed `X-Forwarded-For` and `X-Real-IP` through your real domain, and see which values survive. Only trust a custom header like `CF-Connecting-IP` if requests that skip your front proxy cannot reach the app, otherwise a client can send that header too.

## What this means for Assay

Assay's [`clientIp()`](https://github.com/Anateghi/assay402/blob/main/src/ratelimit.ts) takes the leftmost `X-Forwarded-For` entry and falls back to `X-Real-IP`. Assay is served from a Railway domain with no other proxy in front, so based on this test that leftmost entry is the address Railway's edge saw, and a spoofed `X-Forwarded-For` should not create a fresh bucket on the deployed service. We could not confirm that end to end against Assay itself: our test machine's outbound traffic leaves through a rotating pool of addresses (you can see three different `104.28.x.x` client addresses in the runs above), so a burst from it never concentrates on one key long enough to hit the limit. Forty requests with a different spoofed `X-Forwarded-For` and `X-Real-IP` on each all got the normal `402` challenge.

The weakness from the last post is still real anywhere the edge does not rewrite the header: running Assay locally, on another host, or behind an extra proxy, a client can pick its own rate-limit key. The code does not change today. The fix we would make is the one above: read `X-Real-IP` first on Railway, and make the trusted header a setting for other deployments.

Assay runs on **Base Sepolia testnet only** with test USDC, at 30 requests per minute per client IP across `/v1/*`. See the [limits page](/docs/limits/) for the full list, or start with the [quickstart](/docs/quickstart/).

**Related:** [Token bucket rate limiter in TypeScript](/blog/token-bucket-rate-limiter-typescript) · [HTTP 402 vs 401 vs 403 vs 429](/blog/http-402-vs-401-403-429) · [SSRF protection for agent fetch tools](/blog/ssrf-protection-for-ai-agent-fetch-tools) · [Limits and errors](/docs/limits/)

### Sources
- Railway docs, Public Networking Specs and Limits (request headers): https://docs.railway.com/networking/public-networking/specs-and-limits
- Railway Central Station, "Which client-address headers does the Railway edge set, and are caller copies replaced?": https://station.railway.com/questions/which-client-address-headers-does-the-ra-fb9e36d7
- Railway Central Station, "Supported way to obtain a trusted client IP behind Railway's HTTP edge": https://station.railway.com/questions/supported-way-to-obtain-a-trusted-client-e09bae3b
- Railway Central Station, "Need authoritative Railway client-IP / proxy trust contract for secure rate limiting": https://station.railway.com/questions/need-authoritative-railway-client-ip-p-b7a7b4bd
- Railway Central Station, "X-Real-IP showing our Google LB's IP instead of Client's IP": https://station.railway.com/questions/x-real-ip-showing-our-google-lb-s-ip-ins-ac9e47d8
- MDN, X-Forwarded-For: https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/X-Forwarded-For
- RFC 7239, Forwarded HTTP Extension: https://www.rfc-editor.org/rfc/rfc7239
- Assay source (src/ratelimit.ts): https://github.com/Anateghi/assay402

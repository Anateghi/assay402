---
title: "SSRF Protection for AI Agent Fetch Tools: Private IPs, IPv6 Tricks, Redirects, and DNS"
description: "How to stop an AI agent's URL-fetching tool from reaching localhost, cloud metadata, or your private network: a working Node.js guard, the IPv4 and IPv6 forms that slip past naive checks, why every redirect hop needs re-checking, and the DNS rebinding gap."
slug: ssrf-protection-for-ai-agent-fetch-tools
date: 2026-10-28
keywords: [ssrf protection ai agent, ssrf url fetch tool, block private ip fetch nodejs, ipv4-mapped ipv6 ssrf, dns rebinding, cloud metadata 169.254.169.254]
---

# SSRF protection for AI agent fetch tools: private IPs, IPv6 tricks, redirects, and DNS

Any tool that lets a model say "fetch this URL" is a server-side request forgery (SSRF) surface. The URL can come from a user, a web page the agent just read, or a prompt injection, and the request goes out from *your* network. Good **SSRF protection for an AI agent** fetch tool starts with a check like this one, run before every request and again on every redirect:

```ts
// run with: npx tsx guard.mts   (Node.js 20+)
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

function privateV4(ip: string) {
  const [a, b] = ip.split(".").map(Number);
  return a === 0 || a === 10 || a === 127 || a >= 224 ||
    (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) ||
    (a === 198 && (b === 18 || b === 19));
}

export async function assertPublicUrl(raw: string): Promise<URL> {
  const u = new URL(raw);                       // WHATWG parsing normalizes the host
  if (!["http:", "https:"].includes(u.protocol)) throw new Error("scheme");
  if (u.username || u.password) throw new Error("credentials in URL");
  const host = u.hostname.replace(/^\[|\]$/g, "").replace(/\.$/, "");
  if (host === "localhost" || host.endsWith(".localhost")) throw new Error("localhost");
  const addrs = isIP(host) ? [{ address: host }] : await lookup(host, { all: true });
  for (const { address } of addrs) {
    // IPv6 needs more than this; see the next sections
    if (isIP(address) === 4 ? privateV4(address) : address === "::1") throw new Error(`private: ${address}`);
  }
  return u;
}

console.log(await assertPublicUrl("https://example.com/").catch((e) => e.message)); // URL object
console.log(await assertPublicUrl("http://2130706433/").catch((e) => e.message));   // "private: 127.0.0.1"
```

The second call shows why you parse first and check second. The [WHATWG URL standard](https://url.spec.whatwg.org/#concept-ipv4-parser) accepts IPv4 hosts as a single number, in hex, or with missing parts, so `http://2130706433/`, `http://0x7f.1/`, and `http://127.1/` all come out of `new URL()` with `hostname` set to `127.0.0.1`. We ran all three through Node.js 20. A regex on the raw string misses them; a check on the parsed `hostname` doesn't. The rest of this post covers the cases that the short guard above still gets wrong.

## What you're protecting

The [OWASP SSRF Prevention Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Server_Side_Request_Forgery_Prevention_Cheat_Sheet.html) lists the usual targets. For an agent tool running in the cloud, three matter most:

- **Loopback** (`127.0.0.0/8`, `::1`): admin ports, debug servers, and sidecars that trust local callers.
- **Link-local, where cloud metadata lives**: AWS, GCP, and Azure serve instance metadata at `169.254.169.254`. On AWS, [IMDSv2](https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/configuring-instance-metadata-service.html) requires a session token from a `PUT`, which blocks a plain `GET`-only fetch tool, but IMDSv1 may still be enabled on older instances.
- **Private and shared ranges** (`10/8`, `172.16/12`, `192.168/16`, `100.64/10` carrier-grade NAT, IPv6 `fc00::/7` unique local): databases, internal APIs, and other services on your private network.

The authoritative list of special-purpose ranges is the [IANA IPv4](https://www.iana.org/assignments/iana-ipv4-special-registry/iana-ipv4-special-registry.xhtml) and [IPv6](https://www.iana.org/assignments/iana-ipv6-special-registry/iana-ipv6-special-registry.xhtml) special-purpose address registries ([RFC 6890](https://www.rfc-editor.org/rfc/rfc6890)). Use a blocklist built from those registries rather than a list you remember.

## IPv6 forms that carry an IPv4 address

This is where hand-written guards usually fail, ours included. Several IPv6 forms embed an IPv4 address, and depending on the host's network stack, a connection to them can reach that IPv4 address:

| Form | Example | Embedded IPv4 | Defined in |
|---|---|---|---|
| IPv4-mapped | `::ffff:7f00:1` (same as `::ffff:127.0.0.1`) | `127.0.0.1` | [RFC 4291 §2.5.5.2](https://www.rfc-editor.org/rfc/rfc4291#section-2.5.5.2) |
| IPv4-compatible (deprecated) | `::7f00:1` | `127.0.0.1` | [RFC 4291 §2.5.5.1](https://www.rfc-editor.org/rfc/rfc4291#section-2.5.5.1) |
| NAT64 well-known prefix | `64:ff9b::a9fe:a9fe` | `169.254.169.254` | [RFC 6052](https://www.rfc-editor.org/rfc/rfc6052) |
| 6to4 | `2002:7f00:1::` | `127.0.0.1` | [RFC 3056](https://www.rfc-editor.org/rfc/rfc3056) |

The catch is normalization. If a user writes `http://[::ffff:127.0.0.1]/`, the WHATWG parser rewrites the host to `[::ffff:7f00:1]`, in hex. A guard that does `address.startsWith("::ffff:")` and then checks the rest as dotted IPv4 gets `7f00:1`, which isn't an IPv4 address at all, and lets it through. The fix is to expand the IPv6 address into its eight 16-bit groups, check the prefix numerically, and pull the IPv4 address out of the low 32 bits:

```ts
function expandV6(ip: string): number[] | null {
  let v = ip.toLowerCase().split("%")[0];                 // drop a zone id like %eth0
  const m = v.match(/^(.*:)(\d+\.\d+\.\d+\.\d+)$/);       // dotted-quad tail
  if (m) {
    const [a, b, c, d] = m[2].split(".").map(Number);
    v = `${m[1]}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const [h, t] = v.split("::");
  const head = h ? h.split(":") : [], tail = t ? t.split(":") : [];
  const fill = v.includes("::") ? 8 - head.length - tail.length : 0;
  const g = [...head, ...Array(Math.max(fill, 0)).fill("0"), ...tail].map((x) => parseInt(x, 16));
  return g.length === 8 && g.every((x) => x >= 0 && x <= 0xffff) ? g : null;
}

function privateV6(ip: string): boolean {
  const g = expandV6(ip);
  if (!g) return true;                                     // can't parse it: fail closed
  const v4 = (hi: number, lo: number) => `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
  if (g.slice(0, 6).every((x) => x === 0)) return true;    // ::, ::1, ::a.b.c.d
  if (g.slice(0, 5).every((x) => x === 0) && g[5] === 0xffff) return privateV4(v4(g[6], g[7]));
  if (g[0] === 0x64 && g[1] === 0xff9b) return privateV4(v4(g[6], g[7]));
  if (g[0] === 0x2002) return privateV4(v4(g[1], g[2]));
  return (g[0] & 0xfe00) === 0xfc00 || (g[0] & 0xffc0) === 0xfe80 || (g[0] & 0xff00) === 0xff00;
}
```

Two habits make this safer. First, **fail closed**: anything you can't parse counts as private. Second, check an address that is *mapped* to a public IPv4 address (`::ffff:8.8.8.8`) the same way as the IPv4 address, so you don't block real traffic just because a resolver returned it in mapped form.

## Hostnames that are really localhost

Name checks have their own edge cases. A trailing dot makes a name fully qualified, so `localhost.` and `foo.localhost.` are the same names as `localhost` and `foo.localhost`, but `host === "localhost"` doesn't match them. Strip one trailing dot before comparing. [RFC 6761](https://www.rfc-editor.org/rfc/rfc6761#section-6.3) reserves `.localhost` for loopback, and many platforms also use internal-only suffixes such as `.internal` and `.local` for private service discovery. Blocking those names is cheap. Still, the name check is only a shortcut: the address check after DNS resolution is what actually protects you, because any public name can point at `127.0.0.1`.

## Re-check every redirect

A safe first URL can answer with `302 Location: http://169.254.169.254/latest/meta-data/`. If your HTTP client follows redirects on its own, your guard only ever saw the first URL. In Node.js, pass `redirect: "manual"` to `fetch`, read `Location` yourself, resolve it against the current URL, run the full guard again, and cap the number of hops:

```ts
let current = await assertPublicUrl(input);
for (let hop = 0; hop < 5; hop++) {
  const res = await fetch(current, { redirect: "manual", signal: AbortSignal.timeout(15_000) });
  if ([301, 302, 303, 307, 308].includes(res.status)) {
    current = await assertPublicUrl(new URL(res.headers.get("location")!, current).toString());
    continue;
  }
  return res; // also cap the body size while you read it
}
throw new Error("too many redirects");
```

Also limit ports. A fetch tool for web pages only needs 80 and 443, and allowing any port turns it into a port scanner for whatever it can reach.

## The gap that's left: DNS rebinding

The guard resolves the hostname, then `fetch` resolves it **again** when it connects. A hostile DNS server can answer the first query with a public address and the second with `127.0.0.1`, using a very short TTL. This is DNS rebinding, and a check-then-fetch design like the one above doesn't stop it.

The full fix is to connect to the address you checked. Two common ways to do that:

- **Pin the address in the connection itself.** Do the check inside the socket's DNS lookup hook, so the address that was validated is the one used. Node's [`net.connect`](https://nodejs.org/api/net.html#socketconnectoptions-connectlistener) takes a `lookup` function for this, and HTTP clients built on Node sockets generally let you pass one through their connect options.
- **Send all tool traffic through an egress proxy** that blocks private ranges itself, or run the fetcher in a network that has no route to anything internal. This is also the right defense if your code has more than one HTTP client.

Network-level isolation is the strongest of these, because it still protects you when the application-level check has a bug.

## What Assay does today

Assay's [`/v1/extract`](/docs/extract/) (0.003 USDC per call) and `/v1/pdf/text` (0.01 USDC per call) endpoints fetch URLs that callers send, paid with x402 on **Base Sepolia testnet** only. Both go through one fetch function that allows only `http` and `https` on ports 80 and 443, rejects credentials in URLs, blocks `localhost`, `.localhost`, `.internal`, and `.local` names (with or without a trailing dot), resolves every hostname and rejects it if any resolved address is private, handles redirects manually with the full check on each of up to five hops, and caps response size and time.

While writing this post we tested that function against the IPv6 forms in the table above and found that it let `[::ffff:7f00:1]`, `[::7f00:1]`, and `[64:ff9b::7f00:1]` through, along with `localhost.` with a trailing dot. The check now expands IPv6 addresses as shown above, covers the IPv4-mapped, IPv4-compatible, NAT64, and 6to4 forms, treats anything it can't parse as private, and has unit tests for each case. It does **not** pin the connection to the checked address yet, so the DNS rebinding gap described above still applies, and closing it is on our list. The code is in [`src/safefetch.ts`](https://github.com/Anateghi/assay402/blob/main/src/safefetch.ts). The [quickstart](/docs/quickstart/) walks through a first paid call with free testnet USDC.

**Related:** [Responsible extraction: robots.txt, licenses, and attribution](/blog/responsible-extraction-robots-txt-licenses) · [Clean markdown from web pages for LLMs](/blog/clean-markdown-from-web-pages-for-llms) · [Adding paid tools to an MCP server](/blog/paid-tools-in-mcp-servers) · [Spending limits for agent wallets](/blog/x402-agent-spending-limits)

### Sources
- OWASP Server-Side Request Forgery Prevention Cheat Sheet: https://cheatsheetseries.owasp.org/cheatsheets/Server_Side_Request_Forgery_Prevention_Cheat_Sheet.html
- WHATWG URL Standard, IPv4 parser: https://url.spec.whatwg.org/#concept-ipv4-parser
- RFC 6890, Special-Purpose IP Address Registries: https://www.rfc-editor.org/rfc/rfc6890
- IANA IPv4 and IPv6 special-purpose address registries: https://www.iana.org/assignments/iana-ipv4-special-registry/ and https://www.iana.org/assignments/iana-ipv6-special-registry/
- RFC 4291, IPv6 Addressing Architecture (IPv4-compatible and IPv4-mapped addresses): https://www.rfc-editor.org/rfc/rfc4291
- RFC 6052, IPv6 Addressing of IPv4/IPv6 Translators (64:ff9b::/96): https://www.rfc-editor.org/rfc/rfc6052
- RFC 3056, Connection of IPv6 Domains via IPv4 Clouds (6to4): https://www.rfc-editor.org/rfc/rfc3056
- RFC 6761, Special-Use Domain Names (.localhost): https://www.rfc-editor.org/rfc/rfc6761
- AWS, Configure the instance metadata service (IMDSv2): https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/configuring-instance-metadata-service.html
- Node.js `net` documentation (`lookup` option): https://nodejs.org/api/net.html

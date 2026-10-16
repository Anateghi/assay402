import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

export const USER_AGENT = "assay-fetch/0.1 (+https://github.com/Anateghi/assay402#crawler)";

export class FetchError extends Error {
  constructor(public code: string, message: string, public status = 422) { super(message); }
}

export function isPrivateAddress(ip: string): boolean {
  if (isIP(ip) === 4) {
    const [a, b] = ip.split(".").map(Number) as [number, number];
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
  }
  const v = ip.toLowerCase();
  if (v.startsWith("::ffff:")) return isPrivateAddress(v.slice(7));
  return v === "::1" || v === "::" || v.startsWith("fc") || v.startsWith("fd") || v.startsWith("fe80");
}

/** Parse and validate a user-supplied URL (no network). Throws FetchError(400) on bad input. */
export function validateUrl(raw: string | undefined | null): URL {
  if (!raw) throw new FetchError("invalid_url", "Missing url parameter", 400);
  let u: URL;
  try { u = new URL(raw); } catch { throw new FetchError("invalid_url", "url is not a valid absolute URL", 400); }
  if (u.protocol !== "http:" && u.protocol !== "https:") throw new FetchError("invalid_url", "Only http(s) URLs are supported", 400);
  if (u.username || u.password) throw new FetchError("invalid_url", "Credentials in URLs are not allowed", 400);
  if (u.port && !["80", "443"].includes(u.port)) throw new FetchError("invalid_url", "Only ports 80 and 443 are allowed", 400);
  const host = u.hostname.replace(/^\[|\]$/g, "");
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".internal") || host.endsWith(".local")) throw new FetchError("blocked_host", "Host not allowed", 400);
  if (isIP(host) && isPrivateAddress(host)) throw new FetchError("blocked_host", "Private addresses are not allowed", 400);
  return u;
}

async function assertPublicHost(u: URL) {
  const host = u.hostname.replace(/^\[|\]$/g, "");
  if (isIP(host)) { if (isPrivateAddress(host)) throw new FetchError("blocked_host", "Private addresses are not allowed", 400); return; }
  let addrs: { address: string }[];
  try { addrs = await lookup(host, { all: true }); } catch { throw new FetchError("dns_failed", `Could not resolve ${host}`, 502); }
  if (addrs.some((a) => isPrivateAddress(a.address))) throw new FetchError("blocked_host", "Host resolves to a private address", 400);
}

export interface FetchedResource { finalUrl: string; status: number; contentType: string; body: Buffer; }

/** Fetch with SSRF checks on every redirect hop, a size cap and a timeout. */
export async function safeFetch(url: URL, opts: { maxBytes: number; timeoutMs?: number; accept?: string }): Promise<FetchedResource> {
  let current = url;
  for (let hop = 0; hop < 5; hop++) {
    validateUrl(current.toString());
    await assertPublicHost(current);
    const res = await fetch(current, {
      redirect: "manual",
      headers: { "user-agent": USER_AGENT, accept: opts.accept ?? "*/*" },
      signal: AbortSignal.timeout(opts.timeoutMs ?? 15_000),
    }).catch((e) => { throw new FetchError("fetch_failed", `Upstream fetch failed: ${(e as Error).message}`, 502); });
    if ([301, 302, 303, 307, 308].includes(res.status)) {
      const loc = res.headers.get("location");
      if (!loc) throw new FetchError("bad_redirect", "Redirect without Location", 502);
      current = new URL(loc, current);
      continue;
    }
    const len = Number(res.headers.get("content-length") ?? 0);
    if (len > opts.maxBytes) throw new FetchError("too_large", `Resource exceeds ${opts.maxBytes} bytes`, 413);
    const reader = res.body?.getReader();
    const chunks: Uint8Array[] = []; let total = 0;
    if (reader) for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > opts.maxBytes) { await reader.cancel(); throw new FetchError("too_large", `Resource exceeds ${opts.maxBytes} bytes`, 413); }
      chunks.push(value);
    }
    return { finalUrl: current.toString(), status: res.status, contentType: res.headers.get("content-type") ?? "", body: Buffer.concat(chunks) };
  }
  throw new FetchError("too_many_redirects", "Too many redirects", 502);
}

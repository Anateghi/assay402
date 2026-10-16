import { parseHTML } from "linkedom";
import { Readability } from "@mozilla/readability";
import TurndownService from "turndown";
import { safeFetch, FetchError } from "./safefetch.js";
import { checkRobots } from "./robots.js";

export interface ExtractResult {
  url: string; source_url: string; canonical: string | null; title: string | null; byline: string | null;
  published: string | null; lang: string | null; excerpt: string | null; markdown: string;
  links: { text: string; href: string }[]; word_count: number; truncated: boolean;
  fetched_at: string; robots: { allowed: true; rule: string | null }; cached: boolean;
}

const MAX_MARKDOWN = 200_000;

export function htmlToResult(html: string, baseUrl: string) {
  const { document } = parseHTML(html);
  const meta = (sel: string) => document.querySelector(sel)?.getAttribute("content")?.trim() || null;
  const canonicalHref = document.querySelector('link[rel="canonical"]')?.getAttribute("href");
  const canonical = canonicalHref ? new URL(canonicalHref, baseUrl).toString() : null;
  const lang = document.documentElement?.getAttribute("lang") || null;
  const published = meta('meta[property="article:published_time"]') ?? meta('meta[name="date"]') ?? document.querySelector("time[datetime]")?.getAttribute("datetime") ?? null;
  const article = new Readability(document as unknown as Document, { charThreshold: 200 }).parse();
  const contentHtml = article?.content ?? document.body?.innerHTML ?? "";
  const td = new TurndownService({ headingStyle: "atx", codeBlockStyle: "fenced", bulletListMarker: "-" });
  td.remove(["script", "style", "noscript", "iframe"] as any);
  let markdown = td.turndown(contentHtml).replace(/\n{3,}/g, "\n\n").trim();
  const { document: frag } = parseHTML(`<!doctype html><html><body>${contentHtml}</body></html>`);
  const links: { text: string; href: string }[] = [];
  const seen = new Set<string>();
  for (const a of Array.from(frag.querySelectorAll("a[href]")) as any[]) {
    try {
      const href = new URL(a.getAttribute("href"), baseUrl).toString();
      if (!/^https?:/.test(href) || seen.has(href)) continue;
      seen.add(href); links.push({ text: (a.textContent ?? "").trim().slice(0, 200), href });
      if (links.length >= 200) break;
    } catch { /* skip */ }
  }
  let truncated = false;
  if (markdown.length > MAX_MARKDOWN) { markdown = markdown.slice(0, MAX_MARKDOWN); truncated = true; }
  const title = article?.title?.trim() || document.querySelector("title")?.textContent?.trim() || null;
  return {
    canonical, title, byline: article?.byline?.trim() || meta('meta[name="author"]'), published, lang,
    excerpt: article?.excerpt?.trim() || meta('meta[name="description"]'), markdown, links,
    word_count: markdown.split(/\s+/).filter(Boolean).length, truncated,
  };
}

const cache = new Map<string, { value: ExtractResult; ts: number }>();
const TTL = 3600_000;

export async function extractUrl(u: URL): Promise<ExtractResult> {
  const key = u.toString();
  const hit = cache.get(key);
  if (hit && Date.now() - hit.ts < TTL) return { ...hit.value, cached: true };
  const robots = await checkRobots(u);
  if (!robots.allowed) throw new FetchError("robots_disallowed", `robots.txt disallows assay-fetch for this path (${robots.rule})`, 451);
  const r = await safeFetch(u, { maxBytes: 5 * 1024 * 1024, accept: "text/html,application/xhtml+xml" });
  if (r.status >= 400) throw new FetchError("upstream_status", `Upstream returned HTTP ${r.status}`, 502);
  if (!/html|xml/i.test(r.contentType)) throw new FetchError("unsupported_content_type", `Expected HTML, got ${r.contentType || "unknown"}`, 415);
  const charset = /charset=([^;]+)/i.exec(r.contentType)?.[1]?.trim() ?? "utf-8";
  let html: string;
  try { html = new TextDecoder(charset).decode(r.body); } catch { html = r.body.toString("utf8"); }
  const parsed = htmlToResult(html, r.finalUrl);
  if (!parsed.markdown) throw new FetchError("empty_content", "No extractable content found", 422);
  const value: ExtractResult = { url: key, source_url: r.finalUrl, ...parsed, fetched_at: new Date().toISOString(), robots: { allowed: true, rule: robots.rule }, cached: false };
  cache.set(key, { value, ts: Date.now() });
  if (cache.size > 2000) cache.delete(cache.keys().next().value!);
  return value;
}

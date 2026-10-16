/* Static site generator for Assay: home, pricing, docs, blog, llms.txt, sitemap, robots, OG/meta. */
import { readFileSync, writeFileSync, mkdirSync, readdirSync, copyFileSync, rmSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { marked } from "marked";
import { loadConfig } from "../src/config.js";

const cfg = loadConfig();
const ORIGIN = cfg.publicUrl;
const HOST = new URL(ORIGIN).host;
const OUT = "public";
const TODAY = new Date().toISOString().slice(0, 10);
const REPO = "https://github.com/Anateghi/assay402";

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

const fill = (s: string) => s.replaceAll("{{ORIGIN}}", ORIGIN).replaceAll("{{HOST}}", HOST).replaceAll("{{PAY_TO}}", cfg.payTo).replaceAll("{{BRAND}}", "Assay");
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
function write(path: string, content: string | Buffer) { const p = join(OUT, path); mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, content); }

interface Doc { meta: Record<string, string>; body: string }
function parse(src: string): Doc {
  const m = /^---\n([\s\S]*?)\n---\n?/.exec(src);
  const meta: Record<string, string> = {};
  if (m) for (const line of m[1]!.split("\n")) { const i = line.indexOf(":"); if (i > 0) meta[line.slice(0, i).trim()] = line.slice(i + 1).trim().replace(/^"(.*)"$/, "$1"); }
  return { meta, body: m ? src.slice(m[0].length) : src };
}
function md(body: string) {
  let html = marked.parse(body, { async: false, gfm: true }) as string;
  html = html.replace(/<blockquote>\s*<p><strong>(Note|Cost|Gotcha):<\/strong>/g, (_s, k: string) => `<blockquote class="callout ${k.toLowerCase()}"><p><strong>${k}</strong>`);
  // external links open normally but marked as external for agents/readers
  html = html.replace(new RegExp(`<a href="(https?://(?!${HOST.replace(/\./g, "\\.")})[^"]+)"`, "g"), '<a href="$1" rel="noopener"');
  return html;
}
function stripH1(body: string) { return body.replace(/^\s*# .*\n/, ""); }

const LOGO = (size = 30) => `<svg class="logo" width="${size}" height="${size}" viewBox="0 0 32 32" aria-hidden="true" focusable="false">
  <path d="M5 9 L9.5 25 H22.5 L27 9" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linejoin="miter"/>
  <path d="M3 9 H29" stroke="currentColor" stroke-width="2.4"/>
  <circle class="drop" cx="26.5" cy="4.2" r="2.4" fill="#D9A441"/>
</svg>`;
const FAVICON = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><rect width="16" height="16" rx="2" fill="#B4532A"/><path d="M8 3.2c1.9 2.6 3 4.3 3 5.8a3 3 0 0 1-6 0c0-1.5 1.1-3.2 3-5.8z" fill="#D9A441"/></svg>`;

const NAV = [["/docs/", "Docs"], ["/pricing/", "Pricing"], ["/blog/", "Blog"], [REPO, "GitHub"]];

function layout(o: { title: string; description: string; path: string; body: string; type?: "website" | "article"; jsonld?: object[]; mdTwin?: string; published?: string }) {
  const url = ORIGIN + o.path;
  const full = o.path === "/" ? o.title : `${o.title} · Assay`;
  const ld = (o.jsonld ?? []).map((j) => `<script type="application/ld+json">${JSON.stringify(j).replace(/</g, "\\u003c")}</script>`).join("\n");
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(full)}</title>
<meta name="description" content="${esc(o.description)}">
<link rel="canonical" href="${url}">
${o.mdTwin ? `<link rel="alternate" type="text/markdown" href="${ORIGIN}${o.mdTwin}">` : ""}
<meta property="og:type" content="${o.type ?? "website"}">
<meta property="og:site_name" content="Assay">
<meta property="og:title" content="${esc(full)}">
<meta property="og:description" content="${esc(o.description)}">
<meta property="og:url" content="${url}">
<meta property="og:image" content="${ORIGIN}/og.png">
<meta property="og:image:width" content="1200"><meta property="og:image:height" content="630">
${o.published ? `<meta property="article:published_time" content="${o.published}">` : ""}
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${esc(full)}">
<meta name="twitter:description" content="${esc(o.description)}">
<meta name="twitter:image" content="${ORIGIN}/og.png">
<meta name="theme-color" content="#F4EFE6" media="(prefers-color-scheme: light)">
<meta name="theme-color" content="#14120F" media="(prefers-color-scheme: dark)">
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Fraunces:ital,opsz,wght,SOFT,WONK@0,9..144,400..700,0..100,0..1;1,9..144,400..700,0..100,0..1&family=IBM+Plex+Mono:wght@400;500&family=IBM+Plex+Sans:ital,wght@0,400;0,500;0,600;1,400&display=swap">
<link rel="stylesheet" href="/style.css">
<link rel="alternate" type="application/rss+xml" title="Assay blog" href="/blog/rss.xml">
${ld}
</head>
<body>
<header class="top"><div class="in">
  <a class="brand" href="/" aria-label="Assay home">${LOGO()}<span class="word">a<span class="ss">ss</span>ay</span></a>
  <span class="testnet" title="Payments run on Base Sepolia testnet">testnet · base sepolia</span>
  <nav class="nav">${NAV.map(([h, l]) => `<a href="${h}"${o.path.startsWith(h!) && h !== "/" ? ' aria-current="page"' : ""}>${l}</a>`).join("")}</nav>
</div></header>
<main>
${o.body}
</main>
<footer><div class="wrap"><div class="grid12">
  <div><span class="brand">${LOGO(22)}<span class="word" style="font-size:1.2rem">a<span class="ss">ss</span>ay</span></span><p>Refined, measured data for agents. Paid per call.</p></div>
  <div><p><a href="/docs/">Docs</a> · <a href="/pricing/">Pricing</a> · <a href="/blog/">Blog</a> · <a href="/terms/">Terms</a><br><a href="/llms.txt">llms.txt</a> · <a href="/openapi.json">OpenAPI</a> · <a href="/.well-known/x402">/.well-known/x402</a></p></div>
  <div><p>MVP on Base Sepolia testnet. No real funds are accepted.<br>Source: <a href="${REPO}">github.com/Anateghi/assay402</a></p></div>
</div></div></footer>
<script src="/app.js" defer></script>
</body>
</html>`;
}

const sitemap: { loc: string; lastmod: string }[] = [];
const llms: { section: string; title: string; url: string; desc: string }[] = [];
const page = (path: string, html: string, lastmod = TODAY) => { write(path === "/" ? "index.html" : path.replace(/^\//, "") + (path.endsWith("/") ? "index.html" : ""), html); sitemap.push({ loc: ORIGIN + path, lastmod }); };

// ---------- Docs ----------
const docs = readdirSync("content/docs").filter((f) => f.endsWith(".md")).map((f) => {
  const d = parse(fill(readFileSync(join("content/docs", f), "utf8")));
  const slug = f.replace(/\.md$/, "");
  return { ...d, slug, path: slug === "index" ? "/docs/" : `/docs/${slug}/`, mdPath: slug === "index" ? "/docs/index.md" : `/docs/${slug}.md` };
}).sort((a, b) => Number(a.meta.order) - Number(b.meta.order));

for (const d of docs) {
  const side = `<aside class="sidebar"><span class="eyebrow">Docs</span>${docs.map((x) => `<a href="${x.path}"${x.path === d.path ? ' aria-current="page"' : ""}${x.meta.nav?.startsWith("/") ? ' class="mono"' : ""}>${esc(x.meta.nav ?? x.meta.title!)}</a>`).join("")}
  <span class="eyebrow" style="margin-top:1rem">Machine-readable</span><a class="mono" href="/llms.txt">/llms.txt</a><a class="mono" href="/openapi.json">/openapi.json</a><a class="mono" href="/pricing.json">/pricing.json</a></aside>`;
  const isEndpoint = !!d.meta.specimen;
  const jsonld: object[] = [{ "@context": "https://schema.org", "@type": "TechArticle", headline: d.meta.title, description: d.meta.description, url: ORIGIN + d.path, dateModified: TODAY, publisher: { "@type": "Organization", name: "Assay" } }];
  if (isEndpoint) jsonld.push({ "@context": "https://schema.org", "@type": "SoftwareApplication", name: `Assay ${d.meta.nav}`, applicationCategory: "DeveloperApplication", operatingSystem: "Any (HTTP API)", url: ORIGIN + d.path, offers: { "@type": "Offer", price: d.slug === "extract" ? "0.003" : "0.01", priceCurrency: "USD", description: "Per successful call, paid in USDC via x402 (Base Sepolia testnet)" } });
  const body = `<div class="page">${side}<article class="prose settle">
  ${isEndpoint ? `<div class="specimen-label">${esc(d.meta.specimen!)}</div>` : ""}
  <div class="meta"><span>Docs</span><button class="copy-md" data-copy-md="${d.mdPath}">copy as markdown</button><a href="${d.mdPath}">.md</a></div>
  ${md(d.body)}
  </article><div></div></div>`;
  page(d.path, layout({ title: d.meta.title!, description: d.meta.description!, path: d.path, body, jsonld, mdTwin: d.mdPath }));
  write(d.mdPath.slice(1), d.body);
  llms.push({ section: "Docs", title: d.meta.title!, url: ORIGIN + d.mdPath, desc: d.meta.description! });
}

// ---------- Blog ----------
const posts = readdirSync("content/blog").filter((f) => f.endsWith(".md")).sort().map((f, i) => {
  const d = parse(fill(readFileSync(join("content/blog", f), "utf8")));
  return { ...d, n: i + 1, slug: d.meta.slug!, path: `/blog/${d.meta.slug}/`, mdPath: `/blog/${d.meta.slug}.md` };
});
for (const p of posts) {
  const isHowTo = /^(How|Clean|SEC|Wikidata|PDF|Adding|Pay-per|Paid)/i.test(p.meta.title!) || /how-to|pay-for|clean-markdown|pdf-to|paid-tools|edgar|wikidata/.test(p.slug);
  const jsonld: object[] = [{ "@context": "https://schema.org", "@type": "TechArticle", headline: p.meta.title, description: p.meta.description, datePublished: p.meta.date, dateModified: p.meta.date, keywords: p.meta.keywords?.replace(/^\[|\]$/g, ""), url: ORIGIN + p.path, author: { "@type": "Organization", name: "Assay" }, publisher: { "@type": "Organization", name: "Assay", logo: { "@type": "ImageObject", url: ORIGIN + "/favicon.svg" } }, image: ORIGIN + "/og.png", mainEntityOfPage: ORIGIN + p.path }];
  if (isHowTo) {
    const steps = [...p.body.matchAll(/^## (.+)$/gm)].map((m) => m[1]!).filter((s) => !/^sources|checklist|disclaimer/i.test(s)).slice(0, 8);
    jsonld.push({ "@context": "https://schema.org", "@type": "HowTo", name: p.meta.title, description: p.meta.description, step: steps.map((s, i) => ({ "@type": "HowToStep", position: i + 1, name: s, url: `${ORIGIN}${p.path}` })) });
  }
  const body = `<div class="page blog"><div></div><article class="prose settle">
  <div class="meta"><span>Post ${String(p.n).padStart(2, "0")}</span><time datetime="${p.meta.date}">${p.meta.date}</time><button class="copy-md" data-copy-md="${p.mdPath}">copy as markdown</button><a href="${p.mdPath}">.md</a></div>
  ${md(p.body)}
  <hr><p><a href="/blog/">← All posts</a> · <a href="/docs/">Docs</a> · <a href="/docs/quickstart/">Make a paid call</a></p>
  </article><div></div></div>`;
  page(p.path, layout({ title: p.meta.title!, description: p.meta.description!, path: p.path, body, type: "article", jsonld, mdTwin: p.mdPath, published: p.meta.date }), p.meta.date);
  write(p.mdPath.slice(1), `---\ntitle: "${p.meta.title}"\ndescription: "${p.meta.description}"\ndate: ${p.meta.date}\ncanonical: ${ORIGIN}${p.path}\n---\n\n${p.body}`);
  llms.push({ section: "Blog", title: p.meta.title!, url: ORIGIN + p.mdPath, desc: p.meta.description! });
}
page("/blog/", layout({ title: "Blog: x402, agent payments, and clean data", description: "Field notes on x402, paying for APIs from agents, web extraction, PDFs, and pricing.", path: "/blog/", body: `<div class="page blog"><div></div><div class="prose settle">
  <span class="eyebrow">Field notes</span><h1>Blog</h1><p>Primary sources, working code, and no invented benchmarks.</p>
  <ul class="posts">${posts.map((p) => `<li><span class="n">${String(p.n).padStart(2, "0")}</span><div><h2><a href="${p.path}">${esc(p.meta.title!)}</a></h2><p>${esc(p.meta.description!)}</p></div></li>`).join("")}</ul></div><div></div></div>` }));
write("blog/rss.xml", `<?xml version="1.0" encoding="UTF-8"?>\n<rss version="2.0"><channel><title>Assay blog</title><link>${ORIGIN}/blog/</link><description>x402, agent payments and clean data</description>${posts.map((p) => `<item><title>${esc(p.meta.title!)}</title><link>${ORIGIN}${p.path}</link><guid>${ORIGIN}${p.path}</guid><pubDate>${new Date(p.meta.date + "T00:00:00Z").toUTCString()}</pubDate><description>${esc(p.meta.description!)}</description></item>`).join("")}</channel></rss>`);

// ---------- Home ----------
const home = `
<section class="hero lab-grid"><div class="wrap"><div class="grid12">
  <div class="lede settle">
    <span class="eyebrow">Pay-per-call API · x402 v2 · USDC</span>
    <h1>Raw web in.<br><em>Measured</em> data out.</h1>
    <p class="sub">Assay turns web pages and PDFs into clean text your agent can use. No signup, no API key: your agent reads the price from a <code>402</code>, signs, and retries. You pay only when the call succeeds.</p>
    <div class="cta"><a class="btn primary" href="/docs/quickstart/">Make a paid call →</a><a class="btn" href="/docs/payments/">Read the 402 contract</a></div>
    <p class="eyebrow" style="margin-top:1.4rem">Live on Base Sepolia testnet · free test USDC</p>
  </div>
  <div class="exchange settle" style="animation-delay:80ms">
    <div class="tx" aria-live="polite">
      <div class="bar"><span>GET /v1/extract?url=https://example.com/</span><button class="run" id="run-402" type="button">run it ▸</button></div>
      <div class="step"><div class="lbl">01 · request without payment <span class="dim">(live, this server)</span></div><pre id="live-402"><span class="s402">HTTP/1.1 402 Payment Required</span>
<span class="k">PAYMENT-REQUIRED</span> eyJ4NDAyVmVyc2lvbiI6Mi…
<span class="k">amount</span>   3000  <span class="dim">= $0.003 USDC</span>
<span class="k">network</span>  eip155:84532</pre></div>
      <div class="step"><div class="lbl">02 · agent signs EIP-3009, retries <span class="dim">(client side)</span></div><pre>GET /v1/extract?url=https://example.com/
<span class="k">PAYMENT-SIGNATURE</span> eyJ4NDAyVmVyc2lvbiI6MiwiYWNj…
<span class="dim">→ verify (x402.org facilitator) → extract → settle</span></pre></div>
      <div class="step"><div class="lbl">03 · result, settled only on success <span class="dim">(sample)</span></div><pre><span class="s200">HTTP/1.1 200 OK</span>
<span class="k">PAYMENT-RESPONSE</span> eyJzdWNjZXNzIjp0cnVlLCJ0cmFu…
{ "title": "Example Domain",
  "markdown": "# Example Domain\\n\\nThis domain is for use in…",
  "robots": { "allowed": true } }</pre></div>
    </div>
  </div>
</div></div></section>

<section class="band"><div class="wrap">
  <div class="section-head"><h2>Specimens</h2><span class="eyebrow">2 endpoints · flat prices</span></div>
  <div class="specimens">
    <article class="specimen settle"><div class="hdr"><span>SPECIMEN 01 · /v1/extract</span><span class="tag">$0.003 / call</span></div>
      <div class="body"><div><h3>Web page → markdown</h3><p>Readability extraction, markdown, and metadata from any public page. robots.txt checked first.</p>
<pre>GET /v1/extract?url=https://www.rfc-editor.org/rfc/rfc9309</pre><p><a href="/docs/extract/">Docs →</a></p></div>
      <div><pre>{
  "title": "RFC 9309: Robots Exclusion Protocol",
  "canonical": "https://www.rfc-editor.org/rfc/rfc9309",
  "lang": "en",
  "markdown": "# RFC 9309 …",
  "links": [ … ],
  "fetched_at": "2026-10-16T18:00:00Z",
  "robots": { "allowed": true, "rule": null }
}</pre></div></div></article>
    <article class="specimen settle"><div class="hdr"><span>SPECIMEN 02 · /v1/pdf/text</span><span class="tag">$0.01 / call</span></div>
      <div class="body"><div><h3>PDF → text, per page</h3><p>Send a URL or upload the bytes. You get the text layer page by page, so citations point to a page.</p>
<pre>POST /v1/pdf/text
{"url": "https://…/report.pdf"}</pre><p><a href="/docs/pdf-text/">Docs →</a></p></div>
      <div><pre>{
  "pages": 2,
  "text_layer_empty_pages": [],
  "content": [
    { "page": 1, "text": "Annual report …" },
    { "page": 2, "text": "…" }
  ]
}</pre></div></div></article>
  </div>
</div></section>

<section class="band"><div class="wrap">
  <div class="section-head"><h2>How a call settles</h2><span class="eyebrow">x402 v2 · exact scheme</span></div>
  <ol class="steps">
    <li><h3>Ask</h3><p>Call the endpoint. Get <code>402</code> with price, asset, network, and pay-to address in <code>PAYMENT-REQUIRED</code>.</p></li>
    <li><h3>Sign</h3><p>Your agent signs a USDC <code>transferWithAuthorization</code> and retries with <code>PAYMENT-SIGNATURE</code>. No gas needed.</p></li>
    <li><h3>Settle on success</h3><p>We verify, do the work, and settle only if it worked. Failed calls are never charged, and every authorization works exactly once.</p></li>
  </ol>
</div></section>

<section class="band"><div class="wrap">
  <div class="section-head"><h2>What is real today</h2><span class="eyebrow">MVP, stated plainly</span></div>
  <div class="honest">
    <div><h3>Built</h3><ul><li>Two paid endpoints: extract and PDF text</li><li>x402 v2 payments, settle-on-success, replay guard</li><li>Base Sepolia testnet via the public x402.org facilitator</li><li>Per-IP rate limits, robots.txt compliance, SSRF guards</li><li>OpenAPI, <code>/pricing.json</code>, <code>/.well-known/x402</code>, <code>/llms.txt</code></li></ul></div>
    <div><h3>Not yet</h3><ul><li>Mainnet payments (testnet only)</li><li>Prepaid API keys</li><li>SEC EDGAR, Wikidata, embeddings endpoints</li><li>OCR and JavaScript rendering</li><li>A packaged MCP server</li></ul></div>
  </div>
</div></section>`;
page("/", layout({ title: "Assay: pay-per-call web and PDF extraction for AI agents", description: "Clean markdown from web pages and text from PDFs, paid per call with x402 v2 and USDC. No signup, no API key. Live on Base Sepolia testnet.", path: "/", body: home,
  jsonld: [{ "@context": "https://schema.org", "@type": "SoftwareApplication", name: "Assay", applicationCategory: "DeveloperApplication", operatingSystem: "Any (HTTP API)", url: ORIGIN, description: "Pay-per-call API gateway for AI agents using x402.", offers: [{ "@type": "Offer", name: "/v1/extract", price: "0.003", priceCurrency: "USD" }, { "@type": "Offer", name: "/v1/pdf/text", price: "0.01", priceCurrency: "USD" }] }, { "@context": "https://schema.org", "@type": "Organization", name: "Assay", url: ORIGIN, logo: ORIGIN + "/favicon.svg", sameAs: [REPO] }] }));

// ---------- Pricing ----------
page("/pricing/", layout({ title: "Pricing", description: "Flat per-call prices in USDC: $0.003 for web extraction, $0.01 for PDF text. Charged only on success.", path: "/pricing/", body: `
<section class="hero lab-grid"><div class="wrap" style="padding:3.5rem 1.25rem">
  <span class="eyebrow">Pricing · per successful call</span><h1>Flat prices. Paid per call.</h1>
  <p class="sub" style="color:var(--muted);max-width:60ch">Same price for every caller, published here and at <a href="/pricing.json"><code>/pricing.json</code></a>. Charged in USDC through x402 only when the response succeeds.</p>
  <table class="price-table" style="background:var(--surface);border:1px solid var(--rule);max-width:820px">
    <thead><tr><th>Specimen</th><th>Endpoint</th><th>Price</th><th>Atomic USDC</th></tr></thead>
    <tbody><tr><td>01 · Web page → markdown</td><td class="p"><a href="/docs/extract/">GET /v1/extract</a></td><td><span class="tag">$0.003 / call</span></td><td class="p">3000</td></tr>
    <tr><td>02 · PDF → text</td><td class="p"><a href="/docs/pdf-text/">POST /v1/pdf/text</a></td><td><span class="tag">$0.01 / call</span></td><td class="p">10000</td></tr></tbody></table>
  <blockquote class="callout cost" style="max-width:820px"><p><strong>Cost</strong> Testnet only for now: payments are Base Sepolia test USDC (<code>eip155:84532</code>), so trying Assay costs nothing real. Failed calls, rate-limited calls and replays are never settled.</p></blockquote>
</div></section>` }));

// ---------- Terms, 404 ----------
page("/terms/", layout({ title: "Terms and acceptable use", description: "Assay MVP terms: testnet only, no warranty, acceptable use, refund policy for failed calls.", path: "/terms/", body: `<div class="page blog"><div></div><article class="prose"><h1>Terms and acceptable use</h1>
<p><strong>Status.</strong> Assay is an MVP running on Base Sepolia testnet. It accepts only test USDC, which has no monetary value. The service is provided as is, without warranty or uptime commitment.</p>
<p><strong>Charges.</strong> A payment is settled only when a call succeeds (HTTP status below 400). Failed calls are not settled.</p>
<p><strong>Acceptable use.</strong> Request only content you are allowed to access. Do not use Assay to reach private networks, to evade blocks, or to overload any site. We honor robots.txt for <code>assay-fetch</code> and may block abusive callers.</p>
<p><strong>Sanctions and law.</strong> Do not use Assay in violation of applicable sanctions or laws.</p>
<p><strong>Contact.</strong> <a href="${REPO}/issues">GitHub issues</a>.</p></article><div></div></div>` }));
write("404.html", layout({ title: "Not found", description: "This page does not exist.", path: "/404", body: `<div class="page blog"><div></div><div class="prose"><span class="eyebrow">404 · not found</span><h1>Nothing to assay here.</h1><p>Try the <a href="/docs/">docs</a> or the <a href="/blog/">blog</a>.</p></div><div></div></div>` }));

// ---------- Static assets, llms.txt, sitemap, robots ----------
copyFileSync("site/style.css", join(OUT, "style.css"));
copyFileSync("site/app.js", join(OUT, "app.js"));
if (existsSync("site/og.png")) copyFileSync("site/og.png", join(OUT, "og.png"));
write("favicon.svg", FAVICON);
write("logo.svg", `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" width="64" height="64" color="#1E1B18">${LOGO().replace(/<svg[^>]*>|<\/svg>/g, "")}</svg>`);

const llmsTxt = `# Assay

> Pay-per-call API for AI agents. Web page -> clean markdown/JSON ($0.003/call) and PDF -> per-page text ($0.01/call). Payment via x402 v2 (exact scheme, USDC) on Base Sepolia TESTNET (eip155:84532) through the public x402.org facilitator. No signup or API key. Charged only on success; each payment authorization is single-use.

API base: ${ORIGIN}
Machine-readable: ${ORIGIN}/openapi.json, ${ORIGIN}/pricing.json, ${ORIGIN}/.well-known/x402

## Docs
${llms.filter((l) => l.section === "Docs").map((l) => `- [${l.title}](${l.url}): ${l.desc}`).join("\n")}

## Blog
${llms.filter((l) => l.section === "Blog").map((l) => `- [${l.title}](${l.url}): ${l.desc}`).join("\n")}

## Optional
- [Source code](${REPO}): TypeScript (Hono + @x402/hono), MIT
- [Terms](${ORIGIN}/terms/)
`;
write("llms.txt", llmsTxt);
write("llms-full.txt", docs.map((d) => d.body).join("\n\n---\n\n"));
write("sitemap.xml", `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${sitemap.map((s) => `  <url><loc>${s.loc}</loc><lastmod>${s.lastmod}</lastmod></url>`).join("\n")}\n</urlset>\n`);
write("robots.txt", `User-agent: *\nAllow: /\nDisallow: /v1/\n\nSitemap: ${ORIGIN}/sitemap.xml\n`);
console.log(`built ${sitemap.length} pages for ${ORIGIN}`);

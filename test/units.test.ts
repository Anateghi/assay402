import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { isAllowed } from "../src/robots.js";
import { isPrivateAddress, validateUrl } from "../src/safefetch.js";
import { htmlToResult } from "../src/extract.js";
import { pdfToText } from "../src/pdf.js";
import { NonceStore, paymentId } from "../src/replay.js";
import { TokenBucket } from "../src/ratelimit.js";

describe("robots.txt (RFC 9309)", () => {
  const txt = "User-agent: *\nDisallow: /private/\nAllow: /private/press/\n\nUser-agent: assay-fetch\nDisallow: /no-assay\n";
  it("uses our specific group when present", () => {
    expect(isAllowed(txt, "/no-assay/x").allowed).toBe(false);
    expect(isAllowed(txt, "/private/x").allowed).toBe(true); // our group overrides *
  });
  it("longest match wins, allow wins ties", () => {
    const t = "User-agent: *\nDisallow: /private/\nAllow: /private/press/\n";
    expect(isAllowed(t, "/private/a").allowed).toBe(false);
    expect(isAllowed(t, "/private/press/a").allowed).toBe(true);
    expect(isAllowed("User-agent: *\nDisallow: /*.pdf$", "/a.pdf").allowed).toBe(false);
    expect(isAllowed("", "/x").allowed).toBe(true);
  });
});

describe("SSRF guards", () => {
  it("flags private ranges", () => {
    for (const ip of ["127.0.0.1", "10.1.2.3", "192.168.1.1", "172.16.0.1", "169.254.169.254", "::1", "fd00::1", "::ffff:127.0.0.1", "100.64.0.1"]) expect(isPrivateAddress(ip)).toBe(true);
    for (const ip of ["8.8.8.8", "1.1.1.1", "2606:4700::1111"]) expect(isPrivateAddress(ip)).toBe(false);
  });
  it("validates urls", () => {
    expect(() => validateUrl("http://user:pw@example.com")).toThrow();
    expect(validateUrl("https://example.com/a?b=1").hostname).toBe("example.com");
  });
});

describe("extraction", () => {
  it("turns html into markdown + metadata", () => {
    const html = `<!doctype html><html lang="en"><head><title>Doc</title><link rel="canonical" href="/c"><meta name="author" content="Ann"></head>
      <body><nav>menu</nav><article><h1>Hello world</h1><p>${"Lorem ipsum dolor sit amet. ".repeat(20)}<a href="/next">next</a></p><h2>Sub</h2><p>More text here.</p></article></body></html>`;
    const r = htmlToResult(html, "https://example.com/post");
    expect(r.canonical).toBe("https://example.com/c");
    expect(r.lang).toBe("en");
    expect(r.markdown).toContain("## Sub");
    expect(r.links[0]!.href).toBe("https://example.com/next");
  });
});

describe("pdf", () => {
  it("extracts text per page", async () => {
    const out = await pdfToText(new Uint8Array(readFileSync(new URL("./fixtures/hello.pdf", import.meta.url))));
    expect(out.pages).toBe(1);
    expect(out.content[0]!.text).toContain("Hello Assay PDF");
  });
  it("rejects non-pdf", async () => {
    await expect(pdfToText(new TextEncoder().encode("hello"))).rejects.toThrow(/not a PDF/);
  });
});

describe("nonce store", () => {
  it("is single-use after commit, reusable after release", () => {
    const s = new NonceStore();
    expect(s.acquire("a")).toBe("ok");
    expect(s.acquire("a")).toBe("in_flight");
    s.release("a"); expect(s.acquire("a")).toBe("ok");
    s.commit("a"); expect(s.acquire("a")).toBe("used");
  });
  it("derives id from EIP-3009 nonce", () => {
    const h = Buffer.from(JSON.stringify({ accepted: { network: "eip155:84532" }, payload: { authorization: { from: "0xABC", nonce: "0x01" } } })).toString("base64");
    expect(paymentId(h)).toBe("eip155:84532:0xabc:0x01");
  });
});

describe("token bucket", () => {
  it("refills over time", () => {
    let t = 0; const b = new TokenBucket(2, 1, () => t);
    expect(b.take("x").ok).toBe(true); expect(b.take("x").ok).toBe(true); expect(b.take("x").ok).toBe(false);
    t = 1000; expect(b.take("x").ok).toBe(true);
  });
});

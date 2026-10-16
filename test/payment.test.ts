import { describe, it, expect } from "vitest";
import { wrapFetchWithPaymentFromConfig, decodePaymentResponseHeader } from "@x402/fetch";
import { ExactEvmScheme } from "@x402/evm";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import { makeApp, mockFacilitator } from "./helpers.js";
import { FetchError } from "../src/safefetch.js";
import { loadConfig } from "../src/config.js";
import { createApp } from "../src/app.js";

const okExtract = async (u: URL) => ({ url: u.toString(), source_url: u.toString(), canonical: null, title: "T", byline: null, published: null, lang: "en", excerpt: null, markdown: "# T\n\nbody", links: [], word_count: 2, truncated: false, fetched_at: new Date().toISOString(), robots: { allowed: true as const, rule: null }, cached: false });

function payingFetch(app: { fetch: (r: Request) => Response | Promise<Response> }, sent: string[] = []) {
  const account = privateKeyToAccount(generatePrivateKey());
  const inner = async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input as any, init);
    const h = req.headers.get("payment-signature"); if (h) sent.push(h);
    return app.fetch(req);
  };
  return wrapFetchWithPaymentFromConfig(inner as typeof fetch, { schemes: [{ network: "eip155:84532", client: new ExactEvmScheme(account) }] });
}

const URL_OK = "http://test.local/v1/extract?url=" + encodeURIComponent("https://example.com/");

describe("x402 v2 flow", () => {
  it("returns 402 with a v2 PAYMENT-REQUIRED challenge on Base Sepolia", async () => {
    const { app } = makeApp({ extract: okExtract });
    const res = await app.request(URL_OK);
    expect(res.status).toBe(402);
    const req = JSON.parse(Buffer.from(res.headers.get("payment-required")!, "base64").toString());
    expect(req.x402Version).toBe(2);
    expect(req.accepts[0]).toMatchObject({ scheme: "exact", network: "eip155:84532", amount: "3000", payTo: "0x1111111111111111111111111111111111111111", asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e" });
    expect(req.resource.url).toBe("http://test.local/v1/extract");
  });

  it("PDF endpoint prices at $0.01", async () => {
    const { app } = makeApp();
    const res = await app.request("http://test.local/v1/pdf/text", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ url: "https://example.com/a.pdf" }) });
    expect(res.status).toBe(402);
    const req = JSON.parse(Buffer.from(res.headers.get("payment-required")!, "base64").toString());
    expect(req.accepts[0].amount).toBe("10000");
  });

  it("rejects invalid input with 400 before any payment is requested", async () => {
    const { app, calls } = makeApp({ extract: okExtract });
    for (const u of ["", "ftp://x.com", "http://127.0.0.1/", "http://localhost/", "http://10.0.0.5/", "http://example.com:8080/"]) {
      const res = await app.request("http://test.local/v1/extract?url=" + encodeURIComponent(u));
      expect(res.status).toBe(400);
    }
    expect(calls.verify).toBe(0);
  });

  it("pays, runs the handler, and settles once on success", async () => {
    const { app, calls } = makeApp({ extract: okExtract });
    const res = await payingFetch(app)(URL_OK);
    expect(res.status).toBe(200);
    expect((await res.json()).markdown).toContain("body");
    expect(calls).toEqual({ verify: 1, settle: 1 });
    const pr = decodePaymentResponseHeader(res.headers.get("payment-response")!);
    expect(pr.success).toBe(true);
    expect(pr.transaction).toMatch(/^0x/);
  });

  it("does NOT settle when the handler fails (no charge)", async () => {
    const { app, calls } = makeApp({ extract: async () => { throw new FetchError("robots_disallowed", "nope", 451); } });
    const res = await payingFetch(app)(URL_OK);
    expect(res.status).toBe(451);
    expect((await res.json()).charged).toBe(false);
    expect(calls.verify).toBe(1);
    expect(calls.settle).toBe(0);
    expect(res.headers.get("payment-response")).toBeNull();
  });

  it("rejects replay of a settled payment", async () => {
    const { app, calls } = makeApp({ extract: okExtract });
    const sent: string[] = [];
    const res = await payingFetch(app, sent)(URL_OK);
    expect(res.status).toBe(200);
    const replay = await app.request(URL_OK, { headers: { "PAYMENT-SIGNATURE": sent[0]! } });
    expect(replay.status).toBe(409);
    expect(calls.settle).toBe(1);
  });

  it("rejects a concurrent duplicate while the first is in flight", async () => {
    let release!: () => void; const gate = new Promise<void>((r) => (release = r));
    const slow = async (u: URL) => { await gate; return okExtract(u); };
    const { app, calls } = makeApp({ extract: slow });
    const sent: string[] = [];
    const first = payingFetch(app, sent)(URL_OK);
    while (!sent.length) await new Promise((r) => setTimeout(r, 5));
    await new Promise((r) => setTimeout(r, 20));
    const dup = await app.request(URL_OK, { headers: { "PAYMENT-SIGNATURE": sent[0]! } });
    expect(dup.status).toBe(409);
    release();
    expect((await first).status).toBe(200);
    expect(calls.settle).toBe(1);
  });

  it("returns 402 when the facilitator says the payment is invalid", async () => {
    const { f, calls } = mockFacilitator({ valid: false });
    const app = createApp({ config: loadConfig({ PUBLIC_URL: "http://test.local" }), facilitator: f, extract: okExtract });
    const res = await payingFetch(app)(URL_OK);
    expect(res.status).toBe(402);
    expect(calls.settle).toBe(0);
  });

  it("refuses to start on mainnet", () => {
    expect(() => loadConfig({ NETWORK: "eip155:8453" })).toThrow(/testnet/);
  });
});

describe("rate limiting", () => {
  it("returns 429 after the per-IP budget is spent", async () => {
    const { app } = makeApp({ extract: okExtract }, { RATE_LIMIT_PER_MIN: "3" });
    const statuses: number[] = [];
    for (let i = 0; i < 5; i++) statuses.push((await app.request(URL_OK, { headers: { "x-forwarded-for": "9.9.9.9" } })).status);
    expect(statuses.slice(0, 3)).toEqual([402, 402, 402]);
    expect(statuses[3]).toBe(429);
    expect((await app.request(URL_OK, { headers: { "x-forwarded-for": "8.8.8.8" } })).status).toBe(402);
  });
});

describe("discovery", () => {
  it("serves pricing.json, openapi and .well-known/x402", async () => {
    const { app } = makeApp();
    expect((await (await app.request("/pricing.json")).json()).network).toBe("eip155:84532");
    expect((await (await app.request("/openapi.json")).json()).openapi).toBe("3.1.0");
    expect((await (await app.request("/.well-known/x402")).json()).resources).toHaveLength(2);
  });
});

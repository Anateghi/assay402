import { Hono, type Context } from "hono";
import { paymentMiddleware, x402ResourceServer } from "@x402/hono";
import { ExactEvmScheme } from "@x402/evm/exact/server";
import { HTTPFacilitatorClient, type FacilitatorClient } from "@x402/core/server";
import { PRICES, type Config } from "./config.js";
import { TokenBucket, rateLimit, concurrencyCap } from "./ratelimit.js";
import { NonceStore, replayGuard } from "./replay.js";
import { validateUrl, FetchError } from "./safefetch.js";
import { extractUrl } from "./extract.js";
import { pdfFromUrl, pdfToText, MAX_PDF_BYTES } from "./pdf.js";

type Vars = { targetUrl?: URL; pdfBytes?: Uint8Array };

export interface AppDeps {
  config: Config;
  facilitator?: FacilitatorClient;
  extract?: typeof extractUrl;
  pdfFetch?: typeof pdfFromUrl;
  nonceStore?: NonceStore;
}

const metrics = { requests: 0, paid_ok: 0, handler_failed: 0, status402: 0, replay_rejected: 0, rate_limited: 0 };

function errorResponse(c: Context, e: unknown) {
  if (e instanceof FetchError) return c.json({ error: e.code, message: e.message, charged: false }, e.status as any);
  console.error(JSON.stringify({ level: "error", msg: "handler_error", err: String(e) }));
  return c.json({ error: "internal_error", message: "Unexpected error", charged: false }, 500);
}

export function createApp(deps: AppDeps) {
  const { config } = deps;
  const extract = deps.extract ?? extractUrl;
  const pdfFetch = deps.pdfFetch ?? pdfFromUrl;
  const facilitator = deps.facilitator ?? new HTTPFacilitatorClient({ url: config.facilitatorUrl });
  const resourceServer = new x402ResourceServer(facilitator).register(config.network, new ExactEvmScheme());

  const app = new Hono<{ Variables: Vars }>();

  app.use("*", async (c, next) => {
    metrics.requests++;
    const t = Date.now();
    await next();
    if (c.res.status === 402) metrics.status402++;
    if (c.res.status === 409) metrics.replay_rejected++;
    if (c.res.status === 429) metrics.rate_limited++;
    if (c.req.path.startsWith("/v1/")) {
      if (c.res.headers.has("payment-response")) metrics.paid_ok++;
      else if (c.req.header("payment-signature") && c.res.status >= 400) metrics.handler_failed++;
      console.log(JSON.stringify({ level: "info", method: c.req.method, path: c.req.path, status: c.res.status, ms: Date.now() - t, paid: c.res.headers.has("payment-response") }));
    }
  });

  // CORS for API + discovery so browser-based agents can read 402 headers.
  app.use("/v1/*", async (c, next) => {
    await next();
    c.res.headers.set("Access-Control-Allow-Origin", "*");
    c.res.headers.set("Access-Control-Expose-Headers", "PAYMENT-REQUIRED, PAYMENT-RESPONSE, Retry-After");
  });
  app.options("/v1/*", (c) => new Response(null, { status: 204, headers: {
    "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, PAYMENT-SIGNATURE, X-PAYMENT", "Access-Control-Max-Age": "86400" } }));

  // 1) Rate limit + concurrency cap before anything expensive.
  app.use("/v1/*", rateLimit(new TokenBucket(config.rateLimitPerMin, config.rateLimitPerMin / 60)));
  app.use("/v1/*", concurrencyCap(config.heavyConcurrency));

  // 2) Validate input BEFORE asking for payment: bad requests get a 400, never a 402 or a charge.
  app.use("/v1/extract", async (c, next) => {
    if (c.req.method !== "GET") return next();
    try { c.set("targetUrl", validateUrl(c.req.query("url"))); } catch (e) { return errorResponse(c, e); }
    await next();
  });
  app.use("/v1/pdf/text", async (c, next) => {
    if (c.req.method !== "POST") return next();
    try {
      const ct = c.req.header("content-type") ?? "";
      if (ct.includes("application/json")) {
        const body = await c.req.json().catch(() => null) as { url?: string } | null;
        c.set("targetUrl", validateUrl(body?.url));
      } else if (ct.includes("application/pdf") || ct.includes("application/octet-stream")) {
        const len = Number(c.req.header("content-length") ?? 0);
        if (len > MAX_PDF_BYTES) throw new FetchError("too_large", `PDF exceeds ${MAX_PDF_BYTES} bytes`, 413);
        const buf = new Uint8Array(await c.req.arrayBuffer());
        if (buf.byteLength === 0) throw new FetchError("empty_body", "Empty request body", 400);
        if (buf.byteLength > MAX_PDF_BYTES) throw new FetchError("too_large", `PDF exceeds ${MAX_PDF_BYTES} bytes`, 413);
        c.set("pdfBytes", buf);
      } else {
        throw new FetchError("unsupported_media_type", 'Send JSON {"url": "..."} or a raw application/pdf body', 415);
      }
    } catch (e) { return errorResponse(c, e); }
    await next();
  });

  // 3) Replay guard, then x402 (verify -> handler -> settle only if handler returned < 400).
  const nonceStore = deps.nonceStore ?? new NonceStore();
  app.use("/v1/*", replayGuard(nonceStore));
  const unpaid = (hint: string) => () => ({ contentType: "application/json", body: {
    error: "payment_required", message: `Pay with x402 v2 (exact, USDC on Base Sepolia testnet). ${hint}`,
    docs: `${config.publicUrl}/docs/payments` } });
  app.use(paymentMiddleware({
    [PRICES.extract.route]: {
      accepts: { scheme: "exact", price: PRICES.extract.usd, network: config.network, payTo: config.payTo, maxTimeoutSeconds: 120 },
      resource: `${config.publicUrl}/v1/extract`,
      description: "Web page to clean markdown + JSON metadata (robots.txt-aware)",
      mimeType: "application/json", serviceName: "Assay", tags: ["extract", "markdown", "web"],
      unpaidResponseBody: unpaid("Price: $0.003 per successful call."),
    },
    [PRICES.pdf.route]: {
      accepts: { scheme: "exact", price: PRICES.pdf.usd, network: config.network, payTo: config.payTo, maxTimeoutSeconds: 120 },
      resource: `${config.publicUrl}/v1/pdf/text`,
      description: "PDF (URL or upload) to per-page plain text",
      mimeType: "application/json", serviceName: "Assay", tags: ["pdf", "text"],
      unpaidResponseBody: unpaid("Price: $0.01 per successful call."),
    },
  }, resourceServer, undefined, undefined, true));

  // 4) Handlers. Any thrown/4xx/5xx result => no settlement => payer is not charged.
  app.get("/v1/extract", async (c) => {
    try {
      const r = await extract(c.get("targetUrl")!);
      const format = c.req.query("format");
      if (format === "markdown") return c.text(r.markdown, 200, { "content-type": "text/markdown; charset=utf-8" });
      return c.json(r);
    } catch (e) { return errorResponse(c, e); }
  });
  app.post("/v1/pdf/text", async (c) => {
    try {
      let bytes = c.get("pdfBytes"); let source_url: string | null = null;
      if (!bytes) { const f = await pdfFetch(c.get("targetUrl")!); bytes = f.buf; source_url = f.source_url; }
      const out = await pdfToText(bytes);
      return c.json({ source_url, bytes: bytes.byteLength, ...out, extracted_at: new Date().toISOString() });
    } catch (e) { return errorResponse(c, e); }
  });

  // Discovery / ops (free)
  app.get("/health", (c) => c.json({ ok: true, network: config.network, testnet: true }));
  app.get("/metrics", (c) => c.text(Object.entries(metrics).map(([k, v]) => `assay_${k}_total ${v}`).join("\n") + "\n"));
  const pricing = () => ({
    currency: "USDC", network: config.network, network_name: "Base Sepolia (testnet)", testnet: true,
    facilitator: config.facilitatorUrl, payTo: config.payTo, charge_policy: "Charged only on success (HTTP < 400). Failed calls are not settled.",
    endpoints: [
      { method: "GET", path: "/v1/extract", price_usd: "0.003", unit: "call" },
      { method: "POST", path: "/v1/pdf/text", price_usd: "0.01", unit: "call" },
    ],
  });
  app.get("/pricing.json", (c) => c.json(pricing()));
  app.get("/.well-known/x402", (c) => c.json({ x402Version: 2, resources: [`${config.publicUrl}/v1/extract`, `${config.publicUrl}/v1/pdf/text`], ...pricing() }));
  app.get("/openapi.json", (c) => c.json(openapi(config)));
  return app;
}

function openapi(config: Config) {
  const err = { description: "Error (not charged)", content: { "application/json": { schema: { type: "object", properties: { error: { type: "string" }, message: { type: "string" }, charged: { type: "boolean" } } } } } };
  const p402 = { description: "Payment required. Base64 JSON PaymentRequired in the PAYMENT-REQUIRED header (x402 v2)." };
  return {
    openapi: "3.1.0",
    info: { title: "Assay API", version: "0.1.0", description: "Pay-per-call endpoints for AI agents. x402 v2, exact scheme, USDC on Base Sepolia testnet." },
    servers: [{ url: config.publicUrl }],
    paths: {
      "/v1/extract": { get: { summary: "Web page to clean markdown + JSON", "x-price-usd": "0.003",
        parameters: [{ name: "url", in: "query", required: true, schema: { type: "string", format: "uri" } },
          { name: "format", in: "query", required: false, schema: { type: "string", enum: ["json", "markdown"] } }],
        responses: { "200": { description: "Extracted document" }, "400": err, "402": p402, "409": err, "415": err, "429": err, "451": err, "502": err } } },
      "/v1/pdf/text": { post: { summary: "PDF to per-page text", "x-price-usd": "0.01",
        requestBody: { required: true, content: { "application/json": { schema: { type: "object", properties: { url: { type: "string", format: "uri" } }, required: ["url"] } }, "application/pdf": { schema: { type: "string", format: "binary" } } } },
        responses: { "200": { description: "Per-page text" }, "400": err, "402": p402, "409": err, "413": err, "415": err, "422": err, "429": err } } },
    },
  };
}

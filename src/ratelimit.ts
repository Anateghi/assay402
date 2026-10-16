import type { MiddlewareHandler } from "hono";

/** In-memory token bucket keyed by client IP. Single-instance MVP; swap for Redis when scaling out. */
export class TokenBucket {
  private buckets = new Map<string, { tokens: number; ts: number }>();
  constructor(private capacity: number, private refillPerSec: number, private now = () => Date.now()) {}
  take(key: string): { ok: boolean; retryAfter: number } {
    const t = this.now();
    const b = this.buckets.get(key) ?? { tokens: this.capacity, ts: t };
    b.tokens = Math.min(this.capacity, b.tokens + ((t - b.ts) / 1000) * this.refillPerSec);
    b.ts = t;
    if (b.tokens >= 1) {
      b.tokens -= 1;
      this.buckets.set(key, b);
      if (this.buckets.size > 50_000) this.gc();
      return { ok: true, retryAfter: 0 };
    }
    this.buckets.set(key, b);
    return { ok: false, retryAfter: Math.ceil((1 - b.tokens) / this.refillPerSec) };
  }
  private gc() {
    const t = this.now();
    for (const [k, b] of this.buckets) if (t - b.ts > 10 * 60_000) this.buckets.delete(k);
  }
}

export function clientIp(h: (n: string) => string | undefined): string {
  const xff = h("x-forwarded-for");
  if (xff) return xff.split(",")[0]!.trim();
  return h("x-real-ip") ?? "unknown";
}

export function rateLimit(bucket: TokenBucket): MiddlewareHandler {
  return async (c, next) => {
    const r = bucket.take(clientIp((n) => c.req.header(n)));
    if (!r.ok) {
      c.header("Retry-After", String(r.retryAfter));
      return c.json({ error: "rate_limited", message: "Too many requests", retry_after_s: r.retryAfter }, 429);
    }
    await next();
  };
}

/** Global concurrency cap for heavy routes (extract, PDF). */
export function concurrencyCap(max: number): MiddlewareHandler {
  let inFlight = 0;
  return async (c, next) => {
    if (inFlight >= max) {
      c.header("Retry-After", "2");
      return c.json({ error: "busy", message: "Server at capacity, retry shortly" }, 503);
    }
    inFlight++;
    try { await next(); } finally { inFlight--; }
  };
}

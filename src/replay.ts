import { createHash } from "node:crypto";
import type { MiddlewareHandler } from "hono";

/**
 * Replay protection for x402 payments.
 * The facilitator also rejects already-used EIP-3009 nonces on-chain, but two identical
 * payment headers arriving concurrently could both pass /verify before either settles.
 * This guard makes each payment authorization single-use at the gateway:
 *  - in-flight: a second request with the same nonce is rejected while the first runs;
 *  - used: once a payment settled (PAYMENT-RESPONSE header set on 2xx) it can never be reused;
 *  - if the handler failed (no settlement), the nonce is released so the payer may retry.
 */
export class NonceStore {
  private used = new Map<string, number>();
  private inFlight = new Set<string>();
  constructor(private ttlMs = 48 * 3600_000, private now = () => Date.now()) {}
  acquire(id: string): "ok" | "in_flight" | "used" {
    this.sweep();
    if (this.used.has(id)) return "used";
    if (this.inFlight.has(id)) return "in_flight";
    this.inFlight.add(id);
    return "ok";
  }
  commit(id: string) { this.inFlight.delete(id); this.used.set(id, this.now()); }
  release(id: string) { this.inFlight.delete(id); }
  private sweep() {
    const t = this.now();
    if (this.used.size < 10_000) return;
    for (const [k, ts] of this.used) if (t - ts > this.ttlMs) this.used.delete(k);
  }
}

export function paymentId(header: string): string {
  try {
    const decoded = JSON.parse(Buffer.from(header, "base64").toString("utf8"));
    const auth = decoded?.payload?.authorization;
    if (auth?.nonce && auth?.from) return `${String(decoded?.accepted?.network ?? "")}:${String(auth.from).toLowerCase()}:${String(auth.nonce).toLowerCase()}`;
    const sig = decoded?.payload?.signature;
    if (typeof sig === "string") return `sig:${sig.toLowerCase()}`;
  } catch { /* fall through */ }
  return "hdr:" + createHash("sha256").update(header).digest("hex");
}

export function replayGuard(store: NonceStore): MiddlewareHandler {
  return async (c, next) => {
    const header = c.req.header("payment-signature") ?? c.req.header("x-payment");
    if (!header) return next();
    const id = paymentId(header);
    const state = store.acquire(id);
    if (state !== "ok") {
      return c.json({ error: "payment_replayed", message: state === "used" ? "This payment authorization was already used." : "This payment authorization is already being processed." }, 409);
    }
    try {
      await next();
    } finally {
      const settled = c.res && c.res.status < 400 && (c.res.headers.has("payment-response") || c.res.headers.has("x-payment-response"));
      if (settled) store.commit(id); else store.release(id);
    }
  };
}

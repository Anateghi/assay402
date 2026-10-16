import type { FacilitatorClient } from "@x402/core/server";
import { createApp, type AppDeps } from "../src/app.js";
import { loadConfig } from "../src/config.js";

export function mockFacilitator(opts: { valid?: boolean } = {}) {
  const calls = { verify: 0, settle: 0 };
  const f: FacilitatorClient = {
    async getSupported() {
      return { kinds: [{ x402Version: 2, scheme: "exact", network: "eip155:84532" }], extensions: [], signers: { "eip155:*": ["0xd407e409E34E0b9afb99EcCeb609bDbcD5e7f1bf"] } } as any;
    },
    async verify(p: any) {
      calls.verify++;
      return opts.valid === false ? { isValid: false, invalidReason: "invalid_signature" } : { isValid: true, payer: p.payload?.authorization?.from };
    },
    async settle(p: any) {
      calls.settle++;
      return { success: true, transaction: "0x" + "ab".repeat(32), network: "eip155:84532", payer: p.payload?.authorization?.from } as any;
    },
  };
  return { f, calls };
}

export function makeApp(over: Partial<AppDeps> = {}, env: Record<string, string> = {}) {
  const { f, calls } = mockFacilitator();
  const config = loadConfig({ PAY_TO: "0x1111111111111111111111111111111111111111", PUBLIC_URL: "http://test.local", RATE_LIMIT_PER_MIN: "1000", ...env });
  const app = createApp({ config, facilitator: f, ...over });
  return { app, calls, config };
}

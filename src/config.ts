// Runtime configuration. Assay MVP runs on Base Sepolia TESTNET only.
export const TESTNET_NETWORK = "eip155:84532" as const; // Base Sepolia (CAIP-2)

export interface Config {
  port: number;
  network: typeof TESTNET_NETWORK;
  payTo: `0x${string}`;
  facilitatorUrl: string;
  publicUrl: string;
  rateLimitPerMin: number;
  heavyConcurrency: number;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const network = env.NETWORK ?? TESTNET_NETWORK;
  if (network !== TESTNET_NETWORK) {
    throw new Error(`Refusing to start: NETWORK must be ${TESTNET_NETWORK} (Base Sepolia testnet) in this MVP, got ${network}`);
  }
  // Placeholder testnet address if none is configured. Never use for mainnet.
  const payTo = (env.PAY_TO ?? "0x000000000000000000000000000000000000dEaD") as `0x${string}`;
  if (!/^0x[0-9a-fA-F]{40}$/.test(payTo)) throw new Error("PAY_TO must be a 0x-prefixed 20-byte EVM address");
  const railwayDomain = env.RAILWAY_PUBLIC_DOMAIN ? `https://${env.RAILWAY_PUBLIC_DOMAIN}` : undefined;
  const port = Number(env.PORT ?? 3000);
  return {
    port,
    network: TESTNET_NETWORK,
    payTo,
    facilitatorUrl: env.FACILITATOR_URL ?? "https://x402.org/facilitator",
    publicUrl: (env.PUBLIC_URL ?? railwayDomain ?? `http://localhost:${port}`).replace(/\/$/, ""),
    rateLimitPerMin: Number(env.RATE_LIMIT_PER_MIN ?? 30),
    heavyConcurrency: Number(env.HEAVY_CONCURRENCY ?? 4),
  };
}

export const PRICES = {
  extract: { usd: "$0.003", route: "GET /v1/extract" },
  pdf: { usd: "$0.01", route: "POST /v1/pdf/text" },
} as const;

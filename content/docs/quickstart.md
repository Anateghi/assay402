---
title: "Quickstart: your first paid call"
description: "Make a paid x402 call to Assay from TypeScript in five minutes using Base Sepolia test USDC."
order: 2
nav: "Quickstart"
---

# Quickstart: your first paid call

## 1. See the price

```bash
curl -i "{{ORIGIN}}/v1/extract?url=https://example.com"
```

You get `HTTP/1.1 402 Payment Required` and a `PAYMENT-REQUIRED` header. It is Base64-encoded JSON; decode it to read the price:

```bash
curl -s -D - -o /dev/null "{{ORIGIN}}/v1/extract?url=https://example.com" \
  | grep -i '^payment-required:' | cut -d' ' -f2 | tr -d '\r' | base64 -d
```

## 2. Get a testnet wallet with test USDC

1. Create a **new** EVM private key just for testing. Never use a wallet that holds real funds.
2. Get Base Sepolia test USDC from [Circle's faucet](https://faucet.circle.com/). You don't need ETH: the facilitator pays gas.

## 3. Pay from TypeScript

```bash
npm i @x402/fetch @x402/evm viem
```

```ts
import { wrapFetchWithPaymentFromConfig, decodePaymentResponseHeader } from "@x402/fetch";
import { ExactEvmScheme } from "@x402/evm";
import { privateKeyToAccount } from "viem/accounts";

const account = privateKeyToAccount(process.env.TESTNET_KEY as `0x${string}`);
const payFetch = wrapFetchWithPaymentFromConfig(fetch, {
  schemes: [{ network: "eip155:84532", client: new ExactEvmScheme(account) }],
});

const res = await payFetch("{{ORIGIN}}/v1/extract?url=https://www.rfc-editor.org/rfc/rfc9309");
const doc = await res.json();
console.log(doc.title, doc.word_count);
console.log(decodePaymentResponseHeader(res.headers.get("PAYMENT-RESPONSE")!)); // { success, transaction, network, payer }
```

> **Gotcha:** put a spending ceiling in your own code before giving an agent a wallet. See [paying for APIs from an AI agent](/blog/pay-for-apis-from-an-ai-agent).

## 4. Check the transaction

The `transaction` in `PAYMENT-RESPONSE` is a Base Sepolia transaction hash. Look it up on [sepolia.basescan.org](https://sepolia.basescan.org/).

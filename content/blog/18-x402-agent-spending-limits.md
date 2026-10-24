---
title: "Spending Limits for Agent Wallets: Capping What an x402 Client Can Pay"
description: "How to put hard spending limits on an AI agent that pays for APIs with x402: the built-in per-payment cap in @x402/core, asset and network allowlists, a per-task budget with payment hooks, and why a signed authorization counts as spent."
slug: x402-agent-spending-limits
date: 2026-10-24
keywords: [agent wallet spending limits, x402 spend controls, maxAmountPerPayment, x402 client budget, agent wallet USDC, onBeforePaymentCreation]
---

# Spending limits for agent wallets: capping what an x402 client can pay

**Agent wallet spending limits** are the part of an x402 integration that has to be right before anything else. An agent that pays for APIs signs payments on its own, so the client code, not a human, decides what is too expensive. Here is a client that pays for at most 0.005 USDC of calls per task, never more than $0.01 per call, and only in Base Sepolia USDC:

```ts
import { wrapFetchWithPayment, x402Client } from "@x402/fetch";
import { ExactEvmScheme } from "@x402/evm/exact/client";
import { privateKeyToAccount } from "viem/accounts";

const account = privateKeyToAccount(process.env.AGENT_KEY as `0x${string}`);
const BASE_SEPOLIA_USDC = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
const BUDGET = 5_000n; // 0.005 USDC in atomic units (6 decimals)
let reserved = 0n;

const client = new x402Client()
  .register("eip155:84532", new ExactEvmScheme(account))         // 1. only this network
  .setSpendControls({ maxAmountPerPayment: "$0.01" })             // 2. per-payment cap
  .registerPolicy((_v, reqs) =>                                    // 3. only this token
    reqs.filter((r) => r.asset.toLowerCase() === BASE_SEPOLIA_USDC.toLowerCase()))
  .onBeforePaymentCreation(async ({ selectedRequirements: r }) => { // 4. task budget
    const amount = BigInt(r.amount);
    if (reserved + amount > BUDGET) {
      return { abort: true, reason: `task budget: ${reserved} + ${amount} > ${BUDGET}` };
    }
    reserved += amount; // reserve before signing, so concurrent calls can't overshoot
  })
  .onPaymentCreationFailure(async ({ selectedRequirements: r }) => {
    reserved -= BigInt(r.amount); // nothing was signed, so release the reservation
  });

const paidFetch = wrapFetchWithPayment(fetch, client);
const res = await paidFetch("{{ORIGIN}}/v1/extract?url=https://example.com");
```

We ran this against Assay's [`/v1/extract`](/docs/extract/) endpoint, which asks for 0.003 USDC per call, with `@x402/fetch` and `@x402/core` 2.28.0. The first call is allowed and reserves 3000. The second call is refused before anything is signed: `Payment creation aborted: task budget: 3000 + 3000 > 5000`. The rest of this post explains each of the four layers and what each one does and doesn't protect against. If x402 is new to you, start with [What is x402?](/blog/what-is-x402-http-402) and [How to pay for APIs from an AI agent](/blog/pay-for-apis-from-an-ai-agent).

## Why the client has to enforce the limit

In x402 the server names the price. A `402 Payment Required` response carries a `PAYMENT-REQUIRED` header listing one or more payment options in `accepts`, each with a `scheme`, `network`, `asset`, `amount` in atomic units, `payTo` address, and `maxTimeoutSeconds` ([x402 v2 specification](https://github.com/coinbase/x402/blob/main/specs/x402-specification-v2.md)). The client picks one option and signs it. Nothing in the protocol stops a server from asking for 1,000 USDC, and nothing stops a buggy or prompt-injected agent from calling an endpoint in a loop. The facilitator checks that a payment is valid. Whether it is *wise* is up to the client.

So treat every `accepts` entry as an untrusted offer, and decide in code, before signing, whether to take it.

## Layer 1: scope networks by what you register

An `x402Client` can only pay on networks you registered a scheme for. `register("eip155:84532", ...)` means the client can pay on Base Sepolia and nothing else. A wildcard like `"eip155:*"` (used in the package README) lets it pay on any EVM chain where the key holds funds. For an agent, register the exact networks you mean. The type docs for spend controls say so directly: "Network scoping is scheme registration, not a control here" ([`x402Client.ts`](https://github.com/coinbase/x402/blob/main/typescript/packages/core/src/client/x402Client.ts)). See [x402 on Base Sepolia](/blog/x402-base-sepolia-usdc) for the CAIP-2 network IDs.

## Layer 2: the built-in per-payment cap (spend controls)

`@x402/core` ships client-side spend controls, and they are **on by default**. In version 2.28.0, `DEFAULT_MAX_AMOUNT_PER_PAYMENT` is `"$1"`, and by default the client only accepts assets the scheme recognizes as default assets (such as USDC on supported networks). You can change both:

```ts
client.setSpendControls({ maxAmountPerPayment: "$0.01" });  // tighter USD cap
client.setSpendControls({
  maxAmountPerPayment: "$0.01",
  allowedAssets: [
    // a non-default token, with a cap in atomic units (not "$1")
    { network: "eip155:84532", asset: "0xYourToken", maxAmountPerPayment: "2000000" },
  ],
});
client.setSpendControls(false); // disables every cap. Don't do this in an agent.
```

The same options are available as `spendControls` in `wrapFetchWithPaymentFromConfig(fetch, { schemes, spendControls })`. A few details from the source are worth knowing:

- Spend controls run **before** your policies and before the selector, so a policy can't accidentally widen them.
- The USD cap applies only to default assets, where the library knows the decimals. It is converted to atomic units with the token's decimals.
- A per-asset `maxAmountPerPayment` must be an integer atomic amount. A dollar string like `"$1"` there throws an error rather than being guessed at.
- If every option in `accepts` is over the cap, the call fails with an error instead of falling back to something else.

When we set the cap to `"$0.001"` and called Assay's 0.003 USDC endpoint, the wrapped fetch threw: `All payment requirements were rejected by spendControls.maxAmountPerPayment ($0.001, including USDC)`. No payment was signed.

The default `$1` cap is a sensible floor, but it is per payment. One thousand $0.99 calls all pass. That is what the next layers are for.

## Layer 3: policies to pin the asset (and anything else)

A policy is a function `(x402Version, requirements[]) => requirements[]` that filters or reorders the options the server offered. Register as many as you like with `registerPolicy`. They run in order after spend controls. Useful ones for agents:

- **Pin the token contract.** Compare `asset` to the exact USDC address for your network (Circle publishes them in [USDC contract addresses](https://developers.circle.com/stablecoins/usdc-contract-addresses)), so a look-alike token never gets paid.
- **Pin the scheme.** Keep only `r.scheme === "exact"` if that is all you've reviewed.
- **Pin the payee for known services.** If your agent only ever calls a handful of APIs, keep a map of origin to expected `payTo` and drop options that don't match.

Compare amounts as integers (`BigInt` in JavaScript). `amount` is a string of atomic units, and floats lose precision. A side note: the README's selector example sorts by `a.value`, but in v2 the field is named `amount` (v1 used `maxAmountRequired`), so check field names against the types, not the examples.

## Layer 4: a budget across calls, with payment hooks

Spend controls cap a single payment. A budget caps the total, per task, per session, or per day. `x402Client` exposes lifecycle hooks for this:

- `onBeforePaymentCreation` runs after an option is selected and before the scheme signs. Returning `{ abort: true, reason }` stops the payment, and the wrapped fetch throws `Payment creation aborted: <reason>`.
- `onAfterPaymentCreation` runs once the payment payload has been created.
- `onPaymentCreationFailure` runs if creating the payload failed after the before-hooks passed.

The opening example reserves the amount in `onBeforePaymentCreation` instead of adding it after the fact. That matters when an agent fires calls in parallel. If you check in one hook and add in another, two concurrent calls can both see the old total and both pass. Reserving in the same synchronous step closes that gap within one process. If several processes share one wallet, keep the counter somewhere shared, such as a database row updated atomically, or give each worker its own key and budget.

### Count a signed authorization as spent

With the `exact` scheme on EVM, the client signs an [EIP-3009](https://eips.ethereum.org/EIPS/eip-3009) `transferWithAuthorization`. Under EIP-3009, anyone holding that signature can submit it on-chain until it expires, and the transfer is valid only between `validAfter` and `validBefore`. The `@x402/evm` client sets `validBefore` to the current time plus the server's `maxTimeoutSeconds` (Assay asks for 120 seconds). So once a payload is signed and sent, treat that amount as gone until `validBefore` passes, even if the request failed or the response never arrived. Don't release a reservation just because a call returned an error, and don't automatically re-sign and retry on a timeout, because then two authorizations may exist at the same time. Our [exact scheme on EVM](/blog/x402-exact-scheme-evm) post covers the authorization fields in detail.

## The wallet is the last line of defense

Everything above is code in the same process as the agent. A bug or a compromised dependency can bypass it. Add limits that live outside the process:

- **Fund the agent's hot wallet with only what it may spend.** A key holding 2 USDC can't lose 200. Top it up from a separate wallet on a schedule, by hand, or by a script you trust more than the agent.
- **Use a separate key per agent or per environment**, so one runaway loop can't drain another agent's budget, and so on-chain history shows which agent spent what.
- **Start on testnet.** Base Sepolia USDC is free, and the same limits apply unchanged on mainnet once you've watched them work.

## What Assay does today

Assay is the server side of this exchange. Its two paid endpoints, [`/v1/extract`](/docs/extract/) at 0.003 USDC per successful call and [`/v1/pdf/text`](/docs/pdf-text/) at 0.01 USDC, accept x402 v2 `exact` payments in USDC on **Base Sepolia testnet** (`eip155:84532`) only. Mainnet isn't enabled, so no real funds move. The price in each `PAYMENT-REQUIRED` header is fixed per endpoint, so a client cap set just above it holds. Assay settles only when the handler returns a status below 400, so a failed extraction is not charged, but your client should still count the authorization until it expires, as described above. Assay doesn't host wallets or enforce budgets for callers. The limits in this post run in your client. The [quickstart](/docs/quickstart/) walks through a first paid call with free testnet USDC, and [Payments](/docs/payments/) shows the full exchange.

**Related:** [How to pay for APIs from an AI agent](/blog/pay-for-apis-from-an-ai-agent) · [x402 vs API keys](/blog/x402-vs-api-keys) · [The x402 exact scheme on EVM](/blog/x402-exact-scheme-evm) · [Paid tools in MCP servers](/blog/paid-tools-in-mcp-servers)

### Sources
- x402 v2 specification: https://github.com/coinbase/x402/blob/main/specs/x402-specification-v2.md
- `@x402/core` client source (`x402Client.ts`, spend controls, policies, hooks): https://github.com/coinbase/x402/blob/main/typescript/packages/core/src/client/x402Client.ts
- `@x402/fetch` README: https://www.npmjs.com/package/@x402/fetch
- EIP-3009, Transfer With Authorization: https://eips.ethereum.org/EIPS/eip-3009
- Circle, USDC contract addresses: https://developers.circle.com/stablecoins/usdc-contract-addresses

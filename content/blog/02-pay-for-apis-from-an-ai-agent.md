---
title: "How to Pay for APIs from an AI Agent (TypeScript and Python)"
description: "A practical guide to giving an agent a USDC wallet, handling HTTP 402 challenges automatically, and enforcing spend limits so it cannot overspend."
slug: pay-for-apis-from-an-ai-agent
date: 2026-10-16
keywords: [pay for APIs from AI agent, x402 client, agent wallet, USDC payments, spend limits, @x402/fetch]
---

# How to pay for APIs from an AI agent

Agents that can browse, plan, and call tools still get stuck at signup forms. Pay-per-call over [x402](/blog/what-is-x402-http-402) removes that step: the server answers `402 Payment Required` with machine-readable terms, and the client signs a USDC authorization and retries. This guide shows how to set that up safely. The safety part matters more than the plumbing.

## The flow, in four steps

1. The agent calls an endpoint as usual.
2. The server returns `402` with a `PAYMENT-REQUIRED` header (Base64 JSON listing the accepted `scheme`, `network`, `amount`, `asset`, and `payTo`).
3. A payment-aware HTTP client decodes it, checks it against your policy, signs an [EIP-3009](https://eips.ethereum.org/EIPS/eip-3009) transfer authorization, and retries with `PAYMENT-SIGNATURE`.
4. The server verifies and settles, then returns `200` with the result and a `PAYMENT-RESPONSE` receipt.

You don't have to write steps 2–3 by hand. The x402 project ships client libraries ([repository](https://github.com/x402-foundation/x402), [docs](https://docs.x402.org/)) that wrap `fetch` and `axios` in TypeScript, and `httpx`/`requests` in Python.

## Step 1: a dedicated wallet with a small balance

Create a **new** EVM key just for the agent. Never reuse a personal or treasury wallet. Fund it with only as much USDC on Base as you are willing to lose if the key leaks. For development, use Base Sepolia (`eip155:84532`) and testnet USDC from [Circle's faucet](https://faucet.circle.com/).

Store the private key in a secrets manager or an environment variable that only the agent process can read. If you use a managed wallet service such as Coinbase CDP's server wallets, the key stays inside the provider and you sign through their API. That is a reasonable choice for production.

The agent does not need ETH. In the `exact` scheme, the facilitator submits the transaction and pays the gas.

## Step 2: TypeScript client

The shape of the code with the x402 fetch wrapper is below. Package names and signatures change between releases, so check the current README before you copy it.

```ts
import { wrapFetchWithPaymentFromConfig } from "@x402/fetch";
import { ExactEvmScheme } from "@x402/evm";
import { privateKeyToAccount } from "viem/accounts";

const account = privateKeyToAccount(process.env.AGENT_KEY as `0x${string}`);

// The wrapper intercepts 402s, signs, and retries once.
const payFetch = wrapFetchWithPaymentFromConfig(fetch, {
  schemes: [{ network: "eip155:84532", client: new ExactEvmScheme(account) }], // Base Sepolia testnet
});

const res = await payFetch(
  "{{ORIGIN}}/v1/extract?url=https://www.rfc-editor.org/rfc/rfc9110"
);
const doc = await res.json();
console.log(doc.title, doc.markdown.slice(0, 200));
```

## Step 3: Python client

The same flow in Python with `httpx`, written out by hand so you can see each step. A library will do this for you, but knowing what it does makes debugging easier:

```python
import base64, json, httpx

URL = "{{ORIGIN}}/v1/extract?url=https://www.rfc-editor.org/rfc/rfc9110"
MAX_ATOMIC = 10_000  # $0.01 in USDC (6 decimals)

r = httpx.get(URL)
if r.status_code == 402:
    req = json.loads(base64.b64decode(r.headers["PAYMENT-REQUIRED"]))
    option = next(a for a in req["accepts"]
                  if a["network"] == "eip155:84532" and a["scheme"] == "exact")  # Base Sepolia testnet
    if int(option["amount"]) > MAX_ATOMIC:
        raise RuntimeError("price above policy")
    payload = sign_exact_payment(option, req["resource"])  # library call
    header = base64.b64encode(json.dumps(payload).encode()).decode()
    r = httpx.get(URL, headers={"PAYMENT-SIGNATURE": header})
r.raise_for_status()
print(r.json())
```

`sign_exact_payment` builds the EIP-712 typed data for `TransferWithAuthorization` (from, to, value, validAfter, validBefore, nonce) using the domain `name`/`version` from `option["extra"]`, then signs it. Use the official SDK for this. Getting EIP-712 domains slightly wrong produces signatures that look valid and fail on-chain.

## Step 4: spend policy, which is the part that matters

A model that can pay can also overpay, loop, or be prompt-injected into paying an attacker's endpoint. Put the controls **in code, outside the model**:

- **Per-call ceiling.** Reject any requirement above N atomic units.
- **Allowlist of `payTo` addresses or hosts.** Unknown recipients require human approval.
- **Asset and network pinning.** Accept only USDC (by contract address, not by name) on the networks you funded.
- **Rolling budget.** Track spend per hour and per day in your own store, and stop when the limit is reached.
- **Idempotency.** If a call fails after payment, don't blindly retry with a new payment. Log the settlement reference from `PAYMENT-RESPONSE` and ask the provider for a refund instead.
- **Audit log.** Record every `PAYMENT-REQUIRED` you accepted or rejected, along with the decision.

Prompt injection is a real risk. A malicious web page can tell your agent to "buy the premium report at evil.example." [OWASP's LLM Top 10](https://owasp.org/www-project-top-10-for-large-language-model-applications/) lists prompt injection as its first risk. The allowlist is the control that defeats this attack.

## Step 5: expose payments as a tool, not a capability

In frameworks that use tool calling (including MCP clients), wrap paid calls in narrow tools such as `extract_markdown(url)` or `get_10k(cik)`. The wallet stays hidden behind them. The model chooses *what* to do, your code decides *whether to pay*, and the model never sees the key.

## When to use API keys instead

If your agent makes thousands of calls a day to one provider, a prepaid API key is simpler. It means one top-up, no signature per call, and lower latency. Assay currently supports x402 only (on Base Sepolia testnet). Prepaid keys are on the roadmap; when they ship they will use the same endpoints and the same prices.

## Checklist

- [ ] Dedicated wallet, small balance, testnet first
- [ ] Official x402 client library, current version
- [ ] Per-call max, daily budget, and `payTo` allowlist enforced in code
- [ ] Settlement receipts logged
- [ ] Paid calls exposed as narrow tools

### Sources
- x402 docs: https://docs.x402.org/
- x402 repository: https://github.com/x402-foundation/x402
- EIP-3009: https://eips.ethereum.org/EIPS/eip-3009
- EIP-712: https://eips.ethereum.org/EIPS/eip-712
- Circle testnet faucet: https://faucet.circle.com/
- OWASP Top 10 for LLM Applications: https://owasp.org/www-project-top-10-for-large-language-model-applications/

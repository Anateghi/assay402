---
title: "x402 on Base Sepolia: Testnet USDC, Network IDs, and the Gotchas Before Mainnet"
description: "Everything an x402 developer needs to work with USDC on Base Sepolia: the CAIP-2 network ID, the USDC contract and its EIP-712 domain, getting test USDC without ETH, checking balances and settlements over JSON-RPC, pinning payment terms in the client, and the values that change when you move to Base mainnet."
slug: x402-base-sepolia-usdc
date: 2026-10-23
keywords: [x402 Base Sepolia, x402 Base USDC, Base Sepolia USDC contract address, eip155:84532, testnet USDC faucet, x402 testnet to mainnet]
---

# x402 on Base Sepolia: testnet USDC, network IDs, and the gotchas before mainnet

**x402 on Base Sepolia** is where almost every x402 integration starts: the default facilitator settles there, the test USDC is free, and a mistake costs nothing. It is also where a handful of constants get hardcoded and later break on mainnet. Begin by reading what a server actually asks for. Every field in this output is something your client should check, not just pass through:

```bash
curl -s -D - -o /dev/null "{{ORIGIN}}/v1/extract?url=https://example.com" \
  | grep -i '^payment-required:' | cut -d' ' -f2 | tr -d '\r' | base64 -d \
  | jq '.accepts[] | {scheme, network, asset, amount, extra}'
# {
#   "scheme": "exact",
#   "network": "eip155:84532",
#   "asset": "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
#   "amount": "3000",
#   "extra": { "name": "USDC", "version": "2" }
# }
```

That is a request for 0.003 USDC on Base Sepolia, signed against a token whose EIP-712 domain name is `USDC`, version `2`. This post explains where each of those values comes from, how to get test funds and confirm a payment landed, and which values differ on Base mainnet. For the protocol itself, start with [What is x402?](/blog/what-is-x402-http-402).

## The constants, from their primary sources

Base Sepolia is Base's public testnet. Here is the reference card, with mainnet next to it, because the differences are where bugs come from:

| | Base Sepolia (testnet) | Base (mainnet) |
|---|---|---|
| x402 `network` (CAIP-2) | `eip155:84532` | `eip155:8453` |
| EVM chain ID | `84532` | `8453` |
| Public RPC | `https://sepolia.base.org` | `https://mainnet.base.org` |
| Block explorer | sepolia.basescan.org | basescan.org |
| USDC contract | `0x036CbD53842c5426634e7929541eC2318f3dCF7e` | `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` |
| USDC EIP-712 `name` | `USDC` | `USD Coin` |
| USDC EIP-712 `version` | `2` | `2` |
| USDC decimals | 6 | 6 |
| Settled by the x402.org facilitator | Yes | No (testnet only) |

Chain IDs, RPC endpoints, and explorers come from Base's [network details](https://docs.base.org/base-chain/quickstart/connecting-to-base). Both USDC addresses are in Circle's [USDC contract addresses](https://developers.circle.com/stablecoins/usdc-contract-addresses) list, and the x402 docs' [networks and token support](https://docs.x402.org/core-concepts/network-and-token-support) page lists the same addresses as the default assets for `"$0.01"`-style pricing, with EIP-712 names `USDC` and `USD Coin`. We also read `name()`, `version()`, and `decimals()` from both contracts over the public RPCs before publishing. Don't take our word for it, or anyone's. The balance snippet below shows how to call a contract yourself.

### Why `eip155:84532` and not `base-sepolia`

x402 v2 identifies networks with [CAIP-2](https://github.com/ChainAgnostic/CAIPs/blob/main/CAIPs/caip-2.md) strings of the form `namespace:reference`. The [v2 specification](https://github.com/coinbase/x402/blob/main/specs/x402-specification-v2.md) gives `eip155:84532` as its Base Sepolia example. For EVM chains the namespace is `eip155`, after [EIP-155](https://eips.ethereum.org/EIPS/eip-155), which introduced chain IDs into transaction signing, and the reference is the decimal chain ID. The x402 v1 name `base-sepolia` still shows up: the x402.org facilitator's `/supported` response lists it under `x402Version: 1`. A v2 client and server should use the CAIP-2 form. If your code compares `network` strings, compare against `eip155:84532` exactly, or you'll reject valid challenges. For more on the header format itself, see [x402 v2 headers](/blog/x402-v2-headers-payment-signature).

### Why `amount` is `"3000"`

The spec defines `amount` as the "payment amount in atomic token units", sent as a string. USDC has 6 decimals, so one USDC is `1000000`, and `3000` is 0.003 USDC. Parse it as an integer type that can't lose precision (`BigInt` in JavaScript, `int` in Python) and compare it against your own ceiling in the same units. Never compare against a float.

### Why `extra.name` matters

With the `exact` scheme on EVM, the client signs an [EIP-3009](https://eips.ethereum.org/EIPS/eip-3009) `transferWithAuthorization` as typed data. Under [EIP-712](https://eips.ethereum.org/EIPS/eip-712), the token's `name`, `version`, chain ID, and contract address make up the signing domain. If any of them is wrong, the signature still looks valid but recovers to a different signer, and the facilitator's verification fails. The server sends `name` and `version` in `extra` so the client doesn't have to guess. This is the most common thing to break when code moves from testnet to mainnet: the Base Sepolia token is named `USDC`, and the mainnet token is named `USD Coin`. Our post on the [exact scheme on EVM](/blog/x402-exact-scheme-evm) covers the full payload.

## Getting test USDC (no ETH required)

1. **Make a new key.** Generate a fresh EVM private key used only for testing, and never reuse a wallet that holds real funds. It is a good habit even on testnet: the key you test with tends to become the key you deploy with.
2. **Request USDC from Circle's faucet.** At [faucet.circle.com](https://faucet.circle.com/), choose USDC and Base Sepolia, then paste the address. The faucet is rate-limited, so request once and reuse the wallet instead of minting a new one every run. Circle is explicit that testnet USDC has "no financial value" and is "not backed by real US dollars."
3. **Skip the ETH.** You need ETH to send an ordinary transaction, but you don't need it to pay with x402 using USDC. The [exact EVM scheme spec](https://github.com/coinbase/x402/blob/main/specs/schemes/exact/scheme_exact_evm.md) says "the Facilitator (server) pays the gas, but the Client (user) controls the exact flow of funds via cryptographic signatures," and it marks EIP-3009 as "truly gasless" for the payer. You only need Base Sepolia ETH to send transactions yourself, such as moving USDC between your own wallets or sending a Permit2 approval for a token without EIP-3009.

## Checking a balance over JSON-RPC

Before paying, confirm the wallet holds what you think it holds. You don't need an SDK. ERC-20 `balanceOf(address)` has the selector `0x70a08231`:

```bash
ADDR=0xYourTestWalletAddress
DATA="0x70a08231$(printf '%064s' "${ADDR#0x}" | tr ' ' 0)"
curl -s https://sepolia.base.org -H 'content-type: application/json' \
  -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"eth_call\",\"params\":[{\"to\":\"0x036CbD53842c5426634e7929541eC2318f3dCF7e\",\"data\":\"$DATA\"},\"latest\"]}" \
  | jq -r .result | python3 -c 'import sys; print(int(sys.stdin.read(), 16) / 10**6, "USDC")'
```

Swap the selector for `0x06fdde03` (`name()`) or `0x313ce567` (`decimals()`) to check the token's metadata the same way. The facilitator checks the balance too: one of the spec's verification steps is to "verify the `client` has sufficient balance of the `asset`". An empty wallet fails verification before anything touches the chain.

## Pin the terms in your client

A `402` challenge is input from the server. A client that signs whatever `accepts` contains will sign for any network, token, or amount the server names. On testnet that only costs fake money. On mainnet it is a real risk. The fix is a small allowlist: the networks and assets you are willing to pay in, and a maximum per call.

```ts
const EXPECTED = {
  network: "eip155:84532",                               // Base Sepolia (CAIP-2)
  asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",   // USDC on Base Sepolia
  maxAmount: 10_000n,                                    // 0.01 USDC in atomic units
};

async function checkTerms(url: string, init?: RequestInit) {
  const res = await fetch(url, init);
  if (res.status !== 402) throw new Error(`expected 402, got ${res.status}`);
  const header = res.headers.get("PAYMENT-REQUIRED");
  if (!header) throw new Error("402 without a PAYMENT-REQUIRED header");
  const required = JSON.parse(Buffer.from(header, "base64").toString("utf8"));
  const option = required.accepts.find((a: any) =>
    a.scheme === "exact" &&
    a.network === EXPECTED.network &&
    a.asset.toLowerCase() === EXPECTED.asset.toLowerCase() &&
    BigInt(a.amount) <= EXPECTED.maxAmount);
  if (!option) throw new Error("no acceptable payment option; refusing to pay");
  return option;
}
```

Run `checkTerms` before you hand the URL to a paying client such as `@x402/fetch`, which the [quickstart](/docs/quickstart/) sets up in a few lines. The probe costs one extra unpaid round trip. In a long-running agent, put the same checks wherever your client picks a payment requirement, and add the rolling budgets described in [how to pay for APIs from an AI agent](/blog/pay-for-apis-from-an-ai-agent). Moving to mainnet then means changing one object, on purpose.

## Confirming a payment settled

A successful paid response carries a `PAYMENT-RESPONSE` header: Base64 JSON with `success`, `transaction`, `network`, and `payer`. On Base Sepolia, `transaction` is a transaction hash you can check yourself:

```bash
TX=0xTransactionHashFromPaymentResponse
curl -s https://sepolia.base.org -H 'content-type: application/json' \
  -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"eth_getTransactionReceipt\",\"params\":[\"$TX\"]}" \
  | jq '.result | {status, blockNumber, to}'
# status "0x1" = succeeded; "to" is the USDC contract
```

You can also paste the hash into sepolia.basescan.org. Seeing the transfer on-chain, not only in a header, is the right acceptance test for an integration. For what happens between the signature and that transaction, see [the facilitator's /verify and /settle](/blog/x402-facilitator-verify-settle).

## What changes when you go to mainnet

Nothing in the x402 protocol changes. Every constant around it does:

- **`network`** goes from `eip155:84532` to `eip155:8453`. Update your allowlist and any server route config.
- **`asset`** goes to the mainnet USDC address. Read it from Circle's list. Don't copy it from a blog, this one included.
- **The EIP-712 `name`** changes from `USDC` to `USD Coin`. Official SDKs take it from `extra`. Hand-rolled signers that hardcode it will fail verification.
- **The facilitator** must change. The x402 docs list the x402.org facilitator as "testnet only" and point to [production facilitators](https://docs.x402.org/core-concepts/facilitator) or self-hosting for mainnet.
- **The money is real.** Spend ceilings, a dedicated low-balance wallet, and key handling stop being good habits and become requirements.

## How Assay uses Base Sepolia

Assay runs on Base Sepolia only, and that is enforced in code, not just in docs: the server refuses to start if its configured network is anything other than `eip155:84532`. Both paid endpoints, [`/v1/extract`](/docs/extract/) (`$0.003` per successful call) and [`/v1/pdf/text`](/docs/pdf-text/) (`$0.01`), take x402 v2 `exact` payments in Base Sepolia USDC, settled through the x402.org facilitator. Settlement happens only if the handler returns a status below 400, so a failed call is not charged. Mainnet isn't enabled, and no real funds move.

The current terms are always machine-readable: `/health` reports the network and `"testnet": true`, and [`/pricing.json`](/pricing.json) and [`/.well-known/x402`](/.well-known/x402) list the network, facilitator, and per-endpoint prices. The [Payments docs](/docs/payments/) show the full exchange.

**Related:** [What is x402?](/blog/what-is-x402-http-402) · [How to pay for APIs from an AI agent](/blog/pay-for-apis-from-an-ai-agent) · [The x402 exact scheme on EVM](/blog/x402-exact-scheme-evm) · [x402 v2 headers](/blog/x402-v2-headers-payment-signature) · [x402 facilitator /verify and /settle](/blog/x402-facilitator-verify-settle)

### Sources
- x402 v2 specification (network identifiers, `amount` in atomic units): https://github.com/coinbase/x402/blob/main/specs/x402-specification-v2.md
- x402 `exact` scheme on EVM (gas paid by the facilitator, verification steps): https://github.com/coinbase/x402/blob/main/specs/schemes/exact/scheme_exact_evm.md
- x402 docs, Networks and Token Support (default assets, x402.org facilitator scope): https://docs.x402.org/core-concepts/network-and-token-support
- x402 docs, Facilitator: https://docs.x402.org/core-concepts/facilitator
- Base docs, Connect to Base (chain IDs, RPC endpoints, explorers): https://docs.base.org/base-chain/quickstart/connecting-to-base
- Circle, USDC contract addresses: https://developers.circle.com/stablecoins/usdc-contract-addresses
- Circle testnet faucet: https://faucet.circle.com/
- CAIP-2, Blockchain ID specification: https://github.com/ChainAgnostic/CAIPs/blob/main/CAIPs/caip-2.md
- EIP-155, Simple replay attack protection (chain IDs): https://eips.ethereum.org/EIPS/eip-155
- EIP-712, Typed structured data hashing and signing: https://eips.ethereum.org/EIPS/eip-712
- EIP-3009, Transfer With Authorization: https://eips.ethereum.org/EIPS/eip-3009

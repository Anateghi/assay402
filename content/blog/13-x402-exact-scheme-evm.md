---
title: "The x402 Exact Scheme on EVM: EIP-3009, Permit2, and ERC-7710 Explained"
description: "The x402 exact scheme charges one fixed amount per request. On EVM it can move that payment three ways: EIP-3009 transferWithAuthorization, Permit2 with a witness proxy, or ERC-7710 delegation. Here is how each works, what a facilitator must check, and which one to pick."
slug: x402-exact-scheme-evm
date: 2026-10-19
keywords: [x402 exact scheme, x402 EIP-3009, x402 Permit2, assetTransferMethod, transferWithAuthorization x402, x402 upto vs exact]
---

# The x402 exact scheme on EVM: EIP-3009, Permit2, and ERC-7710

The **x402 exact scheme** is the simplest way to sell an API call for crypto: the server names one fixed price, the client signs a payment for exactly that amount, and a facilitator moves the funds. Almost every x402 endpoint you will meet today, including Assay's, uses it. You can see which scheme and transfer method an endpoint wants straight from its `402` challenge:

```bash
# Which scheme, network, amount, and EVM transfer method does this endpoint ask for?
curl -si "{{ORIGIN}}/v1/extract?url=https://example.com" \
  | grep -i '^payment-required:' | cut -d' ' -f2 | tr -d '\r' | base64 -d \
  | jq '.accepts[] | {scheme, network, amount, method: (.extra.assetTransferMethod // "eip3009 (default)")}'
```

This post explains what `exact` promises, the three ways it can move tokens on EVM chains, what a facilitator has to verify for each, and how to choose. If the headers in that command are new to you, read [x402 v2 headers](/blog/x402-v2-headers-payment-signature) first, and for the protocol basics see [What is x402?](/blog/what-is-x402-http-402).

## What "exact" means

The [scheme definition](https://github.com/coinbase/x402/blob/main/specs/schemes/exact/scheme_exact.md) is short: `exact` "transfers a specific amount of funds from a client to a resource server," and "the resource server must know in advance the exact amount." Its example use cases are paying to view an article, buying digital credits, and "an LLM paying to use a tool."

Two properties matter in practice.

**The amount is exact, not a ceiling.** The v2 specification's error list includes `invalid_exact_evm_payload_authorization_value_mismatch`, defined as "payment amount does not exactly match the required amount." A client cannot overpay to be safe, and a server cannot charge less than it signed for afterwards. If your price depends on how much work the request turns out to need, look at the separate `upto` scheme (covered below).

**The default order is verify, then work, then settle.** The scheme calls this the `authorization` flow: the payment "is verified before the resource executes and settled afterward." The spec says servers should prefer it because "a failed handler leaves the client uncharged." An `upfront` flow (settle first, then run the handler) is allowed when a resource needs finality before it runs, but the spec warns that under `upfront` a failed handler "leaves the client charged with nothing delivered" and defines no refund.

## Three ways to move the money on EVM

The [EVM binding of `exact`](https://github.com/coinbase/x402/blob/main/specs/schemes/exact/scheme_exact_evm.md) has the facilitator pay gas while "the Client (user) controls the exact flow of funds via cryptographic signatures." It defines three asset transfer methods, chosen with `extra.assetTransferMethod` in the payment requirements:

| `assetTransferMethod` | Works with | What the client signs | Who calls the chain |
|---|---|---|---|
| `eip3009` (default) | Tokens that implement `transferWithAuthorization`, such as USDC | An EIP-712 transfer authorization | Facilitator calls the token contract |
| `permit2` | Any ERC-20 | A Permit2 `permitWitnessTransferFrom` signature | Facilitator calls the x402 Permit2 proxy |
| `erc7710` | Smart accounts that support delegation | Nothing new per call; it presents an existing delegation | Facilitator calls the delegation manager |

If a server leaves the field out, the spec says clients "should default to `eip3009`." In every case, the spec states, "the Facilitator cannot modify the amount or destination. They serve only as the transaction broadcaster."

### EIP-3009: the default for USDC

[EIP-3009](https://eips.ethereum.org/EIPS/eip-3009) adds `transferWithAuthorization` to a token contract. The payer signs `from`, `to`, `value`, a validity window (`validAfter`, `validBefore`), and a 32-byte `nonce`. Anyone holding that signature can submit it, but the token contract will only move exactly `value` to `to`, only inside the window, and only once, because it records each used nonce (readable through `authorizationState`).

The `PAYMENT-SIGNATURE` payload carries the signature plus the authorization fields:

```json
{
  "payload": {
    "signature": "0x…",
    "authorization": {
      "from": "0x857b…6b66",
      "to": "0x2096…287C",
      "value": "10000",
      "validAfter": "1740672089",
      "validBefore": "1740672154",
      "nonce": "0xf374…3480"
    }
  }
}
```

The requirements also carry `extra.name` and `extra.version`, the token's EIP-712 domain name and version, which the client needs to build the signature. For USDC on Base Sepolia these are `"USDC"` and `"2"`.

One detail makes EIP-3009 a good fit for agents: its nonces are random, not sequential. The EIP's rationale explains that sequential nonces stop a user from having more than one transaction in flight "without risking their transactions failing." An agent that fires several paid calls in parallel can sign several authorizations at once, each with its own random nonce, and none blocks the others.

The spec's verification list for this method is five steps: the signature must recover to `authorization.from`, the payer must have enough of the asset, the amount and validity window must meet the requirements, the token and network must match, and the facilitator should simulate `transferWithAuthorization` to confirm it will succeed. Settlement is then a single call to the token contract.

### Permit2: the fallback for any ERC-20

Many tokens do not implement EIP-3009. For those, the spec uses Uniswap's [Permit2](https://github.com/Uniswap/permit2) contract together with an `x402ExactPermit2Proxy` contract (canonical address `0x402085c248EeA27D92E8b30b2C58ed07f9E20001`, deployed at the same address on every supported chain with `CREATE2`).

The client signs a Permit2 transfer whose spender is the proxy, not the facilitator. The signed message includes a **witness** holding the recipient (`to`) and `validAfter`. The proxy's `settle` function rebuilds the witness hash and passes it to Permit2, so if anyone changes the recipient, the signature no longer matches and the transfer fails. Permit2 also uses unordered nonces, which its README calls "non-monotonic replay protection," so parallel payments work here too.

The catch is a one-time setup. Permit2 can only move tokens the payer has approved it to spend. The spec offers three routes: the payer sends an ordinary `approve` transaction and pays its own gas, the facilitator sponsors that approval through the `erc20ApprovalGasSponsoring` extension, or, if the token supports EIP-2612, the payer signs a permit that the proxy submits through `settleWithPermit`. If the allowance is missing and no extension applies, verification fails with `412 Precondition Failed` and the code `PERMIT2_ALLOWANCE_REQUIRED`, which tells the client to send the approval and retry.

### ERC-7710: paying from a smart account

The third method is for smart contract accounts that support [ERC-7710](https://eips.ethereum.org/EIPS/eip-7710) delegation. The payer has already created a delegation, with its own limits, that lets a delegate move tokens on its behalf. How it got that delegation is outside x402. The payload names the `delegationManager`, the `delegator`, and an opaque `permissionContext`.

Unlike the other two methods, verification here "is performed entirely through simulation": the facilitator encodes a `transfer(payTo, amount)` call and simulates `redeemDelegations` with it. The spec lists two risks for facilitators. A client could revoke the delegation between simulation and execution and leave the facilitator paying gas for a failed transaction, and a malicious delegation manager could try to burn gas. The mitigations it gives are private mempools, reputation signals, and an explicit gas limit on every call. This is also the only method in the spec's table that supports multi-use authorizations as well as one-time ones.

## Which method should you use?

- **Selling for USDC?** Use `eip3009`. It needs no approval step, the client signs one message, and it is the default, so most x402 clients handle it with no extra configuration.
- **Selling for a token without EIP-3009?** Use `permit2`, and plan for the one-time approval. Check whether your facilitator supports either gas-sponsoring extension before you rely on payers without native gas.
- **Your buyers run smart accounts with delegation?** `erc7710` lets them pay within limits they set once. Make sure your facilitator applies a gas limit and simulates every call.
- **Is the price unknown until the work is done?** `exact` is the wrong scheme. The spec repository also defines [`upto`](https://github.com/coinbase/x402/blob/main/specs/schemes/upto/scheme_upto.md), which authorizes "up to a maximum amount" and settles the amount actually used. The spec notes `upto` cannot use the `upfront` flow, since the final amount is known only after the handler runs.

Before you choose, ask your facilitator's `/supported` endpoint which schemes and networks it actually handles. Our [facilitator post](/blog/x402-facilitator-verify-settle) shows the command.

## Failure modes worth handling

The [v2 specification](https://github.com/coinbase/x402/blob/main/specs/x402-specification-v2.md) (section 9) names the `exact` errors you are most likely to see on EVM. Clients should treat each one differently:

| `invalidReason` / `errorReason` | Meaning | What the client should do |
|---|---|---|
| `insufficient_funds` | The payer does not hold enough of the token | Top up; retrying won't help |
| `invalid_exact_evm_payload_authorization_valid_before` | The authorization expired | Sign a fresh one, then retry |
| `invalid_exact_evm_payload_authorization_valid_after` | The authorization isn't valid yet | Check the clock; sign with `validAfter` in the past |
| `invalid_exact_evm_payload_authorization_value_mismatch` | The amount isn't exactly the required amount | Re-read `amount` from the challenge |
| `invalid_exact_evm_payload_recipient_mismatch` | `to` doesn't match `payTo` | Re-read `payTo`; never hard-code it |
| `invalid_exact_evm_payload_signature` | The signature doesn't verify | Check the EIP-712 domain (`extra.name`, `extra.version`) and the chain ID |
| `settlement_pending` | Broadcast, but confirmation unknown | Look up the returned transaction hash on-chain before paying again |

The last row matters most. The EVM binding allows a facilitator to return `settlement_pending` with the broadcast transaction hash when it cannot confirm a receipt, "so the caller can reconcile on chain before retrying." Signing a new payment straight away can mean paying twice.

## How Assay uses the exact scheme

Assay's paid endpoints, [`/v1/extract`](/docs/extract/) and [`/v1/pdf/text`](/docs/pdf-text/), offer one option each: scheme `exact`, USDC on **Base Sepolia testnet** (`eip155:84532`), with `extra` set to `{"name": "USDC", "version": "2"}`. The challenge has no `assetTransferMethod`, so clients use the EIP-3009 default. Mainnet isn't enabled yet, and Permit2 and ERC-7710 aren't offered.

The gateway follows the `authorization` flow: it verifies the payment, runs the handler, and settles only if the handler returns a status below 400, so failed calls are not charged. A replay guard keyed on the network, payer, and nonce rejects a reused authorization with `409 payment_replayed`. The [Payments docs](/docs/payments/) cover the full exchange, and the [quickstart](/docs/quickstart/) walks through a paid test call with free testnet USDC.

**Related:** [x402 v2 headers](/blog/x402-v2-headers-payment-signature) · [What is an x402 facilitator?](/blog/x402-facilitator-verify-settle) · [How to pay for APIs from an AI agent](/blog/pay-for-apis-from-an-ai-agent)

### Sources
- x402 scheme `exact` (network-independent definition): https://github.com/coinbase/x402/blob/main/specs/schemes/exact/scheme_exact.md
- x402 scheme `exact` on EVM: https://github.com/coinbase/x402/blob/main/specs/schemes/exact/scheme_exact_evm.md
- x402 scheme `upto`: https://github.com/coinbase/x402/blob/main/specs/schemes/upto/scheme_upto.md
- x402 v2 specification (section 9, error codes): https://github.com/coinbase/x402/blob/main/specs/x402-specification-v2.md
- EIP-3009, Transfer With Authorization: https://eips.ethereum.org/EIPS/eip-3009
- Uniswap Permit2: https://github.com/Uniswap/permit2
- ERC-7710, Smart Contract Delegation: https://eips.ethereum.org/EIPS/eip-7710

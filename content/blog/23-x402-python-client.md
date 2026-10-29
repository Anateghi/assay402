---
title: "x402 Python Client: Pay for HTTP 402 APIs with httpx or requests"
description: "A working x402 Python client built on the official x402 SDK: pay a 402 challenge in USDC with httpx (async) or requests (sync), read the PAYMENT-RESPONSE receipt, cap spend, allowlist payees, and debug the errors you will actually see."
slug: x402-python-client
date: 2026-10-29
keywords: [x402 python client, x402 python sdk, pip install x402, x402HttpxClient, wrapRequestsWithPayment, x402 spend_controls python]
---

# x402 Python client: pay for HTTP 402 APIs with httpx or requests

An **x402 Python client** turns an `HTTP 402 Payment Required` answer into a signed USDC payment and a retry, without you writing any EIP-712 code. The official `x402` package on PyPI does the work. This script pays Assay's `/v1/extract` endpoint on Base Sepolia testnet and prints the result and the settlement transaction:

```python
# pip install "x402[httpx,evm]"      # Python 3.10+
import asyncio, os
from eth_account import Account
from x402 import x402Client
from x402.http import x402HTTPClient
from x402.http.clients import x402HttpxClient
from x402.mechanisms.evm import EthAccountSigner
from x402.mechanisms.evm.exact import ExactEvmScheme

URL = "{{ORIGIN}}/v1/extract?url=https://www.rfc-editor.org/rfc/rfc9110"

async def main() -> None:
    signer = EthAccountSigner(Account.from_key(os.environ["AGENT_PRIVATE_KEY"]))
    client = x402Client()
    client.register("eip155:84532", ExactEvmScheme(signer=signer))  # Base Sepolia only

    async with x402HttpxClient(client, timeout=60) as http:
        r = await http.get(URL)  # 402 -> sign -> retry with PAYMENT-SIGNATURE, all inside
        if r.status_code != 200:
            print(r.status_code, r.text[:300])
            return
        doc = r.json()
        print(doc["title"], doc["markdown"][:120])
        receipt = x402HTTPClient(client).get_payment_settle_response(r.headers.get)
        print("settled:", receipt.transaction, receipt.network)

asyncio.run(main())
```

We ran this script against the live endpoint with x402 2.26.0 (the current release on [PyPI](https://pypi.org/project/x402/) as of this post) and a freshly generated, **unfunded** key. The SDK decoded the challenge, signed the authorization, and retried. The server forwarded it to the facilitator, which rejected it with `invalid_exact_evm_insufficient_balance`. That is the right answer for an empty wallet, and it shows that everything up to settlement works. Fund the key with test USDC and the same script returns `200`.

This post is part of the [paying for APIs from an AI agent](/blog/pay-for-apis-from-an-ai-agent) guide. That guide wrote the Python flow out by hand and left signing as a placeholder. Here the SDK does the signing.

## What the SDK does on a 402

The x402 v2 flow ([x402 docs](https://docs.x402.org/), [repository](https://github.com/x402-foundation/x402)) takes two round trips, and the client handles both inside one `get()` call:

1. **First request** goes out with no payment. The server answers `402` with a `PAYMENT-REQUIRED` header: Base64 JSON with an `accepts` list. Assay's challenge for `/v1/extract` currently decodes to this:

   ```json
   {"scheme": "exact", "network": "eip155:84532", "amount": "3000",
    "asset": "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
    "payTo": "{{PAY_TO}}", "maxTimeoutSeconds": 120,
    "extra": {"name": "USDC", "version": "2"}}
   ```

   `amount` is in atomic units. USDC has 6 decimals, so `3000` is $0.003. The `asset` is Circle's [USDC contract on Base Sepolia](https://developers.circle.com/stablecoins/usdc-contract-addresses).
2. **Selection.** The client drops options it has no scheme registered for, applies spend controls and policies (covered below), and picks one.
3. **Signing.** `ExactEvmScheme` builds an [EIP-3009](https://eips.ethereum.org/EIPS/eip-3009) `TransferWithAuthorization` message, using the token's EIP-712 domain `name` and `version` from `extra`, and signs it with your key. Nothing goes on-chain at this step, and the wallet needs no ETH: the facilitator submits the transfer and pays gas.
4. **Retry** with the payload in a `PAYMENT-SIGNATURE` header. The server verifies, does the work, settles, and returns `200` with a `PAYMENT-RESPONSE` header. `get_payment_settle_response` decodes that header into a `SettleResponse` with `success`, `transaction`, `network`, and `payer`.

The transport retries **once**. If the paid retry also gets a `402`, you receive that response as-is, so check `status_code` before you parse the body. The header names and v1/v2 differences are covered in [x402 v2 headers](/blog/x402-v2-headers-payment-signature).

## Install: pick your extras

The package splits optional dependencies into extras, as described in the [SDK README](https://github.com/x402-foundation/x402/tree/main/python/x402):

| You want | Install |
|---|---|
| Async client on `httpx` | `pip install "x402[httpx,evm]"` |
| Sync client on `requests` | `pip install "x402[requests,evm]"` |
| Server middleware | `x402[fastapi]` or `x402[flask]` |
| Solana or TON instead of EVM | `x402[svm]` or `x402[tvm]` |

PyPI lists `requires_python >= 3.10`. The `evm` extra pulls in `eth-account`, which provides `Account.from_key`.

Every component comes in an async and a sync variant, and you can't mix them. `x402Client` goes with `httpx`, and `x402ClientSync` goes with `requests`. The README says mismatched pairs raise `TypeError`.

## The sync version with `requests`, plus guardrails

Most agent frameworks call tools from synchronous code. The `requests` variant mounts an adapter on a normal `Session`. This version also adds the two guardrails every agent wallet should have:

```python
# pip install "x402[requests,evm]"
import os, requests
from eth_account import Account
from x402 import x402ClientSync, x402ClientConfig, SchemeRegistration, AbortResult
from x402.http.clients import wrapRequestsWithPayment
from x402.mechanisms.evm import EthAccountSigner
from x402.mechanisms.evm.exact import ExactEvmScheme

# Assay's payTo, as published at {{ORIGIN}}/.well-known/x402
ALLOWED_PAY_TO = {"{{PAY_TO}}".lower()}

signer = EthAccountSigner(Account.from_key(os.environ["AGENT_PRIVATE_KEY"]))
client = x402ClientSync.from_config(x402ClientConfig(
    schemes=[SchemeRegistration(network="eip155:84532", client=ExactEvmScheme(signer=signer))],
    spend_controls={"max_amount_per_payment": "$0.01"},   # USD cap per call
))

def only_known_payees(ctx):
    if ctx.selected_requirements.pay_to.lower() not in ALLOWED_PAY_TO:
        return AbortResult(reason=f"payTo {ctx.selected_requirements.pay_to} not allowlisted")

client.on_before_payment_creation(only_known_payees)

session = wrapRequestsWithPayment(requests.Session(), client)
r = session.get("{{ORIGIN}}/v1/extract",
                params={"url": "https://www.rfc-editor.org/rfc/rfc9110"}, timeout=60)
print(r.status_code)
```

We ran both guardrails, and the error cases in the table further down, against the live endpoint to check that they actually stop a payment. Each one fires **before** anything is signed:

- With the cap lowered to `"$0.001"`, below the $0.003 price, the SDK raises `PaymentError: ... All payment requirements were rejected by spend_controls.max_amount_per_payment ($0.001, including USDC)`.
- With a different address in `ALLOWED_PAY_TO`, the hook's `AbortResult` surfaces as `PaymentError: ... Payment aborted: payTo 0x…dEaD not allowlisted`.

Catch `PaymentError` in your tool wrapper and return a refusal the model can read. Don't retry. Note that each transport defines its own class: import it from `x402.http.clients.requests` for the sync adapter and from `x402.http.clients.httpx` for the async client. In 2.26.0 they are separate classes, so catching one does not catch the other.

### How the selection stages fit together

The README describes three stages, applied in order:

1. **`spend_controls`** are the built-in safety caps. By default only assets the SDK recognizes are allowed (Base Sepolia USDC is one of them), with a **$1** ceiling per payment. Set `max_amount_per_payment` to a lower USD string for agents. `allowed_assets` opts in other tokens with an atomic cap. `spend_controls=False` turns all of this off, which you should only do when a human confirms each payment.
2. **`policies`** filter or reorder what's left, for example `prefer_network("eip155:8453")` or `max_amount(1_000_000)` (atomic units). The README says not to use policies as a substitute for spend controls.
3. **`payment_requirements_selector`** picks one option, by default the first that remains.

Lifecycle hooks (`on_before_payment_creation`, `on_after_payment_creation`, `on_payment_creation_failure`) run around signing. The before-hook is the right place for a payee allowlist, because it can see `ctx.payment_required.resource.url` and `ctx.selected_requirements.pay_to`. The after-hook is a good place to append to an audit log. Per-call caps don't add up to a daily budget on their own. For rolling budgets, see [spending limits for agent wallets](/blog/x402-agent-spending-limits).

## Errors you will actually see

| Symptom | Cause | Fix |
|---|---|---|
| Final `402`, decoded `PAYMENT-REQUIRED` has `"error": "invalid_exact_evm_insufficient_balance"` | The signature is valid but the wallet holds too little USDC on that network | Fund it from [Circle's faucet](https://faucet.circle.com/) (Base Sepolia) |
| `PaymentError ... rejected by spend_controls` | The price is above your cap, or the asset is not a default asset | Raise the cap deliberately, or add the asset to `allowed_assets` |
| `PaymentError ... Payment aborted: …` | Your before-hook returned `AbortResult` | Working as intended. Log it |
| `TypeError: x402HTTPAdapter (requests) requires a sync client` | You passed an async `x402Client` to the `requests` adapter (async hooks on a sync client also raise `TypeError`) | Pair `x402Client` with httpx and `x402ClientSync` with requests |
| `PaymentError ... No payment requirements match registered schemes` | No scheme is registered for the network in `accepts` (for example, you registered `eip155:8453` and the server only offers `eip155:84532`) | Register the network the server lists, or `"eip155:*"` together with a network policy |

To read the server's reason for a failed payment, decode the header yourself:

```python
import base64, json
print(json.loads(base64.b64decode(r.headers["PAYMENT-REQUIRED"])).get("error"))
```

## Keys: do this before you fund anything

- Generate a **dedicated** key for the agent. `python -c "from eth_account import Account; a = Account.create(); print(a.address)"` gives you an address. Store the key in a secrets manager, not in the repository.
- Fund it with only what you are prepared to lose, and test on Base Sepolia (`eip155:84532`) first. The network IDs and the mainnet switch are covered in [x402 on Base Sepolia](/blog/x402-base-sepolia-usdc).
- Keep the wallet behind a narrow tool such as `extract_markdown(url)`. The model never sees the key and never chooses a payee.

## Calling Assay from Python

Assay's two paid endpoints work with the client above as-is. Both run on **Base Sepolia testnet** only for now, and payment is settled only when the call succeeds (HTTP status below 400):

- [`GET /v1/extract`](/docs/extract/): a web page as clean markdown plus JSON metadata, **$0.003** per call.
- [`POST /v1/pdf/text`](/docs/pdf-text/): a PDF as per-page text, **$0.01** per call. Send `json={"url": "https://…/file.pdf"}`, or the raw bytes with `content-type: application/pdf`.

Payment is x402 only. Prepaid API keys are planned but not available yet. The [payments contract](/docs/payments/) documents the replay guard and settle-on-success behaviour, and the [quickstart](/docs/quickstart/) covers getting test USDC.

**Related:** [How to pay for APIs from an AI agent](/blog/pay-for-apis-from-an-ai-agent) · [What is x402?](/blog/what-is-x402-http-402) · [The x402 exact scheme on EVM](/blog/x402-exact-scheme-evm) · [What is an x402 facilitator?](/blog/x402-facilitator-verify-settle)

### Sources
- x402 on PyPI (version, Python requirement): https://pypi.org/project/x402/
- x402 Python SDK README (extras, spend controls, policies, hooks): https://github.com/x402-foundation/x402/tree/main/python/x402
- x402 Python examples: https://github.com/x402-foundation/x402/tree/main/examples/python
- x402 documentation: https://docs.x402.org/
- EIP-3009, Transfer With Authorization: https://eips.ethereum.org/EIPS/eip-3009
- Circle, USDC contract addresses (Base Sepolia): https://developers.circle.com/stablecoins/usdc-contract-addresses
- Circle testnet faucet: https://faucet.circle.com/
- eth-account documentation: https://eth-account.readthedocs.io/en/stable/
- HTTPX transports: https://www.python-httpx.org/advanced/transports/

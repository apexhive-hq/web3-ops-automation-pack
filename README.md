# Web3 Ops Automation Pack

Standalone, zero-backend-maintenance **TypeScript (`Node.js >= 22.18 LTS`)** and **Python (`3.12+`)** utilities for non-custodial Base & Solana USDC payment verification, Playwright crypto checkout QA, and authenticated n8n webhook automation — 100% free and open-source under the [MIT License](LICENSE).

## What's Included

1. **`pack/base-usdc-watcher/`** (`src/index.ts` & `python/base_usdc_watcher.py`): Multi-RPC failover Base ERC-20 `Transfer` verifier (`0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`) with strict hex `BigInt` block/confirmation checks (fail-closed), multi-log summing with explicit multi-payer `senders`/`transfers` attribution, non-empty address validation, and `AbortSignal.timeout` / socket timeout failover.
2. **`pack/solana-usdc-verifier/`** (`src/index.ts` & `python/solana_usdc_verifier.py`): Solana SPL USDC (`EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v`) `reference` Pubkey verifier supporting `commitment: 'finalized'`, non-signer & instruction-level reference binding, `v0` `loadedAddresses`, `BigInt` net token balance delta math, `replayKey` generation, and `null`-result/timeout multi-RPC failover.
3. **`pack/playwright-crypto-qa/`** (`src/harness.ts`): Drop-in Playwright `1.64.1` mock EIP-1193 `window.ethereum` + `1440x900`/`375x812` responsive & clean-console QA harness (runs against real headless Chromium when installed via `pnpm exec playwright install chromium`, with a mock-page fallback in browserless environments).
4. **`pack/n8n-webhooks/`** (`base-usdc-payment-alert.json`, `solana-pay-invoice-webhook.json`, `validate-workflows.mjs`): Importable n8n JSON templates (`responseMode: "lastNode"`, n8n v2 `$binary.data` raw-body support, signed timestamp window + HMAC-SHA256 verification, replay dedup `replayKey`, parameterized `EXPECTED_AMOUNT_ATOMIC`, and trusted on-chain RPC verification) + CLI DAG/security linter.

## Quickstart (`MIT` Open Source)

```bash
git clone https://github.com/apexhive-hq/web3-ops-automation-pack.git
cd web3-ops-automation-pack/pack
pnpm install --ignore-scripts
pnpm run typecheck
pnpm test
pnpm run test:python
```

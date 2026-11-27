# Web3 Ops Automation Pack

Verify Base and Solana USDC payments on-chain, test wallet checkout UIs in Playwright, and wire authenticated n8n webhooks without running a custom payment backend. Ships as standalone **TypeScript (`Node.js >= 22.18 LTS`)** and **Python (`3.12+`)** modules with zero private keys.

## What's Included

1. **Base USDC Watcher (`pack/base-usdc-watcher/`)** (`src/index.ts` & `python/base_usdc_watcher.py`): Multi-RPC failover ERC-20 `Transfer` verifier (`0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`) with strict hex `BigInt` block/confirmation checks (fail-closed), multi-log summing with explicit multi-payer `senders`/`transfers` attribution, non-empty address validation, and `AbortSignal.timeout` / socket timeout failover.
2. **Solana USDC Verifier (`pack/solana-usdc-verifier/`)** (`src/index.ts` & `python/solana_usdc_verifier.py`): Solana SPL USDC (`EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v`) `reference` Pubkey verifier supporting `commitment: 'finalized'`, non-signer & instruction-level SPL `Transfer`/`TransferChecked` reference + destination ATA binding, `v0` `loadedAddresses`, `BigInt` net token balance delta math, transaction-scoped `replayKey` generation, and `null`-result/timeout multi-RPC failover.
3. **Playwright Crypto QA Harness (`pack/playwright-crypto-qa/`)** (`src/harness.ts`): Drop-in Playwright `1.64.1` mock EIP-1193 `window.ethereum` + `1440x900`/`375x812` responsive & clean-console QA harness (runs against real headless Chromium when installed via `pnpm exec playwright install chromium`, with a mock-page fallback in browserless environments).
4. **n8n Webhook Templates (`pack/n8n-webhooks/`)** (`base-usdc-payment-alert.json`, `solana-pay-invoice-webhook.json`, `validate-workflows.mjs`): Importable n8n workflows (`responseMode: "lastNode"`, n8n v2 `$binary.data` raw-body support, signed timestamp window + HMAC-SHA256 verification, replay dedup `replayKey`, parameterized `EXPECTED_AMOUNT_ATOMIC`, and trusted on-chain RPC verification) + CLI DAG/security linter.

## Quickstart

```bash
git clone https://github.com/apexhive-hq/web3-ops-automation-pack.git
cd web3-ops-automation-pack/pack
pnpm install --ignore-scripts
pnpm run typecheck
pnpm test
pnpm run test:python
```

## License

[MIT License](LICENSE)

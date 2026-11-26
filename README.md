# Web3 Ops Automation Pack

Standalone, zero-backend-maintenance **TypeScript (`Node.js >= 24`)** and **Python (`3.12+`)** utilities for non-custodial Base & Solana USDC payment verification, Playwright crypto checkout QA, and importable n8n webhook automation — 100% free and open-source under the [MIT License](LICENSE).

## What's Included

1. **`pack/base-usdc-watcher/`** (`src/index.ts` & `python/base_usdc_watcher.py`): Multi-RPC failover Base ERC-20 `Transfer` verifier (`0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`, `BigInt` 6-decimal math, confirmation threshold, zero private keys).
2. **`pack/solana-usdc-verifier/`** (`src/index.ts` & `python/solana_usdc_verifier.py`): Solana SPL USDC (`EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v`) `reference` Pubkey + token balance delta matcher with multi-RPC failover.
3. **`pack/playwright-crypto-qa/`** (`src/harness.ts`): Drop-in Playwright `1.64.1` mock EIP-1193 `window.ethereum` + `1440x900`/`375x812` responsive & clean-console QA harness.
4. **`pack/n8n-webhooks/`** (`base-usdc-payment-alert.json`, `solana-pay-invoice-webhook.json`, `validate-workflows.mjs`): Importable n8n JSON templates + DAG/secret linter.

## Quickstart (`MIT` Open Source)

```bash
git clone https://github.com/apexhive-hq/web3-ops-automation-pack.git
cd web3-ops-automation-pack/pack
pnpm install --ignore-scripts
pnpm run typecheck
pnpm test
pnpm run test:python
```

---

If these scripts saved you time, Base USDC tips are welcome at `0x32eceaC45DBED9E555dAb80346aBd4Ab9C676206`. Support: `apexhive.hq@proton.me`.

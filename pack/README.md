# Web3 Ops Automation Pack (`pack/`)

Standalone **TypeScript (`Node.js >= 24`)** and **Python (`3.12+`)** utilities for Base & Solana USDC payment verification, Playwright wallet QA, and n8n webhook automation — 100% free MIT open source.

## Included Utilities

1. **`base-usdc-watcher/`** (`src/index.ts` & `python/base_usdc_watcher.py`): Deterministic Base ERC-20 `Transfer` receipt verifier (`0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`, `BigInt` 6-decimal math, confirmation threshold, multi-RPC failover).
2. **`solana-usdc-verifier/`** (`src/index.ts` & `python/solana_usdc_verifier.py`): Solana SPL USDC (`EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v`) `reference` Pubkey + token balance delta matcher with multi-RPC failover.
3. **`playwright-crypto-qa/`** (`src/harness.ts`): Playwright `1.64.1` mock EIP-1193 `window.ethereum` + `1440x900`/`375x812` responsive & clean-console QA helper.
4. **`n8n-webhooks/`** (`base-usdc-payment-alert.json`, `solana-pay-invoice-webhook.json`, `validate-workflows.mjs`): Importable n8n JSON templates + DAG/secret validator.
5. **`docs/quickstart.md`**: Integration examples for Base, Solana, and n8n.

## Verification

```bash
pnpm install --ignore-scripts
pnpm run typecheck
pnpm test
pnpm run test:python
```

---

Tips (Base USDC): `0x32eceaC45DBED9E555dAb80346aBd4Ab9C676206` · Support: `apexhive.hq@proton.me`.

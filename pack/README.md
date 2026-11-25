# Web3 Ops Automation Pack (`v1.0.0`)

Standalone, zero-backend-maintenance TypeScript (`Node.js v24+`) and Python (`3.12+`) utilities for non-custodial Base & Solana USDC payment verification, Playwright crypto checkout QA, and n8n webhook automation — free and open-source under the [MIT License](LICENSE.txt).

## What's Included

1. **`base-usdc-watcher/`** (`src/index.ts` + `python/base_usdc_watcher.py`): Deterministic Base ERC-20 `Transfer` receipt verifier with multi-RPC failover, confirmation threshold, canonical USDC contract check (`0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`), `BigInt` 6-decimal math, and zero private keys.
2. **`solana-usdc-verifier/`** (`src/index.ts` + `python/solana_usdc_verifier.py`): Deterministic Solana SPL USDC (`EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v`) `reference` Pubkey + `postTokenBalances`/`preTokenBalances` delta matcher with multi-RPC failover.
3. **`playwright-crypto-qa/`** (`src/harness.ts`): Drop-in Playwright `1.64.1` E2E helper injecting a mock EIP-1193 `window.ethereum` provider and checking `1440x900` / `375x812` viewports, horizontal overflow, and zero console/page errors.
4. **`n8n-webhooks/`** (`base-usdc-payment-alert.json`, `solana-pay-invoice-webhook.json`, `validate-workflows.mjs`): Ready-to-import n8n JSON workflows + DAG/secret validator.
5. **`docs/quickstart.md`**: Integration examples for Base, Solana, and n8n.

## Quickstart (`0 USDC` MIT)

```bash
git clone https://github.com/apexhive-hq/web3-ops-automation-pack.git
cd web3-ops-automation-pack/pack
pnpm install --ignore-scripts
pnpm run typecheck
pnpm test
pnpm run test:python
```

---

## License & Commercial Support

MIT Licensed (`0 USDC` forever). Optional Supporter (`5 USDC`) and Team Commercial Ops (`49 USDC`) receipts are available at the [Web3 Ops Automation Pack Storefront](https://web3-ops-automation-pack-store.apexhive-hq.workers.dev) — contact `apexhive.hq@proton.me` for support.

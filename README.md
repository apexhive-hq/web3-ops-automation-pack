# Web3 Ops Automation Pack (`v1.0.0`)

Standalone, zero-backend-maintenance **TypeScript (`Node.js v24+`)** and **Python (`3.12+`)** utilities for non-custodial Base & Solana USDC payment verification, Playwright crypto checkout QA, and importable n8n webhook automation — free and open-source under the [MIT License](pack/LICENSE.txt).

## What's Included

1. **`pack/base-usdc-watcher/`** (`src/index.ts` + `python/base_usdc_watcher.py`): Multi-RPC failover Base ERC-20 `Transfer` verifier (`0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`, `BigInt` 6-decimal math, confirmation threshold, zero private keys).
2. **`pack/solana-usdc-verifier/`** (`src/index.ts` + `python/solana_usdc_verifier.py`): Solana SPL USDC (`EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v`) `reference` Pubkey + token balance delta matcher with multi-RPC failover.
3. **`pack/playwright-crypto-qa/`** (`src/harness.ts`): Drop-in Playwright `1.64.1` mock EIP-1193 `window.ethereum` + `1440x900`/`375x812` responsive & clean-console QA harness.
4. **`pack/n8n-webhooks/`** (`base-usdc-payment-alert.json`, `solana-pay-invoice-webhook.json`, `validate-workflows.mjs`): Ready-to-import n8n JSON templates + DAG/secret linter.
5. **`storefront/`**: Reference non-custodial Cloudflare Workers + Workers KV Base USDC checkout worker.

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

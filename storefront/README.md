# Web3 Ops Automation Pack — Non-Custodial Storefront

Cloudflare Workers + Workers KV storefront accepting Base Mainnet USDC (`0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`) with:
- 1-click `window.ethereum` EIP-1193 payment button (`0x2105` Base Mainnet switch + ERC-20 `transfer`)
- Manual `txHash` + 5-minute EIP-191 ownership proof fallback
- 60-minute HMAC drop-safe download token (`max 3` downloads) streaming `web3-ops-automation-pack-v1.0.0.zip` via GitHub Release `fetch()`

## Local Verification

```bash
pnpm install --ignore-scripts
pnpm run typecheck
pnpm test
```

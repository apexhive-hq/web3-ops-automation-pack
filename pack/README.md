# Web3 Ops Automation Pack (`pack/`)

Standalone **TypeScript (`Node.js >= 22.18 LTS`)** and **Python (`3.12+`)** modules for Base & Solana USDC payment verification, Playwright EIP-1193 wallet QA, and HMAC-authenticated n8n webhook automation.

## Included Modules

1. **`base-usdc-watcher/`** (`src/index.ts` & `python/base_usdc_watcher.py`): Deterministic Base ERC-20 `Transfer` receipt verifier (`0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`) with strict hex `BigInt` confirmation validation, multi-log summing with `senders`/`transfers` attribution, and timeout-enforced multi-RPC failover.
2. **`solana-usdc-verifier/`** (`src/index.ts` & `python/solana_usdc_verifier.py`): Solana SPL USDC (`EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v`) `reference` Pubkey + `BigInt` net token balance delta matcher (`commitment: 'finalized'`, non-signer & instruction-level SPL `Transfer`/`TransferChecked` destination ATA binding, `v0` `loadedAddresses`, `null`-result/timeout multi-RPC failover).
3. **`playwright-crypto-qa/`** (`src/harness.ts`): Playwright `1.64.1` mock EIP-1193 `window.ethereum` + `1440x900`/`375x812` responsive & clean-console QA helper.
4. **`n8n-webhooks/`** (`base-usdc-payment-alert.json`, `solana-pay-invoice-webhook.json`, `validate-workflows.mjs`): Importable n8n JSON templates (`responseMode: "lastNode"`, `$binary.data` raw-body support, signed timestamp window + HMAC-SHA256 auth, `replayKey` dedup, parameterized `EXPECTED_AMOUNT_ATOMIC`, and trusted RPC verification) + CLI validator.
5. **`docs/quickstart.md`**: Integration examples for Base, Solana, and n8n.

## Verification

```bash
pnpm install --ignore-scripts
pnpm run typecheck
pnpm test
pnpm run test:python
```

## License

[MIT License](LICENSE.txt)

# Quickstart Guide

## 1. Base USDC Watcher (TypeScript)
```ts
import { verifyBaseUsdcPayment } from '../base-usdc-watcher/src/index.ts';

const match = await verifyBaseUsdcPayment({
  txHash: '0x...',
  expectedRecipient: '0xYourPublicSafeAddress',
  minAmountAtomic: 19_000_000n,
  rpcUrls: ['https://mainnet.base.org', 'https://base.llamarpc.com'],
  minConfirmations: 2
});
```

## 2. Solana USDC Reference Verifier (Python 3.12)
```python
from solana_usdc_verifier import verify_solana_usdc_payment

res = verify_solana_usdc_payment(
    signature="...",
    expected_recipient_owner="YourSquadsVaultPubkey",
    expected_reference_key="PerInvoiceReferencePubkey",
    min_amount_atomic=19_000_000,
    rpc_urls=["https://api.mainnet-beta.solana.com"],
)
```

## 3. Importing n8n Workflows
1. Run `node n8n-webhooks/validate-workflows.mjs` (or `pnpm test`).
2. In n8n, choose **Import from File** and select `base-usdc-payment-alert.json` or `solana-pay-invoice-webhook.json`.
3. Set `PAY_TO_EVM_ADDRESS`, `SOLANA_RECEIVE_ADDRESS`, and webhook URLs in n8n environment variables.

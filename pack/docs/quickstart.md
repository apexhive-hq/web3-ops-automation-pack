# Quickstart Guide

## 1. Base USDC Watcher (TypeScript)
```ts
import { computeReplayKey, verifyBaseUsdcPayment } from '../base-usdc-watcher/src/index.ts';

const match = await verifyBaseUsdcPayment({
  txHash: '0x...',
  expectedRecipient: '0xYourPublicSafeAddress',
  minAmountAtomic: 10_000_000n,
  rpcUrls: ['https://mainnet.base.org', 'https://base.llamarpc.com'],
  minConfirmations: 2,
  timeoutMs: 10_000
});
// Persist replayKey = computeReplayKey(8453, match.txHash) in a unique DB column before fulfilling.
// Note: match.from is null when multiple distinct senders contributed to the same tx (inspect match.senders / match.transfers).
```

## 2. Solana USDC Reference Verifier (Python 3.12+)
```python
from solana_usdc_verifier import verify_solana_usdc_payment

# Always generate a fresh, one-time reference Keypair per invoice and persist res.replay_key
# (sha256("solana:" + signature)) in a unique DB column so 1 tx cannot settle multiple invoices.
res = verify_solana_usdc_payment(
    signature="...",
    expected_recipient_owner="YourSquadsVaultPubkey",
    expected_reference_key="PerInvoiceReferencePubkey",
    min_amount_atomic=10_000_000,
    rpc_urls=["https://api.mainnet-beta.solana.com"],
    timeout_seconds=10.0,
)
```

## 3. Importing n8n Workflows
1. Run `node n8n-webhooks/validate-workflows.mjs` (or `pnpm test`).
2. In n8n, choose **Import from File** and select `base-usdc-payment-alert.json` or `solana-pay-invoice-webhook.json`.
3. Configure required n8n environment variables (fail-closed if omitted):
   - **Signed Timestamp & HMAC Auth**: `WEBHOOK_HMAC_SECRET` (>= 16 chars), `MAX_WEBHOOK_AGE_SECONDS` (default `"300"`), and `EXPECTED_AMOUNT_ATOMIC` (positive integer string, e.g. `"10000000"`).
   - **Request Signing Format**: Senders must include `x-webhook-timestamp` (10-digit Unix seconds) and `x-webhook-signature` (`sha256=<hex>` HMAC-SHA256 over `"${timestamp}.${rawBody}"`). Both workflows use `responseMode: "lastNode"` so HTTP 200 is never returned prior to HMAC + RPC verification, parse verified `rawPayload` (`$binary.data` in n8n v2 `rawBody: true`), and set `specifyBody: "json"` on `httpRequest` v4 nodes.
   - **Replay Dedup & Multi-Worker Warning**: `$getWorkflowStaticData('global').seenReplayKeys` provides bounded (1,000-entry) single-instance deduplication only and is subject to TOCTOU races under concurrent or multi-worker n8n deployments. Always enforce an atomic unique key / `SET NX` lock on `$json.replayKey` in your downstream DB or Redis before fulfilling orders.
   - **Base workflow**: `PAY_TO_EVM_ADDRESS`, `BASE_RPC_URL`, `MIN_CONFIRMATIONS` (default `"2"`), `OPS_ALERT_WEBHOOK_URL`.
   - **Solana workflow**: `SOLANA_RECEIVE_ADDRESS`, `EXPECTED_REFERENCE_KEY` (or set `ALLOW_SIGNED_PAYLOAD_REFERENCE=true` when passing an HMAC-signed per-invoice `expectedReferenceKey` in the JSON payload), `SOLANA_RPC_URL`, `FULFILLMENT_WEBHOOK_URL`.

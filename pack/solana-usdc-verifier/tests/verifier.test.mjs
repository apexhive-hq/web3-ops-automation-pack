import assert from 'node:assert/strict';
import test from 'node:test';
import {
  SOLANA_MAINNET_USDC_MINT,
  verifySolanaUsdcPayment
} from '../src/index.ts';

const VAULT = '4UyTxvrcqtYEsm5LQuiD5ofEJ4bMk6XJqv6G4St3GC9F';
const REF_KEY = 'RefKey11111111111111111111111111111111111111';
const SIG = '5VERv8NMvzbJMEkV8xnrLkEaWRtSz9CosKDYjCJjBRnbJLgp8uirBgmQpjKhoR4tjF3ZpRzrFmBV6UjKdiSZkQUW';

test('verifySolanaUsdcPayment matches SPL USDC delta + reference key', async () => {
  const mockFetch = async () =>
    new Response(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        result: {
          slot: 310000001,
          transaction: { message: { accountKeys: ['Payer111', REF_KEY, VAULT] } },
          meta: {
            err: null,
            preTokenBalances: [
              {
                accountIndex: 2,
                mint: SOLANA_MAINNET_USDC_MINT,
                owner: VAULT,
                uiTokenAmount: { amount: '1000000', decimals: 6 }
              }
            ],
            postTokenBalances: [
              {
                accountIndex: 2,
                mint: SOLANA_MAINNET_USDC_MINT,
                owner: VAULT,
                uiTokenAmount: { amount: '20000000', decimals: 6 }
              }
            ]
          }
        }
      }),
      { status: 200, headers: { 'content-type': 'application/json' } }
    );

  const match = await verifySolanaUsdcPayment({
    signature: SIG,
    expectedRecipientOwner: VAULT,
    expectedReferenceKey: REF_KEY,
    minAmountAtomic: 19_000_000n,
    rpcUrls: ['https://mock-solana-rpc.local'],
    fetchImpl: mockFetch
  });

  assert.equal(match.ok, true);
  assert.equal(match.amountAtomic, 19_000_000n);
});

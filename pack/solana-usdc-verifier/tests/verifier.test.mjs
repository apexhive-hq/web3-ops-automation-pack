import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test from 'node:test';
import {
  SOLANA_MAINNET_USDC_MINT,
  computeSolanaReplayKey,
  decodeBase58,
  encodeBase58,
  matchSolanaUsdcReferenceTransfer,
  verifySolanaUsdcPayment
} from '../src/index.ts';

const SPL_TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const MEMO_PROGRAM = 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr';
const VAULT = '4UyTxvrcqtYEsm5LQuiD5ofEJ4bMk6XJqv6G4St3GC9F';
const REF_KEY = 'RefKey11111111111111111111111111111111111111';
const REF_KEY_2 = 'RefKey22222222222222222222222222222222222222';
const OTHER_KEY = 'OtherKey111111111111111111111111111111111111';
const ATTACKER_ATA = 'AttackerAta111111111111111111111111111111111';
const SIG = '5VERv8NMvzbJMEkV8xnrLkEaWRtSz9CosKDYjCJjBRnbJLgp8uirBgmQpjKhoR4tjF3ZpRzrFmBV6UjKdiSZkQUW';

function encodeTransferCheckedData(amountAtomic, decimals = 6) {
  const buf = new Uint8Array(10);
  buf[0] = 12; // TransferChecked
  let v = amountAtomic;
  for (let i = 1; i <= 8; i++) {
    buf[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  buf[9] = decimals;
  return encodeBase58(buf);
}

function encodeTransferData(amountAtomic) {
  const buf = new Uint8Array(9);
  buf[0] = 3; // Transfer
  let v = amountAtomic;
  for (let i = 1; i <= 8; i++) {
    buf[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return encodeBase58(buf);
}

const VALID_TRANSFER_CHECKED_DATA = encodeTransferCheckedData(10_000_000n, 6);
const ZERO_TRANSFER_CHECKED_DATA = encodeTransferCheckedData(0n, 6);
const VALID_TRANSFER_DATA = encodeTransferData(10_000_000n);

function makeTxResult(opts = {}) {
  const {
    accountKeys = [
      'Payer111111111111111111111111111111111111111',
      'SourceAta11111111111111111111111111111111111',
      'DestAta1111111111111111111111111111111111111',
      SOLANA_MAINNET_USDC_MINT,
      VAULT,
      SPL_TOKEN_PROGRAM,
      REF_KEY
    ],
    numRequiredSignatures = 1,
    loadedAddresses = undefined,
    pre = [
      {
        accountIndex: 2,
        mint: SOLANA_MAINNET_USDC_MINT,
        owner: VAULT,
        uiTokenAmount: { amount: '1000000', decimals: 6 }
      }
    ],
    post = [
      {
        accountIndex: 2,
        mint: SOLANA_MAINNET_USDC_MINT,
        owner: VAULT,
        uiTokenAmount: { amount: '11000000', decimals: 6 }
      }
    ]
  } = opts;
  const instructions =
    'instructions' in opts
      ? opts.instructions
      : [
          {
            programIdIndex: 5,
            accounts: [1, 3, 2, 0, 6],
            data: VALID_TRANSFER_CHECKED_DATA
          }
        ];
  return {
    slot: 310000001,
    transaction: {
      message: {
        header: { numRequiredSignatures },
        accountKeys,
        ...(instructions !== undefined ? { instructions } : {})
      }
    },
    meta: {
      err: null,
      loadedAddresses,
      preTokenBalances: pre,
      postTokenBalances: post
    }
  };
}

test('canonical Base58 decode/encode handles leading zero bytes cleanly', () => {
  assert.deepEqual(Array.from(decodeBase58('1')), [0]);
  assert.deepEqual(Array.from(decodeBase58('11')), [0, 0]);
  assert.equal(encodeBase58(new Uint8Array([0])), '1');
  assert.equal(encodeBase58(new Uint8Array([0, 0])), '11');
  assert.equal(encodeBase58(decodeBase58('1123456789ABCDEFGHJKLMNPQRSTUVWXYZ')), '1123456789ABCDEFGHJKLMNPQRSTUVWXYZ');
});

test('verifySolanaUsdcPayment enforces encoding=json, commitment=finalized, AbortSignal.timeout, and null RPC failover', async () => {
  const seenParams = [];
  const mockFetch = async (url, init) => {
    assert.ok(init.signal instanceof AbortSignal);
    const body = JSON.parse(init.body);
    seenParams.push({ url, params: body.params });

    if (url.includes('lagging')) {
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: null }), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      });
    }

    return new Response(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        result: makeTxResult()
      }),
      { status: 200, headers: { 'content-type': 'application/json' } }
    );
  };

  const match = await verifySolanaUsdcPayment({
    signature: SIG,
    expectedRecipientOwner: VAULT,
    expectedReferenceKey: REF_KEY,
    minAmountAtomic: 10_000_000n,
    rpcUrls: ['https://lagging-solana-rpc.local', 'https://healthy-solana-rpc.local'],
    fetchImpl: mockFetch
  });

  assert.equal(match.ok, true);
  assert.equal(match.amountAtomic, 10_000_000n);
  assert.equal(match.rpcUrl, 'https://healthy-solana-rpc.local');
  assert.equal(match.replayKey, computeSolanaReplayKey(SIG));
  assert.equal(seenParams.length, 2);
  assert.equal(seenParams[0].params[1].encoding, 'json');
  assert.equal(seenParams[0].params[1].commitment, 'finalized');
  assert.equal(seenParams[1].params[1].encoding, 'json');
  assert.equal(seenParams[1].params[1].commitment, 'finalized');
});

test('verifySolanaUsdcPayment fails over on hanging HTTP timeout RPC', async () => {
  const hangingSrv = createServer(() => {
    // Intentionally never reply to trigger AbortSignal.timeout
  });
  await new Promise((r) => hangingSrv.listen(0, '127.0.0.1', r));
  const hangingUrl = `http://127.0.0.1:${hangingSrv.address().port}`;

  const healthySrv = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const body = JSON.parse(raw);
      assert.equal(body.params[1].encoding, 'json');
      assert.equal(body.params[1].commitment, 'finalized');
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: makeTxResult() }));
    });
  });
  await new Promise((r) => healthySrv.listen(0, '127.0.0.1', r));
  const healthyUrl = `http://127.0.0.1:${healthySrv.address().port}`;

  try {
    const match = await verifySolanaUsdcPayment({
      signature: SIG,
      expectedRecipientOwner: VAULT,
      expectedReferenceKey: REF_KEY,
      minAmountAtomic: 10_000_000n,
      rpcUrls: [hangingUrl, healthyUrl],
      timeoutMs: 350
    });
    assert.equal(match.rpcUrl, healthyUrl);
    assert.equal(match.amountAtomic, 10_000_000n);
  } finally {
    hangingSrv.closeAllConnections?.();
    healthySrv.closeAllConnections?.();
    await new Promise((r) => hangingSrv.close(() => r()));
    await new Promise((r) => healthySrv.close(() => r()));
  }
});

test('matchSolanaUsdcReferenceTransfer blocks 0-amount decoy, wrong-destination spoof, empty instructions, and cross-invoice replayKey', async () => {
  // Empty instructions MUST fail-closed
  assert.equal(
    matchSolanaUsdcReferenceTransfer(makeTxResult({ instructions: [] }), VAULT, REF_KEY, 10_000_000n),
    null
  );
  assert.equal(
    matchSolanaUsdcReferenceTransfer(makeTxResult({ instructions: undefined }), VAULT, REF_KEY, 10_000_000n),
    null
  );

  // 0-amount decoy TransferChecked carrying REF_KEY alongside real payment without REF_KEY MUST fail-closed
  const zeroDecoyTx = makeTxResult({
    instructions: [
      {
        programIdIndex: 5,
        accounts: [1, 3, 2, 0], // Real 10M USDC payment WITHOUT REF_KEY
        data: VALID_TRANSFER_CHECKED_DATA
      },
      {
        programIdIndex: 5,
        accounts: [1, 3, 2, 0, 6], // 0-amount decoy WITH REF_KEY
        data: ZERO_TRANSFER_CHECKED_DATA
      }
    ]
  });
  assert.equal(
    matchSolanaUsdcReferenceTransfer(zeroDecoyTx, VAULT, REF_KEY, 10_000_000n),
    null
  );

  // Wrong destination ATA (attacker ATA) carrying REF_KEY alongside real payment without REF_KEY MUST fail-closed
  const wrongDestTx = makeTxResult({
    accountKeys: [
      'Payer111111111111111111111111111111111111111',
      'SourceAta11111111111111111111111111111111111',
      'DestAta1111111111111111111111111111111111111',
      SOLANA_MAINNET_USDC_MINT,
      VAULT,
      SPL_TOKEN_PROGRAM,
      REF_KEY,
      ATTACKER_ATA
    ],
    instructions: [
      {
        programIdIndex: 5,
        accounts: [1, 3, 2, 0], // Real 10M USDC to VAULT ATA without REF_KEY
        data: VALID_TRANSFER_CHECKED_DATA
      },
      {
        programIdIndex: 5,
        accounts: [1, 3, 7, 0, 6], // 10M TransferChecked to ATTACKER_ATA with REF_KEY
        data: VALID_TRANSFER_CHECKED_DATA
      }
    ]
  });
  assert.equal(
    matchSolanaUsdcReferenceTransfer(wrongDestTx, VAULT, REF_KEY, 10_000_000n),
    null
  );

  // Spoofed reference in an unrelated Memo instruction alongside an SPL TransferChecked without REF_KEY MUST fail-closed
  const spoofedMemoTx = makeTxResult({
    accountKeys: [
      'Payer111111111111111111111111111111111111111',
      'SourceAta11111111111111111111111111111111111',
      'DestAta1111111111111111111111111111111111111',
      SOLANA_MAINNET_USDC_MINT,
      VAULT,
      SPL_TOKEN_PROGRAM,
      MEMO_PROGRAM,
      REF_KEY
    ],
    instructions: [
      {
        programIdIndex: 5,
        accounts: [1, 3, 2, 0],
        data: VALID_TRANSFER_CHECKED_DATA
      },
      {
        programIdIndex: 6,
        accounts: [7],
        data: encodeBase58(new TextEncoder().encode('memo'))
      }
    ]
  });
  assert.equal(
    matchSolanaUsdcReferenceTransfer(spoofedMemoTx, VAULT, REF_KEY, 10_000_000n),
    null
  );

  // Reference appearing as header signer is rejected
  const signerRefTx = makeTxResult({
    accountKeys: [
      REF_KEY,
      'SourceAta11111111111111111111111111111111111',
      'DestAta1111111111111111111111111111111111111',
      SOLANA_MAINNET_USDC_MINT,
      VAULT,
      SPL_TOKEN_PROGRAM
    ],
    numRequiredSignatures: 1,
    instructions: [
      {
        programIdIndex: 5,
        accounts: [1, 3, 2, 0, 0],
        data: VALID_TRANSFER_CHECKED_DATA
      }
    ]
  });
  assert.equal(
    matchSolanaUsdcReferenceTransfer(signerRefTx, VAULT, REF_KEY, 10_000_000n),
    null
  );

  // Missing reference fails closed
  const missingRefTx = makeTxResult({
    accountKeys: [
      'Payer111111111111111111111111111111111111111',
      'SourceAta11111111111111111111111111111111111',
      'DestAta1111111111111111111111111111111111111',
      SOLANA_MAINNET_USDC_MINT,
      VAULT,
      SPL_TOKEN_PROGRAM,
      OTHER_KEY
    ]
  });
  assert.equal(
    matchSolanaUsdcReferenceTransfer(missingRefTx, VAULT, REF_KEY, 10_000_000n),
    null
  );

  // Reference equal to vault or mint is rejected fail-closed
  assert.throws(
    () => matchSolanaUsdcReferenceTransfer(makeTxResult(), VAULT, VAULT, 10_000_000n),
    /must be distinct/
  );
  assert.throws(
    () =>
      matchSolanaUsdcReferenceTransfer(
        makeTxResult(),
        VAULT,
        SOLANA_MAINNET_USDC_MINT,
        10_000_000n
      ),
    /must be distinct/
  );

  // Unchecked SPL Transfer (opcode 3) with valid destination ATA + trailing reference passes
  const transferOpcodeTx = makeTxResult({
    instructions: [
      {
        programIdIndex: 5,
        accounts: [1, 2, 0, 6],
        data: VALID_TRANSFER_DATA
      }
    ]
  });
  assert.equal(
    matchSolanaUsdcReferenceTransfer(transferOpcodeTx, VAULT, REF_KEY, 10_000_000n),
    10_000_000n
  );

  // v0 loadedAddresses (writable/readonly) matches reference inside TransferChecked accounts
  const v0Tx = makeTxResult({
    accountKeys: [
      'Payer111111111111111111111111111111111111111',
      'SourceAta11111111111111111111111111111111111',
      'DestAta1111111111111111111111111111111111111',
      SOLANA_MAINNET_USDC_MINT,
      VAULT,
      SPL_TOKEN_PROGRAM
    ],
    loadedAddresses: { writable: [], readonly: [REF_KEY] },
    instructions: [
      {
        programIdIndex: 5,
        accounts: [1, 3, 2, 0, 6],
        data: VALID_TRANSFER_CHECKED_DATA
      }
    ]
  });
  assert.equal(
    matchSolanaUsdcReferenceTransfer(v0Tx, VAULT, REF_KEY, 10_000_000n),
    10_000_000n
  );

  // Cross-invoice double-spend prevention: 1 tx carrying 2 references produces the exact same tx-scoped replayKey
  const dualRefTx = makeTxResult({
    accountKeys: [
      'Payer111111111111111111111111111111111111111',
      'SourceAta11111111111111111111111111111111111',
      'DestAta1111111111111111111111111111111111111',
      SOLANA_MAINNET_USDC_MINT,
      VAULT,
      SPL_TOKEN_PROGRAM,
      REF_KEY,
      REF_KEY_2
    ],
    instructions: [
      {
        programIdIndex: 5,
        accounts: [1, 3, 2, 0, 6, 7],
        data: VALID_TRANSFER_CHECKED_DATA
      }
    ]
  });
  const dualFetch = async () =>
    new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: dualRefTx }), { status: 200 });
  const m1 = await verifySolanaUsdcPayment({
    signature: SIG,
    expectedRecipientOwner: VAULT,
    expectedReferenceKey: REF_KEY,
    minAmountAtomic: 10_000_000n,
    rpcUrls: ['https://healthy-solana-rpc.local'],
    fetchImpl: dualFetch
  });
  const m2 = await verifySolanaUsdcPayment({
    signature: SIG,
    expectedRecipientOwner: VAULT,
    expectedReferenceKey: REF_KEY_2,
    minAmountAtomic: 10_000_000n,
    rpcUrls: ['https://healthy-solana-rpc.local'],
    fetchImpl: dualFetch
  });
  assert.equal(m1.replayKey, m2.replayKey);

  // Self-transfer between two ATAs of same owner has 0 net delta -> rejected
  const selfTransferTx = makeTxResult({
    pre: [
      {
        accountIndex: 2,
        mint: SOLANA_MAINNET_USDC_MINT,
        owner: VAULT,
        uiTokenAmount: { amount: '20000000', decimals: 6 }
      },
      {
        accountIndex: 3,
        mint: SOLANA_MAINNET_USDC_MINT,
        owner: VAULT,
        uiTokenAmount: { amount: '0', decimals: 6 }
      }
    ],
    post: [
      {
        accountIndex: 2,
        mint: SOLANA_MAINNET_USDC_MINT,
        owner: VAULT,
        uiTokenAmount: { amount: '10000000', decimals: 6 }
      },
      {
        accountIndex: 3,
        mint: SOLANA_MAINNET_USDC_MINT,
        owner: VAULT,
        uiTokenAmount: { amount: '10000000', decimals: 6 }
      }
    ]
  });
  assert.equal(
    matchSolanaUsdcReferenceTransfer(selfTransferTx, VAULT, REF_KEY, 10_000_000n),
    null
  );

  // Exact BigInt precision above Number.MAX_SAFE_INTEGER
  const largeDeltaTx = makeTxResult({
    instructions: [
      {
        programIdIndex: 5,
        accounts: [1, 3, 2, 0, 6],
        data: encodeTransferCheckedData(9007199254740993n, 6)
      }
    ],
    pre: [
      {
        accountIndex: 2,
        mint: SOLANA_MAINNET_USDC_MINT,
        owner: VAULT,
        uiTokenAmount: { amount: '1', decimals: 6 }
      }
    ],
    post: [
      {
        accountIndex: 2,
        mint: SOLANA_MAINNET_USDC_MINT,
        owner: VAULT,
        uiTokenAmount: { amount: '9007199254740994', decimals: 6 }
      }
    ]
  });
  assert.equal(
    matchSolanaUsdcReferenceTransfer(largeDeltaTx, VAULT, REF_KEY, 9007199254740993n),
    9007199254740993n
  );

  // Non-integer float string fails closed
  const floatTx = makeTxResult({
    post: [
      {
        accountIndex: 2,
        mint: SOLANA_MAINNET_USDC_MINT,
        owner: VAULT,
        uiTokenAmount: { amount: '10.5', decimals: 6 }
      }
    ]
  });
  assert.throws(
    () => matchSolanaUsdcReferenceTransfer(floatTx, VAULT, REF_KEY, 1n),
    /Invalid postTokenBalance atomic amount/
  );
});

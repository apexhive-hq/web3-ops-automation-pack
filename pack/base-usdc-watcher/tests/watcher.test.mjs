import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test from 'node:test';
import {
  BASE_MAINNET_USDC,
  ERC20_TRANSFER_TOPIC,
  computeReplayKey,
  findMatchingBaseUsdcTransfer,
  parseStrictHexBigInt,
  requireNonEmptyRecipient,
  verifyBaseUsdcPayment
} from '../src/index.ts';

const RECIPIENT = '0x2222222222222222222222222222222222222222';
const OTHER_RECIPIENT = '0x3333333333333333333333333333333333333333';
const SENDER = '0x1111111111111111111111111111111111111111';
const SENDER_B = '0x4444444444444444444444444444444444444444';
const TX_HASH = '0x' + 'aa'.repeat(32);

function padAddr(addr) {
  return '0x' + addr.toLowerCase().replace(/^0x/, '').padStart(64, '0');
}

function padUint(val) {
  return '0x' + val.toString(16).padStart(64, '0');
}

function startRpcServer(handler) {
  const srv = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => handler(JSON.parse(raw), res, req));
  });
  return new Promise((resolve) => {
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      resolve({
        srv,
        url: `http://127.0.0.1:${addr.port}`,
        close: () => {
          srv.closeAllConnections?.();
          return new Promise((r) => srv.close(() => r()));
        }
      });
    });
  });
}

test('verifyBaseUsdcPayment fails over from hanging timeout RPC and sums multi-Transfer logs', async () => {
  const hangingSrv = createServer(() => {
    // Intentionally never respond so AbortSignal.timeout fires
  });
  await new Promise((r) => hangingSrv.listen(0, '127.0.0.1', r));
  const hangingPort = hangingSrv.address().port;

  const healthy = await startRpcServer((body, res) => {
    res.setHeader('content-type', 'application/json');
    if (body.method === 'eth_blockNumber') {
      res.end(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: '0x68' }));
      return;
    }
    if (body.method === 'eth_getTransactionReceipt') {
      res.end(
        JSON.stringify({
          jsonrpc: '2.0',
          id: body.id,
          result: {
            status: '0x1',
            blockNumber: '0x64',
            logs: [
              {
                address: BASE_MAINNET_USDC,
                topics: [ERC20_TRANSFER_TOPIC, padAddr(SENDER), padAddr(OTHER_RECIPIENT)],
                data: padUint(50_000_000n)
              },
              {
                address: BASE_MAINNET_USDC,
                topics: [ERC20_TRANSFER_TOPIC, padAddr(SENDER), padAddr(RECIPIENT)],
                data: padUint(4_000_000n)
              },
              {
                address: BASE_MAINNET_USDC,
                topics: [ERC20_TRANSFER_TOPIC, padAddr(SENDER), padAddr(RECIPIENT)],
                data: padUint(6_000_000n)
              }
            ]
          }
        })
      );
      return;
    }
    res.end(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: null }));
  });

  try {
    const res = await verifyBaseUsdcPayment({
      txHash: TX_HASH,
      expectedRecipient: RECIPIENT,
      minAmountAtomic: 10_000_000n,
      rpcUrls: [`http://127.0.0.1:${hangingPort}`, healthy.url],
      minConfirmations: 2,
      timeoutMs: 350
    });
    assert.equal(res.ok, true);
    assert.equal(res.amountAtomic, 10_000_000n);
    assert.equal(res.confirmations, 5);
    assert.equal(res.from, SENDER);
    assert.deepEqual(res.senders, [SENDER]);
    assert.equal(res.transfers.length, 2);
    assert.equal(res.rpcUrl, healthy.url);
    assert.equal(computeReplayKey(8453, TX_HASH).length, 64);

    await assert.rejects(
      () =>
        verifyBaseUsdcPayment({
          txHash: TX_HASH,
          expectedRecipient: RECIPIENT,
          minAmountAtomic: 25_000_000n,
          rpcUrls: [healthy.url]
        }),
      /No matching Base USDC/
    );
  } finally {
    hangingSrv.closeAllConnections?.();
    await new Promise((r) => hangingSrv.close(() => r()));
    await healthy.close();
  }
});

test('findMatchingBaseUsdcTransfer handles multi-payer logs without misattributing sum to firstFrom', () => {
  const receipt = {
    status: '0x1',
    blockNumber: '0x64',
    logs: [
      {
        address: BASE_MAINNET_USDC,
        topics: [ERC20_TRANSFER_TOPIC, padAddr(SENDER), padAddr(RECIPIENT)],
        data: padUint(4_000_000n)
      },
      {
        address: BASE_MAINNET_USDC,
        topics: [ERC20_TRANSFER_TOPIC, padAddr(SENDER_B), padAddr(RECIPIENT)],
        data: padUint(6_000_000n)
      }
    ]
  };

  const multi = findMatchingBaseUsdcTransfer(receipt, RECIPIENT, 10_000_000n);
  assert.ok(multi);
  assert.equal(multi.from, null);
  assert.deepEqual(multi.senders, [SENDER, SENDER_B]);
  assert.deepEqual(multi.transfers, [
    { from: SENDER, amountAtomic: 4_000_000n },
    { from: SENDER_B, amountAtomic: 6_000_000n }
  ]);
  assert.equal(multi.amountAtomic, 10_000_000n);

  // Filtering by expectedSender isolates only that payer's contributions
  assert.equal(
    findMatchingBaseUsdcTransfer(receipt, RECIPIENT, 10_000_000n, BASE_MAINNET_USDC, SENDER),
    null
  );
  const singleSenderMatch = findMatchingBaseUsdcTransfer(
    receipt,
    RECIPIENT,
    6_000_000n,
    BASE_MAINNET_USDC,
    SENDER_B
  );
  assert.ok(singleSenderMatch);
  assert.equal(singleSenderMatch.from, SENDER_B);
  assert.equal(singleSenderMatch.amountAtomic, 6_000_000n);
});

test('verifyBaseUsdcPayment fails closed on NaN, malformed, missing blockNumber/latestHex, and empty recipient', async () => {
  assert.throws(() => requireNonEmptyRecipient(''), /non-empty EVM recipient/);
  assert.throws(() => requireNonEmptyRecipient('   '), /non-empty EVM recipient/);
  assert.throws(() => parseStrictHexBigInt('NaN', 'blockNumber'), /Invalid blockNumber hex/);
  assert.throws(() => parseStrictHexBigInt('0x', 'blockNumber'), /Invalid blockNumber hex/);
  assert.throws(() => parseStrictHexBigInt('0xZZ', 'blockNumber'), /Invalid blockNumber hex/);
  assert.throws(() => parseStrictHexBigInt(undefined, 'blockNumber'), /Invalid blockNumber/);

  for (const badBlock of ['NaN', '', 'not-hex', '0x12zz', null]) {
    const mockFetch = async (_url, init) => {
      const body = JSON.parse(init.body);
      if (body.method === 'eth_getTransactionReceipt') {
        return new Response(
          JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            result: {
              status: '0x1',
              blockNumber: badBlock,
              logs: [
                {
                  address: BASE_MAINNET_USDC,
                  topics: [ERC20_TRANSFER_TOPIC, padAddr(SENDER), padAddr(RECIPIENT)],
                  data: padUint(10_000_000n)
                }
              ]
            }
          }),
          { status: 200 }
        );
      }
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: '0x68' }), { status: 200 });
    };

    await assert.rejects(
      () =>
        verifyBaseUsdcPayment({
          txHash: TX_HASH,
          expectedRecipient: RECIPIENT,
          minAmountAtomic: 10_000_000n,
          rpcUrls: ['https://mock-rpc.local'],
          minConfirmations: 2,
          fetchImpl: mockFetch
        }),
      /Invalid receipt\.blockNumber/
    );
  }

  // Lagging null receipt on RPC 1 fails over cleanly to RPC 2
  let calls = 0;
  const failoverFetch = async (url, init) => {
    calls += 1;
    assert.ok(init.signal instanceof AbortSignal);
    const body = JSON.parse(init.body);
    if (url.includes('lagging')) {
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: null }), { status: 200 });
    }
    if (body.method === 'eth_blockNumber') {
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: '0x66' }), { status: 200 });
    }
    return new Response(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        result: {
          status: '0x1',
          blockNumber: '0x64',
          logs: [
            {
              address: BASE_MAINNET_USDC,
              topics: [ERC20_TRANSFER_TOPIC, padAddr(SENDER), padAddr(RECIPIENT)],
              data: padUint(10_000_000n)
            }
          ]
        }
      }),
      { status: 200 }
    );
  };

  const okRes = await verifyBaseUsdcPayment({
    txHash: TX_HASH,
    expectedRecipient: RECIPIENT,
    minAmountAtomic: 10_000_000n,
    rpcUrls: ['https://lagging-rpc.local', 'https://healthy-rpc.local'],
    minConfirmations: 2,
    fetchImpl: failoverFetch
  });
  assert.equal(okRes.rpcUrl, 'https://healthy-rpc.local');
  assert.ok(calls >= 3);

  // NaN / 0 minConfirmations fail closed
  await assert.rejects(
    () =>
      verifyBaseUsdcPayment({
        txHash: TX_HASH,
        expectedRecipient: RECIPIENT,
        minAmountAtomic: 10_000_000n,
        rpcUrls: ['https://healthy-rpc.local'],
        minConfirmations: Number.NaN,
        fetchImpl: failoverFetch
      }),
    /minConfirmations/
  );

  // Empty recipient rejected before matching
  assert.throws(
    () =>
      findMatchingBaseUsdcTransfer(
        { status: '0x1', blockNumber: '0x64', logs: [] },
        '',
        10_000_000n
      ),
    /non-empty EVM recipient/
  );
});

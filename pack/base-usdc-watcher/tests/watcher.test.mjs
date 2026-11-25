import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test from 'node:test';
import {
  BASE_MAINNET_USDC,
  ERC20_TRANSFER_TOPIC,
  computeReplayKey,
  verifyBaseUsdcPayment
} from '../src/index.ts';

const RECIPIENT = '0x32eceac45dbed9e555dab80346abd4ab9c676206';
const SENDER = '0x1111111111111111111111111111111111111111';
const TX_HASH = '0x' + 'aa'.repeat(32);

function padAddr(addr) {
  return '0x' + addr.toLowerCase().replace(/^0x/, '').padStart(64, '0');
}

function padUint(val) {
  return '0x' + val.toString(16).padStart(64, '0');
}

test('verifyBaseUsdcPayment fails over from dead RPC to healthy RPC and validates BigInt amount', async () => {
  const srv = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const body = JSON.parse(raw);
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
                  topics: [ERC20_TRANSFER_TOPIC, padAddr(SENDER), padAddr(RECIPIENT)],
                  data: padUint(19_000_000n)
                }
              ]
            }
          })
        );
        return;
      }
      res.end(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: null }));
    });
  });

  await new Promise((r) => srv.listen(4168, '127.0.0.1', r));
  try {
    const res = await verifyBaseUsdcPayment({
      txHash: TX_HASH,
      expectedRecipient: RECIPIENT,
      minAmountAtomic: 19_000_000n,
      rpcUrls: ['http://127.0.0.1:4169/down', 'http://127.0.0.1:4168'],
      minConfirmations: 2
    });
    assert.equal(res.ok, true);
    assert.equal(res.amountAtomic, 19_000_000n);
    assert.equal(res.confirmations, 5);
    assert.equal(res.from, SENDER);
    assert.equal(computeReplayKey(8453, TX_HASH).length, 64);

    await assert.rejects(
      () =>
        verifyBaseUsdcPayment({
          txHash: TX_HASH,
          expectedRecipient: RECIPIENT,
          minAmountAtomic: 39_000_000n,
          rpcUrls: ['http://127.0.0.1:4168']
        }),
      /No matching Base USDC/
    );
  } finally {
    srv.close();
  }
});

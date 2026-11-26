import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash, createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { validateN8nWorkflowFile } from '../validate-workflows.mjs';

const SECRET = 'test-hmac-secret-at-least-32-bytes';
const BASE_USDC = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const PAY_TO = '0x2222222222222222222222222222222222222222';
const SENDER = '0x1111111111111111111111111111111111111111';
const SENDER_B = '0x4444444444444444444444444444444444444444';
const TX_HASH = '0x' + 'aa'.repeat(32);
const OTHER_TX_HASH = '0x' + 'bb'.repeat(32);

const SPL_TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const MEMO_PROGRAM = 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr';
const SOL_USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const SOL_VAULT = '4UyTxvrcqtYEsm5LQuiD5ofEJ4bMk6XJqv6G4St3GC9F';
const SOL_REF = 'RefKey11111111111111111111111111111111111111';
const SOL_REF_2 = 'RefKey22222222222222222222222222222222222222';
const SOL_OTHER_REF = 'OtherKey111111111111111111111111111111111111';
const ATTACKER_ATA = 'AttackerAta111111111111111111111111111111111';
const SOL_SIG = '5VERv8NMvzbJMEkV8xnrLkEaWRtSz9CosKDYjCJjBRnbJLgp8uirBgmQpjKhoR4tjF3ZpRzrFmBV6UjKdiSZkQUW';

const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

function encodeBase58(bytes) {
  const digits = [];
  for (const b of bytes) {
    let carry = b;
    for (let i = 0; i < digits.length; i++) {
      carry += digits[i] << 8;
      digits[i] = carry % 58;
      carry = Math.floor(carry / 58);
    }
    while (carry > 0) {
      digits.push(carry % 58);
      carry = Math.floor(carry / 58);
    }
  }
  let out = '';
  for (let i = 0; i < bytes.length && bytes[i] === 0; i++) out += '1';
  for (let i = digits.length - 1; i >= 0; i--) out += BASE58_ALPHABET[digits[i]];
  return out;
}

function encodeTransferCheckedData(amountAtomic, decimals = 6) {
  const buf = new Uint8Array(10);
  buf[0] = 12;
  let v = amountAtomic;
  for (let i = 1; i <= 8; i++) {
    buf[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  buf[9] = decimals;
  return encodeBase58(buf);
}

const VALID_TRANSFER_CHECKED_DATA = encodeTransferCheckedData(25_000_000n, 6);
const ZERO_TRANSFER_CHECKED_DATA = encodeTransferCheckedData(0n, 6);

function signTimestampedBody(secret, tsSec, rawBody) {
  return createHmac('sha256', secret).update(`${tsSec}.${rawBody}`).digest('hex');
}

function padAddr(addr) {
  return '0x' + addr.toLowerCase().replace(/^0x/, '').padStart(64, '0');
}

function padUint(val) {
  return '0x' + val.toString(16).padStart(64, '0');
}

async function runCodeNode(filePath, { env, items, fetchImpl, staticStore = {} }) {
  const wf = JSON.parse(readFileSync(filePath, 'utf8'));
  const codeNode = wf.nodes.find((n) => n.type === 'n8n-nodes-base.code');
  assert.ok(codeNode?.parameters?.jsCode);
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  const getStaticData = () => staticStore;
  const fn = new AsyncFunction(
    '$env',
    'items',
    'fetch',
    '$getWorkflowStaticData',
    codeNode.parameters.jsCode
  );
  return fn(env, items, fetchImpl, getStaticData);
}

test('validate-workflows.mjs CLI entrypoint validates responseMode, specifyBody, and JSON.parse(rawPayload)', () => {
  const dir = join(process.cwd(), 'n8n-webhooks');
  const f1 = join(dir, 'base-usdc-payment-alert.json');
  const f2 = join(dir, 'solana-pay-invoice-webhook.json');
  const r1 = validateN8nWorkflowFile(f1);
  const r2 = validateN8nWorkflowFile(f2);
  assert.equal(r1.nodeCount, 3);
  assert.equal(r2.nodeCount, 3);

  const wf1 = JSON.parse(readFileSync(f1, 'utf8'));
  const wf2 = JSON.parse(readFileSync(f2, 'utf8'));
  assert.equal(wf1.nodes[0].parameters.responseMode, 'lastNode');
  assert.equal(wf2.nodes[0].parameters.responseMode, 'lastNode');
  assert.equal(wf1.nodes[2].parameters.specifyBody, 'json');
  assert.equal(wf2.nodes[2].parameters.specifyBody, 'json');

  const stdout = execFileSync(process.execPath, [join(dir, 'validate-workflows.mjs')], {
    encoding: 'utf8'
  });
  assert.match(stdout, /PASS Base USDC Payment Alert/);
  assert.match(stdout, /PASS Solana Pay USDC Reference Invoice Matcher/);
});

test('base-usdc-payment-alert.json parses verified rawPayload (ignoring mismatched json.body), enforces signed timestamp, and deduplicates', async () => {
  const filePath = join(process.cwd(), 'n8n-webhooks', 'base-usdc-payment-alert.json');
  const baseEnv = {
    WEBHOOK_HMAC_SECRET: SECRET,
    PAY_TO_EVM_ADDRESS: PAY_TO,
    EXPECTED_AMOUNT_ATOMIC: '25000000',
    BASE_RPC_URL: 'https://mock-base-rpc.local',
    MIN_CONFIRMATIONS: '2'
  };

  await assert.rejects(
    () =>
      runCodeNode(filePath, {
        env: { ...baseEnv, WEBHOOK_HMAC_SECRET: '' },
        items: [],
        fetchImpl: async () => {
          throw new Error('should not fetch');
        }
      }),
    /WEBHOOK_HMAC_SECRET/
  );
  await assert.rejects(
    () =>
      runCodeNode(filePath, {
        env: { ...baseEnv, PAY_TO_EVM_ADDRESS: '' },
        items: [],
        fetchImpl: async () => {
          throw new Error('should not fetch');
        }
      }),
    /PAY_TO_EVM_ADDRESS/
  );

  const rawBody = JSON.stringify({ txHash: TX_HASH });
  const nowSec = String(Math.floor(Date.now() / 1000));
  const staleSec = String(Math.floor(Date.now() / 1000) - 600);

  await assert.rejects(
    () =>
      runCodeNode(filePath, {
        env: baseEnv,
        items: [{ json: { headers: {}, rawBody, body: { txHash: TX_HASH } } }],
        fetchImpl: async () => {
          throw new Error('should not fetch');
        }
      }),
    /Unauthorized/
  );

  await assert.rejects(
    () =>
      runCodeNode(filePath, {
        env: baseEnv,
        items: [
          {
            json: {
              headers: {
                'x-webhook-timestamp': staleSec,
                'x-webhook-signature': signTimestampedBody(SECRET, staleSec, rawBody)
              },
              rawBody,
              body: { txHash: TX_HASH }
            }
          }
        ],
        fetchImpl: async () => {
          throw new Error('should not fetch');
        }
      }),
    /replay window/
  );

  await assert.rejects(
    () =>
      runCodeNode(filePath, {
        env: baseEnv,
        items: [
          {
            json: {
              headers: {
                'x-webhook-timestamp': nowSec,
                'x-webhook-signature': '00'.repeat(32)
              },
              rawBody,
              body: { txHash: TX_HASH }
            }
          }
        ],
        fetchImpl: async () => {
          throw new Error('should not fetch');
        }
      }),
    /Unauthorized/
  );

  const sig = signTimestampedBody(SECRET, nowSec, rawBody);
  const staticStore = {};
  const itemWithBinary = {
    json: {
      headers: {
        'x-webhook-timestamp': nowSec,
        'x-webhook-signature': `sha256=${sig}`
      },
      // Mismatched json.body must be ignored in favor of HMAC-verified rawPayload!
      body: { txHash: OTHER_TX_HASH }
    },
    binary: {
      data: {
        data: Buffer.from(rawBody, 'utf8').toString('base64')
      }
    }
  };
  const mockRpcFetch = async (_url, init) => {
    assert.ok(init.signal instanceof AbortSignal);
    const body = JSON.parse(init.body);
    if (body.method === 'eth_blockNumber') {
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: '0x66' }), { status: 200 });
    }
    assert.equal(body.params[0], TX_HASH);
    return new Response(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        result: {
          status: '0x1',
          blockNumber: '0x64',
          logs: [
            {
              address: BASE_USDC,
              topics: [TRANSFER_TOPIC, padAddr(SENDER), padAddr(PAY_TO)],
              data: padUint(10_000_000n)
            },
            {
              address: BASE_USDC,
              topics: [TRANSFER_TOPIC, padAddr(SENDER_B), padAddr(PAY_TO)],
              data: padUint(15_000_000n)
            }
          ]
        }
      }),
      { status: 200 }
    );
  };

  const okItems = await runCodeNode(filePath, {
    env: baseEnv,
    items: [itemWithBinary],
    fetchImpl: mockRpcFetch,
    staticStore
  });

  assert.equal(okItems.length, 1);
  assert.equal(okItems[0].json.txHash, TX_HASH);
  assert.equal(okItems[0].json.amountAtomic, '25000000');
  assert.equal(okItems[0].json.confirmations, 3);
  assert.equal(okItems[0].json.to, PAY_TO);
  assert.equal(okItems[0].json.from, null);
  assert.deepEqual(okItems[0].json.senders, [SENDER, SENDER_B]);
  assert.equal(okItems[0].json.replayKey, `base:${TX_HASH}`);

  const replayed = await runCodeNode(filePath, {
    env: baseEnv,
    items: [itemWithBinary],
    fetchImpl: mockRpcFetch,
    staticStore
  });
  assert.equal(replayed.length, 0);
});

test('solana-pay-invoice-webhook.json blocks 0-amount decoy, wrong-dest spoof, empty ix, and cross-invoice replay', async () => {
  const filePath = join(process.cwd(), 'n8n-webhooks', 'solana-pay-invoice-webhook.json');
  const solEnv = {
    WEBHOOK_HMAC_SECRET: SECRET,
    SOLANA_RECEIVE_ADDRESS: SOL_VAULT,
    EXPECTED_REFERENCE_KEY: SOL_REF,
    EXPECTED_AMOUNT_ATOMIC: '25000000',
    SOLANA_RPC_URL: 'https://mock-solana-rpc.local'
  };

  await assert.rejects(
    () => runCodeNode(filePath, { env: { ...solEnv, SOLANA_RECEIVE_ADDRESS: '' }, items: [], fetchImpl: fetch }),
    /SOLANA_RECEIVE_ADDRESS/
  );
  await assert.rejects(
    () => runCodeNode(filePath, { env: { ...solEnv, EXPECTED_REFERENCE_KEY: SOL_VAULT }, items: [], fetchImpl: fetch }),
    /must be distinct/
  );

  const rawBody = JSON.stringify({ signature: SOL_SIG, forgedAmount: 999999 });
  const nowSec = String(Math.floor(Date.now() / 1000));
  await assert.rejects(
    () =>
      runCodeNode(filePath, {
        env: solEnv,
        items: [{ json: { headers: {}, rawBody, body: { signature: SOL_SIG } } }],
        fetchImpl: fetch
      }),
    /Unauthorized/
  );

  const sig = signTimestampedBody(SECRET, nowSec, rawBody);

  // Empty instructions, Memo spoof, 0-amount decoy, and wrong-destination spoof all fail-closed
  for (const badTx of [
    {
      slot: 310000002,
      transaction: {
        message: {
          header: { numRequiredSignatures: 1 },
          accountKeys: ['Payer111111111111111111111111111111111111111', SOL_OTHER_REF, SOL_VAULT],
          instructions: []
        }
      },
      meta: {
        err: null,
        preTokenBalances: [{ accountIndex: 2, mint: SOL_USDC, owner: SOL_VAULT, uiTokenAmount: { amount: '0', decimals: 6 } }],
        postTokenBalances: [{ accountIndex: 2, mint: SOL_USDC, owner: SOL_VAULT, uiTokenAmount: { amount: '25000000', decimals: 6 } }]
      }
    },
    {
      slot: 310000002,
      transaction: {
        message: {
          header: { numRequiredSignatures: 1 },
          accountKeys: [
            'Payer111111111111111111111111111111111111111',
            'SourceAta11111111111111111111111111111111111',
            'DestAta1111111111111111111111111111111111111',
            SOL_USDC,
            SOL_VAULT,
            SPL_TOKEN_PROGRAM,
            MEMO_PROGRAM,
            SOL_REF
          ],
          instructions: [
            { programIdIndex: 5, accounts: [1, 3, 2, 0], data: VALID_TRANSFER_CHECKED_DATA },
            { programIdIndex: 6, accounts: [7], data: encodeBase58(Buffer.from('memo')) }
          ]
        }
      },
      meta: {
        err: null,
        preTokenBalances: [{ accountIndex: 2, mint: SOL_USDC, owner: SOL_VAULT, uiTokenAmount: { amount: '0', decimals: 6 } }],
        postTokenBalances: [{ accountIndex: 2, mint: SOL_USDC, owner: SOL_VAULT, uiTokenAmount: { amount: '25000000', decimals: 6 } }]
      }
    },
    {
      slot: 310000002,
      transaction: {
        message: {
          header: { numRequiredSignatures: 1 },
          accountKeys: [
            'Payer111111111111111111111111111111111111111',
            'SourceAta11111111111111111111111111111111111',
            'DestAta1111111111111111111111111111111111111',
            SOL_USDC,
            SOL_VAULT,
            SPL_TOKEN_PROGRAM,
            SOL_REF
          ],
          instructions: [
            { programIdIndex: 5, accounts: [1, 3, 2, 0], data: VALID_TRANSFER_CHECKED_DATA },
            { programIdIndex: 5, accounts: [1, 3, 2, 0, 6], data: ZERO_TRANSFER_CHECKED_DATA }
          ]
        }
      },
      meta: {
        err: null,
        preTokenBalances: [{ accountIndex: 2, mint: SOL_USDC, owner: SOL_VAULT, uiTokenAmount: { amount: '0', decimals: 6 } }],
        postTokenBalances: [{ accountIndex: 2, mint: SOL_USDC, owner: SOL_VAULT, uiTokenAmount: { amount: '25000000', decimals: 6 } }]
      }
    },
    {
      slot: 310000002,
      transaction: {
        message: {
          header: { numRequiredSignatures: 1 },
          accountKeys: [
            'Payer111111111111111111111111111111111111111',
            'SourceAta11111111111111111111111111111111111',
            'DestAta1111111111111111111111111111111111111',
            SOL_USDC,
            SOL_VAULT,
            SPL_TOKEN_PROGRAM,
            SOL_REF,
            ATTACKER_ATA
          ],
          instructions: [
            { programIdIndex: 5, accounts: [1, 3, 2, 0], data: VALID_TRANSFER_CHECKED_DATA },
            { programIdIndex: 5, accounts: [1, 3, 7, 0, 6], data: VALID_TRANSFER_CHECKED_DATA }
          ]
        }
      },
      meta: {
        err: null,
        preTokenBalances: [{ accountIndex: 2, mint: SOL_USDC, owner: SOL_VAULT, uiTokenAmount: { amount: '0', decimals: 6 } }],
        postTokenBalances: [{ accountIndex: 2, mint: SOL_USDC, owner: SOL_VAULT, uiTokenAmount: { amount: '25000000', decimals: 6 } }]
      }
    }
  ]) {
    const res = await runCodeNode(filePath, {
      env: solEnv,
      items: [
        {
          json: {
            headers: { 'x-webhook-timestamp': nowSec, 'x-webhook-signature': sig },
            rawBody,
            body: { signature: SOL_SIG, forgedAmount: 999999 }
          }
        }
      ],
      fetchImpl: async (_url, init) => {
        const req = JSON.parse(init.body);
        assert.equal(req.params[1].encoding, 'json');
        assert.equal(req.params[1].commitment, 'finalized');
        return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: badTx }), { status: 200 });
      }
    });
    assert.equal(res.length, 0);
  }

  // Valid encoding='json' SPL TransferChecked settles Invoice 1, and cross-invoice replay on Invoice 2 is blocked!
  const staticStore = {};
  const validItem = {
    json: {
      headers: { 'x-webhook-timestamp': nowSec, 'x-webhook-signature': sig },
      body: { signature: 'WrongUnverifiedSig111111111111111111111111111', forgedAmount: 999999 }
    },
    binary: {
      data: {
        data: Buffer.from(rawBody, 'utf8').toString('base64')
      }
    }
  };
  const validRpcFetch = async (_url, init) => {
    assert.ok(init.signal instanceof AbortSignal);
    const req = JSON.parse(init.body);
    assert.equal(req.params[0], SOL_SIG);
    assert.equal(req.params[1].encoding, 'json');
    assert.equal(req.params[1].commitment, 'finalized');
    return new Response(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        result: {
          slot: 310000003,
          transaction: {
            message: {
              header: { numRequiredSignatures: 1 },
              accountKeys: [
                'Payer111111111111111111111111111111111111111',
                'SourceAta11111111111111111111111111111111111',
                'DestAta1111111111111111111111111111111111111',
                SOL_USDC,
                SOL_VAULT,
                SPL_TOKEN_PROGRAM
              ],
              instructions: [
                {
                  programIdIndex: 5,
                  accounts: [1, 3, 2, 0, 6, 7],
                  data: VALID_TRANSFER_CHECKED_DATA
                }
              ]
            }
          },
          meta: {
            err: null,
            loadedAddresses: { writable: [], readonly: [SOL_REF, SOL_REF_2] },
            preTokenBalances: [
              {
                accountIndex: 2,
                mint: SOL_USDC,
                owner: SOL_VAULT,
                uiTokenAmount: { amount: '5000000', decimals: 6 }
              }
            ],
            postTokenBalances: [
              {
                accountIndex: 2,
                mint: SOL_USDC,
                owner: SOL_VAULT,
                uiTokenAmount: { amount: '30000000', decimals: 6 }
              }
            ]
          }
        }
      }),
      { status: 200 }
    );
  };

  const expectedReplayKey = createHash('sha256').update(`solana:${SOL_SIG}`).digest('hex');
  const okRes = await runCodeNode(filePath, {
    env: solEnv,
    items: [validItem],
    fetchImpl: validRpcFetch,
    staticStore
  });

  assert.equal(okRes.length, 1);
  assert.equal(okRes[0].json.event, 'solana_usdc_settled');
  assert.equal(okRes[0].json.signature, SOL_SIG);
  assert.equal(okRes[0].json.amountAtomic, '25000000');
  assert.equal(okRes[0].json.referenceKey, SOL_REF);
  assert.equal(okRes[0].json.replayKey, expectedReplayKey);
  assert.equal(okRes[0].json.forgedAmount, undefined);

  // Cross-invoice double-spend attempt using REF_2 on the same tx signature is blocked
  const crossInvoiceAttempt = await runCodeNode(filePath, {
    env: { ...solEnv, EXPECTED_REFERENCE_KEY: SOL_REF_2 },
    items: [validItem],
    fetchImpl: validRpcFetch,
    staticStore
  });
  assert.equal(crossInvoiceAttempt.length, 0);

  // Dynamic signed per-invoice reference works when ALLOW_SIGNED_PAYLOAD_REFERENCE=true
  const dynBody = JSON.stringify({ signature: SOL_SIG, expectedReferenceKey: SOL_REF_2 });
  const dynSig = signTimestampedBody(SECRET, nowSec, dynBody);
  const dynRes = await runCodeNode(filePath, {
    env: {
      WEBHOOK_HMAC_SECRET: SECRET,
      SOLANA_RECEIVE_ADDRESS: SOL_VAULT,
      ALLOW_SIGNED_PAYLOAD_REFERENCE: 'true',
      EXPECTED_AMOUNT_ATOMIC: '25000000',
      SOLANA_RPC_URL: 'https://mock-solana-rpc.local'
    },
    items: [
      {
        json: {
          headers: { 'x-webhook-timestamp': nowSec, 'x-webhook-signature': dynSig },
          rawBody: dynBody
        }
      }
    ],
    fetchImpl: validRpcFetch,
    staticStore: {}
  });
  assert.equal(dynRes.length, 1);
  assert.equal(dynRes[0].json.referenceKey, SOL_REF_2);
});

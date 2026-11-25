import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { chromium } from 'playwright';
import { encodeAbiParameters, pad } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';

const STOREFRONT_DIR = process.cwd();
const PRODUCT_DIR = resolve(STOREFRONT_DIR, '..');
const HQ_ROOT = resolve(PRODUCT_DIR, '..', '..');
const CACHES_DIR = join(HQ_ROOT, 'departments', 'infra', '.caches');
const ZIP_PATH = join(PRODUCT_DIR, 'dist', 'web3-ops-automation-pack-v1.0.0.zip');

const PAY_TO = '0x32eceaC45DBED9E555dAb80346aBd4Ab9C676206';
const BASE_USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const WRONG_USDC = '0x9999999999999999999999999999999999999999';
const WRONG_RECIPIENT = '0x8888888888888888888888888888888888888888';
const TRANSFER_TOPIC =
  '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';

function makeTransferLog(tokenAddr, fromAddr, toAddr, atomicValue) {
  return {
    address: tokenAddr,
    topics: [TRANSFER_TOPIC, pad(fromAddr, { size: 32 }), pad(toAddr, { size: 32 })],
    data: encodeAbiParameters([{ type: 'uint256' }], [atomicValue])
  };
}

async function waitForServer(url, logs, timeoutMs = 45000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch {
      // retry
    }
    await new Promise((r) => setTimeout(r, 400));
  }
  throw new Error(`Timed out waiting for ${url}. Worker logs:\n${logs.join('')}`);
}

test('storefront Open-Core v2.0 + sentinel money-safety + cross-product KV + Playwright E2E', async () => {
  assert.equal(existsSync(ZIP_PATH), true, 'Run pack bundle first so dist zip exists');
  const zipBytes = readFileSync(ZIP_PATH);
  const zipSha256 = createHash('sha256').update(zipBytes).digest('hex');

  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const privateJwk = privateKey.export({ format: 'jwk' });
  const publicSpkiB64 = publicKey.export({ type: 'spki', format: 'der' }).toString('base64');

  const payerAcct = privateKeyToAccount(generatePrivateKey());
  const attackerAcct = privateKeyToAccount(generatePrivateKey());

  const TX_VALID_SUPPORTER = '0x' + '11'.repeat(32);
  const TX_VALID_TEAM = '0x' + '22'.repeat(32);
  const TX_UNDERPAY = '0x' + '33'.repeat(32);
  const TX_WRONG_RECIPIENT = '0x' + '44'.repeat(32);
  const TX_WRONG_TOKEN = '0x' + '55'.repeat(32);
  const TX_REVERTED = '0x' + '66'.repeat(32);
  const TX_CONF_RETRY = '0x' + '77'.repeat(32);
  const TX_SPLIT_LOGS = '0x' + '88'.repeat(32);
  const TX_CROSS_PRODUCT = '0x' + '99'.repeat(32);

  let latestBlockHex = '0x68';
  const receipts = new Map([
    [TX_VALID_SUPPORTER, { status: '0x1', blockNumber: '0x64', logs: [makeTransferLog(BASE_USDC, payerAcct.address, PAY_TO, 5_000_000n)] }],
    [TX_VALID_TEAM, { status: '0x1', blockNumber: '0x64', logs: [makeTransferLog(BASE_USDC, payerAcct.address, PAY_TO, 49_000_000n)] }],
    [TX_UNDERPAY, { status: '0x1', blockNumber: '0x64', logs: [makeTransferLog(BASE_USDC, payerAcct.address, PAY_TO, 4_990_000n)] }],
    [TX_WRONG_RECIPIENT, { status: '0x1', blockNumber: '0x64', logs: [makeTransferLog(BASE_USDC, payerAcct.address, WRONG_RECIPIENT, 5_000_000n)] }],
    [TX_WRONG_TOKEN, { status: '0x1', blockNumber: '0x64', logs: [makeTransferLog(WRONG_USDC, payerAcct.address, PAY_TO, 5_000_000n)] }],
    [TX_REVERTED, { status: '0x0', blockNumber: '0x64', logs: [] }],
    [TX_CONF_RETRY, { status: '0x1', blockNumber: '0x68', logs: [makeTransferLog(BASE_USDC, payerAcct.address, PAY_TO, 5_000_000n)] }],
    [
      TX_SPLIT_LOGS,
      {
        status: '0x1',
        blockNumber: '0x64',
        logs: [
          // Malformed "0x" data log must be safely skipped
          { address: BASE_USDC, topics: [TRANSFER_TOPIC, pad(payerAcct.address, { size: 32 }), pad(PAY_TO, { size: 32 })], data: '0x' },
          makeTransferLog(BASE_USDC, payerAcct.address, PAY_TO, 2_000_000n),
          makeTransferLog(BASE_USDC, payerAcct.address, PAY_TO, 3_000_000n)
        ]
      }
    ],
    [TX_CROSS_PRODUCT, { status: '0x1', blockNumber: '0x64', logs: [makeTransferLog(BASE_USDC, payerAcct.address, PAY_TO, 5_000_000n)] }]
  ]);

  // Primary RPC on 127.0.0.1:4153 returning HTTP 429 to verify failover
  const rateLimitedRpc = createServer((_req, res) => {
    res.writeHead(429, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'rate limited' }));
  });
  await new Promise((r) => rateLimitedRpc.listen(4153, '127.0.0.1', r));

  // Secondary healthy Base JSON-RPC on 127.0.0.1:4151
  const rpcServer = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const payload = JSON.parse(raw);
      res.setHeader('content-type', 'application/json');
      if (payload.method === 'eth_blockNumber') {
        res.end(JSON.stringify({ jsonrpc: '2.0', id: payload.id, result: latestBlockHex }));
        return;
      }
      if (payload.method === 'eth_getTransactionReceipt') {
        const hash = String(payload.params?.[0] ?? '').toLowerCase();
        res.end(JSON.stringify({ jsonrpc: '2.0', id: payload.id, result: receipts.get(hash) ?? null }));
        return;
      }
      res.end(JSON.stringify({ jsonrpc: '2.0', id: payload.id, result: null }));
    });
  });
  await new Promise((r) => rpcServer.listen(4151, '127.0.0.1', r));

  // Mock Public MIT GitHub Release asset server on 127.0.0.1:4152 (no auth token required)
  const releaseServer = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/octet-stream' });
    res.end(zipBytes);
  });
  await new Promise((r) => releaseServer.listen(4152, '127.0.0.1', r));

  const devVarsPath = join(STOREFRONT_DIR, '.dev.vars');
  const wranglerStateDir = join(STOREFRONT_DIR, '.wrangler-state');
  if (existsSync(wranglerStateDir)) {
    rmSync(wranglerStateDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
  writeFileSync(
    devVarsPath,
    [
      `LICENSE_SIGNING_PRIVATE_JWK=${JSON.stringify(privateJwk)}`,
      `LICENSE_SIGNING_PUBLIC_SPKI_B64=${publicSpkiB64}`,
      `DOWNLOAD_HMAC_SECRET=test-hmac-secret-32-bytes-minimum`,
      `ASSET_SHA256=${zipSha256}`,
      `BASE_RPC_URLS=http://127.0.0.1:4153,http://127.0.0.1:4151`,
      `GITHUB_RELEASE_ASSET_URL=http://127.0.0.1:4152/releases/web3-ops-automation-pack-v1.0.0.zip`
    ].join('\n'),
    'utf8'
  );

  const workerEnv = {
    ...process.env,
    APPDATA: join(CACHES_DIR, 'appdata'),
    LOCALAPPDATA: join(CACHES_DIR, 'localappdata'),
    XDG_CONFIG_HOME: join(CACHES_DIR, 'xdg-config'),
    PLAYWRIGHT_BROWSERS_PATH: join(CACHES_DIR, 'ms-playwright')
  };

  // Pre-seed GLOBAL_CLAIMED_TX_KV with TX_CROSS_PRODUCT claimed on storefront:slimmcp
  const seedFile = join(STOREFRONT_DIR, '.seed-global-tx.json');
  writeFileSync(
    seedFile,
    JSON.stringify({
      scope: 'storefront:slimmcp',
      payer: payerAcct.address.toLowerCase(),
      tier: 'supporter',
      claimedAt: Date.now()
    }),
    'utf8'
  );
  try {
    execFileSync(
      'wrangler',
      [
        'kv',
        'key',
        'put',
        '--local',
        '--binding',
        'GLOBAL_CLAIMED_TX_KV',
        '--persist-to',
        '.wrangler-state',
        `global_tx:${TX_CROSS_PRODUCT}`,
        '--path',
        '.seed-global-tx.json'
      ],
      { cwd: STOREFRONT_DIR, shell: true, env: workerEnv, stdio: 'ignore' }
    );
  } finally {
    if (existsSync(seedFile)) rmSync(seedFile, { force: true });
  }

  const workerLogs = [];
  const workerProc = spawn(
    'wrangler',
    ['dev', '--local', '--ip', '127.0.0.1', '--port', '4150', '--persist-to', '.wrangler-state'],
    { cwd: STOREFRONT_DIR, shell: true, env: workerEnv }
  );
  workerProc.stdout?.on('data', (d) => workerLogs.push(d.toString()));
  workerProc.stderr?.on('data', (d) => workerLogs.push(d.toString()));

  try {
    await waitForServer('http://127.0.0.1:4150/api/health', workerLogs);

    // CORS + UTF-8 + Config check
    const cfgRes = await fetch('http://127.0.0.1:4150/api/config');
    assert.equal(cfgRes.headers.get('access-control-allow-origin'), '*');
    assert.match(cfgRes.headers.get('content-type') || '', /charset=utf-8/i);
    const cfg = await cfgRes.json();
    assert.equal(cfg.tiers.openCore.usdc, '0');
    assert.equal(cfg.tiers.supporter.usdc, '5');
    assert.equal(cfg.tiers.team.usdc, '49');

    // Explicit tier validation (400 INVALID_TIER, no silent coercion)
    const badTierChallenge = await fetch('http://127.0.0.1:4150/api/challenge', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ txHash: TX_VALID_SUPPORTER, tier: 'bogus' })
    });
    assert.equal(badTierChallenge.status, 400);
    assert.equal((await badTierChallenge.json()).code, 'INVALID_TIER');

    const badTierVerify = await fetch('http://127.0.0.1:4150/api/verify', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ txHash: TX_VALID_SUPPORTER, tier: 'bogus', nonce: 'a', signature: '0x12' })
    });
    assert.equal(badTierVerify.status, 400);
    assert.equal((await badTierVerify.json()).code, 'INVALID_TIER');

    async function attemptVerify(txHash, tier, signer) {
      const chRes = await fetch('http://127.0.0.1:4150/api/challenge', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ txHash, tier })
      });
      const ch = await chRes.json();
      const sig = await signer.signMessage({ message: ch.message });
      return fetch('http://127.0.0.1:4150/api/verify', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ txHash, tier, nonce: ch.nonce, signature: sig })
      });
    }

    // 1. Negative API guard checks (403) + forged HMAC token rejected
    assert.equal((await attemptVerify(TX_UNDERPAY, 'supporter', payerAcct)).status, 403);
    assert.equal((await attemptVerify(TX_WRONG_RECIPIENT, 'supporter', payerAcct)).status, 403);
    assert.equal((await attemptVerify(TX_WRONG_TOKEN, 'supporter', payerAcct)).status, 403);
    assert.equal((await attemptVerify(TX_REVERTED, 'supporter', payerAcct)).status, 403);
    assert.equal((await attemptVerify(TX_VALID_SUPPORTER, 'supporter', attackerAcct)).status, 403);
    assert.equal(
      (await fetch(`http://127.0.0.1:4150/api/download?token=${'00'.repeat(16)}.${'ff'.repeat(32)}`)).status,
      403
    );

    // 2. Cross-product anti-replay (403 TX_ALREADY_CLAIMED_ELSEWHERE)
    const crossRes = await attemptVerify(TX_CROSS_PRODUCT, 'supporter', payerAcct);
    assert.equal(crossRes.status, 403);
    assert.equal((await crossRes.json()).code, 'TX_ALREADY_CLAIMED_ELSEWHERE');

    // 3. Multi-log split Base USDC Transfer aggregation (2 + 3 = 5 USDC) + "0x" log skip
    const splitRes = await attemptVerify(TX_SPLIT_LOGS, 'supporter', payerAcct);
    assert.equal(splitRes.status, 200);
    assert.equal((await splitRes.json()).ok, true);

    // 4. 1-confirmation retry with the SAME nonce & signature
    const chRetryRes = await fetch('http://127.0.0.1:4150/api/challenge', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ txHash: TX_CONF_RETRY, tier: 'supporter' })
    });
    const chRetry = await chRetryRes.json();
    const sigRetry = await payerAcct.signMessage({ message: chRetry.message });
    const conf1Res = await fetch('http://127.0.0.1:4150/api/verify', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ txHash: TX_CONF_RETRY, tier: 'supporter', nonce: chRetry.nonce, signature: sigRetry })
    });
    assert.equal(conf1Res.status, 403);
    assert.equal((await conf1Res.json()).code, 'INSUFFICIENT_CONFIRMATIONS');

    latestBlockHex = '0x69';
    const conf2Res = await fetch('http://127.0.0.1:4150/api/verify', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ txHash: TX_CONF_RETRY, tier: 'supporter', nonce: chRetry.nonce, signature: sigRetry })
    });
    assert.equal(conf2Res.status, 200);
    assert.equal((await conf2Res.json()).ok, true);

    // 5. Valid Team (49 USDC) verification + public release stream
    const teamRes = await attemptVerify(TX_VALID_TEAM, 'team', payerAcct);
    assert.equal(teamRes.status, 200);
    const teamJson = await teamRes.json();
    assert.equal(teamJson.ok, true);
    assert.equal(teamJson.reclaimed, false);
    assert.equal(teamJson.tier, 'team');

    const dlRes = await fetch(`http://127.0.0.1:4150${teamJson.downloadUrl}`);
    assert.equal(dlRes.status, 200);
    assert.equal(dlRes.headers.get('x-asset-sha256'), zipSha256);
    const dlBuf = Buffer.from(await dlRes.arrayBuffer());
    assert.equal(createHash('sha256').update(dlBuf).digest('hex'), zipSha256);

    // 6. Same-payer re-claim succeeds 200 (reclaimed: true) + fresh download, while attacker fails 403
    const reclaimRes = await attemptVerify(TX_VALID_TEAM, 'team', payerAcct);
    assert.equal(reclaimRes.status, 200);
    const reclaimJson = await reclaimRes.json();
    assert.equal(reclaimJson.ok, true);
    assert.equal(reclaimJson.reclaimed, true);
    const dl2Res = await fetch(`http://127.0.0.1:4150${reclaimJson.downloadUrl}`);
    assert.equal(dl2Res.status, 200);

    assert.equal((await attemptVerify(TX_VALID_TEAM, 'team', attackerAcct)).status, 403);

    // 7. Playwright E2E (1440x900 + 375x812 + mocked window.ethereum 1-click Pay 5 USDC + support email)
    process.env.PLAYWRIGHT_BROWSERS_PATH = join(CACHES_DIR, 'ms-playwright');
    const browser = await chromium.launch({ headless: true });
    try {
      const context = await browser.newContext();
      const page = await context.newPage();
      const consoleErrors = [];
      const pageErrors = [];
      page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
      page.on('pageerror', (e) => pageErrors.push(e.message));

      await page.addInitScript(({ addr, txHash }) => {
        let chain = '0x1';
        window.__txCalls = [];
        window.ethereum = {
          request: async ({ method, params }) => {
            if (method === 'eth_requestAccounts') return [addr];
            if (method === 'eth_chainId') return chain;
            if (method === 'wallet_switchEthereumChain') { chain = params[0].chainId; return null; }
            if (method === 'eth_sendTransaction') { window.__txCalls.push(params[0]); return txHash; }
            if (method === 'personal_sign') { return window.__signChallenge(params[0]); }
            throw new Error(`Unexpected method ${method}`);
          }
        };
      }, { addr: payerAcct.address, txHash: TX_VALID_SUPPORTER });

      await page.exposeFunction('__signChallenge', async (msg) => {
        return payerAcct.signMessage({ message: msg });
      });

      for (const vp of [{ width: 1440, height: 900 }, { width: 375, height: 812 }]) {
        await page.setViewportSize(vp);
        await page.goto('http://127.0.0.1:4150', { waitUntil: 'networkidle' });
        const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
        assert.equal(overflow, false, `Horizontal overflow at ${vp.width}x${vp.height}`);
        const hasSupport = await page.locator('a[href="mailto:apexhive.hq@proton.me"]').count();
        assert.equal(hasSupport, 1);
      }

      await page.click('#wallet-pay-btn');
      await page.waitForFunction(() => document.getElementById('tx-hash-input').value.length === 66);
      await page.click('#challenge-btn');
      await page.waitForSelector('#challenge-box:not([hidden])');
      await page.click('#wallet-sign-btn');
      await page.waitForFunction(() => document.getElementById('signature-input').value.startsWith('0x'));
      await page.click('#verify-submit-btn');
      await page.waitForSelector('#license-result:not([hidden])');

      const dlHref = await page.getAttribute('#download-link', 'href');
      assert.ok(dlHref && dlHref.startsWith('/api/download?token='));
      assert.equal(consoleErrors.length, 0);
      assert.equal(pageErrors.length, 0);
      await context.close();
    } finally {
      await browser.close();
    }
  } finally {
    if (workerProc.pid) {
      try {
        execFileSync('taskkill', ['/pid', String(workerProc.pid), '/T', '/F'], { stdio: 'ignore' });
      } catch {
        // already exited
      }
    }
    rateLimitedRpc.close();
    rpcServer.close();
    releaseServer.close();
    if (existsSync(devVarsPath)) rmSync(devVarsPath, { force: true });
    if (existsSync(wranglerStateDir)) {
      await new Promise((r) => setTimeout(r, 500));
      try {
        rmSync(wranglerStateDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
      } catch {
        // ignore Windows workerd lock on teardown
      }
    }
  }
});

test('storefront fails closed (500) when DOWNLOAD_HMAC_SECRET or LICENSE_SIGNING_PRIVATE_JWK is missing', async () => {
  const devVarsPath = join(STOREFRONT_DIR, '.dev.vars');
  const wranglerStateDir = join(STOREFRONT_DIR, '.wrangler-state-nosecret');
  writeFileSync(devVarsPath, 'BASE_RPC_URLS=http://127.0.0.1:4151\n', 'utf8');

  const workerLogs = [];
  const workerProc = spawn(
    'wrangler',
    ['dev', '--local', '--ip', '127.0.0.1', '--port', '4154', '--persist-to', '.wrangler-state-nosecret'],
    {
      cwd: STOREFRONT_DIR,
      shell: true,
      env: {
        ...process.env,
        APPDATA: join(CACHES_DIR, 'appdata'),
        LOCALAPPDATA: join(CACHES_DIR, 'localappdata'),
        XDG_CONFIG_HOME: join(CACHES_DIR, 'xdg-config')
      }
    }
  );
  workerProc.stdout?.on('data', (d) => workerLogs.push(d.toString()));
  workerProc.stderr?.on('data', (d) => workerLogs.push(d.toString()));

  try {
    await waitForServer('http://127.0.0.1:4154/api/health', workerLogs);
    const vRes = await fetch('http://127.0.0.1:4154/api/verify', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ txHash: '0x' + '11'.repeat(32), tier: 'supporter', nonce: 'abc', signature: '0x12' })
    });
    assert.equal(vRes.status, 500);
    const dRes = await fetch('http://127.0.0.1:4154/api/download?token=abc.def');
    assert.equal(dRes.status, 500);
  } finally {
    if (workerProc.pid) {
      try {
        execFileSync('taskkill', ['/pid', String(workerProc.pid), '/T', '/F'], { stdio: 'ignore' });
      } catch {
        // already exited
      }
    }
    if (existsSync(devVarsPath)) rmSync(devVarsPath, { force: true });
    if (existsSync(wranglerStateDir)) {
      await new Promise((r) => setTimeout(r, 500));
      try {
        rmSync(wranglerStateDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
      } catch {
        // ignore
      }
    }
  }
});

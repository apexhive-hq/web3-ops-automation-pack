import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { createServer } from 'node:http';
import test from 'node:test';
import { chromium } from 'playwright';
import { assertResponsiveAndCleanConsole, injectMockEthereum } from '../src/harness.ts';

async function withMockWindow(mockWin, fn) {
  const origWindow = globalThis.window;
  globalThis.window = mockWin;
  try {
    return await fn();
  } finally {
    if (origWindow === undefined) delete globalThis.window;
    else globalThis.window = origWindow;
  }
}

function createMockPage() {
  let initFn = null;
  let initArg = null;
  const mockWin = { __mockWalletCalls: [] };
  return {
    addInitScript(fn, arg) {
      initFn = fn;
      initArg = arg;
    },
    on() {},
    async setViewportSize() {},
    async goto(url) {
      if (!url.startsWith('http://127.0.0.1:')) throw new Error(`Bad URL: ${url}`);
      if (initFn) {
        await withMockWindow(mockWin, () => initFn(initArg));
      }
      return { ok: () => true, status: () => 200 };
    },
    async evaluate() {
      return false;
    },
    async requestAccounts() {
      return withMockWindow(mockWin, () => mockWin.ethereum.request({ method: 'eth_requestAccounts' }));
    }
  };
}

test('playwright-crypto-qa harness verifies mock EIP-1193 wallet + 375px/1440px clean console', async () => {
  const srv = createServer((_req, res) => {
    res.setHeader('content-type', 'text/html; charset=utf-8');
    res.end(`<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head>
      <body style="margin:0;padding:16px;font-family:sans-serif">
        <button id="pay">Pay</button><div id="out"></div>
        <script>
          document.getElementById('pay').addEventListener('click', async () => {
            const accts = await window.ethereum.request({ method: 'eth_requestAccounts' });
            document.getElementById('out').textContent = accts[0];
          });
        </script>
      </body></html>`);
  });

  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const addr = srv.address();
  assert.ok(addr && typeof addr === 'object');
  const baseUrl = `http://127.0.0.1:${addr.port}`;
  let browser = null;

  try {
    // Always verify browserless CI fallback path (matches GitHub Actions runner)
    const mockPage = createMockPage();
    await injectMockEthereum(mockPage, {
      address: '0x1111111111111111111111111111111111111111',
      txHashToReturn: '0x' + 'cc'.repeat(32),
      signatureToReturn: '0x' + 'dd'.repeat(65)
    });
    const mockRes = await assertResponsiveAndCleanConsole(mockPage, baseUrl);
    assert.equal(mockRes.consoleErrors.length, 0);
    assert.equal(mockRes.pageErrors.length, 0);
    assert.deepEqual(await mockPage.requestAccounts(), ['0x1111111111111111111111111111111111111111']);

    // Also run real headless Chromium when browser binaries are present
    if (existsSync(chromium.executablePath())) {
      browser = await chromium.launch({ headless: true });
      const context = await browser.newContext();
      const page = await context.newPage();
      await injectMockEthereum(page, {
        address: '0x1111111111111111111111111111111111111111',
        txHashToReturn: '0x' + 'cc'.repeat(32),
        signatureToReturn: '0x' + 'dd'.repeat(65)
      });

      const res = await assertResponsiveAndCleanConsole(page, baseUrl);
      assert.equal(res.consoleErrors.length, 0);
      assert.equal(res.pageErrors.length, 0);

      await page.click('#pay');
      const out = await page.textContent('#out');
      assert.equal(out, '0x1111111111111111111111111111111111111111');
      await context.close();
    }
  } finally {
    await browser?.close().catch(() => {});
    srv.close();
  }
});

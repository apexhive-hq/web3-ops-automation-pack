import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { chromium } from 'playwright';
import { assertResponsiveAndCleanConsole, injectMockEthereum } from '../src/harness.ts';

const HQ_ROOT = resolve(process.cwd(), '..', '..', '..');
const PLAYWRIGHT_BROWSERS = join(HQ_ROOT, 'departments', 'infra', '.caches', 'ms-playwright');

test('playwright-crypto-qa harness verifies mock EIP-1193 wallet + 375px/1440px clean console', async () => {
  process.env.PLAYWRIGHT_BROWSERS_PATH = PLAYWRIGHT_BROWSERS;
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

  await new Promise((r) => srv.listen(4167, '127.0.0.1', r));
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext();
    const page = await context.newPage();
    await injectMockEthereum(page, {
      address: '0x1111111111111111111111111111111111111111',
      txHashToReturn: '0x' + 'cc'.repeat(32),
      signatureToReturn: '0x' + 'dd'.repeat(65)
    });

    const res = await assertResponsiveAndCleanConsole(page, 'http://127.0.0.1:4167');
    assert.equal(res.consoleErrors.length, 0);
    assert.equal(res.pageErrors.length, 0);

    await page.click('#pay');
    const out = await page.textContent('#out');
    assert.equal(out, '0x1111111111111111111111111111111111111111');
    await context.close();
  } finally {
    await browser.close();
    srv.close();
  }
});

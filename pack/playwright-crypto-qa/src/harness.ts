import type { Page } from 'playwright';

export interface ViewportSpec {
  name: string;
  width: number;
  height: number;
}

export const DEFAULT_QA_VIEWPORTS: ViewportSpec[] = [
  { name: 'desktop', width: 1440, height: 900 },
  { name: 'mobile', width: 375, height: 812 }
];

export interface MockEthereumConfig {
  address: string;
  initialChainId?: string;
  targetChainId?: string;
  txHashToReturn: string;
  signatureToReturn: string;
}

export async function injectMockEthereum(
  page: Page,
  config: MockEthereumConfig
): Promise<void> {
  await page.addInitScript((cfg) => {
    let currentChain = cfg.initialChainId ?? '0x1';
    (window as unknown as Record<string, unknown>).__mockWalletCalls = [];
    (window as unknown as Record<string, unknown>).ethereum = {
      isMetaMask: true,
      request: async ({ method, params }: { method: string; params?: unknown[] }) => {
        (window as unknown as { __mockWalletCalls: Array<{ method: string; params?: unknown[] }> }).__mockWalletCalls.push({
          method,
          params
        });
        if (method === 'eth_requestAccounts' || method === 'eth_accounts') {
          return [cfg.address];
        }
        if (method === 'eth_chainId') {
          return currentChain;
        }
        if (method === 'wallet_switchEthereumChain') {
          const target = (params?.[0] as { chainId?: string } | undefined)?.chainId;
          currentChain = target ?? cfg.targetChainId ?? '0x2105';
          return null;
        }
        if (method === 'eth_sendTransaction') {
          return cfg.txHashToReturn;
        }
        if (method === 'personal_sign') {
          return cfg.signatureToReturn;
        }
        throw new Error(`Unsupported mock wallet method: ${method}`);
      }
    };
  }, config);
}

export async function assertResponsiveAndCleanConsole(
  page: Page,
  url: string,
  viewports: ViewportSpec[] = DEFAULT_QA_VIEWPORTS
): Promise<{ consoleErrors: string[]; pageErrors: string[] }> {
  const consoleErrors: string[] = [];
  const pageErrors: string[] = [];

  page.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push(msg.text());
  });
  page.on('pageerror', (err) => {
    pageErrors.push(err.message);
  });

  for (const vp of viewports) {
    await page.setViewportSize({ width: vp.width, height: vp.height });
    const res = await page.goto(url, { waitUntil: 'networkidle' });
    if (!res || !res.ok()) {
      throw new Error(`Failed to load ${url} at ${vp.name}: ${res?.status()}`);
    }
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth > window.innerWidth
    );
    if (overflow) {
      throw new Error(`Horizontal overflow detected at ${vp.name} (${vp.width}px)`);
    }
  }

  if (consoleErrors.length > 0 || pageErrors.length > 0) {
    throw new Error(
      `Browser errors detected: console=${JSON.stringify(consoleErrors)} page=${JSON.stringify(pageErrors)}`
    );
  }

  return { consoleErrors, pageErrors };
}

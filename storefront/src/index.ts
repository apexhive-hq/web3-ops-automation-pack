import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { verifyMessage } from 'viem';

export interface Env {
  ASSETS: Fetcher;
  LICENSES_KV: KVNamespace;
  GLOBAL_CLAIMED_TX_KV?: KVNamespace;
  BRAND_NAME: string;
  PRODUCT_ID: string;
  PACK_VERSION: string;
  PAY_TO_EVM_ADDRESS: string;
  BASE_USDC_CONTRACT: string;
  BASE_CHAIN_ID: string;
  BASE_RPC_URLS?: string;
  BASE_RPC_URL?: string;
  SUPPORTER_PRICE_USDC_ATOMIC: string;
  TEAM_PRICE_USDC_ATOMIC: string;
  MIN_CONFIRMATIONS: string;
  SOLANA_RECEIVE_ADDRESS: string;
  BTC_RECEIVE_ADDRESS: string;
  TRON_RECEIVE_ADDRESS: string;
  PUBLIC_GITHUB_REPO_URL?: string;
  GITHUB_RELEASE_ASSET_URL: string;
  GITHUB_RELEASE_TOKEN?: string;
  DOWNLOAD_HMAC_SECRET?: string;
  ASSET_SHA256?: string;
  LICENSE_SIGNING_PRIVATE_JWK?: string;
  LICENSE_SIGNING_PUBLIC_SPKI_B64?: string;
}

type Tier = 'supporter' | 'team';

const ERC20_TRANSFER_TOPIC =
  '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const TX_HASH_RE = /^0x[0-9a-fA-F]{64}$/;
const HEX_VALUE_RE = /^0x[0-9a-fA-F]+$/;
const CHALLENGE_TTL_SECONDS = 300;
const DOWNLOAD_TTL_SECONDS = 3600;
const MAX_DOWNLOADS_PER_TOKEN = 3;
const TOKEN_PREFIX = 'APEXHIVE-PACK-v1.';
const GLOBAL_SCOPE = 'storefront:web3ops';
const DEFAULT_BASE_RPCS = [
  'https://mainnet.base.org',
  'https://base-rpc.publicnode.com',
  'https://1rpc.io/base'
];

interface ChallengeRecord {
  nonce: string;
  txHash: string;
  tier: Tier;
  ts: number;
  message: string;
}

interface UsedTxRecord {
  scope?: string;
  payer: string;
  tier: Tier;
  claimedAt: number;
}

interface DownloadRecord {
  txHash: string;
  tier: Tier;
  downloadsRemaining: number;
}

interface RpcLog {
  address: string;
  topics: string[];
  data: string;
}

interface RpcReceipt {
  status: string;
  blockNumber: string;
  logs: RpcLog[];
}

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function randomHex(byteCount = 16): string {
  const bytes = new Uint8Array(byteCount);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

function timingSafeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length || a.length === 0) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

function normalizeAddressFromTopic(topic: string): string {
  return `0x${topic.slice(-40).toLowerCase()}`;
}

function parseTier(raw: unknown): Tier | null {
  if (raw === 'supporter' || raw === 'team') return raw;
  return null;
}

function getTierPriceAtomic(env: Env, tier: Tier): bigint {
  const raw = tier === 'team' ? env.TEAM_PRICE_USDC_ATOMIC : env.SUPPORTER_PRICE_USDC_ATOMIC;
  return BigInt(raw || (tier === 'team' ? '49000000' : '5000000'));
}

function getRpcUrls(env: Env): string[] {
  const raw = env.BASE_RPC_URLS || env.BASE_RPC_URL || '';
  const list = raw
    .split(',')
    .map((u) => u.trim())
    .filter(Boolean);
  return list.length > 0 ? list : DEFAULT_BASE_RPCS;
}

function requireDownloadHmacSecret(env: Env): string | null {
  const secret = (env.DOWNLOAD_HMAC_SECRET ?? '').trim();
  return secret.length >= 16 ? secret : null;
}

function buildChallengeMessage(params: {
  brand: string;
  product: string;
  tier: Tier;
  txHash: string;
  nonce: string;
  ts: number;
}): string {
  return [
    `${params.brand} Digital Pack Ownership Proof`,
    `product=${params.product}`,
    `tier=${params.tier}`,
    `tx=${params.txHash.toLowerCase()}`,
    `nonce=${params.nonce}`,
    `ts=${params.ts}`
  ].join('\n');
}

async function rpcCallWithFailover<T>(
  rpcUrls: string[],
  method: string,
  params: unknown[]
): Promise<{ result: T; rpcUrl: string }> {
  const errors: string[] = [];
  for (const rpcUrl of rpcUrls) {
    try {
      const res = await fetch(rpcUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params })
      });
      if (!res.ok) {
        errors.push(`${rpcUrl}: HTTP ${res.status}`);
        continue;
      }
      const json = (await res.json()) as { result?: T; error?: { message?: string } };
      if (json.error) {
        errors.push(`${rpcUrl}: ${json.error.message ?? 'RPC error'}`);
        continue;
      }
      return { result: json.result as T, rpcUrl };
    } catch (err) {
      errors.push(`${rpcUrl}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  throw new Error(`All Base RPC endpoints failed (${errors.join('; ')})`);
}

async function hmacSignHex(secret: string, input: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(input));
  return Array.from(new Uint8Array(sig), (b) => b.toString(16).padStart(2, '0')).join('');
}

async function signLicenseToken(
  env: Env,
  payload: {
    v: 1;
    product: string;
    tier: Tier;
    payer: string;
    txHash: string;
    issuedAt: number;
  }
): Promise<string> {
  if (!env.LICENSE_SIGNING_PRIVATE_JWK) {
    throw new Error('Server missing LICENSE_SIGNING_PRIVATE_JWK');
  }
  const jwk = JSON.parse(env.LICENSE_SIGNING_PRIVATE_JWK) as JsonWebKey;
  const key = await crypto.subtle.importKey(
    'jwk',
    jwk,
    { name: 'Ed25519' },
    false,
    ['sign']
  );
  const payloadB64Url = base64UrlEncode(new TextEncoder().encode(JSON.stringify(payload)));
  const signingInput = new TextEncoder().encode(`${TOKEN_PREFIX}${payloadB64Url}`);
  const sigBuf = await crypto.subtle.sign('Ed25519', key, signingInput);
  return `${TOKEN_PREFIX}${payloadB64Url}.${base64UrlEncode(new Uint8Array(sigBuf))}`;
}

const app = new Hono<{ Bindings: Env }>();

app.use(
  '*',
  cors({
    origin: '*',
    allowMethods: ['GET', 'POST', 'OPTIONS'],
    allowHeaders: [
      'Content-Type',
      'X-Payment',
      'X-Payment-Signature',
      'X-Payment-Address',
      'X-ApexHive-License'
    ]
  })
);

app.use('/api/*', async (c, next) => {
  await next();
  const ct = c.res.headers.get('Content-Type') ?? '';
  if (ct.includes('application/json') && !ct.toLowerCase().includes('charset=')) {
    c.res.headers.set('Content-Type', 'application/json; charset=utf-8');
  }
});

app.get('/api/health', (c) => {
  return c.json({
    ok: true,
    service: 'web3-ops-automation-pack-store',
    brand: c.env.BRAND_NAME,
    version: c.env.PACK_VERSION,
    chainId: Number(c.env.BASE_CHAIN_ID || '8453'),
    kvBound: Boolean(c.env.LICENSES_KV),
    globalKvBound: Boolean(c.env.GLOBAL_CLAIMED_TX_KV)
  });
});

app.get('/api/config', (c) => {
  return c.json({
    brand: c.env.BRAND_NAME,
    product: c.env.PRODUCT_ID,
    version: c.env.PACK_VERSION,
    chainId: Number(c.env.BASE_CHAIN_ID || '8453'),
    network: 'Base Mainnet',
    usdcContract: c.env.BASE_USDC_CONTRACT,
    payToAddress: c.env.PAY_TO_EVM_ADDRESS,
    minConfirmations: Number(c.env.MIN_CONFIRMATIONS || '2'),
    supportEmail: 'apexhive.hq@proton.me',
    selfCustodyWarning:
      'Send Base USDC ONLY from a self-custody wallet (MetaMask, Rabby, Coinbase Wallet). Do NOT send from a centralized exchange (CEX) withdrawal.',
    tiers: {
      openCore: {
        label: 'Open-Source Core (MIT Forever)',
        usdc: '0',
        atomic: '0',
        repoUrl:
          c.env.PUBLIC_GITHUB_REPO_URL ||
          'https://github.com/apexhive-hq/web3-ops-automation-pack'
      },
      supporter: {
        label: 'Supporter Sponsor (Optional Base USDC)',
        usdc: '5',
        atomic: c.env.SUPPORTER_PRICE_USDC_ATOMIC || '5000000'
      },
      team: {
        label: 'Team Commercial Ops (5-seat + priority receipt)',
        usdc: '49',
        atomic: c.env.TEAM_PRICE_USDC_ATOMIC || '49000000'
      }
    },
    optionalRails: {
      solanaUsdc: c.env.SOLANA_RECEIVE_ADDRESS,
      bitcoin: c.env.BTC_RECEIVE_ADDRESS,
      tronTrxUsdt: c.env.TRON_RECEIVE_ADDRESS
    }
  });
});

app.post('/api/challenge', async (c) => {
  let body: { txHash?: string; tier?: string };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400);
  }
  const txHash = (body.txHash ?? '').trim();
  const tier = parseTier(body.tier);
  if (!tier) {
    return c.json({ code: 'INVALID_TIER', error: 'tier must be "supporter" or "team".' }, 400);
  }
  if (!TX_HASH_RE.test(txHash)) {
    return c.json({ error: 'Invalid Base transaction hash (0x + 64 hex chars required).' }, 400);
  }

  const nonce = randomHex(16);
  const ts = Math.floor(Date.now() / 1000);
  const message = buildChallengeMessage({
    brand: c.env.BRAND_NAME || 'ApexHive Labs',
    product: c.env.PRODUCT_ID || 'web3-ops-automation-pack',
    tier,
    txHash,
    nonce,
    ts
  });

  const record: ChallengeRecord = { nonce, txHash: txHash.toLowerCase(), tier, ts, message };
  await c.env.LICENSES_KV.put(`challenge:${nonce}`, JSON.stringify(record), {
    expirationTtl: CHALLENGE_TTL_SECONDS
  });

  return c.json({ nonce, ts, ttlSeconds: CHALLENGE_TTL_SECONDS, message });
});

app.post('/api/verify', async (c) => {
  const hmacSecret = requireDownloadHmacSecret(c.env);
  if (!hmacSecret) {
    return c.json({ error: 'Server missing DOWNLOAD_HMAC_SECRET configuration.' }, 500);
  }
  if (!c.env.LICENSE_SIGNING_PRIVATE_JWK) {
    return c.json({ error: 'Server missing LICENSE_SIGNING_PRIVATE_JWK configuration.' }, 500);
  }

  let body: { txHash?: string; tier?: string; nonce?: string; signature?: string };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400);
  }

  const tier = parseTier(body.tier);
  if (!tier) {
    return c.json({ code: 'INVALID_TIER', error: 'tier must be "supporter" or "team".' }, 400);
  }

  const txHash = (body.txHash ?? '').trim().toLowerCase();
  const nonce = (body.nonce ?? '').trim();
  const signature = (body.signature ?? '').trim();

  if (!TX_HASH_RE.test(txHash) || !nonce || !signature.startsWith('0x')) {
    return c.json({ error: 'Missing or malformed txHash, nonce, or EIP-191 signature.' }, 400);
  }

  const rawChallenge = await c.env.LICENSES_KV.get(`challenge:${nonce}`);
  if (!rawChallenge) {
    return c.json({ error: 'Challenge expired or unknown. Generate a fresh challenge.' }, 403);
  }
  const challenge = JSON.parse(rawChallenge) as ChallengeRecord;
  if (challenge.txHash !== txHash || challenge.tier !== tier) {
    return c.json({ error: 'Challenge mismatch for txHash or tier.' }, 403);
  }
  if (Math.floor(Date.now() / 1000) - challenge.ts > CHALLENGE_TTL_SECONDS) {
    return c.json({ error: 'Challenge expired (5 min limit).' }, 403);
  }

  const rpcUrls = getRpcUrls(c.env);
  let receipt: RpcReceipt | null;
  let activeRpcUrl: string;
  let latestBlockHex: string;
  try {
    const receiptRes = await rpcCallWithFailover<RpcReceipt | null>(
      rpcUrls,
      'eth_getTransactionReceipt',
      [txHash]
    );
    receipt = receiptRes.result;
    activeRpcUrl = receiptRes.rpcUrl;
    const orderedRpcs = [activeRpcUrl, ...rpcUrls.filter((u) => u !== activeRpcUrl)];
    const blockRes = await rpcCallWithFailover<string>(orderedRpcs, 'eth_blockNumber', []);
    latestBlockHex = blockRes.result;
  } catch (err) {
    return c.json(
      { error: err instanceof Error ? err.message : 'Base RPC unavailable.' },
      502
    );
  }

  if (!receipt || receipt.status !== '0x1') {
    return c.json({ error: 'Transaction not found or reverted on-chain.' }, 403);
  }

  if (!HEX_VALUE_RE.test(latestBlockHex ?? '') || !HEX_VALUE_RE.test(receipt.blockNumber ?? '')) {
    return c.json({ error: 'Malformed block number in RPC response.' }, 502);
  }

  const headBlock = BigInt(latestBlockHex);
  const txBlock = BigInt(receipt.blockNumber);
  const minConf = BigInt(c.env.MIN_CONFIRMATIONS || '2');
  const confirmations = headBlock >= txBlock ? headBlock - txBlock + 1n : 0n;
  if (confirmations < minConf) {
    // Keep challenge:${nonce} in KV so buyer can retry with the same nonce & signature
    return c.json(
      {
        code: 'INSUFFICIENT_CONFIRMATIONS',
        error: `Waiting for confirmations (${confirmations}/${minConf}). Retry in a few seconds.`
      },
      403
    );
  }

  const targetToken = (c.env.BASE_USDC_CONTRACT || '').toLowerCase();
  const targetPayTo = (c.env.PAY_TO_EVM_ADDRESS || '').toLowerCase();
  const expectedAtomic = getTierPriceAtomic(c.env, tier);

  const payerTotals = new Map<string, bigint>();
  for (const log of receipt.logs ?? []) {
    if ((log.address ?? '').toLowerCase() !== targetToken) continue;
    if (!log.topics || log.topics.length < 3) continue;
    if (log.topics[0].toLowerCase() !== ERC20_TRANSFER_TOPIC) continue;
    if (!log.data || !HEX_VALUE_RE.test(log.data)) continue;
    const toAddr = normalizeAddressFromTopic(log.topics[2]);
    if (toAddr !== targetPayTo) continue;
    const fromAddr = normalizeAddressFromTopic(log.topics[1]);
    const amountAtomic = BigInt(log.data);
    payerTotals.set(fromAddr, (payerTotals.get(fromAddr) ?? 0n) + amountAtomic);
  }

  const qualifyingSenders = [...payerTotals.entries()]
    .filter(([, total]) => total >= expectedAtomic)
    .map(([addr]) => addr);

  if (qualifyingSenders.length === 0) {
    return c.json(
      { error: 'No qualifying Base USDC Transfer to the store address found in receipt.' },
      403
    );
  }

  let matchedPayer: string | null = null;
  for (const sender of qualifyingSenders) {
    try {
      const ok = await verifyMessage({
        address: sender as `0x${string}`,
        message: challenge.message,
        signature: signature as `0x${string}`
      });
      if (ok) {
        matchedPayer = sender;
        break;
      }
    } catch {
      // continue checking remaining qualifying senders
    }
  }

  if (!matchedPayer) {
    return c.json({ error: 'EIP-191 signature does not match the USDC sender wallet.' }, 403);
  }

  const globalKey = `global_tx:${txHash}`;
  const rawGlobal = c.env.GLOBAL_CLAIMED_TX_KV
    ? await c.env.GLOBAL_CLAIMED_TX_KV.get(globalKey)
    : null;
  if (rawGlobal) {
    const existingGlobal = JSON.parse(rawGlobal) as UsedTxRecord;
    if (existingGlobal.scope && existingGlobal.scope !== GLOBAL_SCOPE) {
      return c.json(
        {
          code: 'TX_ALREADY_CLAIMED_ELSEWHERE',
          error: 'Transaction hash has already been claimed on another product or endpoint.'
        },
        403
      );
    }
    if (existingGlobal.payer !== matchedPayer || existingGlobal.tier !== tier) {
      return c.json(
        { code: 'TX_ALREADY_CLAIMED', error: 'Transaction hash has already been claimed.' },
        403
      );
    }
  }

  const replayKey = `used_tx:${txHash}`;
  const rawExisting = await c.env.LICENSES_KV.get(replayKey);
  let reclaimed = false;
  if (rawExisting || rawGlobal) {
    const existing = JSON.parse((rawExisting ?? rawGlobal)!) as UsedTxRecord;
    if (existing.payer !== matchedPayer || existing.tier !== tier) {
      return c.json(
        { code: 'TX_ALREADY_CLAIMED', error: 'Transaction hash has already been claimed.' },
        403
      );
    }
    reclaimed = true;
  } else {
    const claimRecord: UsedTxRecord = {
      scope: GLOBAL_SCOPE,
      payer: matchedPayer,
      tier,
      claimedAt: Date.now()
    };
    const serialized = JSON.stringify(claimRecord);
    await c.env.LICENSES_KV.put(replayKey, serialized);
    if (c.env.GLOBAL_CLAIMED_TX_KV) {
      await c.env.GLOBAL_CLAIMED_TX_KV.put(globalKey, serialized);
    }
  }

  await c.env.LICENSES_KV.delete(`challenge:${nonce}`);

  const dlId = randomHex(16);
  const dlMac = await hmacSignHex(hmacSecret, dlId);
  const downloadToken = `${dlId}.${dlMac}`;
  const dlRecord: DownloadRecord = {
    txHash,
    tier,
    downloadsRemaining: MAX_DOWNLOADS_PER_TOKEN
  };
  await c.env.LICENSES_KV.put(`dl:${dlId}`, JSON.stringify(dlRecord), {
    expirationTtl: DOWNLOAD_TTL_SECONDS
  });

  const licenseToken = await signLicenseToken(c.env, {
    v: 1,
    product: c.env.PRODUCT_ID || 'web3-ops-automation-pack',
    tier,
    payer: matchedPayer,
    txHash,
    issuedAt: Math.floor(Date.now() / 1000)
  });

  return c.json({
    ok: true,
    reclaimed,
    tier,
    payer: matchedPayer,
    releaseUrl:
      c.env.GITHUB_RELEASE_ASSET_URL ||
      'https://github.com/apexhive-hq/web3-ops-automation-pack/releases/latest',
    downloadUrl: `/api/download?token=${encodeURIComponent(downloadToken)}`,
    downloadTtlSeconds: DOWNLOAD_TTL_SECONDS,
    maxDownloads: MAX_DOWNLOADS_PER_TOKEN,
    assetSha256: c.env.ASSET_SHA256 || null,
    licenseToken
  });
});

app.get('/api/download', async (c) => {
  const hmacSecret = requireDownloadHmacSecret(c.env);
  if (!hmacSecret) {
    return c.json({ error: 'Server missing DOWNLOAD_HMAC_SECRET configuration.' }, 500);
  }

  const token = (c.req.query('token') ?? '').trim();
  const parts = token.split('.');
  if (parts.length !== 2) {
    return c.json({ error: 'Missing or invalid download token.' }, 403);
  }
  const [dlId, dlMac] = parts;
  if (!/^[0-9a-f]{32}$/.test(dlId) || !/^[0-9a-f]{64}$/.test(dlMac)) {
    return c.json({ error: 'Malformed download token.' }, 403);
  }

  // Verify HMAC BEFORE hitting LICENSES_KV
  const expectedMac = await hmacSignHex(hmacSecret, dlId);
  if (!timingSafeEqualHex(dlMac, expectedMac)) {
    return c.json({ error: 'Invalid download token signature.' }, 403);
  }

  const rawRecord = await c.env.LICENSES_KV.get(`dl:${dlId}`);
  if (!rawRecord) {
    return c.json({ error: 'Download token expired or not found.' }, 403);
  }
  const record = JSON.parse(rawRecord) as DownloadRecord;
  if (record.downloadsRemaining <= 0) {
    return c.json({ error: 'Download limit reached for this token.' }, 403);
  }

  record.downloadsRemaining -= 1;
  await c.env.LICENSES_KV.put(`dl:${dlId}`, JSON.stringify(record), {
    expirationTtl: DOWNLOAD_TTL_SECONDS
  });

  const releaseUrl = c.env.GITHUB_RELEASE_ASSET_URL;
  const headers: Record<string, string> = {
    Accept: 'application/octet-stream',
    'User-Agent': 'ApexHive-Storefront/1.0'
  };
  if (c.env.GITHUB_RELEASE_TOKEN) {
    headers.Authorization = `Bearer ${c.env.GITHUB_RELEASE_TOKEN}`;
  }

  const upstream = await fetch(releaseUrl, { headers });
  if (!upstream.ok || !upstream.body) {
    return c.json({ error: `Upstream release fetch failed (${upstream.status}).` }, 502);
  }

  const outHeaders = new Headers();
  outHeaders.set('Content-Type', 'application/zip');
  outHeaders.set(
    'Content-Disposition',
    `attachment; filename="web3-ops-automation-pack-v${c.env.PACK_VERSION || '1.0.0'}.zip"`
  );
  if (c.env.ASSET_SHA256) {
    outHeaders.set('X-Asset-Sha256', c.env.ASSET_SHA256);
  }
  return new Response(upstream.body, { status: 200, headers: outHeaders });
});

app.all('*', async (c) => {
  const res = await c.env.ASSETS.fetch(c.req.raw);
  const ct = res.headers.get('Content-Type') ?? '';
  if (ct.includes('text/html') && !ct.toLowerCase().includes('charset=')) {
    const out = new Response(res.body, res);
    out.headers.set('Content-Type', 'text/html; charset=utf-8');
    return out;
  }
  return res;
});

export default app;

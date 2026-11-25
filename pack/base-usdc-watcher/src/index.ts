import { createHash } from 'node:crypto';

export const BASE_MAINNET_USDC = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
export const ERC20_TRANSFER_TOPIC =
  '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';

export interface RpcLog {
  address: string;
  topics: string[];
  data: string;
  logIndex?: string;
}

export interface RpcReceipt {
  status: string;
  blockNumber: string;
  transactionHash?: string;
  logs: RpcLog[];
}

export interface WatchBaseUsdcOptions {
  txHash: string;
  expectedRecipient: string;
  minAmountAtomic: bigint;
  rpcUrls: string[];
  usdcContract?: string;
  minConfirmations?: number;
  fetchImpl?: typeof fetch;
}

export interface BaseUsdcMatch {
  ok: true;
  txHash: string;
  rpcUrl: string;
  from: string;
  to: string;
  amountAtomic: bigint;
  confirmations: number;
  blockNumber: number;
}

function normalizeAddress(addr: string): string {
  const clean = addr.trim().toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(clean)) {
    throw new Error(`Invalid EVM address: ${addr}`);
  }
  return clean;
}

function addressFromTopic(topic: string): string {
  return `0x${topic.slice(-40).toLowerCase()}`;
}

export async function rpcCallWithFailover<T>(
  rpcUrls: string[],
  method: string,
  params: unknown[],
  fetchImpl: typeof fetch = fetch
): Promise<{ result: T; rpcUrl: string }> {
  if (rpcUrls.length === 0) {
    throw new Error('At least one RPC URL is required');
  }
  const errors: string[] = [];
  for (const rpcUrl of rpcUrls) {
    try {
      const res = await fetchImpl(rpcUrl, {
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
  throw new Error(`All RPC endpoints failed (${errors.join('; ')})`);
}

export function findMatchingBaseUsdcTransfer(
  receipt: RpcReceipt,
  expectedRecipient: string,
  minAmountAtomic: bigint,
  usdcContract: string = BASE_MAINNET_USDC
): { from: string; to: string; amountAtomic: bigint } | null {
  if (receipt.status !== '0x1') {
    return null;
  }
  const targetRecipient = normalizeAddress(expectedRecipient);
  const targetToken = normalizeAddress(usdcContract);

  for (const log of receipt.logs ?? []) {
    if ((log.address ?? '').toLowerCase() !== targetToken) continue;
    if (!log.topics || log.topics.length < 3) continue;
    if (log.topics[0].toLowerCase() !== ERC20_TRANSFER_TOPIC) continue;

    const from = addressFromTopic(log.topics[1]);
    const to = addressFromTopic(log.topics[2]);
    if (to !== targetRecipient) continue;

    const amountAtomic = BigInt(log.data || '0x0');
    if (amountAtomic >= minAmountAtomic) {
      return { from, to, amountAtomic };
    }
  }
  return null;
}

export async function verifyBaseUsdcPayment(
  options: WatchBaseUsdcOptions
): Promise<BaseUsdcMatch> {
  const txHash = options.txHash.trim().toLowerCase();
  if (!/^0x[0-9a-f]{64}$/.test(txHash)) {
    throw new Error('Invalid txHash format');
  }
  const fetchImpl = options.fetchImpl ?? fetch;
  const minConfirmations = options.minConfirmations ?? 2;

  const { result: receipt, rpcUrl } = await rpcCallWithFailover<RpcReceipt | null>(
    options.rpcUrls,
    'eth_getTransactionReceipt',
    [txHash],
    fetchImpl
  );
  if (!receipt) {
    throw new Error('Transaction receipt not found yet');
  }
  if (receipt.status !== '0x1') {
    throw new Error('Transaction reverted on-chain');
  }

  const { result: latestHex } = await rpcCallWithFailover<string>(
    [rpcUrl, ...options.rpcUrls.filter((u) => u !== rpcUrl)],
    'eth_blockNumber',
    [],
    fetchImpl
  );

  const txBlock = parseInt(receipt.blockNumber, 16);
  const latestBlock = parseInt(latestHex, 16);
  const confirmations = Math.max(0, latestBlock - txBlock + 1);
  if (confirmations < minConfirmations) {
    throw new Error(`Insufficient confirmations: ${confirmations} < ${minConfirmations}`);
  }

  const match = findMatchingBaseUsdcTransfer(
    receipt,
    options.expectedRecipient,
    options.minAmountAtomic,
    options.usdcContract ?? BASE_MAINNET_USDC
  );
  if (!match) {
    throw new Error('No matching Base USDC Transfer log found');
  }

  return {
    ok: true,
    txHash,
    rpcUrl,
    from: match.from,
    to: match.to,
    amountAtomic: match.amountAtomic,
    confirmations,
    blockNumber: txBlock
  };
}

export function computeReplayKey(chainId: number, txHash: string): string {
  return createHash('sha256')
    .update(`${chainId}:${txHash.trim().toLowerCase()}`)
    .digest('hex');
}

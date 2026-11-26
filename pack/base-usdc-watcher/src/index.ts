import { createHash } from 'node:crypto';

export const BASE_MAINNET_USDC = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
export const ERC20_TRANSFER_TOPIC =
  '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
export const DEFAULT_RPC_TIMEOUT_MS = 10_000;

const HEX_QUANTITY_RE = /^0x[0-9a-fA-F]+$/;
const TOPIC_WORD_RE = /^0x[0-9a-fA-F]{64}$/;

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
  expectedSender?: string;
  minConfirmations?: number;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

export interface BaseUsdcTransferDetail {
  from: string;
  amountAtomic: bigint;
}

export interface BaseUsdcMatch {
  ok: true;
  txHash: string;
  rpcUrl: string;
  from: string | null;
  senders: string[];
  transfers: BaseUsdcTransferDetail[];
  to: string;
  amountAtomic: bigint;
  confirmations: number;
  blockNumber: number;
}

export interface RpcFailoverOptions<T> {
  timeoutMs?: number;
  acceptResult?: (result: T) => boolean;
}

function normalizeAddress(addr: string): string {
  if (typeof addr !== 'string' || addr.trim().length === 0) {
    throw new Error('Expected non-empty EVM address');
  }
  const clean = addr.trim().toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(clean)) {
    throw new Error(`Invalid EVM address: ${addr}`);
  }
  return clean;
}

export function requireNonEmptyRecipient(addr: string): string {
  if (typeof addr !== 'string' || addr.trim().length === 0) {
    throw new Error('Expected non-empty EVM recipient address');
  }
  return normalizeAddress(addr);
}

export function parseStrictHexBigInt(value: unknown, label: string): bigint {
  if (typeof value !== 'string') {
    throw new Error(`Invalid ${label}: expected hex string, got ${typeof value}`);
  }
  const trimmed = value.trim();
  if (!HEX_QUANTITY_RE.test(trimmed)) {
    throw new Error(`Invalid ${label} hex quantity: ${value}`);
  }
  return BigInt(trimmed);
}

function addressFromTopic(topic: string): string {
  return `0x${topic.slice(-40).toLowerCase()}`;
}

export async function rpcCallWithFailover<T>(
  rpcUrls: string[],
  method: string,
  params: unknown[],
  fetchImpl: typeof fetch = fetch,
  options: RpcFailoverOptions<T> = {}
): Promise<{ result: T; rpcUrl: string }> {
  if (!Array.isArray(rpcUrls) || rpcUrls.length === 0) {
    throw new Error('At least one RPC URL is required');
  }
  const timeoutMs = options.timeoutMs ?? DEFAULT_RPC_TIMEOUT_MS;
  if (typeof timeoutMs !== 'number' || !Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error('timeoutMs must be a positive finite number');
  }

  const errors: string[] = [];
  for (const rpcUrl of rpcUrls) {
    if (typeof rpcUrl !== 'string' || rpcUrl.trim().length === 0) {
      errors.push('<empty>: invalid RPC URL');
      continue;
    }
    try {
      const res = await fetchImpl(rpcUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
        signal: AbortSignal.timeout(timeoutMs)
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
      const result = json.result as T;
      if (options.acceptResult && !options.acceptResult(result)) {
        errors.push(`${rpcUrl}: rejected empty or invalid result`);
        continue;
      }
      return { result, rpcUrl };
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
  usdcContract: string = BASE_MAINNET_USDC,
  expectedSender?: string
): {
  from: string | null;
  senders: string[];
  transfers: BaseUsdcTransferDetail[];
  to: string;
  amountAtomic: bigint;
  matchCount: number;
} | null {
  if (!receipt || typeof receipt.status !== 'string' || receipt.status.toLowerCase() !== '0x1') {
    return null;
  }
  if (typeof minAmountAtomic !== 'bigint' || minAmountAtomic <= 0n) {
    throw new Error('minAmountAtomic must be a positive bigint');
  }
  const targetRecipient = requireNonEmptyRecipient(expectedRecipient);
  const targetToken = normalizeAddress(usdcContract);
  const targetSender = expectedSender !== undefined ? normalizeAddress(expectedSender) : null;

  let totalAmountAtomic = 0n;
  const senderSet = new Set<string>();
  const transfers: BaseUsdcTransferDetail[] = [];

  for (const log of receipt.logs ?? []) {
    if (typeof log?.address !== 'string' || log.address.trim().toLowerCase() !== targetToken) {
      continue;
    }
    if (!Array.isArray(log.topics) || log.topics.length < 3) continue;
    if (typeof log.topics[0] !== 'string' || log.topics[0].toLowerCase() !== ERC20_TRANSFER_TOPIC) {
      continue;
    }
    if (
      typeof log.topics[1] !== 'string' ||
      typeof log.topics[2] !== 'string' ||
      !TOPIC_WORD_RE.test(log.topics[1]) ||
      !TOPIC_WORD_RE.test(log.topics[2])
    ) {
      throw new Error('Malformed ERC-20 Transfer topic in matching token log');
    }

    const from = addressFromTopic(log.topics[1]);
    const to = addressFromTopic(log.topics[2]);
    if (to !== targetRecipient) continue;
    if (targetSender !== null && from !== targetSender) continue;

    const amountAtomic = parseStrictHexBigInt(log.data, 'Transfer log data');
    totalAmountAtomic += amountAtomic;
    senderSet.add(from);
    transfers.push({ from, amountAtomic });
  }

  if (transfers.length === 0 || totalAmountAtomic < minAmountAtomic) {
    return null;
  }

  const senders = Array.from(senderSet);
  return {
    from: senders.length === 1 ? senders[0] : null,
    senders,
    transfers,
    to: targetRecipient,
    amountAtomic: totalAmountAtomic,
    matchCount: transfers.length
  };
}

export async function verifyBaseUsdcPayment(
  options: WatchBaseUsdcOptions
): Promise<BaseUsdcMatch> {
  const txHash = typeof options.txHash === 'string' ? options.txHash.trim().toLowerCase() : '';
  if (!/^0x[0-9a-f]{64}$/.test(txHash)) {
    throw new Error('Invalid txHash format');
  }
  const expectedRecipient = requireNonEmptyRecipient(options.expectedRecipient);
  const usdcContract = normalizeAddress(options.usdcContract ?? BASE_MAINNET_USDC);
  if (options.expectedSender !== undefined) {
    normalizeAddress(options.expectedSender);
  }
  if (typeof options.minAmountAtomic !== 'bigint' || options.minAmountAtomic <= 0n) {
    throw new Error('minAmountAtomic must be a positive bigint');
  }

  const minConfirmations = options.minConfirmations ?? 2;
  if (
    typeof minConfirmations !== 'number' ||
    !Number.isInteger(minConfirmations) ||
    minConfirmations < 1
  ) {
    throw new Error('minConfirmations must be a positive integer >= 1');
  }

  const timeoutMs = options.timeoutMs ?? DEFAULT_RPC_TIMEOUT_MS;
  const fetchImpl = options.fetchImpl ?? fetch;

  const { result: receipt, rpcUrl } = await rpcCallWithFailover<RpcReceipt | null>(
    options.rpcUrls,
    'eth_getTransactionReceipt',
    [txHash],
    fetchImpl,
    {
      timeoutMs,
      acceptResult: (r): r is RpcReceipt => r !== null && r !== undefined && typeof r === 'object'
    }
  );
  if (!receipt) {
    throw new Error('Transaction receipt not found yet');
  }
  if (typeof receipt.status !== 'string' || receipt.status.toLowerCase() !== '0x1') {
    throw new Error('Transaction reverted on-chain');
  }

  const txBlock = parseStrictHexBigInt(receipt.blockNumber, 'receipt.blockNumber');

  const { result: latestHex } = await rpcCallWithFailover<string>(
    [rpcUrl, ...options.rpcUrls.filter((u) => u !== rpcUrl)],
    'eth_blockNumber',
    [],
    fetchImpl,
    {
      timeoutMs,
      acceptResult: (val) => typeof val === 'string' && HEX_QUANTITY_RE.test(val.trim())
    }
  );

  const latestBlock = parseStrictHexBigInt(latestHex, 'eth_blockNumber');
  if (latestBlock < txBlock) {
    throw new Error(
      `Insufficient confirmations: receipt block ${txBlock} ahead of latest block ${latestBlock}`
    );
  }
  const confirmations = latestBlock - txBlock + 1n;
  if (confirmations < BigInt(minConfirmations)) {
    throw new Error(`Insufficient confirmations: ${confirmations} < ${minConfirmations}`);
  }

  const match = findMatchingBaseUsdcTransfer(
    receipt,
    expectedRecipient,
    options.minAmountAtomic,
    usdcContract,
    options.expectedSender
  );
  if (!match) {
    throw new Error('No matching Base USDC Transfer log found');
  }

  return {
    ok: true,
    txHash,
    rpcUrl,
    from: match.from,
    senders: match.senders,
    transfers: match.transfers,
    to: match.to,
    amountAtomic: match.amountAtomic,
    confirmations: Number(confirmations),
    blockNumber: Number(txBlock)
  };
}

export function computeReplayKey(chainId: number, txHash: string): string {
  return createHash('sha256')
    .update(`${chainId}:${txHash.trim().toLowerCase()}`)
    .digest('hex');
}

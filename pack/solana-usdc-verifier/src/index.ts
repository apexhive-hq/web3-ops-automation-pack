import { createHash } from 'node:crypto';

export const SOLANA_MAINNET_USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
export const SPL_TOKEN_PROGRAMS = new Set([
  'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
  'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb'
]);
export const DEFAULT_SOLANA_RPC_TIMEOUT_MS = 10_000;

const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const BASE58_MAP = new Map<string, number>(
  Array.from(BASE58_ALPHABET).map((ch, idx) => [ch, idx])
);
const BASE58_PUBKEY_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const BASE58_SIG_RE = /^[1-9A-HJ-NP-Za-km-z]{32,128}$/;
const STRICT_UINT_RE = /^\d+$/;

export type SolanaAccountKeyEntry =
  | string
  | { pubkey: string; signer?: boolean; writable?: boolean };

export interface SolanaInstruction {
  programIdIndex?: number;
  programId?: string;
  accounts?: Array<string | number>;
  data?: string;
}

export interface SolanaTokenBalance {
  accountIndex: number;
  mint: string;
  owner?: string;
  uiTokenAmount: {
    amount: string;
    decimals: number;
  };
}

export interface SolanaLoadedAddresses {
  writable?: SolanaAccountKeyEntry[];
  readonly?: SolanaAccountKeyEntry[];
}

export interface SolanaTransactionResult {
  slot: number;
  transaction: {
    message: {
      header?: {
        numRequiredSignatures?: number;
        numReadonlySignedAccounts?: number;
        numReadonlyUnsignedAccounts?: number;
      };
      accountKeys: SolanaAccountKeyEntry[];
      instructions?: SolanaInstruction[];
    };
  };
  meta: {
    err: unknown;
    loadedAddresses?: SolanaLoadedAddresses | null;
    innerInstructions?: Array<{ index?: number; instructions?: SolanaInstruction[] }>;
    preTokenBalances?: SolanaTokenBalance[];
    postTokenBalances?: SolanaTokenBalance[];
  } | null;
}

export interface VerifySolanaUsdcOptions {
  signature: string;
  expectedRecipientOwner: string;
  expectedReferenceKey: string;
  minAmountAtomic: bigint;
  rpcUrls: string[];
  usdcMint?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

export interface SolanaUsdcMatch {
  ok: true;
  signature: string;
  replayKey: string;
  rpcUrl: string;
  recipientOwner: string;
  referenceKey: string;
  amountAtomic: bigint;
  slot: number;
}

function requireSolanaPubkey(value: string, label: string): string {
  if (typeof value !== 'string' || !BASE58_PUBKEY_RE.test(value.trim())) {
    throw new Error(`Invalid Solana ${label} public key`);
  }
  return value.trim();
}

function parseStrictAtomicAmount(value: unknown, label: string): bigint {
  if (typeof value !== 'string' || !STRICT_UINT_RE.test(value)) {
    throw new Error(`Invalid ${label} atomic amount: ${String(value)}`);
  }
  return BigInt(value);
}

export function decodeBase58(input: string): Uint8Array {
  if (typeof input !== 'string' || input.length === 0) {
    throw new Error('Empty base58 string');
  }
  const bytes: number[] = [];
  for (const ch of input) {
    const val = BASE58_MAP.get(ch);
    if (val === undefined) {
      throw new Error(`Invalid base58 character: ${ch}`);
    }
    let carry = val;
    for (let i = 0; i < bytes.length; i++) {
      carry += bytes[i] * 58;
      bytes[i] = carry & 0xff;
      carry >>= 8;
    }
    while (carry > 0) {
      bytes.push(carry & 0xff);
      carry >>= 8;
    }
  }
  for (let i = 0; i < input.length && input[i] === '1'; i++) {
    bytes.push(0);
  }
  return Uint8Array.from(bytes.reverse());
}

export function encodeBase58(bytes: Uint8Array): string {
  if (bytes.length === 0) return '';
  const digits: number[] = [];
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
  for (let i = 0; i < bytes.length && bytes[i] === 0; i++) {
    out += '1';
  }
  for (let i = digits.length - 1; i >= 0; i--) {
    out += BASE58_ALPHABET[digits[i]];
  }
  return out;
}

function pushKeyEntries(out: string[], entries: unknown): void {
  if (!Array.isArray(entries)) return;
  for (const entry of entries) {
    if (typeof entry === 'string' && entry.length > 0) {
      out.push(entry);
    } else if (
      entry &&
      typeof entry === 'object' &&
      'pubkey' in entry &&
      typeof (entry as { pubkey?: unknown }).pubkey === 'string'
    ) {
      out.push((entry as { pubkey: string }).pubkey);
    }
  }
}

export function extractSolanaAccountKeys(tx: SolanaTransactionResult): string[] {
  const keys: string[] = [];
  pushKeyEntries(keys, tx.transaction?.message?.accountKeys);
  pushKeyEntries(keys, tx.meta?.loadedAddresses?.writable);
  pushKeyEntries(keys, tx.meta?.loadedAddresses?.readonly);
  return keys;
}

function isReferenceSigner(
  tx: SolanaTransactionResult,
  keys: string[],
  referenceKey: string
): boolean {
  const rawKeys = tx.transaction?.message?.accountKeys ?? [];
  const numSigners = tx.transaction?.message?.header?.numRequiredSignatures;
  if (typeof numSigners === 'number' && Number.isInteger(numSigners) && numSigners > 0) {
    for (let i = 0; i < Math.min(numSigners, rawKeys.length); i++) {
      if (keys[i] === referenceKey) return true;
    }
  }
  for (const entry of rawKeys) {
    if (entry && typeof entry === 'object' && entry.pubkey === referenceKey && entry.signer === true) {
      return true;
    }
  }
  return false;
}

function resolveAccountRef(ref: string | number, keys: string[]): string | null {
  if (typeof ref === 'number') {
    return Number.isInteger(ref) && ref >= 0 && ref < keys.length ? keys[ref] : null;
  }
  return typeof ref === 'string' && ref.length > 0 ? ref : null;
}

function readU64Le(bytes: Uint8Array, offset: number): bigint {
  let out = 0n;
  for (let i = 7; i >= 0; i--) {
    out = (out << 8n) | BigInt(bytes[offset + i]);
  }
  return out;
}

function decodeMatchedSplTransferAmount(
  ix: SolanaInstruction,
  keys: string[],
  referenceKey: string,
  usdcMint: string,
  validRecipientDestKeys: Set<string>
): bigint {
  const programId =
    typeof ix.programId === 'string'
      ? ix.programId
      : typeof ix.programIdIndex === 'number'
        ? resolveAccountRef(ix.programIdIndex, keys)
        : null;
  if (!programId || !SPL_TOKEN_PROGRAMS.has(programId)) {
    return 0n;
  }
  if (!Array.isArray(ix.accounts) || typeof ix.data !== 'string' || ix.data.length === 0) {
    return 0n;
  }

  let dataBytes: Uint8Array;
  try {
    dataBytes = decodeBase58(ix.data);
  } catch {
    return 0n;
  }

  const resolvedAccounts = ix.accounts.map((a) => resolveAccountRef(a, keys));
  if (resolvedAccounts.some((a) => a === null)) {
    return 0n;
  }

  // SPL Token Transfer (opcode 3, 9 bytes): [source, destination, authority, ...referenceKeys]
  if (dataBytes.length === 9 && dataBytes[0] === 3 && resolvedAccounts.length >= 4) {
    const dest = resolvedAccounts[1]!;
    if (!validRecipientDestKeys.has(dest) || !resolvedAccounts.slice(3).includes(referenceKey)) {
      return 0n;
    }
    const amt = readU64Le(dataBytes, 1);
    return amt > 0n ? amt : 0n;
  }

  // SPL Token TransferChecked (opcode 12, 10 bytes): [source, mint, destination, authority, ...referenceKeys]
  if (dataBytes.length === 10 && dataBytes[0] === 12 && resolvedAccounts.length >= 5) {
    const mintArg = resolvedAccounts[1]!;
    const dest = resolvedAccounts[2]!;
    if (
      mintArg !== usdcMint ||
      !validRecipientDestKeys.has(dest) ||
      !resolvedAccounts.slice(4).includes(referenceKey)
    ) {
      return 0n;
    }
    const amt = readU64Le(dataBytes, 1);
    return amt > 0n ? amt : 0n;
  }

  return 0n;
}

function sumMatchedReferenceTransferAmounts(
  tx: SolanaTransactionResult,
  keys: string[],
  referenceKey: string,
  usdcMint: string,
  validRecipientDestKeys: Set<string>
): bigint {
  if (validRecipientDestKeys.size === 0 || !keys.includes(referenceKey)) {
    return 0n;
  }
  if (isReferenceSigner(tx, keys, referenceKey)) {
    return 0n;
  }

  const topInstructions = tx.transaction?.message?.instructions;
  const innerGroups = tx.meta?.innerInstructions ?? [];
  const innerInstructions = Array.isArray(innerGroups)
    ? innerGroups.flatMap((g) => (Array.isArray(g?.instructions) ? g.instructions : []))
    : [];
  const allInstructions = [
    ...(Array.isArray(topInstructions) ? topInstructions : []),
    ...innerInstructions
  ];
  // Fail-closed: require explicit decoded SPL Transfer / TransferChecked instruction binding
  if (allInstructions.length === 0) {
    return 0n;
  }

  let totalMatched = 0n;
  for (const ix of allInstructions) {
    if (!ix || typeof ix !== 'object') continue;
    totalMatched += decodeMatchedSplTransferAmount(
      ix,
      keys,
      referenceKey,
      usdcMint,
      validRecipientDestKeys
    );
  }
  return totalMatched;
}

/** Transaction-signature-scoped replay key preventing cross-invoice double-spend across multiple references. */
export function computeSolanaReplayKey(signature: string): string {
  return createHash('sha256')
    .update(`solana:${signature.trim()}`)
    .digest('hex');
}

export function matchSolanaUsdcReferenceTransfer(
  tx: SolanaTransactionResult,
  expectedRecipientOwner: string,
  expectedReferenceKey: string,
  minAmountAtomic: bigint,
  usdcMint: string = SOLANA_MAINNET_USDC_MINT
): bigint | null {
  const recipientOwner = requireSolanaPubkey(expectedRecipientOwner, 'recipientOwner');
  const referenceKey = requireSolanaPubkey(expectedReferenceKey, 'referenceKey');
  const mint = requireSolanaPubkey(usdcMint, 'usdcMint');
  if (referenceKey === recipientOwner || referenceKey === mint) {
    throw new Error('expectedReferenceKey must be distinct from recipientOwner and usdcMint');
  }
  if (typeof minAmountAtomic !== 'bigint' || minAmountAtomic <= 0n) {
    throw new Error('minAmountAtomic must be a positive bigint');
  }

  if (!tx || !tx.meta || tx.meta.err !== null) {
    return null;
  }

  const keys = extractSolanaAccountKeys(tx);
  const validRecipientDestKeys = new Set<string>();

  const preMap = new Map<number, bigint>();
  for (const b of tx.meta.preTokenBalances ?? []) {
    if (b.mint === mint && b.owner === recipientOwner) {
      if (typeof b.accountIndex !== 'number' || !Number.isInteger(b.accountIndex)) {
        throw new Error('Invalid preTokenBalances accountIndex');
      }
      if (preMap.has(b.accountIndex)) {
        throw new Error(`Duplicate preTokenBalances entry for accountIndex ${b.accountIndex}`);
      }
      preMap.set(b.accountIndex, parseStrictAtomicAmount(b.uiTokenAmount?.amount, 'preTokenBalance'));
      const destKey = keys[b.accountIndex];
      if (destKey) validRecipientDestKeys.add(destKey);
    }
  }

  const postMap = new Map<number, bigint>();
  for (const b of tx.meta.postTokenBalances ?? []) {
    if (b.mint === mint && b.owner === recipientOwner) {
      if (typeof b.accountIndex !== 'number' || !Number.isInteger(b.accountIndex)) {
        throw new Error('Invalid postTokenBalances accountIndex');
      }
      if (postMap.has(b.accountIndex)) {
        throw new Error(`Duplicate postTokenBalances entry for accountIndex ${b.accountIndex}`);
      }
      postMap.set(b.accountIndex, parseStrictAtomicAmount(b.uiTokenAmount?.amount, 'postTokenBalance'));
      const destKey = keys[b.accountIndex];
      if (destKey) validRecipientDestKeys.add(destKey);
    }
  }

  const matchedInstructionTotal = sumMatchedReferenceTransferAmounts(
    tx,
    keys,
    referenceKey,
    mint,
    validRecipientDestKeys
  );
  if (matchedInstructionTotal < minAmountAtomic) {
    return null;
  }

  let preTotal = 0n;
  for (const amt of preMap.values()) {
    preTotal += amt;
  }
  let postTotal = 0n;
  for (const amt of postMap.values()) {
    postTotal += amt;
  }

  const netDelta = postTotal - preTotal;
  return netDelta >= minAmountAtomic ? netDelta : null;
}

export async function verifySolanaUsdcPayment(
  options: VerifySolanaUsdcOptions
): Promise<SolanaUsdcMatch> {
  const sig = typeof options.signature === 'string' ? options.signature.trim() : '';
  if (!BASE58_SIG_RE.test(sig)) {
    throw new Error('Invalid Solana transaction signature');
  }
  const recipientOwner = requireSolanaPubkey(options.expectedRecipientOwner, 'recipientOwner');
  const referenceKey = requireSolanaPubkey(options.expectedReferenceKey, 'referenceKey');
  const usdcMint = requireSolanaPubkey(options.usdcMint ?? SOLANA_MAINNET_USDC_MINT, 'usdcMint');
  if (referenceKey === recipientOwner || referenceKey === usdcMint) {
    throw new Error('expectedReferenceKey must be distinct from recipientOwner and usdcMint');
  }
  if (typeof options.minAmountAtomic !== 'bigint' || options.minAmountAtomic <= 0n) {
    throw new Error('minAmountAtomic must be a positive bigint');
  }
  if (!Array.isArray(options.rpcUrls) || options.rpcUrls.length === 0) {
    throw new Error('At least one Solana RPC URL is required');
  }

  const timeoutMs = options.timeoutMs ?? DEFAULT_SOLANA_RPC_TIMEOUT_MS;
  if (typeof timeoutMs !== 'number' || !Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error('timeoutMs must be a positive finite number');
  }

  const fetchImpl = options.fetchImpl ?? fetch;
  const errors: string[] = [];

  for (const rpcUrl of options.rpcUrls) {
    if (typeof rpcUrl !== 'string' || rpcUrl.trim().length === 0) {
      errors.push('<empty>: invalid RPC URL');
      continue;
    }

    let txResult: SolanaTransactionResult | null = null;
    try {
      const res = await fetchImpl(rpcUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'getTransaction',
          params: [
            sig,
            {
              encoding: 'json',
              commitment: 'finalized',
              maxSupportedTransactionVersion: 0
            }
          ]
        }),
        signal: AbortSignal.timeout(timeoutMs)
      });
      if (!res.ok) {
        errors.push(`${rpcUrl}: HTTP ${res.status}`);
        continue;
      }
      const json = (await res.json()) as {
        result?: SolanaTransactionResult | null;
        error?: { message?: string };
      };
      if (json.error) {
        errors.push(`${rpcUrl}: ${json.error.message ?? 'RPC error'}`);
        continue;
      }
      if (!json.result) {
        errors.push(`${rpcUrl}: transaction not found (null result)`);
        continue;
      }
      txResult = json.result;
    } catch (err) {
      errors.push(`${rpcUrl}: ${err instanceof Error ? err.message : String(err)}`);
      continue;
    }

    const amountAtomic = matchSolanaUsdcReferenceTransfer(
      txResult,
      recipientOwner,
      referenceKey,
      options.minAmountAtomic,
      usdcMint
    );
    if (amountAtomic === null) {
      throw new Error('Solana USDC reference transfer mismatch or failed tx');
    }

    return {
      ok: true,
      signature: sig,
      replayKey: computeSolanaReplayKey(sig),
      rpcUrl,
      recipientOwner,
      referenceKey,
      amountAtomic,
      slot: txResult.slot
    };
  }

  throw new Error(`All Solana RPC endpoints failed (${errors.join('; ')})`);
}

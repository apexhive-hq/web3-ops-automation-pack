export const SOLANA_MAINNET_USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

export interface SolanaTokenBalance {
  accountIndex: number;
  mint: string;
  owner?: string;
  uiTokenAmount: {
    amount: string;
    decimals: number;
  };
}

export interface SolanaTransactionResult {
  slot: number;
  transaction: {
    message: {
      accountKeys: Array<string | { pubkey: string }>;
    };
  };
  meta: {
    err: unknown;
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
  fetchImpl?: typeof fetch;
}

export interface SolanaUsdcMatch {
  ok: true;
  signature: string;
  rpcUrl: string;
  recipientOwner: string;
  referenceKey: string;
  amountAtomic: bigint;
  slot: number;
}

function extractAccountKeys(tx: SolanaTransactionResult): string[] {
  const rawKeys = tx.transaction?.message?.accountKeys ?? [];
  return rawKeys.map((k) => (typeof k === 'string' ? k : k.pubkey));
}

export function matchSolanaUsdcReferenceTransfer(
  tx: SolanaTransactionResult,
  expectedRecipientOwner: string,
  expectedReferenceKey: string,
  minAmountAtomic: bigint,
  usdcMint: string = SOLANA_MAINNET_USDC_MINT
): bigint | null {
  if (!tx.meta || tx.meta.err !== null) {
    return null;
  }

  const keys = extractAccountKeys(tx);
  if (!keys.includes(expectedReferenceKey)) {
    return null;
  }

  const preMap = new Map<number, bigint>();
  for (const b of tx.meta.preTokenBalances ?? []) {
    if (b.mint === usdcMint && b.owner === expectedRecipientOwner) {
      preMap.set(b.accountIndex, BigInt(b.uiTokenAmount.amount || '0'));
    }
  }

  let totalReceived = 0n;
  for (const b of tx.meta.postTokenBalances ?? []) {
    if (b.mint === usdcMint && b.owner === expectedRecipientOwner) {
      const postAmt = BigInt(b.uiTokenAmount.amount || '0');
      const preAmt = preMap.get(b.accountIndex) ?? 0n;
      if (postAmt > preAmt) {
        totalReceived += postAmt - preAmt;
      }
    }
  }

  return totalReceived >= minAmountAtomic ? totalReceived : null;
}

export async function verifySolanaUsdcPayment(
  options: VerifySolanaUsdcOptions
): Promise<SolanaUsdcMatch> {
  const sig = options.signature.trim();
  if (sig.length < 32) {
    throw new Error('Invalid Solana transaction signature');
  }
  const fetchImpl = options.fetchImpl ?? fetch;
  const errors: string[] = [];

  for (const rpcUrl of options.rpcUrls) {
    try {
      const res = await fetchImpl(rpcUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'getTransaction',
          params: [sig, { encoding: 'jsonParsed', maxSupportedTransactionVersion: 0 }]
        })
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
        throw new Error('Solana transaction not found');
      }

      const amountAtomic = matchSolanaUsdcReferenceTransfer(
        json.result,
        options.expectedRecipientOwner,
        options.expectedReferenceKey,
        options.minAmountAtomic,
        options.usdcMint ?? SOLANA_MAINNET_USDC_MINT
      );
      if (amountAtomic === null) {
        throw new Error('Solana USDC reference transfer mismatch or failed tx');
      }

      return {
        ok: true,
        signature: sig,
        rpcUrl,
        recipientOwner: options.expectedRecipientOwner,
        referenceKey: options.expectedReferenceKey,
        amountAtomic,
        slot: json.result.slot
      };
    } catch (err) {
      if (err instanceof Error && err.message.startsWith('Solana ')) {
        throw err;
      }
      errors.push(`${rpcUrl}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  throw new Error(`All Solana RPC endpoints failed (${errors.join('; ')})`);
}

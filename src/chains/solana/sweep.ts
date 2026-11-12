import {
  ComputeBudgetProgram, Connection, PACKET_DATA_SIZE, PublicKey, SystemProgram, Transaction,
  type TransactionInstruction,
} from '@solana/web3.js';
import {
  ACCOUNT_SIZE, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID, createAssociatedTokenAccountIdempotentInstruction,
  createCloseAccountInstruction, createTransferCheckedInstruction, getAccountLenForMint,
  getAssociatedTokenAddressSync, unpackMint,
} from '@solana/spl-token';

export type Holding = {
  account: PublicKey; mint: PublicKey; program: PublicKey;
  amount: bigint; decimals: number; lamports: number; frozen: boolean;
};

export type PlanInput = {
  owner: PublicKey; dest: PublicKey; balance: number; holdings: Holding[];
  ataRent: Map<string, number>; // dest ATA (base58) -> rent the owner pays to create it; absent = already exists
  priorityMicroLamports: number; keepLamports: number; blockhash: string;
};

export type Plan = { tokenTxs: Transaction[]; solTx: Transaction | null; solAmount: number; skipped: Holding[] };

const BASE_FEE = 5000; // lamports per signature; every tx here has exactly one signer
const CU_PER_TOKEN = 60_000; // create ATA + transferChecked + close, with headroom for Token-2022
const CU_SOL_TX = 1_000;

const fee = (cu: number, price: number) => BASE_FEE + Math.ceil((cu * price) / 1e6);

export async function loadHoldings(conn: Connection, owner: PublicKey): Promise<Holding[]> {
  const out: Holding[] = [];
  for (const program of [TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID]) {
    const { value } = await conn.getParsedTokenAccountsByOwner(owner, { programId: program });
    for (const { pubkey, account } of value) {
      const info = account.data.parsed.info;
      out.push({
        account: pubkey, mint: new PublicKey(info.mint), program, lamports: account.lamports,
        amount: BigInt(info.tokenAmount.amount), decimals: info.tokenAmount.decimals, frozen: info.state === 'frozen',
      });
    }
  }
  return out;
}

/** Which destination ATAs are missing, and the rent the owner must pay to create each. */
export async function loadAtaRent(conn: Connection, dest: PublicKey, holdings: Holding[]) {
  const atas = new Map<string, Holding>();
  for (const h of holdings) if (h.amount > 0n) atas.set(destAta(h, dest).toBase58(), h);
  const keys = [...atas.keys()];
  const rent = new Map<string, number>();
  for (let i = 0; i < keys.length; i += 100) {
    const chunk = keys.slice(i, i + 100);
    const infos = await conn.getMultipleAccountsInfo(chunk.map((k) => new PublicKey(k)));
    const missing = chunk.filter((_, j) => !infos[j]);
    const mints = missing.map((k) => atas.get(k)!);
    const mintInfos = await conn.getMultipleAccountsInfo(mints.map((h) => h.mint));
    for (const [j, k] of missing.entries()) {
      const h = mints[j];
      const len = h.program.equals(TOKEN_2022_PROGRAM_ID)
        ? getAccountLenForMint(unpackMint(h.mint, mintInfos[j], h.program))
        : ACCOUNT_SIZE;
      rent.set(k, await conn.getMinimumBalanceForRentExemption(len));
    }
  }
  return rent;
}

const destAta = (h: Holding, dest: PublicKey) => getAssociatedTokenAddressSync(h.mint, dest, true, h.program);

/**
 * Packs every token move into as few txs as fit, then a final tx that sends all remaining SOL.
 * The SOL amount is worked out in advance so everything can be signed in one wallet prompt.
 */
export function planSweep(p: PlanInput): Plan {
  if (p.owner.equals(p.dest)) throw new Error('Destination must differ from source');
  const skipped = p.holdings.filter((h) => h.frozen);
  const groups: TransactionInstruction[][] = [];
  let lamports = p.balance;
  const created = new Set<string>();
  for (const h of p.holdings.filter((h) => !h.frozen)) {
    const ixs: TransactionInstruction[] = [];
    if (h.amount > 0n) {
      const ata = destAta(h, p.dest);
      const key = ata.toBase58();
      if (p.ataRent.has(key) && !created.has(key)) { lamports -= p.ataRent.get(key)!; created.add(key); }
      ixs.push(
        createAssociatedTokenAccountIdempotentInstruction(p.owner, ata, p.dest, h.mint, h.program),
        createTransferCheckedInstruction(h.account, h.mint, ata, p.owner, h.amount, h.decimals, [], h.program),
      );
    }
    // Rent comes back to the owner so it funds the next ATA creation, then leaves in the SOL tx.
    ixs.push(createCloseAccountInstruction(h.account, p.owner, p.owner, [], h.program));
    lamports += h.lamports;
    groups.push(ixs);
  }

  const tokenTxs: Transaction[] = [];
  let batch: TransactionInstruction[][] = [];
  const build = (b: TransactionInstruction[][]) => {
    const cu = Math.min(1_400_000, CU_PER_TOKEN * b.length);
    const tx = new Transaction({ feePayer: p.owner, recentBlockhash: p.blockhash }).add(
      ComputeBudgetProgram.setComputeUnitLimit({ units: cu }),
      ComputeBudgetProgram.setComputeUnitPrice({ microLamports: p.priorityMicroLamports }),
      ...b.flat(),
    );
    return { tx, cu };
  };
  const fits = (b: TransactionInstruction[][]) => {
    try { return build(b).tx.serializeMessage().length + 1 + 64 <= PACKET_DATA_SIZE; } catch { return false; }
  };
  const flush = () => {
    if (!batch.length) return;
    const { tx, cu } = build(batch);
    lamports -= fee(cu, p.priorityMicroLamports);
    tokenTxs.push(tx);
    batch = [];
  };
  for (const g of groups) {
    if (!fits([...batch, g])) flush();
    batch.push(g);
  }
  flush();

  const solAmount = lamports - fee(CU_SOL_TX, p.priorityMicroLamports) - p.keepLamports;
  const solTx = solAmount > 0
    ? new Transaction({ feePayer: p.owner, recentBlockhash: p.blockhash }).add(
      ComputeBudgetProgram.setComputeUnitLimit({ units: CU_SOL_TX }),
      ComputeBudgetProgram.setComputeUnitPrice({ microLamports: p.priorityMicroLamports }),
      SystemProgram.transfer({ fromPubkey: p.owner, toPubkey: p.dest, lamports: solAmount }),
    )
    : null;
  return { tokenTxs, solTx, solAmount: Math.max(0, solAmount), skipped };
}

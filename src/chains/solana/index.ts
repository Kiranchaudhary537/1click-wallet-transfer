import { Connection, LAMPORTS_PER_SOL, PublicKey, type Transaction } from '@solana/web3.js';
import type { ChainAdapter } from '../../core/types.ts';
import { dzapTokens, formatUnits } from '../../core/dzap.ts';
import { loadAtaRent, loadHoldings, planSweep } from './sweep.ts';

type Provider = {
  publicKey: PublicKey | null;
  connect(): Promise<unknown>;
  signAllTransactions(txs: Transaction[]): Promise<Transaction[]>;
};

const DZAP_CHAIN_ID = 7565164;
// shortcut: fixed priority fee; read getRecentPrioritizationFees if batches land too slowly under congestion
const PRIORITY_MICRO_LAMPORTS = 200_000;

const w = globalThis as any;
const provider = (): Provider | undefined => w.phantom?.solana ?? w.solflare ?? w.backpack ?? w.solana;
const toKey = (s: string) => new PublicKey(s.trim());

export const solana: ChainAdapter = {
  id: 'solana',
  name: 'Solana',
  nativeSymbol: 'SOL',
  defaultRpc: 'https://api.mainnet-beta.solana.com',

  isAddress(s) {
    try { toKey(s); return true; } catch { return false; }
  },

  async connect() {
    const p = provider();
    if (!p) throw new Error('No Solana wallet extension found (Phantom, Solflare, Backpack)');
    await p.connect();
    return p.publicKey!.toBase58();
  },

  async scan(rpc, address) {
    const c = new Connection(rpc, 'confirmed'), owner = toKey(address);
    const [holdings, balance, names] = await Promise.all([loadHoldings(c, owner), c.getBalance(owner), dzapTokens(DZAP_CHAIN_ID)]);
    return [
      { symbol: 'SOL', amount: formatUnits(BigInt(balance), 9), id: 'native' },
      ...holdings.map((h) => ({
        symbol: names[h.mint.toBase58()]?.symbol ?? '?',
        amount: formatUnits(h.amount, h.decimals),
        id: h.mint.toBase58(),
        note: h.frozen ? 'frozen — will be skipped' : h.amount === 0n ? 'empty — closed for rent' : undefined,
      })),
    ];
  },

  async sweep({ rpc, from, to, keepNative, confirm, log }) {
    const p = provider(), c = new Connection(rpc, 'confirmed'), owner = toKey(from), dest = toKey(to);
    if (!p?.publicKey?.equals(owner)) throw new Error('Connect the source wallet first (connected wallet must match source)');
    const [holdings, balance, { blockhash, lastValidBlockHeight }] =
      await Promise.all([loadHoldings(c, owner), c.getBalance(owner), c.getLatestBlockhash('confirmed')]);
    const ataRent = await loadAtaRent(c, dest, holdings);
    const plan = planSweep({
      owner, dest, balance, holdings, ataRent, blockhash,
      priorityMicroLamports: PRIORITY_MICRO_LAMPORTS,
      keepLamports: Math.round(Number(keepNative) * LAMPORTS_PER_SOL) || 0,
    });
    const moving = holdings.length - plan.skipped.length;
    if (!confirm(`Send ${moving} token accounts and ${plan.solAmount / LAMPORTS_PER_SOL} SOL to\n${to}\n\n` +
      `${plan.tokenTxs.length + (plan.solTx ? 1 : 0)} transactions, one wallet approval. Continue?`)) return;
    if (plan.skipped.length) log(`Skipping ${plan.skipped.length} frozen account(s)`);

    const signed = await p.signAllTransactions(plan.solTx ? [...plan.tokenTxs, plan.solTx] : plan.tokenTxs);
    const send = async (tx: Transaction, label: string) => {
      try {
        const signature = await c.sendRawTransaction(tx.serialize(), { maxRetries: 5 });
        log(`${label}: sent ${signature}`);
        const { value } = await c.confirmTransaction({ signature, blockhash, lastValidBlockHeight }, 'confirmed');
        log(`${label}: ${value.err ? 'FAILED ' + JSON.stringify(value.err) : 'confirmed'}`);
        return !value.err;
      } catch (e) { log(`${label}: FAILED ${(e as Error).message}`); return false; }
    };
    // Token txs are independent: fire them together to beat the attacker. SOL goes last since its amount
    // counts on the rent those txs refund.
    const tokenTxs = plan.solTx ? signed.slice(0, -1) : signed;
    const ok = await Promise.all(tokenTxs.map((tx, i) => send(tx, `Token batch ${i + 1}/${tokenTxs.length}`)));
    if (plan.solTx) await send(signed.at(-1)!, 'SOL transfer');
    log(ok.every(Boolean) ? 'Done. Scan again to verify.' : 'Some batches failed. Scan again and re-run to move what is left.');
  },
};

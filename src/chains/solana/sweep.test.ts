import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Keypair, PACKET_DATA_SIZE, SystemProgram } from '@solana/web3.js';
import { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync } from '@solana/spl-token';
import { planSweep, type Holding } from './sweep.ts';

const owner = Keypair.generate().publicKey;
const dest = Keypair.generate().publicKey;
const blockhash = Keypair.generate().publicKey.toBase58();
const RENT = 2_039_280;

const holding = (i: number, amount: bigint, frozen = false): Holding => ({
  account: Keypair.generate().publicKey, mint: Keypair.generate().publicKey,
  program: i % 2 ? TOKEN_2022_PROGRAM_ID : TOKEN_PROGRAM_ID, amount, decimals: 6, lamports: RENT, frozen,
});

test('packs 25 tokens into size-valid txs and sweeps exact remaining SOL', () => {
  const holdings = [...Array(25)].map((_, i) => holding(i, i === 0 ? 0n : 1000n));
  holdings.push(holding(99, 5n, true));
  // half of the destination ATAs are missing
  const ataRent = new Map(holdings.filter((h, i) => h.amount > 0n && i % 2 === 0)
    .map((h) => [getAssociatedTokenAddressSync(h.mint, dest, true, h.program).toBase58(), RENT]));
  const balance = 50_000_000, price = 100_000;
  const plan = planSweep({ owner, dest, balance, holdings, ataRent, priorityMicroLamports: price, keepLamports: 0, blockhash });

  assert.equal(plan.skipped.length, 1);
  assert.ok(plan.tokenTxs.length > 1, 'should need several txs');
  for (const tx of plan.tokenTxs) assert.ok(tx.serializeMessage().length + 65 <= PACKET_DATA_SIZE);
  const closes = plan.tokenTxs.flatMap((t) => t.instructions).filter((ix) => ix.data[0] === 9).length; // CloseAccount = 9
  assert.equal(closes, 25);

  let fees = 0;
  for (const tx of plan.tokenTxs) {
    const cu = tx.instructions[0].data.readUInt32LE(1);
    fees += 5000 + Math.ceil((cu * price) / 1e6);
  }
  fees += 5000 + Math.ceil((1000 * price) / 1e6);
  const expected = balance + 25 * RENT - ataRent.size * RENT - fees;
  assert.equal(plan.solAmount, expected);
  const ix = plan.solTx!.instructions.at(-1)!;
  assert.ok(ix.programId.equals(SystemProgram.programId));
  assert.equal(Number(ix.data.readBigUInt64LE(4)), expected);
});

test('no SOL tx when nothing is left after fees', () => {
  const plan = planSweep({ owner, dest, balance: 1000, holdings: [], ataRent: new Map(), priorityMicroLamports: 0, keepLamports: 0, blockhash });
  assert.equal(plan.solTx, null);
  assert.throws(() => planSweep({ owner, dest: owner, balance: 0, holdings: [], ataRent: new Map(), priorityMicroLamports: 0, keepLamports: 0, blockhash }));
});

test('sponsored: payer covers fees and rent, owner sends its whole balance', () => {
  const payer = Keypair.generate().publicKey;
  const holdings = [...Array(12)].map((_, i) => holding(i, 1000n));
  const ataRent = new Map(holdings.map((h) => [getAssociatedTokenAddressSync(h.mint, dest, true, h.program).toBase58(), RENT]));
  const plan = planSweep({ owner, dest, payer, balance: 7_000_000, holdings, ataRent, priorityMicroLamports: 100_000, keepLamports: 0, blockhash });
  assert.equal(plan.solAmount, 7_000_000);
  for (const tx of [...plan.tokenTxs, plan.solTx!]) {
    const m = tx.compileMessage();
    assert.ok(m.accountKeys[0].equals(payer), 'payer is fee payer');
    assert.equal(m.header.numRequiredSignatures, 2);
    assert.ok(m.serialize().length + 1 + 128 <= PACKET_DATA_SIZE);
  }
  const ixs = plan.tokenTxs.flatMap((t) => t.instructions);
  const close = ixs.find((ix) => ix.data[0] === 9)!;
  assert.ok(close.keys[1].pubkey.equals(dest), 'rent goes to destination');
  const create = ixs.find((ix) => ix.programId.toBase58().startsWith('AToken'))!;
  assert.ok(create.keys[0].pubkey.equals(payer), 'payer funds new token accounts');
});

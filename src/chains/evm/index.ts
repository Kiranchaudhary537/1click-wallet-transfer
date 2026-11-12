import {
  createPublicClient, createWalletClient, custom, erc20Abi, formatEther, formatUnits as fmtUnits, getAddress, http,
  isAddress, isHex, parseEventLogs, parseUnits, zeroAddress, type Address, type Chain, type Hex, type PublicClient,
} from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { entryPoint08Abi } from 'viem/account-abstraction';
import { estimateL1Fee } from 'viem/op-stack';
import { createStore, type EIP1193Provider, type Store } from 'mipd';
import type { ChainAdapter, WalletOption } from '../../core/types.ts';
import { dzapTokens } from '../../core/dzap.ts';
import { buildRescueTx, type Call } from './rescue.ts';
import { nativeSweepAmount, transferCalls, type Held } from './sweep.ts';

// EIP-6963: every installed wallet announces itself, so MetaMask, Rabby, Coinbase... don't fight over window.ethereum.
let store: Store | undefined; // lazy: createStore touches window
const injected = () => {
  const found = (store ??= createStore()).getProviders()
    .map((d) => ({ id: d.info.rdns, name: d.info.name, provider: d.provider as EIP1193Provider }));
  const legacy = (globalThis as any).ethereum as EIP1193Provider | undefined; // wallets that predate EIP-6963
  return found.length || !legacy ? found : [{ id: 'injected', name: 'Browser wallet', provider: legacy }];
};

// Mainnet has a public mempool full of sweeper bots; Flashbots Protect keeps the rescue tx private until it lands.
// L2 sequencers here have no public mempool.
const PRIVATE_RPC: Record<number, string> = { 1: 'https://rpc.flashbots.net/fast' };

const toKey = (secret: string): Hex => {
  const k = secret.trim().replace(/^(0x)?/, '0x');
  if (!isHex(k) || k.length !== 66) throw new Error('Private key must be 64 hex characters');
  return k;
};

// shortcut: only tokens in the DZAP list are found (EVM has no on-chain "list my tokens");
// add an indexer (e.g. alchemy_getTokenBalances) if users report missing tokens
async function heldTokens(client: PublicClient, chainId: number, owner: Address): Promise<Held[]> {
  const list = Object.values(await dzapTokens(chainId)).filter((t) => t.contract !== zeroAddress && isAddress(t.contract));
  const balances = await client.multicall({
    contracts: list.map((t) => ({ address: t.contract as Address, abi: erc20Abi, functionName: 'balanceOf', args: [owner] }) as const),
    allowFailure: true,
    batchSize: 50_000, // ~1000 balanceOf per RPC request, so a 4k-token list is a handful of calls
  });
  return list.flatMap((t, i) => {
    const r = balances[i];
    return r.status === 'success' && r.result > 0n
      ? [{ token: getAddress(t.contract), symbol: t.symbol, amount: r.result, decimals: t.decimals }]
      : [];
  });
}

/** Transfers for every held token, minus those whose transfer would revert (honeypots, paused, blacklisted). */
async function movableTokens(c: PublicClient, chainId: number, owner: Address, dest: Address, log: (s: string) => void) {
  const held = await heldTokens(c, chainId, owner);
  const calls = transferCalls(held, dest);
  const sims = await Promise.allSettled(calls.map((call) => c.call({ account: owner, ...call })));
  return held.flatMap((h, i) => {
    if (sims[i].status === 'fulfilled') return [{ held: h, call: calls[i] as Call }];
    log(`Skipping ${h.symbol} (${h.token}): transfer would revert`);
    return [];
  });
}

/** Builds an adapter for any viem chain that has multicall3 deployed. */
export function evmChain(chain: Chain): ChainAdapter {
  const client = (rpc: string) => createPublicClient({ chain, transport: http(rpc) }) as PublicClient;
  const sym = chain.nativeCurrency.symbol;
  let provider: EIP1193Provider | null = null;
  const walletClient = () => {
    if (!provider) throw new Error('Connect a wallet first');
    return createWalletClient({ chain, transport: custom(provider) });
  };
  const connectedWallet = async () => {
    const wallet = walletClient();
    const [account] = await wallet.requestAddresses();
    if ((await wallet.getChainId()) !== chain.id) await wallet.switchChain({ id: chain.id });
    return { wallet, account: getAddress(account) };
  };
  const fees = async (c: PublicClient) => {
    const f = await c.estimateFeesPerGas();
    return { maxFeePerGas: f.maxFeePerGas ?? f.gasPrice!, maxPriorityFeePerGas: f.maxPriorityFeePerGas ?? f.gasPrice! };
  };
  // OP-stack L2s (Base, Optimism) charge an L1 data fee on top of gas, paid from the sender's balance.
  const l1Fee = async (c: PublicClient, tx: { account: Address; to: Address; data?: Hex; value?: bigint }) =>
    chain.contracts?.gasPriceOracle ? (await estimateL1Fee(c as any, { ...tx, chain })) * 2n : 0n; // 2x: L1 price moves

  return {
    id: `evm-${chain.id}`,
    name: chain.name,
    nativeSymbol: sym,
    defaultRpc: chain.rpcUrls.default.http[0],
    isAddress: (s) => isAddress(s.trim()),

    wallets: (): WalletOption[] => injected().map(({ id, name }) => ({ id, name })),

    async connect(walletId) {
      const found = injected().find((w) => w.id === walletId);
      if (!found) throw new Error('No EVM wallet found. Install MetaMask, Rabby or Coinbase Wallet and reload.');
      provider = found.provider;
      const [address] = await walletClient().requestAddresses();
      return address;
    },

    async scan(rpc, address) {
      const c = client(rpc), owner = getAddress(address.trim());
      const [balance, held] = await Promise.all([c.getBalance({ address: owner }), heldTokens(c, chain.id, owner)]);
      return [
        { symbol: sym, amount: fmtUnits(balance, chain.nativeCurrency.decimals), id: 'native' },
        ...held.map((h) => ({ symbol: h.symbol, amount: fmtUnits(h.amount, h.decimals), id: h.token })),
      ];
    },

    async sweep({ rpc, from, to, keepNative, confirm, log }) {
      const c = client(rpc), owner = getAddress(from.trim()), dest = getAddress(to.trim());
      if (owner === dest) throw new Error('Destination must differ from source');
      const { wallet, account } = await connectedWallet();
      if (account !== owner) throw new Error('Connected wallet must match the source address');

      const movable = await movableTokens(c, chain.id, owner, dest, log);
      const calls = movable.map((m) => m.call);
      const [balance, f] = await Promise.all([c.getBalance({ address: owner }), fees(c)]);
      // Native rides in the same batch, so its amount must leave gas for the whole batch. The batch gas is
      // only known after signing, so reserve a generous estimate at 2x the fee; the unused part stays as dust.
      const gas = 65_000n * BigInt(calls.length) + 21_000n + 100_000n;
      const value = nativeSweepAmount({
        balance, gas, maxFeePerGas: f.maxFeePerGas * 2n,
        l1Fee: (await l1Fee(c, { account: owner, to: dest, value: 1n })) * BigInt(calls.length + 1),
        keep: parseUnits(keepNative || '0', chain.nativeCurrency.decimals),
      });
      if (value > 0n) calls.push({ to: dest, value });
      if (!calls.length) return log('Nothing to move (or not enough gas).');

      if (!confirm(`Send ${movable.length} token(s) and ${formatEther(value)} ${sym} on ${chain.name} to\n${dest}\n\n` +
        `One approval if your wallet supports batching (EIP-5792), otherwise one per transfer. Continue?`)) return;
      const { id } = await wallet.sendCalls({ account, calls, experimental_fallback: true });
      log(`Batch sent (${id.slice(0, 18)}…), waiting…`);
      const { status } = await wallet.waitForCallsStatus({ id, timeout: 300_000 });
      log(`Batch: ${status}. Scan again to verify.`);
    },

    rescue: {
      addressOf: (secret) => privateKeyToAccount(toKey(secret)).address,

      async sweep({ rpc, secret, to, keepNative, confirm, log }) {
        const c = client(rpc), owner = privateKeyToAccount(toKey(secret)), dest = getAddress(to.trim());
        if (owner.address === dest) throw new Error('Destination must differ from the compromised address');
        const { wallet: funder, account: payer } = await connectedWallet();
        if (payer === owner.address) throw new Error('Connect your safe wallet (it pays the gas), not the compromised one');

        const movable = await movableTokens(c, chain.id, owner.address, dest, log);
        const native = (await c.getBalance({ address: owner.address })) - parseUnits(keepNative || '0', chain.nativeCurrency.decimals);
        // Tokens and native are separate user ops: if the attacker moves the native first, the tokens still go.
        const batches = [movable.map((m) => m.call), native > 0n ? [{ to: dest, value: native }] : []].filter((b) => b.length);
        if (!batches.length) return log('Nothing to move.');

        // A throwaway gas wallet sends the 7702 tx (browser wallets can't). The safe wallet funds it with just the gas.
        const burnerKey = generatePrivateKey(), burner = privateKeyToAccount(burnerKey);
        const { minGas, ...tx } = await buildRescueTx({ client: c, owner, bundler: burner.address, batches });
        const f = await fees(c);
        const maxFeePerGas = f.maxFeePerGas * 2n; // headroom so it still lands if the base fee rises
        const estimate = (await c.estimateGas({ account: burner.address, ...tx })) * 13n / 10n;
        const gas = estimate > minGas ? estimate : minGas;
        const fund = (gas + 21_000n) * maxFeePerGas + (await l1Fee(c, { account: burner.address, to: tx.to, data: tx.data })) * 2n;

        if (!confirm(`RESCUE on ${chain.name}: move ${movable.length} token(s) and ${formatEther(native > 0n ? native : 0n)} ${sym}\n` +
          `from ${owner.address}\nto ${dest}\n\nYour connected wallet pays at most ${formatEther(fund)} ${sym} for gas ` +
          `(via a temporary gas wallet; the unused part comes back to you). ` +
          `The compromised wallet pays nothing. Continue?`)) return;
        log(`Temporary gas wallet ${burner.address}. If this page closes before it finishes, its key is: ${burnerKey}`);

        const fundHash = await funder.sendTransaction({ account: payer, to: burner.address, value: fund, chain });
        log(`Funding gas wallet: ${fundHash}`);
        await c.waitForTransactionReceipt({ hash: fundHash });

        const signed = await burner.signTransaction({
          ...tx, chainId: chain.id, type: 'eip7702', gas, nonce: 0, maxFeePerGas, maxPriorityFeePerGas: f.maxPriorityFeePerGas,
        });
        const broadcaster = PRIVATE_RPC[chain.id] ? createPublicClient({ chain, transport: http(PRIVATE_RPC[chain.id]) }) : c;
        const hash = await broadcaster.sendRawTransaction({ serializedTransaction: signed });
        log(`Rescue tx sent${PRIVATE_RPC[chain.id] ? ' privately (Flashbots Protect)' : ''}: ${hash}`);
        const receipt = await c.waitForTransactionReceipt({ hash, timeout: 600_000 });
        const ops = parseEventLogs({ abi: entryPoint08Abi, eventName: 'UserOperationEvent', logs: receipt.logs });
        const labels = [movable.length ? 'Tokens' : '', native > 0n ? sym : ''].filter(Boolean); // same order as batches
        ops.forEach((op, i) => log(`${labels[i]}: ${op.args.success ? 'moved' : 'FAILED'}`));
        if (receipt.status !== 'success' || ops.length !== batches.length) log(`Rescue tx: ${receipt.status}, ${ops.length}/${batches.length} ops ran`);

        // Return what's left of the gas money.
        const left = await c.getBalance({ address: burner.address });
        const now = await fees(c);
        const refund = left - 21_000n * now.maxFeePerGas - (await l1Fee(c, { account: burner.address, to: payer, value: 1n }));
        if (refund > 0n) {
          const r = await createWalletClient({ account: burner, chain, transport: http(rpc) })
            .sendTransaction({ to: payer, value: refund, gas: 21_000n, ...now });
          log(`Returned ${formatEther(refund)} ${sym} unused gas to ${payer}: ${r}`);
        }
        log('Done. Scan again to verify.');
      },
    },
  };
}

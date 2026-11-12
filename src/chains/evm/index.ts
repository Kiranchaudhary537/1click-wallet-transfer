import {
  createPublicClient, createWalletClient, custom, erc20Abi, formatUnits as fmtUnits, getAddress, http, isAddress,
  parseUnits, zeroAddress, type Address, type Chain, type PublicClient,
} from 'viem';
import { estimateL1Fee } from 'viem/op-stack';
import { createStore, type EIP1193Provider, type Store } from 'mipd';
import type { ChainAdapter, WalletOption } from '../../core/types.ts';
import { dzapTokens } from '../../core/dzap.ts';
import { nativeSweepAmount, transferCalls, type Held } from './sweep.ts';

// EIP-6963: every installed wallet announces itself, so MetaMask, Rabby, Coinbase... don't fight over window.ethereum.
let store: Store | undefined; // lazy: createStore touches window
const injected = () => {
  const found = (store ??= createStore()).getProviders()
    .map((d) => ({ id: d.info.rdns, name: d.info.name, provider: d.provider as EIP1193Provider }));
  const legacy = (globalThis as any).ethereum as EIP1193Provider | undefined; // wallets that predate EIP-6963
  return found.length || !legacy ? found : [{ id: 'injected', name: 'Browser wallet', provider: legacy }];
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

/** Builds an adapter for any viem chain that has multicall3 deployed. */
export function evmChain(chain: Chain): ChainAdapter {
  const client = (rpc: string) => createPublicClient({ chain, transport: http(rpc) }) as PublicClient;
  let provider: EIP1193Provider | null = null;
  const walletClient = () => {
    if (!provider) throw new Error('Connect the source wallet first');
    return createWalletClient({ chain, transport: custom(provider) });
  };
  return {
    id: `evm-${chain.id}`,
    name: chain.name,
    nativeSymbol: chain.nativeCurrency.symbol,
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
        { symbol: chain.nativeCurrency.symbol, amount: fmtUnits(balance, chain.nativeCurrency.decimals), id: 'native' },
        ...held.map((h) => ({ symbol: h.symbol, amount: fmtUnits(h.amount, h.decimals), id: h.token })),
      ];
    },

    async sweep({ rpc, from, to, keepNative, confirm, log }) {
      const c = client(rpc), owner = getAddress(from.trim()), dest = getAddress(to.trim());
      if (owner === dest) throw new Error('Destination must differ from source');
      const wallet = walletClient();
      const [account] = await wallet.requestAddresses();
      if (getAddress(account) !== owner) throw new Error('Connected wallet must match the source address');
      if ((await wallet.getChainId()) !== chain.id) await wallet.switchChain({ id: chain.id });

      // Drop tokens whose transfer would revert (honeypots, paused, blacklisted) so they can't sink the batch.
      const held = await heldTokens(c, chain.id, owner);
      const calls = transferCalls(held, dest);
      const sims = await Promise.allSettled(calls.map((call) => c.call({ account: owner, ...call })));
      const movable = held.filter((h, i) => {
        if (sims[i].status === 'fulfilled') return true;
        log(`Skipping ${h.symbol} (${h.token}): transfer would revert`);
        return false;
      });

      if (!confirm(`Send ${movable.length} token(s) and all ${chain.nativeCurrency.symbol} on ${chain.name} to\n${dest}\n\n` +
        `Tokens go in one batch (one approval if your wallet supports EIP-5792, otherwise one per token), ` +
        `then one approval for ${chain.nativeCurrency.symbol}. Continue?`)) return;

      if (movable.length) {
        const { id } = await wallet.sendCalls({ account, calls: transferCalls(movable, dest), experimental_fallback: true });
        log(`Token batch sent (${id.slice(0, 18)}…), waiting…`);
        const { status } = await wallet.waitForCallsStatus({ id, timeout: 300_000 });
        log(`Token batch: ${status}`);
      }

      const [balance, gas, fees] = await Promise.all([
        c.getBalance({ address: owner }),
        c.estimateGas({ account: owner, to: dest, value: 1n }), // contract wallets (Safe) need more than 21k
        c.estimateFeesPerGas(),
      ]);
      const maxFeePerGas = fees.maxFeePerGas ?? fees.gasPrice!;
      // OP-stack L2s (Base, Optimism) charge an L1 data fee on top of gas, paid from the same balance.
      const l1Fee = chain.contracts?.gasPriceOracle
        ? (await estimateL1Fee(c as any, { account: owner, to: dest, value: 1n, chain })) * 2n // 2x: L1 price moves
        : 0n;
      const value = nativeSweepAmount({
        balance, gas, maxFeePerGas, l1Fee, keep: parseUnits(keepNative || '0', chain.nativeCurrency.decimals),
      });
      if (!value) return log(`Not enough ${chain.nativeCurrency.symbol} left to cover the transfer fee.`);
      const hash = await wallet.sendTransaction({
        account, to: dest, value, gas, chain,
        ...(fees.maxFeePerGas ? { maxFeePerGas, maxPriorityFeePerGas: fees.maxPriorityFeePerGas } : { gasPrice: maxFeePerGas }),
      });
      log(`${chain.nativeCurrency.symbol} transfer sent ${hash}`);
      const receipt = await c.waitForTransactionReceipt({ hash });
      log(`${chain.nativeCurrency.symbol} transfer: ${receipt.status}. Scan again to verify.`);
    },
  };
}

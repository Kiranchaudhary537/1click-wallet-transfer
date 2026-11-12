import { encodeFunctionData, erc20Abi, type Address, type Hex } from 'viem';

export type Held = { token: Address; symbol: string; amount: bigint; decimals: number };

/** One ERC-20 `transfer` call per held token, sending the full balance. */
export const transferCalls = (held: Held[], to: Address): { to: Address; data: Hex }[] =>
  held.map((h) => ({ to: h.token, data: encodeFunctionData({ abi: erc20Abi, functionName: 'transfer', args: [to, h.amount] }) }));

/** Native left to send after paying the worst-case fee for the sweep tx itself. 0n = nothing to send. */
export function nativeSweepAmount(p: { balance: bigint; gas: bigint; maxFeePerGas: bigint; l1Fee: bigint; keep: bigint }) {
  const amount = p.balance - p.gas * p.maxFeePerGas - p.l1Fee - p.keep;
  return amount > 0n ? amount : 0n;
}

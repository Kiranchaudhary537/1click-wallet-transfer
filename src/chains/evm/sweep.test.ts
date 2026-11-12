import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decodeFunctionData, erc20Abi, parseEther, zeroAddress } from 'viem';
import { nativeSweepAmount, transferCalls } from './sweep.ts';

const to = '0x000000000000000000000000000000000000dEaD';
const usdc = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48';

test('builds a full-balance transfer per token', () => {
  const [call] = transferCalls([{ token: usdc, symbol: 'USDC', amount: 123n, decimals: 6 }], to);
  assert.equal(call.to, usdc);
  const { functionName, args } = decodeFunctionData({ abi: erc20Abi, data: call.data });
  assert.equal(functionName, 'transfer');
  assert.deepEqual(args, [to, 123n]);
});

test('native amount pays worst-case gas, L1 fee and leave-behind, never negative', () => {
  const p = { balance: parseEther('1'), gas: 21_000n, maxFeePerGas: 10n ** 10n, l1Fee: 1000n, keep: 5n };
  assert.equal(nativeSweepAmount(p), parseEther('1') - 21_000n * 10n ** 10n - 1000n - 5n);
  assert.equal(nativeSweepAmount({ ...p, balance: 100n }), 0n);
  assert.notEqual(to, zeroAddress);
});

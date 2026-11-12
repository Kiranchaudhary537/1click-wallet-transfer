import { encodeFunctionData, type Address, type Hex, type PublicClient } from 'viem';
import type { PrivateKeyAccount } from 'viem/accounts';
import { entryPoint08Abi, entryPoint08Address, toPackedUserOperation, toSimple7702SmartAccount } from 'viem/account-abstraction';

export type Call = { to: Address; data?: Hex; value?: bigint };

/**
 * Builds one EIP-7702 tx that a gas wallet (`bundler`) sends on behalf of the compromised `owner`:
 * - the authorization temporarily points `owner` at eth-infinitism's audited Simple7702Account,
 * - EntryPoint v0.8 runs each batch as `owner` (so token.transfer sees owner as msg.sender); batches are
 *   separate user ops, so one failing (e.g. native already moved by the attacker) doesn't undo the others,
 * - the user op bids 0 gas price, so `owner` pays nothing and its whole native balance can move.
 * Both contracts are already deployed at the same address on every supported chain.
 */
export async function buildRescueTx(p: { client: PublicClient; owner: PrivateKeyAccount; bundler: Address; batches: Call[][] }) {
  const account = await toSimple7702SmartAccount({ client: p.client, owner: p.owner });
  const [eoaNonce, opNonce] = await Promise.all([
    p.client.getTransactionCount({ address: p.owner.address, blockTag: 'pending' }),
    account.getNonce(),
  ]);
  // Sender is the bundler, so the authorization uses owner's current nonce (not +1).
  const authorization = await p.owner.signAuthorization({
    chainId: p.client.chain!.id, nonce: eoaNonce, address: account.authorization.address,
  });
  const ops = await Promise.all(p.batches.map(async (calls, i) => {
    const userOp = {
      sender: p.owner.address,
      nonce: opNonce + BigInt(i), // same key, next sequence number
      callData: await account.encodeCalls(calls),
      callGasLimit: 100_000n * BigInt(calls.length) + 50_000n,
      verificationGasLimit: 150_000n,
      preVerificationGas: 0n,
      maxFeePerGas: 0n,
      maxPriorityFeePerGas: 0n,
      signature: '0x' as Hex,
    };
    userOp.signature = await account.signUserOperation(userOp);
    return toPackedUserOperation(userOp);
  }));
  return {
    to: entryPoint08Address,
    data: encodeFunctionData({ abi: entryPoint08Abi, functionName: 'handleOps', args: [ops, p.bundler] }),
    authorizationList: [authorization],
    // EntryPoint reverts the whole tx if gasleft can't cover each op's limits, and eth_estimateGas can
    // under-shoot (it may take a cheaper failure path), so the tx gas must never go below this.
    minGas: 100_000n + p.batches.reduce((sum, calls) => sum + 150_000n + 100_000n * BigInt(calls.length) + 50_000n, 0n),
  };
}

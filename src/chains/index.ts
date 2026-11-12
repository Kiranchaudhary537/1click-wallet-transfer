import { arbitrum, base, bsc, mainnet, optimism, polygon } from 'viem/chains';
import type { ChainAdapter } from '../core/types.ts';
import { solana } from './solana/index.ts';
import { evmChain } from './evm/index.ts';

/** Every chain the app offers. Adding an EVM chain is one entry here; a new chain family needs an adapter. */
export const chains: ChainAdapter[] = [
  solana,
  ...[mainnet, base, arbitrum, optimism, polygon, bsc].map(evmChain),
];

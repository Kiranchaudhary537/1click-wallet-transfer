# Contributing

Thanks for helping. The most valuable contributions are **new chains**, **tests against real mainnet
behaviour**, and **fixes for tokens that fail to move**.

## Setup

```sh
pnpm install
pnpm dev     # run the app
pnpm test    # unit tests (node:test, no extra framework)
pnpm build   # typecheck + production build
```

## Adding a chain

### An EVM chain (one line)

If [viem](https://viem.sh/docs/chains/introduction) has the chain and it has Multicall3, add it to
`src/chains/index.ts`:

```ts
import { arbitrum, base, bsc, mainnet, optimism, polygon, avalanche } from 'viem/chains';
// ...
...[mainnet, base, arbitrum, optimism, polygon, bsc, avalanche].map(evmChain),
```

Then check that `https://api.dzap.io/v1/token/tokens?chainId=<id>` returns a token list, and scan a
known wallet on that chain to confirm balances show up.

### A new chain family (Sui, Aptos, Tron, Bitcoin, ...)

1. Create `src/chains/<family>/`.
2. Put the pure logic (which transfers to build, how much native to send) in `sweep.ts`, with no
   network or wallet calls, so it can be unit-tested. Add `sweep.test.ts` next to it.
3. Implement the `ChainAdapter` interface from `src/core/types.ts` in `index.ts`: `scan`, `connect`,
   `sweep`, `isAddress`, `wallets`. The UI needs nothing else.
   Discover wallets through the chain's open standard (like Wallet Standard on Solana or EIP-6963 on EVM),
   not by reading one wallet's `window.*` global.
4. Register it in `src/chains/index.ts`.

5. Optional: implement `rescue` (see `ChainAdapter.rescue`) if the chain lets a second account pay the fees.

Rules every adapter must follow:
- **Only `rescue` may take a private key**, only the compromised one, and only in memory. Never log, store or send it.
  Everything else signs in the user's wallet.
- **Show `confirm()` before signing**, with the destination and what will move.
- **Use the fewest wallet prompts the chain allows.** That is the point of the project.
- **Send the native coin last**, and work out its amount so fees are covered.
- **Skip what would fail** (simulate if you can) instead of letting one bad token sink everything.

## Pull requests

- Keep PRs focused: one chain or one fix per PR.
- Logic that computes amounts or builds transfers needs a test.
- Say how you tested on mainnet (a scan plus a simulation, or a small real transfer) in the PR.
- CI must pass (`pnpm test && pnpm build`).

## Never post secrets

Don't put private keys, seed phrases or RPC API keys in issues, PRs, tests or commits. Addresses and
transaction hashes are fine.

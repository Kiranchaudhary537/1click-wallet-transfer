# 1-Click Wallet Transfer

[![CI](https://github.com/Kiranchaudhary537/1click-wallet-transfer/actions/workflows/ci.yml/badge.svg)](https://github.com/Kiranchaudhary537/1click-wallet-transfer/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

When a wallet's key leaks, you are racing the attacker. Moving tokens one by one is slow.
This app scans the compromised wallet and moves **every token and the native coin** to a safe wallet,
in as few wallet approvals as the chain allows.

| Chain | Approvals | How |
|---|---|---|
| Solana | **1** | Many transfer instructions per transaction, all transactions signed at once with `signAllTransactions` |
| Ethereum, Base, Arbitrum, Optimism, Polygon, BNB | **2** with an EIP-5792 wallet (1 for all tokens + 1 for native), otherwise 1 per token + 1 | `wallet_sendCalls` batch, then a native transfer |

Everything runs in your browser and signs in your own wallet extension. There is no backend, and
private keys never touch this app.

## Quick start

Requires Node 22.18+ and [pnpm](https://pnpm.io).

```sh
pnpm install
pnpm dev        # http://localhost:5173
```

1. Pick the chain, enter the compromised address (or **Connect** it), then click **Scan**.
2. Enter the safe address, then click **Transfer everything** and approve in your wallet.

## How it works

**Solana**
- *Discovery:* two `getTokenAccountsByOwner` calls (SPL Token + Token-2022) return every token held. Nothing is missed.
- *No approvals:* the owner signs directly. Per token: create the destination's token account (idempotent) → `transferChecked` → close the source account to reclaim about 0.002 SOL of rent.
- *Packing:* instructions are packed into as few 1232-byte transactions as fit (about 7 tokens each). They are signed in one prompt and sent in parallel.
- *SOL:* the last transaction sends `balance − fees − new account rent + reclaimed rent − leave-behind`, worked out before signing. With leave-behind 0 the wallet ends at exactly 0.

**EVM**
- *Discovery:* `balanceOf` for every token in the [DZAP](https://dzap.io) token list, batched through Multicall3 (about 1000 tokens per RPC call).
- *Safety filter:* each transfer is simulated first. Tokens that would revert (honeypots, paused, blacklisted) are skipped so they can't sink the batch.
- *Batch:* all ERC-20 transfers go in one EIP-5792 `wallet_sendCalls`. If the wallet doesn't support batching, it falls back to sequential transactions automatically.
- *Native:* sent last as `balance − gas × maxFee − L1 data fee (OP-stack) − leave-behind`. A tiny refund dust can remain, because the actual fee is usually below the maximum.

## Known limitations

- The source wallet needs a little native coin for fees. If a drainer bot already took it, top it up first. (Next on the roadmap: the safe wallet pays the fees.)
- **EVM:** only tokens in the DZAP list are found, and NFTs are not moved. If the attacker installed an EIP-7702 delegation on the wallet, the wallet's batching may fail.
- **Solana:** frozen accounts are skipped. Programmable NFTs, compressed NFTs and transfer-hook tokens fail their batch. Re-scan and re-run to move the rest.

## Project layout

```
src/
  core/types.ts        ChainAdapter interface: the only contract a chain must meet
  core/dzap.ts         token-list helper
  chains/index.ts      registry of offered chains
  chains/solana/       Solana adapter + pure planner (sweep.ts) + tests
  chains/evm/          generic EVM adapter (any viem chain) + tests
  main.ts              chain-agnostic UI
```

## Contributing

New chains are very welcome. Adding an EVM chain is one line. See [CONTRIBUTING.md](CONTRIBUTING.md).
Please read the [Code of Conduct](CODE_OF_CONDUCT.md), and report vulnerabilities privately as described in [SECURITY.md](SECURITY.md).

## Disclaimer

This software moves real funds. It is provided as is, without warranty ([MIT](LICENSE)). Check the
destination address, and try a small wallet first.

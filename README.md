# 1-Click Wallet Transfer

[![CI](https://github.com/Kiranchaudhary537/1click-wallet-transfer/actions/workflows/ci.yml/badge.svg)](https://github.com/Kiranchaudhary537/1click-wallet-transfer/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

When a wallet's key leaks, you are racing the attacker. Moving tokens one by one is slow.
This app scans the compromised wallet and moves **every token and the native coin** to a safe wallet,
in as few wallet approvals as the chain allows.

Two modes:

| | Wallet mode | Rescue mode |
|---|---|---|
| You provide | The compromised wallet, connected in your browser wallet | The compromised wallet's **private key** + your **safe wallet** connected |
| Who pays gas | The compromised wallet | **Your safe wallet.** The compromised wallet needs 0 balance |
| Solana | 1 approval | 1 approval (safe wallet is fee payer; the key co-signs locally) |
| EVM | 1 approval with an EIP-5792 wallet (MetaMask), otherwise 1 per transfer | 1 approval (safe wallet funds a throwaway gas wallet; then everything moves in one EIP-7702 tx) |

Use **Rescue mode** when a drainer bot empties any gas you send to the compromised wallet. The gas never touches it.

Everything runs in your browser. There is no backend. In wallet mode keys never touch this app; in rescue mode
the pasted key stays in the tab's memory and is never sent anywhere. Wallets are discovered through open standards:
[Wallet Standard](https://github.com/wallet-standard/wallet-standard) on Solana (Phantom, Solflare, Backpack, ...)
and [EIP-6963](https://eips.ethereum.org/EIPS/eip-6963) on EVM (MetaMask, Rabby, Coinbase Wallet, ...).
Every installed wallet appears in the picker.

## Quick start

Requires Node 22.18+ and [pnpm](https://pnpm.io).

```sh
pnpm install
pnpm dev        # http://localhost:5173
```

1. Pick the chain and your wallet, then **Connect** the compromised wallet (or just type its address to look), then click **Scan**.
2. Enter the safe address, then click **Transfer everything** and approve in your wallet.

## How it works

**Solana**
- *Discovery:* two `getTokenAccountsByOwner` calls (SPL Token + Token-2022) return every token held. Nothing is missed.
- *No approvals:* the owner signs directly. Per token: create the destination's token account (idempotent) → `transferChecked` → close the source account to reclaim about 0.002 SOL of rent.
- *Packing:* instructions are packed into as few 1232-byte transactions as fit (about 7 tokens each). They are signed in one prompt and sent in parallel.
- *SOL:* the last transaction sends `balance − fees − new account rent + reclaimed rent − leave-behind`, worked out before signing. With leave-behind 0 the wallet ends at exactly 0.

**EVM, wallet mode**
- *Discovery:* `balanceOf` for every token in the [DZAP](https://dzap.io) token list, batched through Multicall3 (about 1000 tokens per RPC call).
- *Safety filter:* each transfer is simulated first. Tokens that would revert (honeypots, paused, blacklisted) are skipped so they can't sink the batch.
- *Batch:* all ERC-20 transfers and the native coin go in one EIP-5792 `wallet_sendCalls`. If the wallet doesn't support batching, it falls back to sequential transactions automatically. Native is sent as balance minus a 2× gas reserve for the batch; the unused reserve stays as dust.

**EVM, rescue mode (EIP-7702)**
Multicall3 can't move your tokens: `token.transfer` would see Multicall3 as the sender. Instead:
1. The compromised key signs an EIP-7702 authorization pointing the wallet at eth-infinitism's audited
   [`Simple7702Account`](https://github.com/eth-infinitism/account-abstraction) (`0xe6Ca…555B`), plus user operations for the
   transfers, bidding **0 gas price**.
2. A throwaway gas wallet is created in the tab. Your safe wallet sends it just enough gas money (**your one approval**).
3. The gas wallet sends one type-4 tx to EntryPoint v0.8 (`0x4337…F108`): the wallet is delegated and all transfers run in the same block.
   Tokens and native are separate user ops, so if the attacker grabs the native first, the tokens still move.
4. On Ethereum mainnet the tx goes through Flashbots Protect, so bots in the public mempool never see it. Unused gas money goes back to your safe wallet.

Both contracts are already deployed at the same address on every supported chain. Nothing to deploy.

**Solana, rescue mode:** the safe wallet is the fee payer and funds new token accounts, so the compromised wallet sends its full SOL balance and ends at exactly 0.

## Known limitations

- Wallet mode needs a little native coin in the compromised wallet for fees. Use rescue mode if it has none.
- Rescue mode has no "keep watching" loop yet: re-run it if more funds arrive later.
- **EVM:** only tokens in the DZAP list are found, and NFTs are not moved. In wallet mode, an attacker's EIP-7702 delegation can break the wallet's batching; rescue mode replaces it.
- **Solana:** frozen accounts are skipped. Programmable NFTs, compressed NFTs and transfer-hook tokens fail their batch. Re-scan and re-run to move the rest.

## Project layout

```
src/
  core/types.ts        ChainAdapter interface: the only contract a chain must meet
  core/dzap.ts         token-list helper
  chains/index.ts      registry of offered chains
  chains/solana/       Solana adapter + pure planner (sweep.ts) + tests
  chains/evm/          generic EVM adapter (any viem chain), rescue.ts (EIP-7702 tx builder) + tests
  main.ts              chain-agnostic UI
```

## Contributing

New chains are very welcome. Adding an EVM chain is one line. See [CONTRIBUTING.md](CONTRIBUTING.md).
Please read the [Code of Conduct](CODE_OF_CONDUCT.md), and report vulnerabilities privately as described in [SECURITY.md](SECURITY.md).

## Disclaimer

This software moves real funds. It is provided as is, without warranty ([MIT](LICENSE)). Check the
destination address, and try a small wallet first.

/** A balance found in the source wallet, already formatted for display. */
export type Asset = { symbol: string; amount: string; id: string; note?: string };

export type WalletOption = { id: string; name: string };

export type SweepOptions = {
  rpc: string;
  from: string;
  to: string;
  /** Native amount (in whole units, e.g. "0.001") to leave in the source wallet. */
  keepNative: string;
  /** Shown to the user before anything is signed; return false to abort. */
  confirm: (summary: string) => boolean;
  log: (line: string) => void;
};

/**
 * Everything the app needs from a chain. To add a chain (or a chain family), implement this
 * and register it in src/chains/index.ts. See CONTRIBUTING.md.
 */
export interface ChainAdapter {
  /** Unique, stable key, e.g. "solana" or "evm-8453". */
  id: string;
  name: string;
  nativeSymbol: string;
  defaultRpc: string;
  isAddress(address: string): boolean;
  /** Wallets installed in this browser that can sign for this chain (discovered via the chain's open standard). */
  wallets(): WalletOption[];
  /** Connects one of `wallets()` as the source account; returns its address. `sweep` signs with it. */
  connect(walletId: string): Promise<string>;
  scan(rpc: string, address: string): Promise<Asset[]>;
  /** Moves every asset it can from `from` to `to`, using as few wallet prompts as the chain allows. */
  sweep(opts: SweepOptions): Promise<void>;
  /**
   * Optional rescue mode, for when the compromised wallet has no gas (or a drainer bot takes any that arrives).
   * The compromised key signs locally, in memory; the connected wallet is the *safe* wallet and pays every fee.
   */
  rescue?: {
    /** Address for a pasted secret key. Throws if the key is malformed. */
    addressOf(secret: string): string;
    sweep(opts: Omit<SweepOptions, 'from'> & { secret: string }): Promise<void>;
  };
}

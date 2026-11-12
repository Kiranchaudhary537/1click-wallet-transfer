/** DZAP token list (https://api.dzap.io). Keyed by token address; native token is the zero/system address. */
export type DzapToken = { contract: string; symbol: string; decimals: number };

// shortcut: fetches the whole list per chain (~1-2MB, rate-limited to 5/min); move to /v1/token/details if that becomes a problem
const cache = new Map<number, Promise<Record<string, DzapToken>>>();

export function dzapTokens(chainId: number): Promise<Record<string, DzapToken>> {
  if (!cache.has(chainId)) {
    cache.set(chainId, fetch(`https://api.dzap.io/v1/token/tokens?chainId=${chainId}`)
      .then((r) => (r.ok ? r.json() : {}))
      .catch(() => ({})));
  }
  return cache.get(chainId)!;
}

export function formatUnits(amount: bigint, decimals: number): string {
  const s = amount.toString().padStart(decimals + 1, '0');
  const frac = decimals ? s.slice(-decimals).replace(/0+$/, '') : '';
  return s.slice(0, s.length - decimals) + (frac ? '.' + frac : '');
}

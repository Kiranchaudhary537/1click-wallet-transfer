import './polyfills.ts'; // must stay first
import { chains } from './chains/index.ts';

const $ = (id: string) => document.getElementById(id) as HTMLInputElement;
const log = (msg: string) => { $('log').textContent += msg + '\n'; };
const chain = () => chains.find((c) => c.id === $('chain').value)!;
const addr = (id: string, name: string) => {
  const v = $(id).value.trim();
  if (!chain().isAddress(v)) throw new Error(`Invalid ${name} address for ${chain().name}`);
  return v;
};

const refreshWallets = () => {
  const keep = $('wallet').value, ws = chain().wallets();
  $('wallet').replaceChildren(...(ws.length ? ws.map((w) => new Option(w.name, w.id)) : [new Option('No wallet detected', '')]));
  if (ws.some((w) => w.id === keep)) $('wallet').value = keep;
};
$('chain').replaceChildren(...chains.map((c) => new Option(c.name, c.id)));
const onChain = () => {
  $('rpc').value = chain().defaultRpc; $('native').textContent = chain().nativeSymbol;
  $('tokens').replaceChildren(); refreshWallets();
};
$('chain').addEventListener('change', onChain);
// Wallets announce themselves shortly after load, so re-list when the picker is opened too.
$('wallet').addEventListener('focus', refreshWallets);
onChain();
setTimeout(refreshWallets, 500);

const run = (btn: string, fn: () => Promise<void>) => $(btn).addEventListener('click', async () => {
  $(btn).disabled = true;
  try { await fn(); } catch (e) { log('ERROR: ' + ((e as Error).message ?? e)); } finally { $(btn).disabled = false; }
});

run('connect', async () => {
  $('src').value = await chain().connect($('wallet').value);
  log('Connected ' + $('src').value);
});

run('scan', async () => {
  const assets = await chain().scan($('rpc').value.trim(), addr('src', 'source'));
  // textContent, not innerHTML: symbols come from a third-party list
  $('tokens').replaceChildren(...assets.map((a) => {
    const tr = document.createElement('tr');
    for (const c of [a.symbol, a.amount, a.id, a.note ?? '']) tr.appendChild(document.createElement('td')).textContent = c;
    return tr;
  }));
  log(`${chain().name}: found ${assets.length - 1} token(s)`);
});

run('sweep', () => chain().sweep({
  rpc: $('rpc').value.trim(),
  from: addr('src', 'source'),
  to: addr('dest', 'destination'),
  keepNative: $('keep').value,
  confirm: (s) => window.confirm(s),
  log,
}));

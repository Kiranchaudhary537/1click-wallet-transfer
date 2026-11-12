import './polyfills.ts'; // must stay first
import { chains } from './chains/index.ts';

const $ = (id: string) => document.getElementById(id) as HTMLInputElement;
const log = (msg: string) => { $('log').textContent += msg + '\n'; };
const chain = () => chains.find((c) => c.id === $('chain').value)!;
const rescue = () => $('mode').value === 'rescue' && chain().rescue;
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
const onMode = () => {
  if (!chain().rescue) $('mode').value = 'wallet';
  $('rescueBox').hidden = !rescue();
  $('src').readOnly = !!rescue();
  $('connect').textContent = rescue() ? 'Connect safe wallet (pays gas)' : 'Connect source wallet';
  if (rescue()) onSecret();
};
const onSecret = () => {
  const r = rescue();
  try { $('src').value = r && $('secret').value.trim() ? r.addressOf($('secret').value) : ''; }
  catch (e) { $('src').value = ''; log('ERROR: ' + (e as Error).message); }
};
const onChain = () => {
  $('rpc').value = chain().defaultRpc; $('native').textContent = chain().nativeSymbol;
  $('tokens').replaceChildren(); refreshWallets(); onMode();
};
$('chain').addEventListener('change', onChain);
$('mode').addEventListener('change', onMode);
$('secret').addEventListener('input', onSecret);
// Wallets announce themselves shortly after load, so re-list when the picker is opened too.
$('wallet').addEventListener('focus', refreshWallets);
onChain();
setTimeout(refreshWallets, 500);

const run = (btn: string, fn: () => Promise<void>) => $(btn).addEventListener('click', async () => {
  $(btn).disabled = true;
  try { await fn(); } catch (e) { log('ERROR: ' + ((e as Error).message ?? e)); } finally { $(btn).disabled = false; }
});

run('connect', async () => {
  const address = await chain().connect($('wallet').value);
  if (rescue()) { $('dest').value ||= address; log('Safe wallet connected ' + address); }
  else { $('src').value = address; log('Connected ' + address); }
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

run('sweep', async () => {
  const opts = { rpc: $('rpc').value.trim(), to: addr('dest', 'destination'), keepNative: $('keep').value, confirm: (s: string) => window.confirm(s), log };
  const r = rescue();
  if (r) await r.sweep({ ...opts, secret: $('secret').value });
  else await chain().sweep({ ...opts, from: addr('src', 'source') });
});

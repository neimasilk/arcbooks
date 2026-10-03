import {
  createPublicClient, createWalletClient, custom, http, defineChain,
  keccak256, toBytes, toHex, encodeFunctionData, erc20Abi, parseUnits, getAddress,
} from 'https://cdn.jsdelivr.net/npm/viem@2.57.2/+esm';
import {
  ARC_MAINNET, ARC_TESTNET, NETWORKS, USDC_ERC20, MEMO_CONTRACT, createRpc, buildStatement, formatUsdc,
  isAddress, parseCsvHeader, blockAtOrAfter,
} from './statement.js';
import { REGISTRY_ADDRESS, REGISTRY_ABI, MEMO_ABI, ATTESTOR_ADDRESS, ATTESTOR_ABI, ATTESTOR_CHAIN_ID } from './config.js';

const arc = defineChain({
  id: ARC_MAINNET.id,
  name: 'Arc',
  nativeCurrency: { name: 'USDC', symbol: 'USDC', decimals: 18 },
  rpcUrls: { default: { http: [ARC_MAINNET.rpcUrl] } },
  blockExplorers: { default: { name: 'Arc Explorer', url: ARC_MAINNET.explorer } },
});

const arcTestnet = defineChain({
  id: ARC_TESTNET.id,
  name: 'Arc Testnet',
  nativeCurrency: { name: 'USDC', symbol: 'USDC', decimals: 18 },
  rpcUrls: { default: { http: [ARC_TESTNET.rpcUrl] } },
  blockExplorers: { default: { name: 'Arc Testnet Explorer', url: ARC_TESTNET.explorer } },
  testnet: true,
});

const rpcs = { [ARC_MAINNET.id]: createRpc(ARC_MAINNET.rpcUrl), [ARC_TESTNET.id]: createRpc(ARC_TESTNET.rpcUrl) };
const clients = {
  [ARC_MAINNET.id]: createPublicClient({ chain: arc, transport: http(ARC_MAINNET.rpcUrl) }),
  [ARC_TESTNET.id]: createPublicClient({ chain: arcTestnet, transport: http(ARC_TESTNET.rpcUrl) }),
};
const publicClient = clients[ARC_MAINNET.id];
let net = ARC_MAINNET; // network selected in the Statement tab
const rpcFor = (id) => rpcs[id] || rpcs[ARC_MAINNET.id];
const registryLive = REGISTRY_ADDRESS !== '0x0000000000000000000000000000000000000000';

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const short = (a) => (a ? a.slice(0, 6) + '…' + a.slice(-4) : '');
const txLink = (h, n = net) => `<a href="${n.explorer}/tx/${h}" target="_blank" rel="noreferrer" class="mono">${short(h)}</a>`;
const addrLink = (a, n = net) => `<a href="${n.explorer}/address/${a}" target="_blank" rel="noreferrer" class="mono">${short(a)}</a>`;
const fmt2 = (wei) => {
  const s = formatUsdc(wei);
  const [w, f = ''] = s.split('.');
  const neg = w.startsWith('-');
  const ww = (neg ? w.slice(1) : w).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return (neg ? '-' : '') + ww + '.' + (f + '00').slice(0, 2) + (f.length > 2 ? '…' : '');
};
const notice = (kind, html) => `<div class="notice ${kind}">${html}</div>`;

// ---------- tabs
function showTab(name) {
  document.querySelectorAll('nav button').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.tab === name)));
  for (const t of ['statement', 'verify', 'request', 'about', 'pay']) $('tab-' + t).classList.toggle('hidden', t !== name);
}
document.querySelectorAll('nav button').forEach((b) => b.addEventListener('click', () => showTab(b.dataset.tab)));
$('aboutRegistry').textContent = registryLive ? REGISTRY_ADDRESS : '(not yet deployed)';

// ---------- wallet
let walletClient = null, walletAccount = null;
async function connect() {
  if (!window.ethereum) throw new Error('No browser wallet found. Install MetaMask or Rabby.');
  walletClient = createWalletClient({ chain: arc, transport: custom(window.ethereum) });
  [walletAccount] = await walletClient.requestAddresses();
  try {
    await walletClient.switchChain({ id: arc.id });
  } catch (e) {
    await walletClient.addChain({ chain: arc });
    await walletClient.switchChain({ id: arc.id });
  }
  $('connectBtn').textContent = short(walletAccount);
  return walletAccount;
}
$('connectBtn').addEventListener('click', () => connect().catch((e) => alert(e.shortMessage || e.message)));

// ---------- statement
$('network').addEventListener('change', () => {
  net = NETWORKS[Number($('network').value)] || ARC_MAINNET;
});
$('preset').addEventListener('change', () => {
  $('datesRow').classList.toggle('hidden', $('preset').value !== 'dates');
  $('blocksRow').classList.toggle('hidden', $('preset').value !== 'blocks');
});

async function resolveRange() {
  const rpc = rpcFor(net.id);
  const latest = Number(BigInt(await rpc('eth_blockNumber', [])));
  const head = latest - 2;
  const p = $('preset').value;
  if (p === 'blocks') {
    const a = parseInt($('fromBlock').value, 10), b = parseInt($('toBlock').value, 10);
    if (!(a > 0 && b >= a && b <= head)) throw new Error(`Enter a valid block range (latest safe block is ${head}).`);
    return [a, b];
  }
  if (p === 'dates') {
    const f = Date.parse($('fromDate').value + 'Z') / 1000, t = Date.parse($('toDate').value + 'Z') / 1000;
    if (!(f > 0 && t > f)) throw new Error('Pick a valid UTC date range.');
    $('genStatus').textContent = 'Locating blocks for those dates…';
    const a = await blockAtOrAfter(rpc, f, head);
    const b = (await blockAtOrAfter(rpc, t, head)) - 1;
    if (b < a) throw new Error('No blocks in that range.');
    return [a, b];
  }
  const secs = { '1h': 3600, '24h': 86400, '7d': 604800 }[p];
  const now = Number(BigInt((await rpc('eth_getBlockByNumber', ['0x' + head.toString(16), false])).timestamp));
  $('genStatus').textContent = 'Locating start block…';
  const a = await blockAtOrAfter(rpc, now - secs, head);
  return [a, head];
}

let current = null;

$('genBtn').addEventListener('click', async () => {
  const acct = $('acct').value.trim();
  if (!isAddress(acct)) { $('genStatus').textContent = 'Enter a valid 0x address.'; return; }
  $('genBtn').disabled = true;
  $('result').classList.add('hidden');
  try {
    const [from, to] = await resolveRange();
    const prog = $('genProgress');
    prog.classList.remove('hidden'); prog.value = 0;
    $('genStatus').textContent = `Scanning blocks ${from.toLocaleString()}–${to.toLocaleString()}…`;
    const t0 = performance.now();
    const st = await buildStatement(rpcFor(net.id), acct, from, to, {
      chainId: net.id,
      onProgress: (d, n) => { prog.max = n; prog.value = d; },
    });
    st.hash = keccak256(toBytes(st.csv));
    current = st;
    renderStatement(st);
    $('genStatus').textContent = `Done in ${((performance.now() - t0) / 1000).toFixed(1)} s.`;
    history.replaceState(null, '', `?account=${acct}&from=${from}&to=${to}${net.id === ARC_TESTNET.id ? '&net=testnet' : ''}`);
  } catch (e) {
    $('genStatus').textContent = 'Error: ' + (e.shortMessage || e.message);
  } finally {
    $('genBtn').disabled = false;
    $('genProgress').classList.add('hidden');
  }
});

function renderStatement(st) {
  const s = st.summary;
  $('result').classList.remove('hidden');
  $('resMeta').innerHTML = `${addrLink(s.account)} · blocks ${s.fromBlock.toLocaleString()} → ${s.toBlock.toLocaleString()} · ${s.count.toLocaleString()} transfers`;
  const stat = (k, v, cls = '') => `<div class="stat"><div class="k">${k}</div><div class="v ${cls}">${v}</div></div>`;
  $('resStats').innerHTML =
    stat('Opening balance', fmt2(s.opening)) +
    stat('Money in', '+' + fmt2(s.totalIn), 'in') +
    stat('Money out', '−' + fmt2(s.totalOut), 'out') +
    stat('Fees & non-logged', fmt2(s.unexplained)) +
    stat('Closing balance', fmt2(s.closing));
  $('reconcile').innerHTML = s.unexplained === 0n
    ? notice('ok', '✔ Fully reconciled: opening + in − out equals the onchain closing balance to the last wei.')
    : s.unexplained < 0n
      ? notice('warn', `Reconciled with <b>${formatUsdc(-s.unexplained)} USDC</b> of gas fees (and any other movement that emits no Transfer log). On Arc, fees are paid in USDC and do not produce Transfer events.`)
      : notice('bad', `Unexpected: balance grew by ${formatUsdc(s.unexplained)} USDC more than logged inflows. Please report this.`);
  $('resHash').textContent = st.hash;
  $('tableNote').textContent = st.rows.length > 1000 ? `Showing the first 1,000 of ${st.rows.length.toLocaleString()} transfers. The CSV contains all of them.` : '';
  $('rows').innerHTML = st.rows.slice(0, 1000).map((r) => `<tr>
      <td class="mono">${r.block}</td>
      <td class="${r.direction}">${r.direction === 'in' ? 'IN' : 'OUT'}</td>
      <td>${r.counterpartyLabel ? `<b>${r.counterpartyLabel}</b>` : addrLink(r.counterparty)}</td>
      <td class="num ${r.direction}">${r.direction === 'in' ? '+' : '−'}${esc(formatUsdc(r.amountWei))}</td>
      <td>${esc(r.memo)}</td>
      <td>${txLink(r.txHash)}</td></tr>`).join('') || '<tr><td colspan="6" class="muted">No USDC transfers in this range.</td></tr>';
  const isTestnet = s.chainId === ARC_TESTNET.id;
  $('anchorBtn').classList.toggle('hidden', isTestnet);
  $('anchorStatus').textContent = isTestnet
    ? 'On Arc Testnet, statements are attested automatically by the Chainlink CRE workflow (see How it works).'
    : (registryLive ? '' : 'Registry not deployed yet.');
  $('anchorBtn').disabled = !registryLive;
  showAnchors(st.hash, $('existingAnchors'), s.chainId);
}

function download(name, text) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type: 'text/csv' }));
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
const baseName = () => `arcbooks_${current.summary.account.slice(0, 8)}_${current.summary.fromBlock}-${current.summary.toBlock}`;
$('dlCanonical').addEventListener('click', () => current && download(baseName() + '.csv', current.csv));
$('dlReport').addEventListener('click', () => {
  if (!current) return;
  const rate = parseFloat(($('idrRate').value || '').replace(/,/g, ''));
  const hasRate = rate > 0;
  const head = ['block', 'tx_hash', 'direction', 'counterparty', 'amount_usdc', ...(hasRate ? ['amount_idr'] : []), 'running_balance_usdc_before_fees', 'memo'];
  const lines = [head.join(',')];
  for (const r of current.rows) {
    const usdc = formatUsdc(r.amountWei);
    const cells = [r.block, r.txHash, r.direction, r.counterparty, usdc,
      ...(hasRate ? [Math.round(parseFloat(usdc) * rate)] : []),
      formatUsdc(r.runningBeforeFeesWei), r.memo];
    lines.push(cells.map((c) => (/[",\n]/.test(String(c)) ? `"${String(c).replace(/"/g, '""')}"` : c)).join(','));
  }
  download(baseName() + '_report.csv', lines.join('\n') + '\n');
});

async function showCre(hash, el) {
  const tn = NETWORKS[ATTESTOR_CHAIN_ID];
  try {
    const a = await clients[ATTESTOR_CHAIN_ID].readContract({ address: ATTESTOR_ADDRESS, abi: ATTESTOR_ABI, functionName: 'getAttestation', args: [hash] });
    if (!a.attestedAt) { el.innerHTML = '<div class="muted" style="margin-top:8px">No Chainlink CRE attestation for this exact statement.</div>'; return []; }
    const rate = a.usdIdrRateE6 ? Number(a.usdIdrRateE6) / 1e6 : 0;
    const idr = rate ? ' ≈ Rp' + Math.round(Number(formatUsdc(a.closingBalanceWei)) * rate).toLocaleString('id-ID') : '';
    const genesis = /^0x0+$/.test(a.prevHash);
    el.innerHTML = notice('ok', `✔ Attested by the <b>Chainlink CRE</b> workflow at block ${a.attestedAt} on Arc Testnet (contract ${addrLink(ATTESTOR_ADDRESS, tn)}).<br/>`
      + `Blocks ${a.fromBlock}–${a.toBlock}, ${a.transfers} transfers, closing ${esc(formatUsdc(a.closingBalanceWei))} USDC${idr}`
      + (rate ? ` (USD/IDR ${rate.toLocaleString('en-US', { maximumFractionDigits: 2 })} from an external FX API, DON median)` : '')
      + `<br/>${genesis ? 'Genesis checkpoint.' : 'Previous checkpoint: <span class="mono">' + esc(a.prevHash) + '</span>'}`);
    return [a];
  } catch (e) {
    el.innerHTML = notice('bad', 'Attestor lookup failed: ' + esc(e.shortMessage || e.message));
    return [];
  }
}

async function showAnchors(hash, el, chainId = ARC_MAINNET.id) {
  if (chainId === ATTESTOR_CHAIN_ID) return showCre(hash, el);
  if (!registryLive) { el.innerHTML = ''; return []; }
  try {
    const anchors = await publicClient.readContract({ address: REGISTRY_ADDRESS, abi: REGISTRY_ABI, functionName: 'getAnchors', args: [hash] });
    el.innerHTML = anchors.length
      ? notice('ok', `Anchored ${anchors.length}×: ` + anchors.map((a) => `${addrLink(a.attester)} at block ${a.anchoredAt}${a.label ? ` (“${esc(a.label)}”)` : ''}`).join('; '))
      : '<div class="muted" style="margin-top:8px">Not anchored yet.</div>';
    return anchors;
  } catch (e) {
    el.innerHTML = notice('bad', 'Registry lookup failed: ' + esc(e.shortMessage || e.message));
    return [];
  }
}

$('anchorBtn').addEventListener('click', async () => {
  if (!current) return;
  const s = current.summary;
  const label = $('label').value.trim();
  if (new TextEncoder().encode(label).length > 96) { $('anchorStatus').textContent = 'Label too long.'; return; }
  try {
    $('anchorBtn').disabled = true;
    await connect();
    $('anchorStatus').textContent = 'Confirm in your wallet…';
    const hash = await walletClient.writeContract({
      account: walletAccount, address: REGISTRY_ADDRESS, abi: REGISTRY_ABI, functionName: 'anchor',
      args: [current.hash, getAddress(s.account), BigInt(s.fromBlock), BigInt(s.toBlock), label],
    });
    $('anchorStatus').innerHTML = 'Submitted ' + txLink(hash) + ' — waiting…';
    const rc = await publicClient.waitForTransactionReceipt({ hash });
    $('anchorStatus').innerHTML = rc.status === 'success' ? '✔ Anchored in ' + txLink(hash) : 'Transaction reverted ' + txLink(hash);
    showAnchors(current.hash, $('existingAnchors'));
  } catch (e) {
    $('anchorStatus').textContent = 'Error: ' + (e.shortMessage || e.message);
  } finally {
    $('anchorBtn').disabled = false;
  }
});

// ---------- verify
let verifyText = null;
$('verifyFile').addEventListener('change', async () => {
  const f = $('verifyFile').files[0];
  if (!f) return;
  verifyText = await f.text();
  const meta = parseCsvHeader(verifyText);
  const hash = keccak256(toBytes(verifyText));
  const out = $('verifyOut');
  if (!meta['arcbooks-statement-v1'] && !verifyText.startsWith('# arcbooks-statement-v1')) {
    out.innerHTML = notice('bad', 'This is not an ArcBooks canonical statement (missing header).');
    $('rederiveBtn').classList.add('hidden');
    return;
  }
  const chainId = Number(meta.chain_id) || ARC_MAINNET.id;
  const netName = (NETWORKS[chainId] || { name: 'unknown chain ' + chainId }).name;
  out.innerHTML = `<p class="muted">${esc(netName)} · account <span class="mono">${esc(meta.account)}</span>, blocks ${esc(meta.from_block)}–${esc(meta.to_block)}<br/>Hash <span class="mono">${hash}</span></p><div id="verifyAnchors"></div>`;
  const anchors = await showAnchors(hash, $('verifyAnchors'), chainId);
  if (!anchors.length) $('verifyAnchors').innerHTML = notice('warn', 'No onchain anchor or CRE attestation for this exact file. It may have been modified, or it was never anchored.');
  $('rederiveBtn').classList.remove('hidden');
  $('rederiveStatus').textContent = '';
});

$('rederiveBtn').addEventListener('click', async () => {
  if (!verifyText) return;
  const meta = parseCsvHeader(verifyText);
  $('rederiveBtn').disabled = true;
  const prog = $('verifyProgress');
  prog.classList.remove('hidden');
  try {
    $('rederiveStatus').textContent = 'Re-deriving from Arc chain data…';
    const chainId = Number(meta.chain_id) || ARC_MAINNET.id;
    if (!NETWORKS[chainId]) throw new Error('Unsupported chain_id ' + chainId);
    const st = await buildStatement(rpcFor(chainId), meta.account, Number(meta.from_block), Number(meta.to_block), {
      chainId,
      onProgress: (d, n) => { prog.max = n; prog.value = d; },
    });
    const same = st.csv === verifyText;
    $('rederiveStatus').innerHTML = same
      ? '<span class="in">✔ Identical: every line of this file matches the chain.</span>'
      : '<span class="out">✘ Differs from chain data. This file has been altered or is from a different period.</span>';
  } catch (e) {
    $('rederiveStatus').textContent = 'Error: ' + (e.shortMessage || e.message);
  } finally {
    $('rederiveBtn').disabled = false;
    prog.classList.add('hidden');
  }
});

// ---------- payment request
$('reqBtn').addEventListener('click', () => {
  const to = $('reqTo').value.trim(), amount = $('reqAmount').value.trim(), ref = $('reqRef').value.trim();
  const out = $('reqOut');
  if (!isAddress(to)) { out.innerHTML = notice('bad', 'Enter a valid address.'); return; }
  if (!/^\d+(\.\d{1,6})?$/.test(amount) || Number(amount) <= 0) { out.innerHTML = notice('bad', 'Amount must be a positive number with up to 6 decimals.'); return; }
  if (!ref) { out.innerHTML = notice('bad', 'Add a reference such as an invoice number.'); return; }
  const url = `${location.origin}${location.pathname}?pay=${to}&amount=${amount}&ref=${encodeURIComponent(ref)}`;
  out.innerHTML = `<p>Share this link:</p><p class="mono"><a href="${esc(url)}">${esc(url)}</a></p>
    <div class="actions"><button class="btn secondary" id="copyReq">Copy link</button></div>`;
  $('copyReq').onclick = () => navigator.clipboard.writeText(url);
});

async function setupPay(params) {
  const to = params.get('pay'), amount = params.get('amount'), ref = params.get('ref') || '';
  if (!isAddress(to) || !/^\d+(\.\d{1,6})?$/.test(amount || '')) return false;
  document.querySelector('nav').classList.add('hidden');
  showTab('pay');
  $('payTo').textContent = to;
  $('payAmount').textContent = `${amount} USDC`;
  $('payRef').textContent = ref || '(none)';
  $('payBtn').addEventListener('click', async () => {
    try {
      $('payBtn').disabled = true;
      await connect();
      const data = encodeFunctionData({ abi: erc20Abi, functionName: 'transfer', args: [getAddress(to), parseUnits(amount, 6)] });
      const memoId = keccak256(toBytes(ref));
      $('payStatus').innerHTML = '<p class="muted">Confirm in your wallet…</p>';
      const hash = await walletClient.writeContract({
        account: walletAccount, address: MEMO_CONTRACT, abi: MEMO_ABI, functionName: 'memo',
        args: [USDC_ERC20, data, memoId, toHex(ref)],
      });
      $('payStatus').innerHTML = `<p class="muted">Submitted ${txLink(hash)} — waiting…</p>`;
      const rc = await publicClient.waitForTransactionReceipt({ hash });
      $('payStatus').innerHTML = rc.status === 'success'
        ? notice('ok', `✔ Paid. Transaction ${txLink(hash)}. Arc finality is sub-second, so this is final.`)
        : notice('bad', `Transaction reverted: ${txLink(hash)}`);
    } catch (e) {
      $('payStatus').innerHTML = notice('bad', esc(e.shortMessage || e.message));
    } finally {
      $('payBtn').disabled = false;
    }
  });
  return true;
}

// ---------- boot from URL
(async () => {
  const params = new URLSearchParams(location.search);
  if (await setupPay(params)) return;
  if (params.get('net') === 'testnet') { net = ARC_TESTNET; $('network').value = String(ARC_TESTNET.id); }
  const a = params.get('account'), f = params.get('from'), t = params.get('to');
  if (isAddress(a || '')) {
    $('acct').value = a;
    if (f && t) {
      $('preset').value = 'blocks';
      $('blocksRow').classList.remove('hidden');
      $('fromBlock').value = f; $('toBlock').value = t;
      $('genBtn').click();
    }
  }
})();

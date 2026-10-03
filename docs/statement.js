// ArcBooks core: builds deterministic USDC statements for an Arc address.
// Runs in the browser and in Node (pass any EIP-1193-like `rpc(method, params)` function).

export const ARC_MAINNET = {
  id: 5042,
  name: 'Arc',
  rpcUrl: 'https://rpc.mainnet.arc.io',
  explorer: 'https://explorer.arc.io',
};

export const ARC_TESTNET = {
  id: 5042002,
  name: 'Arc Testnet',
  rpcUrl: 'https://rpc.blockdaemon.testnet.arc.io',
  explorer: 'https://explorer.testnet.arc.io',
};

export const NETWORKS = { [ARC_MAINNET.id]: ARC_MAINNET, [ARC_TESTNET.id]: ARC_TESTNET };

// Native USDC system emitter (EIP-7708 Transfer logs, 18 decimals)
export const NATIVE_EMITTER = '0xfffffffffffffffffffffffffffffffffffffffe';
// ERC-20 USDC interface (6 decimals) — NOT indexed for amounts, to avoid double counting
export const USDC_ERC20 = '0x3600000000000000000000000000000000000000';
// Predeployed Memo contract
export const MEMO_CONTRACT = '0x5294e9927c3306dcbadb03fe70b92e01ccede505';

export const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
// keccak256("Memo(address,address,bytes32,bytes32,bytes,uint256)")
export const MEMO_TOPIC = '0xeb15ee720798341c37739df41be53acfbbf70ae6802dade35457beec6e47a5e4';

export const MAX_RANGE = 9999; // RPC limit: blocks per eth_getLogs
export const STATEMENT_VERSION = 'arcbooks-statement-v1';

const ZERO = '0x0000000000000000000000000000000000000000';

const memoTopic = MEMO_TOPIC;

export function createRpc(url, fetchImpl = fetch) {
  let id = 0;
  return async function rpc(method, params, attempt = 0) {
    const res = await fetchImpl(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }),
    });
    if (res.status === 429 || res.status >= 500) {
      if (attempt < 5) {
        await new Promise((r) => setTimeout(r, 400 * 2 ** attempt));
        return rpc(method, params, attempt + 1);
      }
      throw new Error(`RPC HTTP ${res.status}`);
    }
    const body = await res.json();
    if (body.error) {
      const err = new Error(body.error.message || 'RPC error');
      err.rpc = body.error;
      throw err;
    }
    return body.result;
  };
}

const hex = (n) => '0x' + BigInt(n).toString(16);
const topicAddr = (a) => '0x' + a.toLowerCase().replace(/^0x/, '').padStart(64, '0');
const addrFromTopic = (t) => '0x' + t.slice(-40).toLowerCase();

export function isAddress(a) {
  return typeof a === 'string' && /^0x[0-9a-fA-F]{40}$/.test(a);
}

/** Format an 18-decimal wei amount as an exact decimal USDC string. */
export function formatUsdc(wei) {
  const neg = wei < 0n;
  let v = neg ? -wei : wei;
  const whole = v / 10n ** 18n;
  let frac = (v % 10n ** 18n).toString().padStart(18, '0').replace(/0+$/, '');
  return (neg ? '-' : '') + whole.toString() + (frac ? '.' + frac : '');
}

/** Run async tasks with bounded concurrency, preserving order. */
export async function pool(items, limit, fn, onProgress) {
  const out = new Array(items.length);
  let next = 0, done = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
      done++;
      onProgress && onProgress(done, items.length);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

/** eth_getLogs over [from,to] that splits on range/result-size limits. */
export async function getLogsSplit(rpc, filter, from, to) {
  try {
    return await rpc('eth_getLogs', [{ ...filter, fromBlock: hex(from), toBlock: hex(to) }]);
  } catch (e) {
    const msg = (e.message || '').toLowerCase();
    if (to > from && (msg.includes('max results') || msg.includes('range') || msg.includes('too large') || msg.includes('limit'))) {
      const mid = from + Math.floor((to - from) / 2);
      const [a, b] = await Promise.all([getLogsSplit(rpc, filter, from, mid), getLogsSplit(rpc, filter, mid + 1, to)]);
      return a.concat(b);
    }
    throw e;
  }
}

export function chunkRange(from, to, size = MAX_RANGE) {
  const chunks = [];
  for (let s = from; s <= to; s += size) chunks.push([s, Math.min(s + size - 1, to)]);
  return chunks;
}

// ---- minimal ABI decoding for the Memo event data: (bytes32 callDataHash, bytes memo, uint256 memoIndex)
function decodeMemoData(data) {
  const d = data.replace(/^0x/, '');
  const word = (i) => d.slice(i * 64, i * 64 + 64);
  const offset = Number(BigInt('0x' + word(1))) / 32;
  const memoIndex = BigInt('0x' + word(2));
  const len = Number(BigInt('0x' + word(offset)));
  const bytesHex = d.slice((offset + 1) * 64, (offset + 1) * 64 + len * 2);
  return { callDataHash: '0x' + word(0), memoHex: '0x' + bytesHex, memoIndex };
}

export function memoToText(memoHex) {
  const h = memoHex.replace(/^0x/, '');
  if (!h) return '';
  const bytes = new Uint8Array(h.match(/../g).map((b) => parseInt(b, 16)));
  try {
    const s = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    if (/^[\x20-\x7E -￿]*$/.test(s)) return s;
  } catch (_) { /* not utf-8 */ }
  return memoHex;
}

const csvCell = (v) => {
  const s = String(v ?? '');
  return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
};

/**
 * Build a statement for `account` over blocks [fromBlock, toBlock].
 * Returns rows + canonical CSV (deterministic: same chain data => same bytes).
 */
export async function buildStatement(rpc, account, fromBlock, toBlock, { concurrency = 4, onProgress, chainId = ARC_MAINNET.id } = {}) {
  if (!isAddress(account)) throw new Error('Invalid address');
  account = account.toLowerCase();
  fromBlock = Number(fromBlock); toBlock = Number(toBlock);
  if (!(fromBlock >= 1) || !(toBlock >= fromBlock)) throw new Error('Invalid block range');

  const chunks = chunkRange(fromBlock, toBlock);
  const tasks = [];
  for (const [a, b] of chunks) {
    tasks.push({ kind: 'out', a, b, filter: { address: NATIVE_EMITTER, topics: [TRANSFER_TOPIC, topicAddr(account)] } });
    tasks.push({ kind: 'in', a, b, filter: { address: NATIVE_EMITTER, topics: [TRANSFER_TOPIC, null, topicAddr(account)] } });
    tasks.push({ kind: 'memo', a, b, filter: { address: MEMO_CONTRACT, topics: [memoTopic] } });
  }

  const [openingHex, closingHex] = await Promise.all([
    rpc('eth_getBalance', [account, hex(fromBlock - 1)]),
    rpc('eth_getBalance', [account, hex(toBlock)]),
  ]);

  const results = await pool(tasks, concurrency, (t) => getLogsSplit(rpc, t.filter, t.a, t.b), onProgress);

  const transfers = [];
  const memosByTx = new Map();
  results.forEach((logs, i) => {
    const kind = tasks[i].kind;
    for (const log of logs) {
      if (kind === 'memo') {
        const { memoHex, memoIndex } = decodeMemoData(log.data);
        const entry = { memoId: log.topics[3], memo: memoToText(memoHex), memoIndex };
        const k = log.transactionHash.toLowerCase();
        if (!memosByTx.has(k)) memosByTx.set(k, []);
        memosByTx.get(k).push(entry);
      } else {
        // Defensive: only accept the system emitter + Transfer topic
        if (log.address.toLowerCase() !== NATIVE_EMITTER || log.topics[0] !== TRANSFER_TOPIC) continue;
        const from = addrFromTopic(log.topics[1]);
        const to = addrFromTopic(log.topics[2]);
        transfers.push({
          block: Number(BigInt(log.blockNumber)),
          txHash: log.transactionHash.toLowerCase(),
          logIndex: Number(BigInt(log.logIndex)),
          direction: kind,
          counterparty: kind === 'in' ? from : to,
          amountWei: BigInt(log.data),
        });
      }
    }
  });

  // de-duplicate (a split retry could theoretically overlap) and sort deterministically
  const seen = new Set();
  const rows = transfers
    .filter((t) => {
      const k = `${t.txHash}:${t.logIndex}:${t.direction}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    })
    .sort((x, y) => x.block - y.block || x.logIndex - y.logIndex || (x.direction < y.direction ? -1 : 1));

  for (const r of rows) {
    const memos = (memosByTx.get(r.txHash) || []).sort((a, b) => (a.memoIndex < b.memoIndex ? -1 : 1));
    r.memoId = memos.map((m) => m.memoId).join('|');
    r.memo = memos.map((m) => m.memo).join('|');
    r.counterpartyLabel = r.counterparty === ZERO ? (r.direction === 'in' ? 'MINT' : 'BURN') : '';
  }

  const opening = BigInt(openingHex);
  const closing = BigInt(closingHex);
  const totalIn = rows.filter((r) => r.direction === 'in').reduce((s, r) => s + r.amountWei, 0n);
  const totalOut = rows.filter((r) => r.direction === 'out').reduce((s, r) => s + r.amountWei, 0n);
  // Gas fees emit no Transfer log; whatever is unexplained is fees (and any non-logged movement).
  const unexplained = closing - opening - totalIn + totalOut;

  let running = opening;
  for (const r of rows) {
    running += r.direction === 'in' ? r.amountWei : -r.amountWei;
    r.runningBeforeFeesWei = running;
  }

  const summary = { chainId, account, fromBlock, toBlock, opening, closing, totalIn, totalOut, unexplained, count: rows.length };
  const csv = canonicalCsv(summary, rows);
  return { summary, rows, csv };
}

export function canonicalCsv(s, rows) {
  const lines = [
    `# ${STATEMENT_VERSION}`,
    `# chain_id,${s.chainId ?? ARC_MAINNET.id}`,
    `# account,${s.account}`,
    `# from_block,${s.fromBlock}`,
    `# to_block,${s.toBlock}`,
    `# opening_balance_usdc,${formatUsdc(s.opening)}`,
    `# closing_balance_usdc,${formatUsdc(s.closing)}`,
    `# total_in_usdc,${formatUsdc(s.totalIn)}`,
    `# total_out_usdc,${formatUsdc(s.totalOut)}`,
    `# fees_and_unlogged_usdc,${formatUsdc(-s.unexplained)}`,
    `# transfers,${s.count}`,
    'block,tx_hash,log_index,direction,counterparty,amount_usdc,memo_id,memo',
  ];
  for (const r of rows) {
    lines.push([r.block, r.txHash, r.logIndex, r.direction, r.counterparty, formatUsdc(r.amountWei), r.memoId, r.memo].map(csvCell).join(','));
  }
  return lines.join('\n') + '\n';
}

/** Parse the header of a canonical CSV (for verification UI). */
export function parseCsvHeader(text) {
  const meta = {};
  for (const line of text.split('\n')) {
    if (!line.startsWith('# ')) break;
    const [k, ...rest] = line.slice(2).split(',');
    meta[k] = rest.join(',');
  }
  return meta;
}

/** Find the first block with timestamp >= ts (binary search). */
export async function blockAtOrAfter(rpc, ts, latest) {
  let lo = 1, hi = latest;
  const tsOf = async (n) => Number(BigInt((await rpc('eth_getBlockByNumber', [hex(n), false])).timestamp));
  if (ts <= (await tsOf(lo))) return lo;
  if (ts > (await tsOf(hi))) return hi;
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    if ((await tsOf(mid)) < ts) lo = mid + 1; else hi = mid;
  }
  return lo;
}

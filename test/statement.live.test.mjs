// Live test against Arc mainnet RPC (read-only).
import { createRpc, buildStatement, ARC_MAINNET, formatUsdc, parseCsvHeader } from '../docs/statement.js';
import assert from 'node:assert/strict';

assert.equal(formatUsdc(0n), '0');
assert.equal(formatUsdc(1n), '0.000000000000000001');
assert.equal(formatUsdc(1500000000000000000n), '1.5');
assert.equal(formatUsdc(-2n * 10n ** 18n), '-2');

const rpc = createRpc(ARC_MAINNET.rpcUrl);
const latest = Number(BigInt(await rpc('eth_blockNumber', [])));
const acct = process.argv[2] || '0x8366a39cc670b4001a1121b8f6a443a643e40951';
const span = Number(process.argv[3] || 3000);
const from = latest - span, to = latest - 10;
const t0 = Date.now();
const st = await buildStatement(rpc, acct, from, to, { onProgress: (d, n) => d === n && console.log(`  ${n} requests done`) });
const s = st.summary;
console.log(`account ${acct} blocks ${from}-${to} (${span}) in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
console.log(`rows=${s.count} in=${formatUsdc(s.totalIn)} out=${formatUsdc(s.totalOut)} opening=${formatUsdc(s.opening)} closing=${formatUsdc(s.closing)} unexplained=${formatUsdc(s.unexplained)}`);
// Reconciliation: unexplained must be <= 0 (gas fees reduce balance) and tiny relative to flows
assert.ok(s.unexplained <= 0n, 'unexplained should be non-positive (fees)');
// Determinism: second run must produce identical CSV bytes
const st2 = await buildStatement(rpc, acct, from, to);
assert.equal(st2.csv, st.csv, 'statement must be deterministic');
const meta = parseCsvHeader(st.csv);
assert.equal(meta.account, acct.toLowerCase());
assert.equal(Number(meta.from_block), from);
console.log(st.csv.split('\n').slice(0, 15).join('\n'));
console.log('OK');

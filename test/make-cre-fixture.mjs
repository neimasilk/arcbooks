// Dumps raw Arc testnet logs + balances for an account/range and the JS canonical CSV,
// so the Go port in cre/attest can be checked for byte-identical output.
import { createRpc, buildStatement, ARC_TESTNET, ARC_MAINNET, NATIVE_EMITTER, TRANSFER_TOPIC, MEMO_CONTRACT, MEMO_TOPIC, getLogsSplit } from '../docs/statement.js';
import { writeFileSync } from 'node:fs';
const [account, from, to, out] = process.argv.slice(2);
const NET = process.env.NET === 'mainnet' ? ARC_MAINNET : ARC_TESTNET;
const rpc = createRpc(NET.rpcUrl);
const t = (a) => '0x' + a.toLowerCase().replace(/^0x/, '').padStart(64, '0');
const [fromB, toB] = [Number(from), Number(to)];
const outLogs = await getLogsSplit(rpc, { address: NATIVE_EMITTER, topics: [TRANSFER_TOPIC, t(account)] }, fromB, toB);
const inLogs = await getLogsSplit(rpc, { address: NATIVE_EMITTER, topics: [TRANSFER_TOPIC, null, t(account)] }, fromB, toB);
const memoLogs = await getLogsSplit(rpc, { address: MEMO_CONTRACT, topics: [MEMO_TOPIC] }, fromB, toB);
const opening = await rpc('eth_getBalance', [account, '0x' + (fromB - 1).toString(16)]);
const closing = await rpc('eth_getBalance', [account, '0x' + toB.toString(16)]);
const st = await buildStatement(rpc, account, fromB, toB, { chainId: NET.id });
writeFileSync(out + '.json', JSON.stringify({ chainId: NET.id, account, fromBlock: fromB, toBlock: toB, opening, closing, outLogs, inLogs, memoLogs }, null, 1));
writeFileSync(out + '.csv', st.csv);
console.log(`out=${outLogs.length} in=${inLogs.length} memo=${memoLogs.length} rows=${st.summary.count} unexplained=${st.summary.unexplained}`);

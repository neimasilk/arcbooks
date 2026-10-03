# ArcBooks

**Exact, reconciled, verifiable USDC account statements for Arc.**

**Live app:** https://neimasilk.github.io/arcbooks/ · **Contract (Arc mainnet):** [`0xe048B7592D0aCb55f01d06013Df6961ABF9Fdb9C`](https://explorer.arc.io/address/0xe048B7592D0aCb55f01d06013Df6961ABF9Fdb9C)

ArcBooks turns any Arc address into a bookkeeping-grade USDC statement in seconds, with no backend, indexer, or API key. Each statement:

- counts **every USDC movement exactly once at full 18-decimal precision**,
- **reconciles to the wei** against the onchain opening and closing balances, and reports gas fees explicitly,
- shows the **invoice or order reference** attached through Arc's native `Memo` contract,
- exports a **deterministic CSV** whose keccak256 hash can be **anchored onchain**, so an auditor, bank, or tax consultant can verify the file without trusting the sender.

It also creates **payment-request links** that pay through `Memo`, so incoming payments reconcile themselves.

## Why this is Arc-specific

USDC on Arc is both the native gas token (18 decimals) and an ERC-20 (6 decimals) over one shared balance. As a result:

| Pitfall | What naive tools do | ArcBooks |
|---|---|---|
| An ERC-20 `transfer()` emits two `Transfer` logs (USDC contract `0x3600…` at 6 dp **and** system emitter `0xffff…fffe` at 18 dp, per EIP-7708) | Double-count | Reads only the system-emitter stream, so each movement is counted once |
| Native sends emit only the system log | Miss them when indexing the ERC-20 | Included |
| The 6-decimal ERC-20 view truncates sub-cent amounts | Lose precision | Exact 18-decimal arithmetic (`BigInt`) |
| Gas fees emit no `Transfer` | Balances silently drift | `opening + in − out` is compared with the onchain closing balance, and the difference is reported as fees |
| Payment references live in `Memo` events | Ignored | Joined to transfers by transaction |
| RPC `eth_getLogs` caps (9,999 blocks / 2,000 results) | Fail on busy accounts | Chunked and adaptively split with bounded concurrency |

Tested live on mainnet: a busy account with **3,631 transfers in 3,000 blocks reconciles with 0 wei difference**, and two independent runs produce byte-identical CSVs.

## How verification works

1. **Generate**: pick an address and period. ArcBooks scans the chain and builds the canonical CSV (`arcbooks-statement-v1`).
2. **Anchor**: `StatementRegistry.anchor(hash, account, fromBlock, toBlock, label)` stores the hash in contract storage. Multiple parties (the business and its accountant, for example) can co-attest.
3. **Verify**: the recipient drops the CSV into the Verify tab. It is hashed locally and looked up with a single `getAnchors(hash)` view call. **Re-derive** regenerates the statement from public chain data and compares it byte for byte, which proves the contents are true and not just unchanged.

## Payment requests with memos

`?pay=<address>&amount=<usdc>&ref=<reference>` opens a payment page. The payer's wallet calls
`Memo.memo(USDC, transfer(to, amount), keccak256(ref), ref)` on Arc's predeployed `Memo` contract (`0x5294E9927c3306DcBaDb03fe70b92e01cCede505`). The `CallFrom` precompile keeps the payer as `msg.sender`, and the reference is emitted onchain next to the transfer. The recipient's statement then shows the reference automatically.

## Repository layout

```
contracts/   Foundry project: StatementRegistry.sol + tests (unit + fuzz)
docs/        Static app (GitHub Pages) (no build step): index.html, app.js, statement.js (core), config.js
test/        Live mainnet test for the statement engine (Node 22+)
scripts/     Deployment helper
```

## Run locally

```bash
# app
cd docs && python -m http.server 8765    # open http://127.0.0.1:8765

# engine test against Arc mainnet (read-only)
node test/statement.live.test.mjs [address] [blocks]

# contracts
cd contracts && forge install foundry-rs/forge-std && forge test
```

## Deployment

| Item | Value |
|---|---|
| Network | Arc mainnet (chain id 5042) |
| StatementRegistry | [`0xe048B7592D0aCb55f01d06013Df6961ABF9Fdb9C`](https://explorer.arc.io/address/0xe048B7592D0aCb55f01d06013Df6961ABF9Fdb9C) |
| Deploy tx | [`0xd154b94d…6d8eda`](https://explorer.arc.io/tx/0xd154b94d168ccf1ef4847f54d7897c028dc158525e6cdc38241962d66f6d8eda) (block 24,009,177, 681,243 gas ≈ 0.0136 USDC) |

## Live demo (all onchain, Arc mainnet)

A demo merchant `0xE1ac95a9D735E6e8E01EBF76915981d2A53F9288` received three payments:

| Tx | What | Amount |
|---|---|---|
| [`0xa52897e1…`](https://explorer.arc.io/tx/0xa52897e1d78abd3ec711ec76d96b77863d0bf3311df691b8b01ea38cd4292615) | ERC-20 transfer via `Memo`, ref **INV-2026-0001 Batik tulis Malang x2** | 0.05 USDC |
| [`0x5e651849…`](https://explorer.arc.io/tx/0x5e65184953bc3db93dc1ee34a42991a26e7b2a0574ea3cf89694f84dd5ca3459) | ERC-20 transfer via `Memo`, ref **INV-2026-0002 Kopi Dampit 1kg** | 0.03 USDC |
| [`0x6da4d5a8…`](https://explorer.arc.io/tx/0x6da4d5a899662aca767e90b2e6ffa014c55febba91925ef75faa32cdc4142910) | Plain native USDC send (no memo) | 0.015 USDC |

- **Statement:** [open in ArcBooks](https://neimasilk.github.io/arcbooks/?account=0xE1ac95a9D735E6e8E01EBF76915981d2A53F9288&from=24009177&to=24009255). It shows 3 transfers, both invoice references, and is fully reconciled (0 + 0.095 = 0.095). The two ERC-20 payments each emitted two `Transfer` logs and are counted once.
- **Anchored:** hash `0xaa31e5f4dae54e04bb8416caa7d36acdbe7a6ec6eb5b3696a60f17b7298710b6` in tx [`0x1998f9e0…`](https://explorer.arc.io/tx/0x1998f9e0128d546b85c37000420204665bf55e8992a123c87875d39f5effd360).
- **Verify it yourself:** download [`docs/demo-statement.csv`](docs/demo-statement.csv), drop it into the **Verify** tab, then click **Re-derive from chain**.

## Disclosure

This project was built with substantial AI assistance (Anthropic's Claude), working with a human maintainer who owns the accounts, funds deployment, and is responsible for the submission. The code is MIT licensed. It is provided as is, without warranty, and is not financial or tax advice.

# ArcBooks

**Exact, reconciled, verifiable USDC account statements for Arc.**

Live app: https://neimasilk.github.io/arcbooks/ · Contract: see [Deployment](#deployment)

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
| StatementRegistry | _pending_ |

## Disclosure

This project was built with substantial AI assistance (Anthropic's Claude), working with a human maintainer who owns the accounts, funds deployment, and is responsible for the submission. The code is MIT licensed. It is provided as is, without warranty, and is not financial or tax advice.

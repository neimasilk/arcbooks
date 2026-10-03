# ArcBooks Auto-Attest: Chainlink CRE workflow

A Chainlink Runtime Environment (CRE) workflow in Go that keeps a **tamper-evident, hash-chained audit trail** of an account's USDC activity on Arc. Every checkpoint is a canonical ArcBooks statement that anyone can re-derive in the [ArcBooks web app](https://neimasilk.github.io/arcbooks/).

```
cron ──► EVM read (Arc Testnet)                       HTTP (external API)
         • latest header                              • USD/IDR reference rate
         • attestor.headOf(account)  ◄── last checkpoint   (open.er-api.com, DON median)
         • archive balances at range edges                     │
         • USDC Transfer logs (EIP-7708 system emitter)        │
         • Memo logs (invoice references)                      │
              │                                                │
              ▼                                                ▼
     canonical arcbooks-statement-v1 CSV  ──keccak256──►  signed report
     (byte-identical to the web app)                          │
                                                              ▼
                                  EVM write ─► CRE forwarder ─► ArcBooksAttestor.onReport
                                  (rejects gaps, overlaps, wrong prevHash, duplicates)
```

## Why

Businesses, auditors and tax consultants need statements they can trust without trusting the person who sends them. On Arc, USDC is both the 18-decimal gas token and a 6-decimal ERC-20, so naive indexers double-count or truncate (see the main README). This workflow moves statement production into a **decentralized oracle network**:

- **Data integrity:** the DON reads the chain itself (headers, archive balances, logs). No single server's indexer is trusted.
- **Continuity:** checkpoint *n* must cover `[toBlock(n-1)+1, …]` and commit to `hash(n-1)`, which `ArcBooksAttestor` enforces onchain. A missing or edited period breaks the chain visibly.
- **Off-chain data:** the USD/IDR reference rate comes from an external API, aggregated with median consensus. Statements can then be booked in rupiah, as Indonesian bookkeeping requires.
- **Independent verification:** the Go statement builder is a port of `docs/statement.js` and is tested **byte for byte** against real mainnet and testnet data. Anyone can drop a checkpoint CSV into the web app's Verify tab and re-derive it from public RPC.

## Deployed and verified (Arc Testnet)

| | |
|---|---|
| ArcBooksAttestor | [`0xe048B7592D0aCb55f01d06013Df6961ABF9Fdb9C`](https://explorer.testnet.arc.io/address/0xe048B7592D0aCb55f01d06013Df6961ABF9Fdb9C) (forwarder = CRE MockKeystoneForwarder `0x6E9E…eDc1` for simulation) |
| Checkpoint #1 (account `0xb31a…7010`) | tx [`0x70bf1547…`](https://explorer.testnet.arc.io/tx/0x70bf1547d19a5c97786270157a8350265435d25b01669b7de5f04f969f92e097), blocks 65,255,513–65,255,812 |
| Checkpoint #2 (chained) | tx [`0x4421122e…`](https://explorer.testnet.arc.io/tx/0x4421122eafc3a6a3b316727adea8abc5cd1b0a78f73d89430ddbc284386885d0), starts at 65,255,813 with prevHash = checkpoint #1 |
| Demo merchant checkpoint | tx [`0x581e8d0d…`](https://explorer.testnet.arc.io/tx/0x581e8d0d1c0e2e79a42dd94cdebb2f73c541d41893947783d31aec6ae323f590): 3 transfers incl. two Memo invoice payments, 2.5 USDC ≈ Rp44,708 at the DON-agreed rate; [view in ArcBooks](https://neimasilk.github.io/arcbooks/?account=0xE1ac95a9D735E6e8E01EBF76915981d2A53F9288&from=65255654&to=65255953&net=testnet) |

All three are real transactions broadcast by `cre workflow simulate --broadcast`. For each one, the hash produced inside the CRE workflow (Go/WASM) equals the hash the browser app computes independently (e.g. `0xf8e72633…197f`).

## Run it

Prerequisites: [CRE CLI](https://docs.chain.link/cre/getting-started/cli-installation) (`cre login`), Go 1.25+.

```bash
cd cre
go test ./attest/                    # Go port == JS engine on real chain data (fixtures in attest/testdata)
cre workflow simulate attest --target staging-settings --non-interactive --trigger-index 0              # dry run
cre workflow simulate attest --target staging-settings --non-interactive --trigger-index 0 --broadcast  # real tx (needs CRE_ETH_PRIVATE_KEY in .env, funded with testnet USDC)
```

`attest/config.json` holds the account, attestor address, window size and FX API. Fixtures are regenerated with `node test/make-cre-fixture.mjs <account> <from> <to> cre/attest/testdata/<name>` (set `NET=mainnet` for mainnet).

### Design notes (CRE quotas)

- `ChainRead.LogQueryBlockLimit = 100`, so logs are queried in 100-block windows.
- `ChainRead.CallLimit = 15`, so one run uses header + headOf + 2 balances + 3 windows × (out, in, memo) = **13 reads** and covers ≤ 300 blocks. Consecutive runs keep extending the chain.
- If the FX API is unreachable, the checkpoint is still attested with `usdIdrRateE6 = 0`. Accounting continuity is never blocked by a price feed.
- Production would switch `ArcBooksAttestor.setForwarder` to the KeystoneForwarder (`0x76c9…5E62` on arc-testnet).

Built with AI assistance (Claude); see the main README.

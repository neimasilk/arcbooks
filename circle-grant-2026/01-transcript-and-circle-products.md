# ArcBooks: video transcript and Circle product map

Applicant: Mukhlis Amien (individual, Malang, Indonesia). Project: ArcBooks, https://github.com/neimasilk/arcbooks
The code is written by Claude (Anthropic) under the applicant's direction and responsibility. The video narration is a synthetic voice (edge-tts, en-US-AndrewNeural), and the video says so.
Video length: about 3 min 38 s. Code references below are to the repository at the time of submission (file:line).

## Circle products: where each one appears in the codebase

| Circle / Arc product | Status | Where in the code | What it does there |
|---|---|---|---|
| **USDC (native, 18 decimals, EIP-7708 system-emitter logs)** | Integrated, live on Arc mainnet | `docs/statement.js:21` (`NATIVE_EMITTER`), `:154-160` (log filters), `:180-193` (log acceptance and exact `BigInt` amounts), `:215-220` (reconciliation with native balance) | Every USDC movement is read once, from the system emitter only, and reconciled to the onchain balance. Gas is the explicit remainder. |
| **USDC (ERC-20 interface, 6 decimals)** | Integrated | `docs/statement.js:23` (`USDC_ERC20`, deliberately not indexed for amounts to avoid double counting), `docs/app.js:333-339` (payment request: ERC-20 `transfer` wrapped in a `Memo` call) | Payment-request links pay USDC through the ERC-20 interface and attach the invoice reference. |
| Arc `Memo` predeploy (an Arc primitive, not a Circle developer product) | Integrated | `docs/statement.js:25,29` (address and topic), `:159` (filter), `:174-180` and `:208-213` (join to transfers by transaction hash) | Invoice and order references appear on each payment row. |
| Own contract `StatementRegistry` (not a Circle product) | Deployed on Arc mainnet `0xe048B7592D0aCb55f01d06013Df6961ABF9Fdb9C`, block 24,009,177 | `contracts/src/StatementRegistry.sol:48-81` | Anchors the keccak256 hash of a statement; several parties may attest the same hash. |
| CCTP | **Planned, not implemented** (grant milestone 1) | no code yet | Label cross-chain USDC arrivals. |
| Gateway | **Planned, not implemented** (milestone 2) | no code yet | Agent micropayment accounting. |
| Wallets | **Planned, not implemented** (milestone 2) | no code yet | Payment requests paid from developer-controlled wallets. |
| EURC, USYC, Agent Stack, App Kits, cirBTC, Circle Mint, Contracts, Paymaster, StableFX | Not used | none | none |

The Chainlink CRE workflow in `cre/` (Go) reads the same USDC logs and Memo events on Arc Testnet and writes hash-chained checkpoints. It is on testnet and is not counted as traction.

## Video transcript (full narration)

[s1] ArcBooks gives Arc users books they can prove: exact USDC statements, with invoice references, and a hash anchored onchain that anyone can re-derive. I am Claude, an AI model, and I wrote this code for my human owner, who is the applicant. This narration is a synthetic voice. The Circle technology in this project is USDC on Arc. First I will walk through the code that uses it, then I will show the product running on Arc mainnet.

[s2] On Arc, USDC is the native gas token, with eighteen decimals, and also an ERC-20, with six decimals, over one shared balance. One ERC-20 transfer emits two Transfer logs. A native send emits one. Gas emits none. And invoice references live in a separate Memo contract. Naive tools double count, truncate small amounts, and miss fees.

[s3] Here is the codebase, statement dot j s. The first place Circle's USDC appears is three addresses. The native USDC system emitter, which publishes Transfer logs at eighteen decimals. The USDC ERC-20 interface, which we deliberately do not index for amounts, so nothing is counted twice. And Arc's predeployed Memo contract, which carries the invoice references.

[s4] To read USDC movements, build statement creates two log filters for every block range, outgoing and incoming, both on the system emitter only. A third filter reads the Memo events.

[s5] Every log is checked defensively. It must come from the system emitter and carry the Transfer topic. The amount is the log data, held as an exact big integer. No floating point, and no rounding.

[s6] Here is the reconciliation. The engine reads the account's native USDC balance at the block before the range, and at its last block. Opening plus money in, minus money out, should equal the closing balance. Whatever remains is gas, because gas emits no log, and it is reported explicitly instead of being hidden.

[s7] Memo references are joined to each transfer by transaction hash, so every payment carries its invoice number.

[s8] The statement is a deterministic file. Its hash is anchored in the StatementRegistry contract, deployed on Arc mainnet. Several parties can attest the same hash, so a merchant and an accountant can sign the same books.

[s9] Now the product, live on Arc mainnet. This is a demo merchant. Three transfers, two of them with invoice references. Opening zero, plus point zero nine five, equals the closing balance, and the app says: fully reconciled.

[s10] The statement hash is anchored onchain. To verify it, drop the canonical file into the Verify tab. The app re-derives every line from public chain data, and compares. The answer: identical.

[s11] Integrated today: USDC. Planned with this grant: CCTP, to label cross-chain arrivals. Gateway, for agent micropayment accounting. And Wallets, for payment requests paid from developer-controlled wallets. I have no customers yet, and I will not pretend otherwise. I am asking for five thousand dollars, in three milestones, to turn a verified demo into something accountants and agent builders can rely on. Thank you.

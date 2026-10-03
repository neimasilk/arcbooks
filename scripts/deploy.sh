#!/usr/bin/env bash
# Deploy StatementRegistry to Arc mainnet. Reads ARC_DEPLOYER_KEY from ../.env (outside the repo).
set -euo pipefail
cd "$(dirname "$0")/.."
FORGE="${FORGE:-forge}"
RPC="${RPC:-https://rpc.mainnet.arc.io}"
KEY="$(grep '^ARC_DEPLOYER_KEY=' ../.env | cut -d= -f2)"
cd contracts
"$FORGE" create src/StatementRegistry.sol:StatementRegistry --rpc-url "$RPC" --private-key "$KEY" --broadcast --json

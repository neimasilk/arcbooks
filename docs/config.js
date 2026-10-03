// Deployed StatementRegistry on Arc mainnet (filled in after deployment).
export const REGISTRY_ADDRESS = '0xe048B7592D0aCb55f01d06013Df6961ABF9Fdb9C';
export const REGISTRY_DEPLOY_BLOCK = 24009177;

export const REGISTRY_ABI = [
  {
    type: 'function', name: 'anchor', stateMutability: 'nonpayable',
    inputs: [
      { name: 'statementHash', type: 'bytes32' },
      { name: 'account', type: 'address' },
      { name: 'fromBlock', type: 'uint64' },
      { name: 'toBlock', type: 'uint64' },
      { name: 'label', type: 'string' },
    ],
    outputs: [],
  },
  {
    type: 'function', name: 'getAnchors', stateMutability: 'view',
    inputs: [{ name: 'statementHash', type: 'bytes32' }],
    outputs: [{
      type: 'tuple[]',
      components: [
        { name: 'attester', type: 'address' },
        { name: 'account', type: 'address' },
        { name: 'fromBlock', type: 'uint64' },
        { name: 'toBlock', type: 'uint64' },
        { name: 'anchoredAt', type: 'uint64' },
        { name: 'label', type: 'string' },
      ],
    }],
  },
  {
    type: 'function', name: 'statementsOf', stateMutability: 'view',
    inputs: [
      { name: 'account', type: 'address' },
      { name: 'offset', type: 'uint256' },
      { name: 'limit', type: 'uint256' },
    ],
    outputs: [{ name: 'page', type: 'bytes32[]' }, { name: 'total', type: 'uint256' }],
  },
  { type: 'function', name: 'totalAnchors', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
];

export const MEMO_ABI = [
  {
    type: 'function', name: 'memo', stateMutability: 'nonpayable',
    inputs: [
      { name: 'target', type: 'address' },
      { name: 'data', type: 'bytes' },
      { name: 'memoId', type: 'bytes32' },
      { name: 'memoData', type: 'bytes' },
    ],
    outputs: [],
  },
];

// ArcBooksAttestor on Arc Testnet: receives hash-chained statement checkpoints from the
// Chainlink CRE workflow in /cre (same address as the mainnet registry by deployer nonce, different chain).
export const ATTESTOR_ADDRESS = '0xe048B7592D0aCb55f01d06013Df6961ABF9Fdb9C';
export const ATTESTOR_CHAIN_ID = 5042002;

export const ATTESTOR_ABI = [
  {
    type: 'function', name: 'getAttestation', stateMutability: 'view',
    inputs: [{ name: 'statementHash', type: 'bytes32' }],
    outputs: [{
      type: 'tuple',
      components: [
        { name: 'prevHash', type: 'bytes32' },
        { name: 'account', type: 'address' },
        { name: 'fromBlock', type: 'uint64' },
        { name: 'toBlock', type: 'uint64' },
        { name: 'attestedAt', type: 'uint64' },
        { name: 'closingBalanceWei', type: 'int256' },
        { name: 'totalInWei', type: 'uint256' },
        { name: 'totalOutWei', type: 'uint256' },
        { name: 'transfers', type: 'uint32' },
        { name: 'usdIdrRateE6', type: 'uint64' },
        { name: 'workflowId', type: 'bytes32' },
      ],
    }],
  },
  {
    type: 'function', name: 'headOf', stateMutability: 'view',
    inputs: [{ name: 'account', type: 'address' }],
    outputs: [{ name: 'statementHash', type: 'bytes32' }, { name: 'toBlock', type: 'uint64' }, { name: 'count', type: 'uint64' }],
  },
  {
    type: 'function', name: 'attestationsOf', stateMutability: 'view',
    inputs: [{ name: 'account', type: 'address' }],
    outputs: [{ type: 'bytes32[]' }],
  },
];

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

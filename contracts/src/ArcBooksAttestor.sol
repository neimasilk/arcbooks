// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IERC165 {
    function supportsInterface(bytes4 interfaceId) external view returns (bool);
}

/// @dev Chainlink CRE consumer interface: the KeystoneForwarder calls onReport.
interface IReceiver is IERC165 {
    function onReport(bytes calldata metadata, bytes calldata report) external;
}

/// @title ArcBooksAttestor
/// @notice Receives ArcBooks statement checkpoints produced by a Chainlink CRE workflow.
///         The workflow reads USDC Transfer + Memo logs and archive balances from Arc,
///         builds the canonical `arcbooks-statement-v1` CSV (byte-identical to the
///         ArcBooks web app), hashes it, fetches a USD/IDR reference rate from an external
///         API under DON consensus, and delivers a signed report through the forwarder.
///         Checkpoints for an account form a hash chain over contiguous block ranges:
///         each one must start exactly one block after the previous one and commit to the
///         previous statement hash, so gaps, overlaps and rewrites are rejected onchain.
///         Anyone can regenerate any checkpoint's CSV from chain data and check it.
contract ArcBooksAttestor is IReceiver {
    struct Attestation {
        bytes32 prevHash;
        address account;
        uint64 fromBlock;
        uint64 toBlock;
        uint64 attestedAt;
        int256 closingBalanceWei; // 18-decimal native USDC
        uint256 totalInWei;
        uint256 totalOutWei;
        uint32 transfers;
        uint64 usdIdrRateE6; // USD -> IDR reference rate * 1e6 (0 if unavailable)
        bytes32 workflowId;
    }

    /// @dev Report payload produced by the CRE workflow (static tuple, so abi.encode of the
    ///      flat fields and of this struct are byte-identical).
    struct Report {
        bytes32 prevHash;
        bytes32 statementHash;
        address account;
        uint64 fromBlock;
        uint64 toBlock;
        int256 closingBalanceWei;
        uint256 totalInWei;
        uint256 totalOutWei;
        uint32 transfers;
        uint64 usdIdrRateE6;
    }

    struct Head {
        bytes32 statementHash;
        uint64 toBlock;
        uint64 count;
    }

    address public owner;
    address public forwarder;

    mapping(bytes32 => Attestation) private _attestations; // statementHash => attestation
    mapping(address => Head) private _heads; // account => latest checkpoint
    mapping(address => bytes32[]) private _byAccount;
    uint256 public totalAttestations;

    event StatementAttested(
        bytes32 indexed statementHash,
        address indexed account,
        bytes32 indexed prevHash,
        uint64 fromBlock,
        uint64 toBlock,
        int256 closingBalanceWei,
        uint32 transfers,
        uint64 usdIdrRateE6
    );
    event ForwarderUpdated(address indexed previous, address indexed current);

    error NotForwarder(address caller);
    error NotOwner();
    error ZeroAddress();
    error InvalidRange();
    error AlreadyAttested(bytes32 statementHash);
    error BrokenChain(bytes32 expectedPrevHash, uint64 expectedFromBlock);

    constructor(address forwarder_) {
        if (forwarder_ == address(0)) revert ZeroAddress();
        owner = msg.sender;
        forwarder = forwarder_;
        emit ForwarderUpdated(address(0), forwarder_);
    }

    /// @notice Switch forwarder (e.g. MockKeystoneForwarder for simulation -> KeystoneForwarder in production).
    function setForwarder(address forwarder_) external {
        if (msg.sender != owner) revert NotOwner();
        if (forwarder_ == address(0)) revert ZeroAddress();
        emit ForwarderUpdated(forwarder, forwarder_);
        forwarder = forwarder_;
    }

    /// @inheritdoc IReceiver
    function onReport(bytes calldata metadata, bytes calldata report) external override {
        if (msg.sender != forwarder) revert NotForwarder(msg.sender);

        Report memory r = abi.decode(report, (Report));
        bytes32 statementHash = r.statementHash;
        Attestation memory a = Attestation({
            prevHash: r.prevHash,
            account: r.account,
            fromBlock: r.fromBlock,
            toBlock: r.toBlock,
            attestedAt: 0,
            closingBalanceWei: r.closingBalanceWei,
            totalInWei: r.totalInWei,
            totalOutWei: r.totalOutWei,
            transfers: r.transfers,
            usdIdrRateE6: r.usdIdrRateE6,
            workflowId: bytes32(0)
        });

        if (a.account == address(0)) revert ZeroAddress();
        if (a.fromBlock > a.toBlock) revert InvalidRange();
        if (_attestations[statementHash].attestedAt != 0) revert AlreadyAttested(statementHash);

        Head storage head = _heads[a.account];
        if (head.count == 0) {
            // genesis checkpoint: must not claim a predecessor
            if (a.prevHash != bytes32(0)) revert BrokenChain(bytes32(0), a.fromBlock);
        } else if (a.prevHash != head.statementHash || a.fromBlock != head.toBlock + 1) {
            revert BrokenChain(head.statementHash, head.toBlock + 1);
        }

        if (metadata.length >= 32) a.workflowId = bytes32(metadata[0:32]);
        // casting to 'uint64' is safe because block numbers stay far below 2^64
        // forge-lint: disable-next-line(unsafe-typecast)
        a.attestedAt = uint64(block.number);

        _attestations[statementHash] = a;
        head.statementHash = statementHash;
        head.toBlock = a.toBlock;
        unchecked {
            ++head.count;
            ++totalAttestations;
        }
        _byAccount[a.account].push(statementHash);

        emit StatementAttested(
            statementHash, a.account, a.prevHash, a.fromBlock, a.toBlock, a.closingBalanceWei, a.transfers, a.usdIdrRateE6
        );
    }

    /// @notice Latest checkpoint for an account (hash, last covered block, number of checkpoints).
    function headOf(address account) external view returns (bytes32 statementHash, uint64 toBlock, uint64 count) {
        Head memory h = _heads[account];
        return (h.statementHash, h.toBlock, h.count);
    }

    function getAttestation(bytes32 statementHash) external view returns (Attestation memory) {
        return _attestations[statementHash];
    }

    function isAttested(bytes32 statementHash) external view returns (bool) {
        return _attestations[statementHash].attestedAt != 0;
    }

    function attestationsOf(address account) external view returns (bytes32[] memory) {
        return _byAccount[account];
    }

    function supportsInterface(bytes4 interfaceId) external pure override returns (bool) {
        return interfaceId == type(IReceiver).interfaceId || interfaceId == type(IERC165).interfaceId;
    }
}

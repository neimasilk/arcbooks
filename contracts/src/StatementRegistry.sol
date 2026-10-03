// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title StatementRegistry
/// @notice Lets anyone anchor the hash of a USDC account statement generated for an
///         Arc address over a block range. Because ArcBooks statements are derived
///         deterministically from onchain data, an auditor can regenerate the
///         statement, hash it, and check it against the anchor. The registry
///         stores anchors in contract storage so verification is a single view
///         call, with no log scanning.
contract StatementRegistry {
    struct Anchor {
        address attester;
        address account;
        uint64 fromBlock;
        uint64 toBlock;
        uint64 anchoredAt;
        string label;
    }

    /// @dev statement hash => anchors (several parties may attest the same statement)
    mapping(bytes32 => Anchor[]) private _anchors;
    /// @dev statement hash => attester => already attested
    mapping(bytes32 => mapping(address => bool)) public attested;
    /// @dev account => statement hashes anchored for it, in anchoring order
    mapping(address => bytes32[]) private _statementsByAccount;

    uint256 public totalAnchors;

    uint256 public constant MAX_LABEL_BYTES = 96;

    event StatementAnchored(
        bytes32 indexed statementHash,
        address indexed account,
        address indexed attester,
        uint64 fromBlock,
        uint64 toBlock,
        string label
    );

    error ZeroHash();
    error ZeroAccount();
    error InvalidRange();
    error RangeInFuture();
    error LabelTooLong();
    error AlreadyAttested();

    /// @notice Anchor a statement hash for `account` covering blocks [fromBlock, toBlock].
    /// @param statementHash keccak256 of the canonical statement CSV bytes.
    function anchor(bytes32 statementHash, address account, uint64 fromBlock, uint64 toBlock, string calldata label)
        external
    {
        if (statementHash == bytes32(0)) revert ZeroHash();
        if (account == address(0)) revert ZeroAccount();
        if (fromBlock > toBlock) revert InvalidRange();
        if (toBlock >= block.number) revert RangeInFuture();
        if (bytes(label).length > MAX_LABEL_BYTES) revert LabelTooLong();
        if (attested[statementHash][msg.sender]) revert AlreadyAttested();

        attested[statementHash][msg.sender] = true;
        _anchors[statementHash].push(
            Anchor({
                attester: msg.sender,
                account: account,
                fromBlock: fromBlock,
                toBlock: toBlock,
                // casting to 'uint64' is safe because block numbers stay far below 2^64
                // forge-lint: disable-next-line(unsafe-typecast)
                anchoredAt: uint64(block.number),
                label: label
            })
        );
        if (_anchors[statementHash].length == 1) {
            _statementsByAccount[account].push(statementHash);
        }
        unchecked {
            ++totalAnchors;
        }

        emit StatementAnchored(statementHash, account, msg.sender, fromBlock, toBlock, label);
    }

    /// @notice All anchors recorded for a statement hash.
    function getAnchors(bytes32 statementHash) external view returns (Anchor[] memory) {
        return _anchors[statementHash];
    }

    /// @notice Number of anchors recorded for a statement hash.
    function anchorCount(bytes32 statementHash) external view returns (uint256) {
        return _anchors[statementHash].length;
    }

    /// @notice Paginated list of statement hashes anchored for an account.
    function statementsOf(address account, uint256 offset, uint256 limit)
        external
        view
        returns (bytes32[] memory page, uint256 total)
    {
        bytes32[] storage all = _statementsByAccount[account];
        total = all.length;
        if (offset >= total) return (new bytes32[](0), total);
        uint256 end = offset + limit;
        if (end > total) end = total;
        page = new bytes32[](end - offset);
        for (uint256 i = offset; i < end; ++i) {
            page[i - offset] = all[i];
        }
    }
}

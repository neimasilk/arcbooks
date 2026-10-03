// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {StatementRegistry} from "../src/StatementRegistry.sol";

contract StatementRegistryTest is Test {
    StatementRegistry reg;
    address alice = address(0xA11CE);
    address bob = address(0xB0B);
    address merchant = address(0x3E7C);
    bytes32 constant H = keccak256("statement-csv");

    event StatementAnchored(
        bytes32 indexed statementHash,
        address indexed account,
        address indexed attester,
        uint64 fromBlock,
        uint64 toBlock,
        string label
    );

    function setUp() public {
        reg = new StatementRegistry();
        vm.roll(1_000);
    }

    function test_anchor_storesAndEmits() public {
        vm.expectEmit(true, true, true, true);
        emit StatementAnchored(H, merchant, alice, 100, 200, "Sep 2026");
        vm.prank(alice);
        reg.anchor(H, merchant, 100, 200, "Sep 2026");

        StatementRegistry.Anchor[] memory a = reg.getAnchors(H);
        assertEq(a.length, 1);
        assertEq(a[0].attester, alice);
        assertEq(a[0].account, merchant);
        assertEq(a[0].fromBlock, 100);
        assertEq(a[0].toBlock, 200);
        assertEq(a[0].anchoredAt, 1_000);
        assertEq(a[0].label, "Sep 2026");
        assertTrue(reg.attested(H, alice));
        assertEq(reg.totalAnchors(), 1);
        assertEq(reg.anchorCount(H), 1);
    }

    function test_multipleAttesters_sameHash() public {
        vm.prank(alice);
        reg.anchor(H, merchant, 100, 200, "");
        vm.prank(bob);
        reg.anchor(H, merchant, 100, 200, "co-signed");
        assertEq(reg.anchorCount(H), 2);
        assertEq(reg.totalAnchors(), 2);
        // account index lists the hash once
        (bytes32[] memory page, uint256 total) = reg.statementsOf(merchant, 0, 10);
        assertEq(total, 1);
        assertEq(page[0], H);
    }

    function test_revert_duplicateAttestation() public {
        vm.startPrank(alice);
        reg.anchor(H, merchant, 100, 200, "");
        vm.expectRevert(StatementRegistry.AlreadyAttested.selector);
        reg.anchor(H, merchant, 100, 200, "");
        vm.stopPrank();
    }

    function test_revert_badInputs() public {
        vm.expectRevert(StatementRegistry.ZeroHash.selector);
        reg.anchor(bytes32(0), merchant, 1, 2, "");
        vm.expectRevert(StatementRegistry.ZeroAccount.selector);
        reg.anchor(H, address(0), 1, 2, "");
        vm.expectRevert(StatementRegistry.InvalidRange.selector);
        reg.anchor(H, merchant, 5, 4, "");
        vm.expectRevert(StatementRegistry.RangeInFuture.selector);
        reg.anchor(H, merchant, 5, 1_000, "");
        vm.expectRevert(StatementRegistry.LabelTooLong.selector);
        reg.anchor(H, merchant, 1, 2, string(new bytes(97)));
    }

    function test_statementsOf_pagination() public {
        for (uint256 i = 0; i < 5; ++i) {
            reg.anchor(keccak256(abi.encode(i)), merchant, 1, 2, "");
        }
        (bytes32[] memory p1, uint256 total) = reg.statementsOf(merchant, 0, 2);
        assertEq(total, 5);
        assertEq(p1.length, 2);
        assertEq(p1[1], keccak256(abi.encode(uint256(1))));
        (bytes32[] memory p3,) = reg.statementsOf(merchant, 4, 10);
        assertEq(p3.length, 1);
        assertEq(p3[0], keccak256(abi.encode(uint256(4))));
        (bytes32[] memory none,) = reg.statementsOf(merchant, 9, 10);
        assertEq(none.length, 0);
    }

    function testFuzz_anchor(bytes32 h, address acct, uint64 fromB, uint64 len) public {
        vm.assume(h != bytes32(0) && acct != address(0));
        len = uint64(bound(len, 0, 500));
        fromB = uint64(bound(fromB, 0, 400));
        reg.anchor(h, acct, fromB, fromB + len < 999 ? fromB + len : 998, "");
        assertEq(reg.anchorCount(h), 1);
    }
}

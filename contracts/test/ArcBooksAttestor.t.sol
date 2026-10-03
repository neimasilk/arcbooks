// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {ArcBooksAttestor, IReceiver, IERC165} from "../src/ArcBooksAttestor.sol";

contract ArcBooksAttestorTest is Test {
    ArcBooksAttestor att;
    address fwd = address(0xF0);
    address acct = address(0xACC7);
    bytes32 constant H1 = keccak256("csv1");
    bytes32 constant H2 = keccak256("csv2");
    bytes32 constant WF = bytes32(uint256(0xabc));

    function setUp() public {
        att = new ArcBooksAttestor(fwd);
        vm.roll(500);
    }

    function _report(bytes32 prev, bytes32 h, uint64 fromB, uint64 toB) internal view returns (bytes memory) {
        return abi.encode(
            prev, h, acct, fromB, toB, int256(95e15), uint256(95e15), uint256(0), uint32(3), uint64(16_450_000_000)
        );
    }

    function _metadata() internal pure returns (bytes memory) {
        return abi.encodePacked(WF, bytes10("arcbooks"), address(0x0b), bytes2(0));
    }

    function test_genesis_stores() public {
        vm.prank(fwd);
        att.onReport(_metadata(), _report(bytes32(0), H1, 10, 20));
        ArcBooksAttestor.Attestation memory a = att.getAttestation(H1);
        assertEq(a.account, acct);
        assertEq(a.fromBlock, 10);
        assertEq(a.toBlock, 20);
        assertEq(a.attestedAt, 500);
        assertEq(a.closingBalanceWei, int256(95e15));
        assertEq(a.transfers, 3);
        assertEq(a.usdIdrRateE6, 16_450_000_000);
        assertEq(a.workflowId, WF);
        assertTrue(att.isAttested(H1));
        (bytes32 h, uint64 toB, uint64 n) = att.headOf(acct);
        assertEq(h, H1);
        assertEq(toB, 20);
        assertEq(n, 1);
    }

    function test_chain_contiguous() public {
        vm.startPrank(fwd);
        att.onReport(_metadata(), _report(bytes32(0), H1, 10, 20));
        att.onReport(_metadata(), _report(H1, H2, 21, 40));
        vm.stopPrank();
        (bytes32 h, uint64 toB, uint64 n) = att.headOf(acct);
        assertEq(h, H2);
        assertEq(toB, 40);
        assertEq(n, 2);
        assertEq(att.getAttestation(H2).prevHash, H1);
        assertEq(att.attestationsOf(acct).length, 2);
        assertEq(att.totalAttestations(), 2);
    }

    function test_revert_gap() public {
        vm.startPrank(fwd);
        att.onReport(_metadata(), _report(bytes32(0), H1, 10, 20));
        vm.expectRevert(abi.encodeWithSelector(ArcBooksAttestor.BrokenChain.selector, H1, uint64(21)));
        att.onReport(_metadata(), _report(H1, H2, 22, 40));
        vm.stopPrank();
    }

    function test_revert_wrongPrev() public {
        vm.startPrank(fwd);
        att.onReport(_metadata(), _report(bytes32(0), H1, 10, 20));
        vm.expectRevert(abi.encodeWithSelector(ArcBooksAttestor.BrokenChain.selector, H1, uint64(21)));
        att.onReport(_metadata(), _report(keccak256("forged"), H2, 21, 40));
        vm.stopPrank();
    }

    function test_revert_genesisWithPrev() public {
        vm.prank(fwd);
        vm.expectRevert(abi.encodeWithSelector(ArcBooksAttestor.BrokenChain.selector, bytes32(0), uint64(10)));
        att.onReport(_metadata(), _report(H2, H1, 10, 20));
    }

    function test_revert_notForwarder() public {
        vm.expectRevert(abi.encodeWithSelector(ArcBooksAttestor.NotForwarder.selector, address(this)));
        att.onReport(_metadata(), _report(bytes32(0), H1, 10, 20));
    }

    function test_revert_duplicate() public {
        vm.startPrank(fwd);
        att.onReport(_metadata(), _report(bytes32(0), H1, 10, 20));
        vm.expectRevert(abi.encodeWithSelector(ArcBooksAttestor.AlreadyAttested.selector, H1));
        att.onReport(_metadata(), _report(H1, H1, 21, 30));
        vm.stopPrank();
    }

    function test_revert_badRange() public {
        vm.prank(fwd);
        vm.expectRevert(ArcBooksAttestor.InvalidRange.selector);
        att.onReport(_metadata(), _report(bytes32(0), H1, 30, 20));
    }

    function test_setForwarder_onlyOwner() public {
        vm.prank(address(0xBAD));
        vm.expectRevert(ArcBooksAttestor.NotOwner.selector);
        att.setForwarder(address(0x1));
        att.setForwarder(address(0x1));
        assertEq(att.forwarder(), address(0x1));
    }

    function test_supportsInterface() public view {
        assertTrue(att.supportsInterface(type(IReceiver).interfaceId));
        assertTrue(att.supportsInterface(type(IERC165).interfaceId));
        assertFalse(att.supportsInterface(0xffffffff));
    }

    function test_shortMetadata_ok() public {
        vm.prank(fwd);
        att.onReport("", _report(bytes32(0), H1, 10, 20));
        assertEq(att.getAttestation(H1).workflowId, bytes32(0));
    }

    function testFuzz_chain(uint8 steps, uint16 width) public {
        steps = uint8(bound(steps, 1, 20));
        width = uint16(bound(width, 1, 400));
        bytes32 prev;
        uint64 fromB = 1;
        vm.startPrank(fwd);
        for (uint256 i = 0; i < steps; ++i) {
            bytes32 h = keccak256(abi.encode(i, width));
            uint64 toB = fromB + width - 1;
            att.onReport("", _report(prev, h, fromB, toB));
            prev = h;
            fromB = toB + 1;
        }
        vm.stopPrank();
        (bytes32 head, uint64 last, uint64 n) = att.headOf(acct);
        assertEq(head, prev);
        assertEq(last, fromB - 1);
        assertEq(n, steps);
    }
}

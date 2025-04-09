// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "./MyLogic.sol";

contract MyLogicV2 is MyLogic {
    string public message;

    function initializeV2(uint256 _value, string memory _msg) public reinitializer(2) {
        value = _value;
        message = _msg;
    }

    function getMessage() public view returns (string memory) {
        return message;
    }

    function setMessage(string memory _msg) public {
        message = _msg;
    }
}

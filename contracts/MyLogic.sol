// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";

contract MyLogic is Initializable {
    uint256 public value;

    function initialize(uint256 _value) public initializer {
        value = _value;
    }

    function setValue(uint256 _value) public {
        value = _value;
    }
}

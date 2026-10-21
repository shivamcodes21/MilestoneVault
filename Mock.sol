// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
contract MockUSDC is ERC20 {
    constructor() ERC20("Mock USDC","mUSDC") {}
    function mint(address to, uint256 a) external { _mint(to,a); }
}

MilestoneVault evidence pack (research prototype, unaudited)
- simulate.py : agent-based model; run "python3 simulate.py" -> results.csv
- MilestoneVault.sol : reference escrow (solc 0.8.24, OpenZeppelin 5.0.2)
- Mock.sol, test.js : test token and 29 tests on an in-process EVM (ganache). Run groups: node test.js 1 ... node test.js 5
- Install: npm i solc@0.8.24 @openzeppelin/contracts@5.0.2 ganache@7.9.2 ethers@6.13.4
Simulation assumptions (mix 65/20/15 honest/fraud/abandon, reviewer accuracy 85%) are a model, not field data.

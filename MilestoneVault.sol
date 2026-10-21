// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @title MilestoneVault (reference implementation, one escrow per campaign)
/// @notice Immutable escrow: tranche cap, optimistic release with a challenge
///         window, arbiter-scored partial release, creator bond, pro-rata refunds.
/// @dev    No upgrade key and no admin withdrawal. The guardian can pause
///         releases only; refunds can never be paused. Reference code for a
///         research prototype, NOT audited.
contract MilestoneVault is ReentrancyGuard {
    using SafeERC20 for IERC20;

    enum State { FUNDING, ACTIVE, REFUNDING, COMPLETE }
    enum MStatus { PENDING, SUBMITTED, DISPUTED, DONE }

    struct Milestone {
        uint16 bps;            // tranche as basis points of totalRaised
        uint64 duration;       // seconds allowed after the previous step
        uint64 deadline;       // set when the milestone becomes current
        uint64 submittedAt;
        bytes32 criteriaHash;  // IPFS hash of acceptance criteria (fixed at creation)
        bytes32 evidenceHash;  // IPFS hash of creator evidence
        MStatus status;
    }

    IERC20 public immutable token;
    address public immutable creator;
    address public immutable arbiter;    // dispute module (reviewer panel / court adapter)
    address public immutable guardian;   // can pause RELEASES only
    uint256 public immutable goal;
    uint256 public immutable bond;       // creator bond, forfeited on failure
    uint256 public immutable challengeBond;
    uint64  public immutable fundingDeadline;
    uint64  public immutable challengeWindow;
    uint64  public immutable grace;
    uint16  public constant FIRST_TRANCHE_CAP_BPS = 1500; // tranche 1 <= 15%

    State public state;
    bool public releasesPaused;
    bool public bondPosted;
    bool public bondForfeited;
    uint256 public totalRaised;
    uint256 public totalReleased;
    uint256 public refundPool;
    uint256 public current;              // index of current milestone
    address public challenger;

    Milestone[] public milestones;
    mapping(address => uint256) public contributions;
    mapping(address => bool) public refunded;
    mapping(address => uint256) public pending; // pull-payment balances

    event BondPosted(uint256 amount);
    event Donated(address indexed backer, uint256 amount);
    event Activated(uint256 totalRaised);
    event Submitted(uint256 indexed index, bytes32 evidenceHash);
    event Challenged(uint256 indexed index, address indexed by);
    event Released(uint256 indexed index, uint256 amount);
    event Resolved(uint256 indexed index, uint16 scoreBps);
    event RefundMode(uint256 refundPool, bool bondForfeited);
    event RefundClaimed(address indexed backer, uint256 amount);

    error WrongState();
    error NotAllowed();
    error BadParams();
    error TooEarly();
    error TooLate();

    struct Config {
        IERC20 token; address creator; address arbiter; address guardian;
        uint256 goal; uint256 bond; uint256 challengeBond;
        uint64 fundingDeadline; uint64 challengeWindow; uint64 grace;
    }

    constructor(Config memory cfg, uint16[] memory bps, uint64[] memory durations, bytes32[] memory criteria) {
        if (bps.length == 0 || bps.length != durations.length || bps.length != criteria.length) revert BadParams();
        if (bps[0] > FIRST_TRANCHE_CAP_BPS) revert BadParams();
        uint256 sum;
        for (uint256 i; i < bps.length; ++i) {
            sum += bps[i];
            milestones.push(Milestone(bps[i], durations[i], 0, 0, criteria[i], bytes32(0), MStatus.PENDING));
        }
        if (sum != 10_000) revert BadParams();
        token = cfg.token; creator = cfg.creator; arbiter = cfg.arbiter; guardian = cfg.guardian;
        goal = cfg.goal; bond = cfg.bond; challengeBond = cfg.challengeBond;
        fundingDeadline = cfg.fundingDeadline; challengeWindow = cfg.challengeWindow; grace = cfg.grace;
    }

    // ---------------------------------------------------------------- funding
    function postBond() external nonReentrant {
        if (msg.sender != creator || bondPosted) revert NotAllowed();
        bondPosted = true;
        token.safeTransferFrom(msg.sender, address(this), bond);
        emit BondPosted(bond);
    }

    function donate(uint256 amount) external nonReentrant {
        if (state != State.FUNDING || !bondPosted) revert WrongState();
        if (block.timestamp > fundingDeadline) revert TooLate();
        if (msg.sender == creator || amount == 0) revert NotAllowed();
        contributions[msg.sender] += amount;
        totalRaised += amount;
        token.safeTransferFrom(msg.sender, address(this), amount);
        emit Donated(msg.sender, amount);
    }

    /// Anyone can finalize after the deadline (or once the goal is met).
    function finalizeFunding() external {
        if (state != State.FUNDING) revert WrongState();
        if (totalRaised >= goal) {
            state = State.ACTIVE;
            _startMilestone(0);
            emit Activated(totalRaised);
        } else {
            if (block.timestamp <= fundingDeadline) revert TooEarly();
            _enterRefund(false);          // goal missed: creator keeps bond
        }
    }

    // ------------------------------------------------------------- milestones
    function submitMilestone(bytes32 evidenceHash) external {
        if (msg.sender != creator) revert NotAllowed();
        if (state != State.ACTIVE) revert WrongState();
        Milestone storage m = milestones[current];
        if (m.status != MStatus.PENDING) revert WrongState();
        if (block.timestamp > m.deadline) revert TooLate();
        m.status = MStatus.SUBMITTED;
        m.submittedAt = uint64(block.timestamp);
        m.evidenceHash = evidenceHash;
        emit Submitted(current, evidenceHash);
    }

    /// A backer disputes a submission inside the challenge window (posts a bond).
    function challenge() external nonReentrant {
        if (state != State.ACTIVE || contributions[msg.sender] == 0) revert NotAllowed();
        Milestone storage m = milestones[current];
        if (m.status != MStatus.SUBMITTED) revert WrongState();
        if (block.timestamp > m.submittedAt + challengeWindow) revert TooLate();
        m.status = MStatus.DISPUTED;
        challenger = msg.sender;
        token.safeTransferFrom(msg.sender, address(this), challengeBond);
        emit Challenged(current, msg.sender);
    }

    /// Optimistic release: nobody challenged during the window.
    function release() external {
        if (releasesPaused) revert NotAllowed();
        if (state != State.ACTIVE) revert WrongState();
        Milestone storage m = milestones[current];
        if (m.status != MStatus.SUBMITTED) revert WrongState();
        if (block.timestamp <= m.submittedAt + challengeWindow) revert TooEarly();
        _pay(10_000);
    }

    /// Arbiter ruling: 0 = reject, 1..9999 = partial, 10000 = full approval.
    function resolve(uint16 scoreBps) external nonReentrant {
        if (msg.sender != arbiter) revert NotAllowed();
        if (releasesPaused) revert NotAllowed();
        if (state != State.ACTIVE) revert WrongState();
        if (scoreBps > 10_000) revert BadParams();
        Milestone storage m = milestones[current];
        if (m.status != MStatus.DISPUTED) revert WrongState();
        emit Resolved(current, scoreBps);

        address ch = challenger;
        challenger = address(0);
        if (scoreBps == 0) {
            pending[ch] += challengeBond;     // challenge upheld: bond returned
            _enterRefund(true);               // fraud/failure: creator bond forfeited
        } else if (scoreBps == 10_000) {
            pending[creator] += challengeBond; // challenge failed: bond to creator
            _pay(10_000);
        } else {
            pending[ch] += challengeBond;     // partial: challenge partly right
            _pay(scoreBps);
        }
    }

    /// Anyone can end a campaign whose creator missed a deadline (plus grace).
    function lapse() external {
        if (state != State.ACTIVE) revert WrongState();
        Milestone storage m = milestones[current];
        if (m.status != MStatus.PENDING) revert WrongState();
        if (block.timestamp <= m.deadline + grace) revert TooEarly();
        _enterRefund(true);
    }

    function setReleasesPaused(bool p) external {
        if (msg.sender != guardian) revert NotAllowed();
        releasesPaused = p;               // refunds are never gated by this flag
    }

    // ---------------------------------------------------------------- payouts
    function claimRefund() external nonReentrant {
        if (state != State.REFUNDING && state != State.COMPLETE) revert WrongState();
        if (refunded[msg.sender]) revert NotAllowed();
        uint256 c = contributions[msg.sender];
        if (c == 0) revert NotAllowed();
        refunded[msg.sender] = true;      // effects before interaction
        uint256 amount = (c * refundPool) / totalRaised;   // pro-rata of what is LEFT
        token.safeTransfer(msg.sender, amount);
        emit RefundClaimed(msg.sender, amount);
    }

    function withdraw() external nonReentrant {
        uint256 amount = pending[msg.sender];
        if (amount == 0) revert NotAllowed();
        pending[msg.sender] = 0;
        token.safeTransfer(msg.sender, amount);
    }

    // --------------------------------------------------------------- internal
    function _startMilestone(uint256 i) internal {
        current = i;
        milestones[i].deadline = uint64(block.timestamp) + milestones[i].duration;
    }

    function _pay(uint16 scoreBps) internal {
        Milestone storage m = milestones[current];
        uint256 amount = (totalRaised * m.bps / 10_000) * scoreBps / 10_000;
        m.status = MStatus.DONE;
        totalReleased += amount;
        pending[creator] += amount;       // pull payment
        emit Released(current, amount);
        if (current + 1 == milestones.length) {
            state = State.COMPLETE;
            refundPool = totalRaised - totalReleased;     // unreleased partial remainder
            pending[creator] += bond;     // creator bond returned on success
        } else {
            _startMilestone(current + 1);
        }
    }

    function _enterRefund(bool forfeit) internal {
        state = State.REFUNDING;
        bondForfeited = forfeit;
        refundPool = totalRaised - totalReleased;
        if (forfeit) refundPool += bond;  // bond compensates backers
        else if (bondPosted) pending[creator] += bond;
        emit RefundMode(refundPool, forfeit);
    }
}

// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title CampusBallot
/// @notice One administrator manages elections; approved voters may cast one ballot per election.
/// @dev Ballot choices are visible in transaction input on an EVM chain. This is a campus pilot,
///      not a secret-ballot protocol for binding public elections.
contract CampusBallot {
    enum Phase { Setup, Open, Closed, Published }

    struct Election {
        string title;
        Phase phase;
        uint32 candidateCount;
        uint32 voterCount;
        uint32 voteCount;
        uint64 createdAt;
        uint64 startedAt;
        uint64 endedAt;
        uint64 publishedAt;
    }

    address public immutable admin;
    uint256 public electionCount;
    uint256 public activeVoterAccountCount;
    address[] private _knownVoterAccounts;
    mapping(address => bool) private _hasBeenAdded;
    mapping(address => bool) public isVoterAccount;
    mapping(uint256 => Election) private _elections;
    mapping(uint256 => string[]) private _candidateNames;
    mapping(uint256 => mapping(uint256 => uint256)) private _candidateVotes;
    mapping(uint256 => mapping(address => bool)) public isEligible;
    mapping(uint256 => mapping(address => bool)) public hasVoted;

    event ElectionCreated(uint256 indexed electionId, string title, address indexed admin);
    event CandidateAdded(uint256 indexed electionId, uint256 indexed candidateId, string name);
    event VoterAccountAdded(address indexed voter);
    event VoterAccountRemoved(address indexed voter);
    event VoterRegistered(uint256 indexed electionId, address indexed voter);
    event VoterRemoved(uint256 indexed electionId, address indexed voter);
    event ElectionStarted(uint256 indexed electionId);
    event VoteCast(uint256 indexed electionId, address indexed voter);
    event ElectionEnded(uint256 indexed electionId, uint32 voteCount);
    event ResultsPublished(uint256 indexed electionId, uint32 voteCount);

    modifier onlyAdmin() {
        require(msg.sender == admin, "Admin only");
        _;
    }

    modifier validElection(uint256 electionId) {
        require(electionId > 0 && electionId <= electionCount, "Unknown election");
        _;
    }

    constructor(address adminAddress) {
        require(adminAddress != address(0), "Invalid admin");
        admin = adminAddress;
    }

    function addVoterAccount(address voter) external onlyAdmin {
        require(voter != address(0) && voter != admin, "Invalid voter");
        require(!isVoterAccount[voter], "Account already added");
        if (!_hasBeenAdded[voter]) {
            _hasBeenAdded[voter] = true;
            _knownVoterAccounts.push(voter);
        }
        isVoterAccount[voter] = true;
        activeVoterAccountCount++;
        emit VoterAccountAdded(voter);
    }

    /// @notice Revokes voting access. Votes already cast remain in the tally.
    function removeVoterAccount(address voter) external onlyAdmin {
        require(isVoterAccount[voter], "Account not active");
        isVoterAccount[voter] = false;
        activeVoterAccountCount--;
        for (uint256 electionId = 1; electionId <= electionCount; electionId++) {
            if (_elections[electionId].phase == Phase.Setup && isEligible[electionId][voter]) {
                isEligible[electionId][voter] = false;
                _elections[electionId].voterCount--;
                emit VoterRemoved(electionId, voter);
            }
        }
        emit VoterAccountRemoved(voter);
    }

    /// @notice Includes old accounts; check isVoterAccount to see which are active.
    function voterAccounts() external view returns (address[] memory) {
        return _knownVoterAccounts;
    }

    function createElection(string calldata title) external onlyAdmin returns (uint256 electionId) {
        require(bytes(title).length > 0 && bytes(title).length <= 120, "Invalid title");
        electionId = ++electionCount;
        _elections[electionId].title = title;
        _elections[electionId].createdAt = uint64(block.timestamp);
        emit ElectionCreated(electionId, title, msg.sender);
    }

    function addCandidate(uint256 electionId, string calldata name) external onlyAdmin validElection(electionId) {
        Election storage election = _elections[electionId];
        require(election.phase == Phase.Setup, "Setup closed");
        require(election.candidateCount < 20, "Too many candidates");
        require(bytes(name).length > 0 && bytes(name).length <= 80, "Invalid candidate");
        for (uint256 i = 0; i < election.candidateCount; i++) {
            require(keccak256(bytes(name)) != keccak256(bytes(_candidateNames[electionId][i])), "Duplicate candidate");
        }
        uint256 candidateId = election.candidateCount++;
        _candidateNames[electionId].push(name);
        emit CandidateAdded(electionId, candidateId, name);
    }

    function registerVoter(uint256 electionId, address voter) external onlyAdmin validElection(electionId) {
        Election storage election = _elections[electionId];
        require(election.phase == Phase.Setup, "Registration closed");
        require(isVoterAccount[voter], "Account not added");
        require(!isEligible[electionId][voter], "Already registered");
        isEligible[electionId][voter] = true;
        election.voterCount++;
        emit VoterRegistered(electionId, voter);
    }

    /// @notice Removes voting eligibility while the election is still being set up.
    /// @dev The wallet itself continues to exist; only its registration for this election is removed.
    function removeVoter(uint256 electionId, address voter) external onlyAdmin validElection(electionId) {
        Election storage election = _elections[electionId];
        require(election.phase == Phase.Setup, "Registration closed");
        require(isEligible[electionId][voter], "Not registered");
        isEligible[electionId][voter] = false;
        election.voterCount--;
        emit VoterRemoved(electionId, voter);
    }

    function startElection(uint256 electionId) external onlyAdmin validElection(electionId) {
        Election storage election = _elections[electionId];
        require(election.phase == Phase.Setup, "Already started");
        require(election.candidateCount >= 2, "Need two candidates");
        require(election.voterCount > 0, "Need a voter");
        election.phase = Phase.Open;
        election.startedAt = uint64(block.timestamp);
        emit ElectionStarted(electionId);
    }

    function castVote(uint256 electionId, uint256 candidateId) external validElection(electionId) {
        Election storage election = _elections[electionId];
        require(election.phase == Phase.Open, "Voting is closed");
        require(isEligible[electionId][msg.sender], "Not registered");
        require(isVoterAccount[msg.sender], "Account removed");
        require(!hasVoted[electionId][msg.sender], "Already voted");
        require(candidateId < election.candidateCount, "Unknown candidate");
        hasVoted[electionId][msg.sender] = true;
        election.voteCount++;
        _candidateVotes[electionId][candidateId]++;
        emit VoteCast(electionId, msg.sender);
    }

    function endElection(uint256 electionId) external onlyAdmin validElection(electionId) {
        Election storage election = _elections[electionId];
        require(election.phase == Phase.Open, "Election not open");
        election.phase = Phase.Closed;
        election.endedAt = uint64(block.timestamp);
        emit ElectionEnded(electionId, election.voteCount);
    }

    function publishResults(uint256 electionId) external onlyAdmin validElection(electionId) {
        Election storage election = _elections[electionId];
        require(election.phase == Phase.Closed, "End election first");
        election.phase = Phase.Published;
        election.publishedAt = uint64(block.timestamp);
        emit ResultsPublished(electionId, election.voteCount);
    }

    function getElection(uint256 electionId) external view validElection(electionId) returns (Election memory) {
        return _elections[electionId];
    }

    function candidateName(uint256 electionId, uint256 candidateId) external view validElection(electionId) returns (string memory) {
        require(candidateId < _elections[electionId].candidateCount, "Unknown candidate");
        return _candidateNames[electionId][candidateId];
    }

    function candidateVotes(uint256 electionId, uint256 candidateId) external view validElection(electionId) returns (uint256) {
        require(_elections[electionId].phase == Phase.Published, "Results not published");
        require(candidateId < _elections[electionId].candidateCount, "Unknown candidate");
        return _candidateVotes[electionId][candidateId];
    }
}

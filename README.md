# CampusBallot

CampusBallot is a small campus election pilot inspired by the permissioned voting approach in Solution 2 of the group report. It uses a Solidity smart contract on a local EVM chain. One admin account controls election setup and publication; registered voter accounts can each cast one vote per election.

## Run

Install Node.js 20.19+ or 22.12+, then in PowerShell:

```powershell
cd C:\Users\Ritesh\Downloads\BlockchainProject
npm.cmd install
npm.cmd run demo
```

Open the URL printed by the command, normally `http://127.0.0.1:5173/`. Keep the terminal open. The demo chooses free ports, compiles and deploys a fresh contract, approves five demo voter accounts on chain, creates a sample election, adds three candidates, and registers those five accounts for that election. The local blockchain resets each time the demo restarts. The Ganache `µWS` compatibility message means it uses a slower JavaScript fallback; it does not stop the demo.

**Restart the demo after changing the smart contract.** Stop the old `npm.cmd run demo` terminal with Ctrl+C, then run the command again. Refresh the browser at the new URL printed in the terminal. The `artifacts/`, `dist/`, and `public/deployment.json` files are generated; edit the files in `contracts/`, `src/`, and `scripts/` instead.

## Classroom walkthrough

1. The site opens as **Admin**. Open **Voter accounts** to see the five on-chain approved demo wallets and add Voter 6. Open **Manage elections**. The sample election already has candidates and five registered voters.
2. Press **Start election**.
3. Switch to **Voter 1** in the account list. Open **Vote & results**, choose a candidate, and press **Submit my vote**.
   Press **Verify my vote** to read the recorded candidate from your transaction and check its receipt and block hash. This works before or after results are published.
4. Switch to **Voter 2** and vote for another candidate. Try voting twice to see the contract reject it.
5. Switch back to **Admin**. In **Manage elections**, press **End election**, then **Publish results**. The admin is taken to **Results** and can select any published election to view its final tally.
6. Switch to a voter account to see the same published result. As Admin, open **Verify chain** to inspect transaction and block hashes and compare vote transactions with the published tally.

For a new election, first approve wallets in **Voter accounts**. You can choose an unused demo wallet or enter an existing external wallet address. Then use the **Approved voter account** dropdown in Manage elections to register one approved account, or press **Register all available** to register every remaining approved account. Registered accounts are marked and cannot be selected again for that election. Register all sends one admin transaction per voter and shows the final count.

The admin can press **Remove** next to a registered voter while an election is in Setup. This revokes eligibility for that election. In **Voter accounts**, Remove revokes the wallet globally. That also removes its registration from elections still in Setup and prevents future votes in open elections. Votes already cast remain counted. An account can be added again later. Neither action deletes a wallet or its private key.

## Roles and contract transactions

The constructor records one immutable `admin` wallet. Only that wallet can call `addVoterAccount`, `removeVoterAccount`, `createElection`, `addCandidate`, `registerVoter`, `removeVoter`, `startElection`, `endElection`, and `publishResults`. An active globally approved wallet that is also registered for a particular election can call `castVote` once while voting is open. The contract rejects unauthorized roles, invalid candidates, unregistered voters, and repeat votes.

The admin must add at least two candidates and register at least one voter before starting an election. Candidate names and the voter list are locked when voting starts. Results appear in the app after the admin ends voting and publishes them. Anyone with access to the chain can independently inspect transaction receipts and block hashes. The admin's **Verify chain** screen decodes vote transactions and compares them with the published contract totals.

The voter's **Verify my vote** button finds that wallet's `VoteCast` event for the selected election, checks that the transaction succeeded and its receipt matches the block hash, decodes the `castVote` candidate ID, and shows the candidate name. This verifies what the contract recorded for that wallet; it does not provide ballot secrecy.

## Checks

```powershell
npm.cmd test
npm.cmd run build
```

The tests cover admin permissions, the global account registry, voter removal and re-registration, the election lifecycle, eligibility, one vote per wallet, result publication, and transaction verification.

## Practical limits

This is a functional prototype for a voluntary campus or club election. A real pilot needs an identity check before the admin registers each wallet, secure admin key management, voter support, independent validators, and an accessible fallback. The contract cannot prove that one person has only one wallet.

**The ballot is not secret on an EVM chain.** The chosen candidate is present in the `castVote` transaction input, so a chain observer can reconstruct the tally before the admin presses Publish. The Publish control governs the app and contract's result view, not cryptographic secrecy. A binding election needs an audited anonymous ballot and encrypted tally design. Demo accounts are disposable and must not be used with real funds or identities.

## Files

- `contracts/CampusBallot.sol` — election rules and events
- `src/main.js`, `src/style.css`, `src/choice.css` — dashboard
- `scripts/compile.js`, `scripts/deploy.js`, `scripts/demo.js` — compile, deploy, and run
- `test/CampusBallot.test.js` — contract behavior tests

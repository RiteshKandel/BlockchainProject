import test from 'node:test';
import assert from 'node:assert/strict';
import ganache from 'ganache';
import { ethers } from 'ethers';
import { compile } from '../scripts/compile.js';
import { verifyRecordedVote } from '../src/verifyVote.js';

async function setup() {
  const rpc = ganache.provider({ logging: { quiet: true }, wallet: { deterministic: true, totalAccounts: 6 }, chain: { chainId: 31337 } });
  const provider = new ethers.BrowserProvider(rpc);
  const signers = await Promise.all(Array.from({ length: 6 }, (_, index) => provider.getSigner(index)));
  const addresses = await Promise.all(signers.map(signer => signer.getAddress()));
  const artifact = compile();
  const contract = await new ethers.ContractFactory(artifact.abi, artifact.evm.bytecode.object, signers[0]).deploy(addresses[0]);
  await contract.waitForDeployment();
  await (await contract.addVoterAccount(addresses[1])).wait();
  await (await contract.addVoterAccount(addresses[2])).wait();
  return { provider, signers, addresses, contract };
}

const rejectsTx = action => assert.rejects(async () => { const tx = await action(); await tx.wait(); });

test('admin manages the on-chain voter account registry', async () => {
  const { contract, signers, addresses } = await setup();
  await rejectsTx(() => contract.connect(signers[1]).addVoterAccount(addresses[3]));
  await rejectsTx(() => contract.addVoterAccount(addresses[1]));
  await (await contract.addVoterAccount(addresses[3])).wait();
  assert.equal(await contract.isVoterAccount(addresses[3]), true);
  assert.equal(await contract.activeVoterAccountCount(), 3n);
  await (await contract.createElection('Council')).wait();
  await (await contract.registerVoter(1, addresses[3])).wait();
  await rejectsTx(() => contract.connect(signers[1]).removeVoterAccount(addresses[3]));
  await (await contract.removeVoterAccount(addresses[3])).wait();
  assert.equal(await contract.isVoterAccount(addresses[3]), false);
  assert.equal(await contract.isEligible(1, addresses[3]), false);
  assert.equal((await contract.getElection(1)).voterCount, 0n);
  assert.equal(await contract.activeVoterAccountCount(), 2n);
  await rejectsTx(() => contract.registerVoter(1, addresses[3]));
  await (await contract.addVoterAccount(addresses[3], { gasLimit: 200000 })).wait();
  assert.equal((await contract.voterAccounts()).length, 3);
});

test('only the constructor admin can create and configure an election', async () => {
  const { contract, signers, addresses } = await setup();
  assert.equal(await contract.admin(), addresses[0]);
  await rejectsTx(() => contract.connect(signers[1]).createElection('Unauthorized'));
  await (await contract.createElection('Council President')).wait();
  await rejectsTx(() => contract.connect(signers[1]).addCandidate(1, 'Alex'));
  await (await contract.addCandidate(1, 'Alex')).wait();
  await rejectsTx(() => contract.addCandidate(1, 'Alex'));
  await (await contract.addCandidate(1, 'Sam')).wait();
  await rejectsTx(() => contract.connect(signers[1]).registerVoter(1, addresses[1]));
  await (await contract.registerVoter(1, addresses[1])).wait();
  await rejectsTx(() => contract.registerVoter(1, addresses[1]));
  assert.equal((await contract.getElection(1)).candidateCount, 2n);
  assert.equal((await contract.getElection(1)).voterCount, 1n);
});

test('admin can remove and re-add a voter during setup, but not after voting starts', async () => {
  const { contract, signers, addresses } = await setup();
  await (await contract.createElection('Council')).wait();
  await (await contract.registerVoter(1, addresses[1])).wait();
  await rejectsTx(() => contract.connect(signers[1]).removeVoter(1, addresses[1]));
  await (await contract.removeVoter(1, addresses[1])).wait();
  assert.equal(await contract.isEligible(1, addresses[1]), false);
  assert.equal((await contract.getElection(1)).voterCount, 0n);
  await rejectsTx(() => contract.removeVoter(1, addresses[1]));
  await (await contract.registerVoter(1, addresses[1], { gasLimit: 200000 })).wait();
  assert.equal(await contract.isEligible(1, addresses[1]), true);
  assert.equal((await contract.getElection(1)).voterCount, 1n);
  await (await contract.addCandidate(1, 'Alex')).wait();
  await (await contract.addCandidate(1, 'Sam')).wait();
  await (await contract.startElection(1)).wait();
  await rejectsTx(() => contract.removeVoter(1, addresses[1]));
});

test('global removal blocks later votes but keeps votes already counted', async () => {
  const { contract, signers, addresses } = await setup();
  await (await contract.createElection('Council')).wait();
  await (await contract.addCandidate(1, 'Alex')).wait();
  await (await contract.addCandidate(1, 'Sam')).wait();
  await (await contract.registerVoter(1, addresses[1])).wait();
  await (await contract.registerVoter(1, addresses[2])).wait();
  await (await contract.startElection(1)).wait();
  await (await contract.connect(signers[1]).castVote(1, 0)).wait();
  await (await contract.removeVoterAccount(addresses[1])).wait();
  await (await contract.removeVoterAccount(addresses[2])).wait();
  await rejectsTx(() => contract.connect(signers[2]).castVote(1, 1));
  await (await contract.endElection(1)).wait();
  await (await contract.publishResults(1)).wait();
  assert.equal(await contract.candidateVotes(1, 0), 1n);
  assert.equal(await contract.candidateVotes(1, 1), 0n);
});

test('voters can cast once while open; only admin ends and publishes results', async () => {
  const { contract, signers, addresses } = await setup();
  await (await contract.createElection('Council')).wait();
  await (await contract.addCandidate(1, 'Alex')).wait();
  await (await contract.addCandidate(1, 'Sam')).wait();
  await (await contract.registerVoter(1, addresses[1])).wait();
  await (await contract.registerVoter(1, addresses[2])).wait();
  await rejectsTx(() => contract.connect(signers[1]).castVote(1, 0));
  await rejectsTx(() => contract.connect(signers[1]).startElection(1));
  await (await contract.startElection(1)).wait();
  await rejectsTx(() => contract.addCandidate(1, 'Late candidate'));
  await rejectsTx(() => contract.registerVoter(1, addresses[3]));
  await rejectsTx(() => contract.connect(signers[3]).castVote(1, 0));
  await rejectsTx(() => contract.connect(signers[1]).castVote(1, 2));
  await (await contract.connect(signers[1]).castVote(1, 0, { gasLimit: 200000 })).wait();
  await (await contract.connect(signers[2]).castVote(1, 1)).wait();
  await rejectsTx(() => contract.connect(signers[1]).castVote(1, 1));
  await assert.rejects(contract.candidateVotes(1, 0));
  await rejectsTx(() => contract.connect(signers[1]).endElection(1));
  await (await contract.endElection(1)).wait();
  await rejectsTx(() => contract.connect(signers[2]).castVote(1, 1));
  await rejectsTx(() => contract.connect(signers[1]).publishResults(1));
  await (await contract.publishResults(1)).wait();
  assert.equal(await contract.candidateVotes(1, 0), 1n);
  assert.equal(await contract.candidateVotes(1, 1), 1n);
  assert.equal((await contract.getElection(1)).phase, 3n);
  await rejectsTx(() => contract.publishResults(1));
});

test('vote events can be checked against transaction inputs and published totals', async () => {
  const { provider, contract, signers, addresses } = await setup();
  await (await contract.createElection('Council')).wait();
  await (await contract.addCandidate(1, 'Alex')).wait();
  await (await contract.addCandidate(1, 'Sam')).wait();
  await (await contract.registerVoter(1, addresses[1])).wait();
  await (await contract.startElection(1)).wait();
  const vote = await contract.connect(signers[1]).castVote(1, 1);
  await vote.wait();
  await (await contract.endElection(1)).wait();
  await (await contract.publishResults(1)).wait();
  const logs = await contract.queryFilter(contract.filters.VoteCast(1), 0);
  assert.equal(logs.length, 1);
  const transaction = await provider.getTransaction(logs[0].transactionHash);
  const receipt = await provider.getTransactionReceipt(logs[0].transactionHash);
  const block = await provider.getBlock(logs[0].blockNumber);
  const decoded = contract.interface.parseTransaction({ data: transaction.data, value: transaction.value });
  assert.equal(decoded.name, 'castVote');
  assert.equal(decoded.args[1], 1n);
  assert.equal(receipt.blockHash, block.hash);
  assert.equal(await contract.candidateVotes(1, decoded.args[1]), 1n);
  const proof = await verifyRecordedVote({ provider, contractAddress: await contract.getAddress(), abi: contract.interface.fragments, electionId: 1, voterAddress: addresses[1] });
  assert.equal(proof.candidateName, 'Sam');
  assert.equal(proof.transactionHash, vote.hash);
  assert.equal(proof.blockHash, block.hash);
  await assert.rejects(verifyRecordedVote({ provider, contractAddress: await contract.getAddress(), abi: contract.interface.fragments, electionId: 1, voterAddress: addresses[2] }), /No recorded vote/);
});

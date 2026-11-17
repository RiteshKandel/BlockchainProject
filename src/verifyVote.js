import { ethers } from 'ethers';

/// Read a voter's own on-chain ballot and prove that its transaction was mined successfully.
export async function verifyRecordedVote({ provider, contractAddress, abi, electionId, voterAddress }) {
  if (!ethers.isAddress(contractAddress) || !ethers.isAddress(voterAddress)) throw new Error('Invalid wallet or contract address');
  const contract = new ethers.Contract(contractAddress, abi, provider);
  const logs = await contract.queryFilter(contract.filters.VoteCast(electionId, voterAddress), 0);
  if (logs.length !== 1) throw new Error(logs.length ? 'More than one vote event was found for this wallet' : 'No recorded vote was found for this wallet');

  const log = logs[0];
  const [transaction, receipt, block, hasVoted] = await Promise.all([
    provider.getTransaction(log.transactionHash),
    provider.getTransactionReceipt(log.transactionHash),
    provider.getBlock(log.blockNumber),
    contract.hasVoted(electionId, voterAddress)
  ]);
  const same = (left, right) => left?.toLowerCase() === right?.toLowerCase();
  if (!transaction || !receipt || !block || !hasVoted) throw new Error('Vote transaction or contract state is missing');
  if (receipt.status !== 1 || !same(transaction.from, voterAddress) || !same(transaction.to, contractAddress) || receipt.blockHash !== block.hash || log.blockHash !== block.hash || !block.transactions.some(hash => same(hash, transaction.hash))) {
    throw new Error('Transaction receipt or block hash does not match');
  }

  const decoded = contract.interface.parseTransaction({ data: transaction.data, value: transaction.value });
  if (decoded?.name !== 'castVote' || Number(decoded.args[0]) !== Number(electionId)) throw new Error('Transaction is not the expected vote');
  const candidateId = Number(decoded.args[1]);
  const election = await contract.getElection(electionId);
  if (candidateId < 0 || candidateId >= Number(election.candidateCount)) throw new Error('Recorded candidate is invalid');
  return {
    candidateId,
    candidateName: await contract.candidateName(electionId, candidateId),
    transactionHash: transaction.hash,
    blockHash: block.hash,
    blockNumber: block.number
  };
}

import fs from 'node:fs';
import { ethers } from 'ethers';
import { compile } from './compile.js';

export async function deploy({ rpcUrl = process.env.RPC_URL || 'http://127.0.0.1:8545', seed = false } = {}) {
  const artifact = compile();
  const provider = new ethers.JsonRpcProvider(rpcUrl);
  const accounts = await provider.listAccounts();
  if (accounts.length < 6) throw new Error('At least six unlocked accounts are required for the local demo');
  const admin = accounts[0].address;
  const contract = await new ethers.ContractFactory(artifact.abi, artifact.evm.bytecode.object, accounts[0]).deploy(admin);
  await contract.waitForDeployment();
  let demoElectionId = null;
  if (seed) {
    for (const account of accounts.slice(1, 6)) {
      await (await contract.addVoterAccount(account.address)).wait();
    }
    await (await contract.createElection('Student Council President')).wait();
    for (const name of ['Aarav Sharma', 'Maya Thapa', 'Aayush Shreshtha']) {
      await (await contract.addCandidate(1, name)).wait();
    }
    for (const account of accounts.slice(1, 6)) {
      await (await contract.registerVoter(1, account.address)).wait();
    }
    demoElectionId = 1;
  }
  const network = await provider.getNetwork();
  const deployment = {
    address: await contract.getAddress(),
    chainId: Number(network.chainId),
    rpcUrl,
    abi: artifact.abi,
    admin,
    demoAccounts: accounts.slice(0, 10).map(account => account.address),
    demoElectionId
  };
  fs.mkdirSync('public', { recursive: true });
  fs.writeFileSync('public/deployment.json', JSON.stringify(deployment, null, 2));
  console.log(`CampusBallot deployed at ${deployment.address}`);
  return deployment;
}

if (process.argv[1]?.replaceAll('\\', '/').endsWith('/scripts/deploy.js')) {
  deploy().catch(error => { console.error(error); process.exitCode = 1; });
}

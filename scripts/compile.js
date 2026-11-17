import fs from 'node:fs';
import path from 'node:path';
import solc from 'solc';

export function compile() {
  const source = fs.readFileSync('contracts/CampusBallot.sol', 'utf8');
  const input = {
    language: 'Solidity',
    sources: { 'CampusBallot.sol': { content: source } },
    settings: { evmVersion: 'shanghai', optimizer: { enabled: true, runs: 200 }, outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object'] } } }
  };
  const output = JSON.parse(solc.compile(JSON.stringify(input)));
  const errors = output.errors?.filter(error => error.severity === 'error') ?? [];
  if (errors.length) throw new Error(errors.map(error => error.formattedMessage).join('\n'));
  const artifact = output.contracts['CampusBallot.sol'].CampusBallot;
  fs.mkdirSync('artifacts', { recursive: true });
  fs.writeFileSync(path.join('artifacts', 'CampusBallot.json'), JSON.stringify(artifact, null, 2));
  return artifact;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve('scripts/compile.js')) {
  compile();
  console.log('Compiled CampusBallot.sol');
}

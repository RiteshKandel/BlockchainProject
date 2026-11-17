import net from 'node:net';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { deploy } from './deploy.js';

const host = '127.0.0.1';
const node = process.execPath;
let chain;
let web;

function portIsFree(port) {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', error => error.code === 'EADDRINUSE' ? resolve(false) : reject(error));
    server.listen(port, host, () => server.close(() => resolve(true)));
  });
}

async function findFreePort(start) {
  for (let port = start; port < start + 20; port++) {
    if (await portIsFree(port)) return port;
  }
  throw new Error(`No free port found from ${start} to ${start + 19}`);
}

function cleanup() {
  if (web && web.exitCode === null) web.kill();
  if (chain && chain.exitCode === null) chain.kill();
}

process.once('SIGINT', cleanup);
process.once('SIGTERM', cleanup);

try {
  const [rpcPort, webPort] = await Promise.all([findFreePort(8545), findFreePort(5173)]);
  console.log(`Using blockchain port ${rpcPort} and web port ${webPort}.`);

  chain = spawn(node, ['node_modules/ganache/dist/node/cli.js', '--server.host', host, '--server.port', String(rpcPort), '--chain.chainId', '31337', '--wallet.deterministic', '--wallet.totalAccounts', '10', '--logging.quiet'], { stdio: ['ignore', 'ignore', 'inherit'] });
  chain.once('error', error => console.error('Blockchain process failed:', error.message));
  let ready = false;
  for (let i = 0; i < 40; i++) {
    if (chain.exitCode !== null) throw new Error('Local blockchain exited before it was ready');
    try {
      const response = await fetch(`http://${host}:${rpcPort}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] }) });
      if (response.ok) { ready = true; break; }
    } catch {}
    await delay(250);
  }
  if (!ready) throw new Error('Local blockchain did not start');
  await deploy({ rpcUrl: `http://${host}:${rpcPort}`, seed: true });
  web = spawn(node, ['node_modules/vite/bin/vite.js', '--host', host, '--port', String(webPort), '--strictPort'], { stdio: 'inherit' });
  web.once('error', error => console.error('Web process failed:', error.message));
  console.log(`\nOpen http://${host}:${webPort}/ — choose a demo account to begin.`);
  await new Promise(resolve => web.once('exit', resolve));
  cleanup();
} catch (error) {
  console.error(`Demo failed: ${error.message}`);
  cleanup();
  process.exitCode = 1;
}

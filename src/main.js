import { ethers } from 'ethers';
import { verifyRecordedVote } from './verifyVote.js';
import './style.css';
import './choice.css';

const app = document.querySelector('#app');
const state = { config: null, provider: null, signer: null, address: null, tab: 'home', selected: 1, elections: [], events: [], voter: { eligible: false, voted: false }, registeredAccounts: {}, voterAccounts: [], knownVoterAccounts: [], registrySupported: false, audit: null, myVoteCheck: null, busy: false, message: null };
const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
const short = value => value ? `${value.slice(0, 8)}…${value.slice(-6)}` : '—';
const date = seconds => seconds ? new Date(Number(seconds) * 1000).toLocaleString() : '—';
const phases = ['Setup', 'Voting open', 'Voting ended', 'Results published'];
const phase = election => phases[election.phase] ?? 'Unknown';
const isAdmin = () => state.address?.toLowerCase() === state.config?.admin?.toLowerCase();
const accountLabel = address => { const index = state.config.demoAccounts.findIndex(account => account.toLowerCase() === address.toLowerCase()); return index > 0 ? `Voter ${index}` : 'External wallet'; };
const selected = () => state.elections.find(election => election.id === state.selected);
const readContract = () => new ethers.Contract(state.config.address, state.config.abi, state.provider);
const writeContract = () => new ethers.Contract(state.config.address, state.config.abi, state.signer);
const badge = election => `<span class="badge ${election.phase === 0 ? 'pending' : election.phase === 2 ? 'reveal' : election.phase === 3 ? 'closed' : ''}">${phase(election)}</span>`;

async function init() {
  try {
    const response = await fetch('/deployment.json', { cache: 'no-store' });
    if (!response.ok) throw new Error('Deployment file is missing');
    state.config = await response.json();
    if (!state.config.admin) throw new Error('The running chain has the old contract. Restart npm.cmd run demo.');
    state.registrySupported = state.config.abi.some(item => item.type === 'function' && item.name === 'voterAccounts');
    state.provider = new ethers.JsonRpcProvider(state.config.rpcUrl);
    const code = await state.provider.getCode(state.config.address);
    if (code === '0x') throw new Error('Contract was not found on this chain. Restart npm.cmd run demo.');
    const accounts = await state.provider.listAccounts();
    if (!accounts.length) throw new Error('No demo accounts were found');
    state.signer = accounts[0];
    state.address = accounts[0].address;
    await refresh();
  } catch (error) {
    app.innerHTML = `<div class="main"><h1>CampusBallot</h1><div class="notice error">${esc(error.message)}<br>Run <code>npm.cmd run demo</code> and open the URL printed in the terminal.</div></div>`;
  }
}

async function refresh() {
  const contract = readContract();
  if (state.registrySupported) {
    state.knownVoterAccounts = await contract.voterAccounts();
    const active = await Promise.all(state.knownVoterAccounts.map(address => contract.isVoterAccount(address)));
    state.voterAccounts = state.knownVoterAccounts.filter((_, index) => active[index]);
  } else {
    state.knownVoterAccounts = state.config.demoAccounts.slice(1);
    state.voterAccounts = state.knownVoterAccounts;
  }
  const count = Number(await contract.electionCount());
  const elections = [];
  for (let id = 1; id <= count; id++) {
    const item = await contract.getElection(id);
    const candidates = [];
    for (let candidateId = 0; candidateId < Number(item.candidateCount); candidateId++) {
      candidates.push({ id: candidateId, name: await contract.candidateName(id, candidateId), votes: Number(item.phase) === 3 ? Number(await contract.candidateVotes(id, candidateId)) : null });
    }
    elections.push({ id, title: item.title, phase: Number(item.phase), candidateCount: Number(item.candidateCount), voterCount: Number(item.voterCount), voteCount: Number(item.voteCount), createdAt: Number(item.createdAt), startedAt: Number(item.startedAt), endedAt: Number(item.endedAt), publishedAt: Number(item.publishedAt), candidates });
  }
  state.elections = elections;
  if (!selected()) state.selected = elections.at(-1)?.id ?? 1;
  const logs = await contract.queryFilter('*', 0);
  state.events = logs.reverse().map(log => ({ name: log.fragment?.name ?? 'Transaction', hash: log.transactionHash, block: log.blockNumber, blockHash: log.blockHash, electionId: Number(log.args?.electionId ?? 0), voter: log.args?.voter ?? null }));
  const election = selected();
  const globallyActive = state.voterAccounts.some(address => address.toLowerCase() === state.address?.toLowerCase());
  state.voter = election ? { eligible: globallyActive && await contract.isEligible(election.id, state.address), voted: await contract.hasVoted(election.id, state.address) } : { eligible: false, voted: false };
  const eligibility = election ? await Promise.all(state.voterAccounts.map(address => contract.isEligible(election.id, address))) : [];
  state.registeredAccounts = Object.fromEntries(state.voterAccounts.map((address, index) => [address.toLowerCase(), eligibility[index] ?? false]));
  render();
}

function notify(message, error = false) {
  state.message = { message, error };
  render();
  setTimeout(() => { state.message = null; document.querySelector('.toast')?.remove(); }, 5000);
}

async function transact(label, action, afterConfirmed) {
  if (state.busy) return;
  state.busy = true;
  notify(`${label}: waiting for chain confirmation…`);
  try {
    const tx = await action();
    await tx.wait();
    afterConfirmed?.();
    state.audit = null;
    state.myVoteCheck = null;
    await refresh();
    notify(`${label} confirmed. Transaction ${short(tx.hash)}`);
  } catch (error) {
    notify(error.reason || error.shortMessage || error.message, true);
  } finally {
    state.busy = false;
  }
}

async function registerAllVoters() {
  if (state.busy || !isAdmin()) return;
  const election = selected();
  if (!election || election.phase !== 0) return notify('Select an election in setup', true);
  const addresses = state.voterAccounts.filter(address => !state.registeredAccounts[address.toLowerCase()]);
  if (!addresses.length) return notify('All demo voters are already registered');
  const electionId = election.id;
  const contract = writeContract();
  let registered = 0;
  state.busy = true;
  notify(`Registering ${addresses.length} available voters…`);
  try {
    for (const address of addresses) {
      if (await contract.isEligible(electionId, address)) continue;
      const tx = await contract.registerVoter(electionId, address);
      await tx.wait();
      registered++;
    }
    state.busy = false;
    await refresh();
    notify(`${registered} voter${registered === 1 ? '' : 's'} registered for this election.`);
  } catch (error) {
    state.busy = false;
    await refresh().catch(() => {});
    notify(`Registered ${registered} voter${registered === 1 ? '' : 's'} before an error: ${error.reason || error.shortMessage || error.message}`, true);
  }
}

function accountPicker() {
  return `<div class="account-list">${state.config.demoAccounts.map((address, index) => `<button class="account ${state.address?.toLowerCase() === address.toLowerCase() ? 'active' : ''}" data-account="${index}"><span>${index === 0 ? 'Admin' : `Voter ${index}${state.registrySupported && !state.voterAccounts.some(account => account.toLowerCase() === address.toLowerCase()) ? ' · not approved' : ''}`}</span><code>${short(address)}</code></button>`).join('')}</div><button class="btn ghost small" data-wallet style="margin-top:12px">Connect browser wallet</button>`;
}

function render() {
  const admin = isAdmin();
  const tabs = admin ? [['home', 'Overview'], ['accounts', 'Voter accounts'], ['manage', 'Manage elections'], ['results', 'Results'], ['audit', 'Verify chain'], ['help', 'How to use']] : [['home', 'Overview'], ['ballot', 'Vote & results'], ['help', 'How to use']];
  if (!tabs.some(([key]) => key === state.tab)) state.tab = 'home';
  app.innerHTML = `<div class="shell"><aside class="sidebar"><div class="brand"><div class="brand-mark">C</div>CampusBallot</div><nav class="nav">${tabs.map(([key, label]) => `<button data-tab="${key}" class="${state.tab === key ? 'active' : ''}">${label}</button>`).join('')}</nav><div class="side-note"><strong>${admin ? 'Administrator' : 'Voter'} account</strong><br>${admin ? 'Create, configure, run, and publish elections.' : 'Cast one vote in each election where you are registered.'}</div></aside><main class="main"><header class="topbar"><div><p class="eyebrow">Campus election dashboard</p><h1>${tabs.find(([key]) => key === state.tab)?.[1]}</h1></div><div class="connection"><span class="pill"><span class="dot"></span>Chain ${state.config.chainId}</span><span class="pill">${admin ? 'Admin' : 'Voter'} · ${short(state.address)}</span></div></header>${state.tab === 'home' ? home() : state.tab === 'accounts' ? voterAccountsPage() : state.tab === 'manage' ? manage() : state.tab === 'ballot' ? ballot() : state.tab === 'results' ? adminResults() : state.tab === 'audit' ? audit() : help()}<div class="foot">Local demo · Contract ${esc(state.config.address)} · Use the latest URL printed by npm.cmd run demo</div></main></div>${state.message ? `<div class="toast ${state.message.error ? 'error' : ''}">${esc(state.message.message)}</div>` : ''}`;
  bind();
}

function electionSelect() {
  return `<div class="field"><label for="election-select">Election</label><select id="election-select">${state.elections.map(election => `<option value="${election.id}" ${election.id === state.selected ? 'selected' : ''}>#${election.id} · ${esc(election.title)}</option>`).join('')}</select></div>`;
}

function home() {
  const admin = isAdmin();
  const published = state.elections.filter(election => election.phase === 3).length;
  const totalVotes = state.elections.reduce((sum, election) => sum + election.voteCount, 0);
  return `<section class="hero"><div><p class="eyebrow" style="color:#68d8c5">${admin ? 'Admin workspace' : 'Voter workspace'}</p><h2>${admin ? 'Run an election from one place.' : 'Your vote, recorded on the chain.'}</h2><p>${admin ? 'Add candidates and voters, open voting, close it, then publish results. Every step has a transaction hash.' : 'Choose an open election, select a candidate, and submit one vote. Results appear when the admin publishes them.'}</p></div><div class="hero-icon">◈</div></section><div class="grid"><div class="stat"><div class="label">Elections</div><div class="value">${state.elections.length}</div><div class="detail">Created on this chain</div></div><div class="stat"><div class="label">Votes cast</div><div class="value">${totalVotes}</div><div class="detail">Across all elections</div></div><div class="stat"><div class="label">Published results</div><div class="value">${published}</div><div class="detail">Visible to voters</div></div></div><div class="section-head"><h2>Elections</h2><span>${admin ? 'Open one to manage it' : 'Open one to vote or see results'}</span></div><div class="cards">${state.elections.map(election => `<article class="card"><div class="card-top">${badge(election)}<span class="muted">#${election.id}</span></div><h3>${esc(election.title)}</h3><p>${election.candidateCount} candidates · ${election.voterCount} registered voters</p><div class="meta"><span>${election.voteCount} votes cast</span><button class="btn small" data-open="${election.id}">Open →</button></div></article>`).join('') || `<div class="empty">${admin ? 'Create your first election in Manage elections.' : 'No elections have been created yet.'}</div>`}</div><div class="panel-grid"><div class="panel"><h3>Quick start</h3><p class="muted">${admin ? 'The sample election already has three candidates and five registered demo voters. Start it in Manage elections, then switch to a voter account.' : 'Use a registered demo voter account. The admin starts voting and publishes results after it ends.'}</p><button class="btn" data-tab="${admin ? 'manage' : 'ballot'}">${admin ? 'Manage election' : 'Go to ballot'}</button></div><div class="panel"><h3>Choose an account</h3>${accountPicker()}</div></div>`;
}

function voterRegistrationForm(election) {
  const voters = state.voterAccounts;
  const removalSupported = state.config.abi.some(item => item.type === 'function' && item.name === 'removeVoter');
  const available = voters.filter(address => !state.registeredAccounts[address.toLowerCase()]);
  const disabled = election.phase !== 0 || available.length === 0 || state.busy;
  const options = voters.map(address => {
    const registered = state.registeredAccounts[address.toLowerCase()];
    return `<option value="${esc(address)}" ${registered ? 'disabled' : ''}>${accountLabel(address)} · ${short(address)}${registered ? ' (registered)' : ''}</option>`;
  }).join('');
  const registered = voters.filter(address => state.registeredAccounts[address.toLowerCase()]);
  const roster = registered.map(address => `<div class="candidate"><div><b>${accountLabel(address)}</b><small>${short(address)}</small></div><button type="button" class="btn danger small" data-remove-voter="${esc(address)}" ${election.phase !== 0 || state.busy || !removalSupported ? 'disabled' : ''}>Remove</button></div>`).join('');
  return `<form id="voter-form" class="form"><div class="field"><label for="voter-account">Approved voter account</label><select id="voter-account" name="address" required ${disabled ? 'disabled' : ''}><option value="">${available.length ? 'Choose an approved account' : 'No available accounts'}</option>${options}</select></div><div class="row"><button class="btn secondary" ${disabled ? 'disabled' : ''}>Add to election</button><button type="button" class="btn ghost" data-register-all ${disabled ? 'disabled' : ''}>Register all available (${available.length})</button></div></form><div class="section-head"><h2>Registered voters</h2><span>${registered.length} accounts</span></div>${roster || '<div class="empty">No voters registered for this election.</div>'}${!removalSupported ? '<div class="notice">Restart the demo to deploy the updated contract and enable Remove.</div>' : ''}<p class="muted">Manage the chain account pool in Voter accounts. Add or remove election access before voting starts.</p>`;
}

function voterAccountsPage() {
  if (!state.registrySupported) return '<div class="panel"><h2>Voter accounts</h2><div class="notice">Restart the demo to deploy the new contract and activate the on-chain voter account registry.</div></div>';
  const active = state.voterAccounts;
  const availableDemo = state.config.demoAccounts.slice(1).filter(address => !active.some(account => account.toLowerCase() === address.toLowerCase()));
  const options = availableDemo.map(address => `<option value="${esc(address)}">${accountLabel(address)} · ${short(address)}</option>`).join('');
  const roster = active.map(address => `<div class="candidate"><div><b>${accountLabel(address)}</b><small class="code">${esc(address)}</small></div><button type="button" class="btn danger small" data-remove-account="${esc(address)}" ${state.busy ? 'disabled' : ''}>Remove</button></div>`).join('');
  return `<div class="section-head"><h2>On-chain voter accounts</h2><span>${active.length} approved wallets</span></div><div class="panel-grid"><div><div class="panel"><h2>Add a demo voter account</h2><p class="muted">Approve one of the available local demo wallets for election registration.</p><form id="add-demo-account-form" class="form"><div class="field"><label for="new-demo-account">Demo account</label><select id="new-demo-account" name="address" required ${!availableDemo.length || state.busy ? 'disabled' : ''}><option value="">${availableDemo.length ? 'Choose a demo voter' : 'All demo voters are approved'}</option>${options}</select></div><button class="btn" ${!availableDemo.length || state.busy ? 'disabled' : ''}>Add account to chain</button></form></div><div class="panel"><h2>Add an external wallet</h2><p class="muted">Enter an existing voter-owned wallet address. The voter keeps its private key and connects that wallet to vote.</p><form id="add-wallet-account-form" class="form"><div class="field"><label>Wallet address</label><input name="address" placeholder="0x…" required></div><button class="btn secondary" ${state.busy ? 'disabled' : ''}>Add wallet to chain</button></form></div></div><div><div class="panel"><h2>Approved accounts</h2>${roster || '<div class="empty">No voter accounts have been approved yet.</div>'}</div><div class="panel"><h3>What removal does</h3><p class="muted">Removing an account revokes its voting access. Registrations in elections still in Setup are removed automatically. Votes already cast remain on the chain and in the tally. You can add a removed address again later.</p></div></div></div>`;
}

function manage() {
  const election = selected();
  return `<div class="section-head"><h2>Admin controls</h2><span>Only the contract admin can submit these transactions</span></div><div class="panel-grid"><div><div class="panel"><h2>Create a new election</h2><p class="muted">Give it a title, then add candidates and register voters before starting.</p><form id="create-form" class="form"><div class="field"><label>Election title</label><input name="title" maxlength="120" placeholder="Student Council President" required></div><button class="btn">Create election</button></form></div><div class="panel"><h2>Set up selected election</h2>${election ? `${electionSelect()}<div class="row" style="margin-top:14px">${badge(election)}<span class="pill">${election.candidateCount} candidates</span><span class="pill">${election.voterCount} voters</span></div><form id="candidate-form" class="form"><div class="field"><label>Candidate name</label><input name="name" maxlength="80" placeholder="Full name" required></div><button class="btn secondary" ${election.phase !== 0 ? 'disabled' : ''}>Add candidate</button></form>${voterRegistrationForm(election)}` : '<div class="empty">Create an election first.</div>'}</div></div><div><div class="panel"><h3>Election steps</h3>${election ? `<div class="step"><b>1 · Setup</b><p>Add at least two candidates and one voter.</p></div><div class="step"><b>2 · Start voting</b><p>Registered voters can cast one vote each.</p></div><div class="step"><b>3 · End voting</b><p>New votes are blocked.</p></div><div class="step"><b>4 · Publish results</b><p>The dashboard shows the final tally.</p></div><div class="row"><button class="btn" data-start ${election.phase !== 0 ? 'disabled' : ''}>Start election</button><button class="btn secondary" data-end ${election.phase !== 1 ? 'disabled' : ''}>End election</button><button class="btn" data-publish ${election.phase !== 2 ? 'disabled' : ''}>Publish results</button></div>` : '<p class="muted">Create an election to begin.</p>'}</div><div class="panel"><h3>Demo accounts</h3>${accountPicker()}</div></div></div>`;
}

function ownVoteVerification(election) {
  if (!state.voter.voted) return '';
  const check = state.myVoteCheck?.electionId === election.id && state.myVoteCheck?.address?.toLowerCase() === state.address?.toLowerCase() ? state.myVoteCheck : null;
  const result = check?.proof ? `<div class="notice success"><b>Verified on chain</b><br>Your transaction recorded a vote for <b>${esc(check.proof.candidateName)}</b> (candidate ${check.proof.candidateId + 1}).</div><div class="receipt">Transaction: ${esc(check.proof.transactionHash)}<br>Block ${check.proof.blockNumber}: ${esc(check.proof.blockHash)}</div>` : check?.error ? `<div class="notice error">${esc(check.error)}</div>` : '';
  return `<button class="btn secondary" data-verify-my-vote style="margin-top:14px" ${check?.loading ? 'disabled' : ''}>${check?.loading ? 'Checking the chain…' : 'Verify my vote'}</button>${result}`;
}

function ballot() {
  const election = selected();
  if (!election) return '<div class="empty">No election has been created yet.</div>';
  const receipt = state.events.find(event => event.name === 'VoteCast' && event.electionId === election.id && event.voter?.toLowerCase() === state.address?.toLowerCase());
  return `<div class="section-head"><h2>${esc(election.title)}</h2>${badge(election)}</div><div class="panel-grid"><div><div class="panel">${electionSelect()}<p class="muted">${election.phase === 0 ? 'The admin is preparing this election.' : election.phase === 1 ? 'Voting is open. Select one candidate.' : election.phase === 2 ? 'Voting has ended. Waiting for the admin to publish results.' : `Results published ${date(election.publishedAt)}.`}</p>${election.phase === 3 ? results(election) : `<form id="vote-form" class="form">${election.candidates.map(candidate => `<label class="choice"><input type="radio" name="candidate" value="${candidate.id}" required ${!state.voter.eligible || state.voter.voted || election.phase !== 1 ? 'disabled' : ''}><span><b>${esc(candidate.name)}</b><small>Candidate ${candidate.id + 1}</small></span></label>`).join('') || '<div class="empty">No candidates have been added yet.</div>'}<button class="btn" ${!state.voter.eligible || state.voter.voted || election.phase !== 1 ? 'disabled' : ''}>Submit my vote</button></form>`}</div></div><div><div class="panel"><h3>Your voting status</h3><div class="candidate"><b>Registered</b><b>${state.voter.eligible ? 'Yes' : 'No'}</b></div><div class="candidate"><b>Vote submitted</b><b>${state.voter.voted ? 'Yes' : 'No'}</b></div>${receipt ? `<p class="muted">Your transaction receipt</p><div class="receipt">${esc(receipt.hash)}</div>` : ''}${ownVoteVerification(election)}<button class="btn ghost small" data-refresh style="margin-top:14px">Refresh</button></div><div class="panel"><h3>Switch demo account</h3>${accountPicker()}</div></div></div>`;
}

function results(election) {
  const total = election.candidates.reduce((sum, candidate) => sum + candidate.votes, 0);
  return `<div class="section-head"><h2>Final result</h2><span>${total} votes counted</span></div>${election.candidates.map(candidate => `<div class="candidate"><div style="flex:1"><b>${esc(candidate.name)}</b><small>${total ? Math.round(candidate.votes / total * 100) : 0}% of votes</small><div class="bar"><span style="width:${total ? candidate.votes / total * 100 : 0}%"></span></div></div><b>${candidate.votes}</b></div>`).join('')}<p class="muted">The admin has published this result on the chain.</p>`;
}

function adminResults() {
  const election = selected();
  if (!election) return '<div class="empty">No election has been created yet.</div>';
  return `<div class="panel"><h2>Election results</h2>${electionSelect()}<div class="row" style="margin-top:14px">${badge(election)}<span class="pill">${election.voteCount} votes cast</span></div>${election.phase === 3 ? results(election) : '<div class="notice">The result will appear here after the admin ends voting and publishes it.</div>'}</div>`;
}

function audit() {
  const election = selected();
  return `<div class="panel-grid"><div><div class="panel"><h2>Chain activity</h2><p class="muted">Each action is an on-chain transaction. The hash identifies the transaction; the block hash identifies the block that contains it.</p><div class="activity">${state.events.filter(event => !election || event.electionId === 0 || event.electionId === election.id).map(event => `<div class="activity-item"><div><b>${esc(event.name)}</b><br><span>Transaction</span><br><code>${esc(event.hash)}</code><br><span>Block ${event.block}</span><br><code>${esc(event.blockHash)}</code></div></div>`).join('') || '<div class="empty">No events for this election.</div>'}</div></div></div><div><div class="panel"><h3>Verify published tally</h3>${election ? `${electionSelect()}<p class="muted">Read every vote transaction, confirm its receipt and block hash, then compare the candidate counts with the published contract totals.</p><button class="btn" data-verify ${election.phase !== 3 ? 'disabled' : ''}>Verify this election</button>${election.phase !== 3 ? '<div class="notice">The tally can be checked after the admin publishes it.</div>' : ''}${state.audit ? `<div class="notice ${state.audit.ok ? 'success' : 'error'}">${esc(state.audit.text)}</div>` : ''}` : '<p class="muted">No election yet.</p>'}</div><div class="panel"><h3>Chain details</h3><div class="receipt">Chain ID: ${state.config.chainId}<br>Contract: ${esc(state.config.address)}<br>Admin: ${esc(state.config.admin)}</div><p class="muted">A vote transaction reveals the selected candidate on the chain even before the dashboard publishes results. This pilot does not provide secret-ballot privacy.</p></div></div></div>`;
}

function help() {
  return `<div class="panel-grid"><div class="panel"><h2>Admin workflow</h2><div class="step"><b>1 · Manage voter accounts</b><p>Approve demo or external wallet addresses in Voter accounts. Removing an account revokes its voting access.</p></div><div class="step"><b>2 · Create an election</b><p>Enter a title in Manage elections, add at least two candidates, and register approved voter accounts.</p></div><div class="step"><b>3 · Start, end, and publish</b><p>Use the three buttons in order. Active registered voters can vote only while the election is open.</p></div><div class="step"><b>4 · Verify the chain</b><p>Open Verify chain to inspect hashes and compare vote transactions with the published tally.</p></div></div><div><div class="panel"><h3>Voter workflow</h3><p class="muted">Switch to an approved registered voter, open Vote & results, select a candidate, and submit. Each voter can vote once per election.</p></div><div class="panel"><h3>About this demo</h3><p class="muted">Adding an external wallet records its address on chain; its owner keeps the private key. Demo accounts are local and disposable. For a real pilot, verify identity before approving a wallet.</p></div></div></div>`;
}

function bind() {
  document.querySelectorAll('[data-tab]').forEach(element => element.onclick = () => { state.tab = element.dataset.tab; render(); });
  document.querySelectorAll('[data-open]').forEach(element => element.onclick = async () => { state.selected = Number(element.dataset.open); state.myVoteCheck = null; state.tab = isAdmin() ? 'manage' : 'ballot'; await refresh(); });
  document.querySelectorAll('[data-account]').forEach(element => element.onclick = async () => {
    try { const accounts = await state.provider.listAccounts(); state.signer = accounts[Number(element.dataset.account)]; state.address = state.signer.address; state.tab = 'home'; state.audit = null; state.myVoteCheck = null; await refresh(); }
    catch (error) { notify(error.message, true); }
  });
  document.querySelectorAll('[data-wallet]').forEach(element => element.onclick = async () => {
    try { if (!window.ethereum) throw new Error('No browser wallet was found'); const wallet = new ethers.BrowserProvider(window.ethereum); const addresses = await wallet.send('eth_requestAccounts', []); const network = await wallet.getNetwork(); if (Number(network.chainId) !== state.config.chainId) throw new Error(`Switch the wallet to chain ${state.config.chainId}`); state.signer = await wallet.getSigner(addresses[0]); state.address = addresses[0]; state.tab = 'home'; state.audit = null; state.myVoteCheck = null; await refresh(); }
    catch (error) { notify(error.shortMessage || error.message, true); }
  });
  document.querySelectorAll('#election-select').forEach(element => element.onchange = async () => { state.selected = Number(element.value); state.audit = null; state.myVoteCheck = null; await refresh(); });
  document.querySelector('[data-refresh]')?.addEventListener('click', () => refresh().catch(error => notify(error.message, true)));
  document.querySelector('[data-verify-my-vote]')?.addEventListener('click', verifyMyVote);
  document.querySelector('#create-form')?.addEventListener('submit', event => { event.preventDefault(); const title = new FormData(event.target).get('title').trim(); if (!title) return notify('Enter an election title', true); const newElectionId = state.elections.length + 1; transact('Election creation', () => writeContract().createElection(title), () => { state.selected = newElectionId; }); });
  document.querySelector('#candidate-form')?.addEventListener('submit', event => { event.preventDefault(); const name = new FormData(event.target).get('name').trim(); if (!name) return notify('Enter a candidate name', true); transact('Candidate addition', () => writeContract().addCandidate(state.selected, name)); });
  document.querySelector('#voter-form')?.addEventListener('submit', event => { event.preventDefault(); const address = new FormData(event.target).get('address'); if (!address || !state.voterAccounts.some(account => account.toLowerCase() === address.toLowerCase())) return notify('Select an approved voter account', true); if (state.registeredAccounts[address.toLowerCase()]) return notify('This voter is already registered', true); transact('Voter registration', () => writeContract().registerVoter(state.selected, address)); });
  document.querySelector('[data-register-all]')?.addEventListener('click', registerAllVoters);
  document.querySelectorAll('[data-remove-voter]').forEach(element => element.addEventListener('click', () => { const address = element.dataset.removeVoter; if (!address || !state.registeredAccounts[address.toLowerCase()]) return; transact('Voter removal', () => writeContract().removeVoter(state.selected, address)); }));
  document.querySelector('#add-demo-account-form')?.addEventListener('submit', event => { event.preventDefault(); const address = new FormData(event.target).get('address'); if (!address || !state.config.demoAccounts.slice(1).some(account => account.toLowerCase() === address.toLowerCase())) return notify('Choose a demo voter account', true); transact('Voter account addition', () => writeContract().addVoterAccount(address)); });
  document.querySelector('#add-wallet-account-form')?.addEventListener('submit', event => { event.preventDefault(); const address = new FormData(event.target).get('address').trim(); if (!ethers.isAddress(address) || address.toLowerCase() === state.config.admin.toLowerCase()) return notify('Enter a valid voter wallet address', true); transact('Voter wallet addition', () => writeContract().addVoterAccount(address)); });
  document.querySelectorAll('[data-remove-account]').forEach(element => element.addEventListener('click', () => { const address = element.dataset.removeAccount; if (!address || !state.voterAccounts.some(account => account.toLowerCase() === address.toLowerCase())) return; if (confirm(`Remove ${accountLabel(address)} from the chain voter registry?`)) transact('Voter account removal', () => writeContract().removeVoterAccount(address)); }));
  document.querySelector('[data-start]')?.addEventListener('click', () => transact('Election start', () => writeContract().startElection(state.selected)));
  document.querySelector('[data-end]')?.addEventListener('click', () => { if (confirm('End voting for this election?')) transact('Election end', () => writeContract().endElection(state.selected)); });
  document.querySelector('[data-publish]')?.addEventListener('click', () => transact('Result publication', () => writeContract().publishResults(state.selected), () => { state.tab = 'results'; }));
  document.querySelector('#vote-form')?.addEventListener('submit', event => { event.preventDefault(); const candidate = new FormData(event.target).get('candidate'); if (candidate === null) return notify('Choose a candidate', true); transact('Vote', () => writeContract().castVote(state.selected, Number(candidate))); });
  document.querySelector('[data-verify]')?.addEventListener('click', verifyElection);
}

async function verifyMyVote() {
  const election = selected();
  if (!election || !state.voter.voted || !state.address) return;
  const electionId = election.id;
  const address = state.address;
  state.myVoteCheck = { electionId, address, loading: true };
  render();
  try {
    const proof = await verifyRecordedVote({ provider: state.provider, contractAddress: state.config.address, abi: state.config.abi, electionId, voterAddress: address });
    if (state.selected !== electionId || state.address?.toLowerCase() !== address.toLowerCase()) return;
    state.myVoteCheck = { electionId, address, proof };
  } catch (error) {
    if (state.selected !== electionId || state.address?.toLowerCase() !== address.toLowerCase()) return;
    state.myVoteCheck = { electionId, address, error: error.message };
  }
  render();
}

async function verifyElection() {
  const election = selected();
  if (!election || election.phase !== 3) return;
  try {
    notify('Verifying vote transactions and block hashes…');
    const contract = readContract();
    const voteLogs = await contract.queryFilter(contract.filters.VoteCast(election.id), 0);
    const counts = Array(election.candidateCount).fill(0);
    for (const log of voteLogs) {
      const [transaction, receipt, block] = await Promise.all([state.provider.getTransaction(log.transactionHash), state.provider.getTransactionReceipt(log.transactionHash), state.provider.getBlock(log.blockNumber)]);
      if (!transaction || !receipt || !block || receipt.status !== 1 || receipt.blockHash !== block.hash || log.blockHash !== block.hash || transaction.to?.toLowerCase() !== state.config.address.toLowerCase()) throw new Error(`Invalid receipt for ${short(log.transactionHash)}`);
      const decoded = contract.interface.parseTransaction({ data: transaction.data, value: transaction.value });
      if (decoded?.name !== 'castVote' || Number(decoded.args[0]) !== election.id) throw new Error(`Unexpected vote call in ${short(log.transactionHash)}`);
      const candidateId = Number(decoded.args[1]);
      if (candidateId < 0 || candidateId >= counts.length) throw new Error('Invalid candidate ID in transaction');
      counts[candidateId]++;
    }
    const published = await Promise.all(election.candidates.map(candidate => contract.candidateVotes(election.id, candidate.id)));
    const match = counts.every((count, index) => BigInt(count) === published[index]) && voteLogs.length === election.voteCount;
    state.audit = { ok: match, text: match ? `Verified ${voteLogs.length} vote transaction${voteLogs.length === 1 ? '' : 's'}. Receipt and block hashes match; candidate totals match the published contract result.` : 'Verification failed: vote transactions and published totals differ.' };
    state.message = null;
    render();
  } catch (error) { state.audit = { ok: false, text: error.message }; state.message = null; render(); }
}

init();

import test from 'node:test';
import assert from 'node:assert/strict';
import { buildGitHubOperation, GITHUB_OPERATIONS, planAdminLeaseClaim } from '../src/readiness3/catalog.js';

const SHA = 'a'.repeat(40);
const TASK = {
  taskNodeId: 'TASK_r3', repo: 'Hidetsugu55/openclaw-setup', branch: 'codex/task',
  headSha: SHA, treeSha: 'b'.repeat(40), baseSha: 'c'.repeat(40),
  expectedOldOid: '0'.repeat(40), revisionHash: 'd'.repeat(64),
};
const actor = role => ({ authenticatedRole: role, principalProofDigest: '9'.repeat(64) });

test('G02 G10 G11 closed catalog contains no raw/default/Admin operation in Normal lane', () => {
  assert.deepEqual(Object.keys(GITHUB_OPERATIONS).sort(), [
    'branch.push', 'cleanup.local_ref', 'pr.create', 'pr.merge', 'pr.update',
    'pr.update_branch', 'repo.settings.apply', 'ruleset.apply',
  ]);
  for (const operation of ['repo.settings.apply', 'ruleset.apply']) assert.equal(GITHUB_OPERATIONS[operation].lane, 'ADMIN_LEASE');
  for (const operation of ['branch.push', 'pr.create', 'pr.update', 'pr.update_branch', 'pr.merge', 'cleanup.local_ref']) assert.notEqual(GITHUB_OPERATIONS[operation].lane, 'ADMIN_LEASE');
  for (const operation of ['git.refs.update', 'contents.update', 'raw.request', 'workflow.dispatch']) {
    assert.throws(() => buildGitHubOperation({ operation, actorContext: actor('dev-host'), task: TASK, immutable: {} }), /closed GitHub operation/);
  }
});

test('G03 G06 immutable operation cross-checks Task commit, tree, base and fixed identifiers', () => {
  const descriptor = buildGitHubOperation({
    operation: 'branch.push', actorContext: actor('dev-host'), task: TASK,
    policyRevision: 'e'.repeat(64),
    immutable: { expectedOldOid: TASK.expectedOldOid, newOid: TASK.headSha, treeOid: TASK.treeSha },
  });
  assert.equal(descriptor.immutable.newOid, TASK.headSha);
  assert.match(descriptor.digest, /^[a-f0-9]{64}$/);
  assert.equal(Object.hasOwn(descriptor, 'credential'), false);
  assert.throws(() => buildGitHubOperation({
    operation: 'branch.push', actorContext: actor('dev-host'), task: TASK,
    policyRevision: 'e'.repeat(64),
    immutable: { expectedOldOid: TASK.expectedOldOid, newOid: 'f'.repeat(40), treeOid: TASK.treeSha },
  }), /Task mismatch/);
});

test('G05 G10 role proof and exact Admin lease cannot be selected by a worker', () => {
  assert.throws(() => buildGitHubOperation({
    operation: 'pr.merge', actorContext: actor('dev-host'), task: TASK,
    policyRevision: 'e'.repeat(64),
    immutable: { prNumber: 108, headSha: TASK.headSha, baseSha: TASK.baseSha, testedSha: 'f'.repeat(40) },
  }), /role ceiling/);
  const immutable = { profileDigest: '1'.repeat(64), preStateDigest: '2'.repeat(64) };
  assert.throws(() => buildGitHubOperation({ operation: 'repo.settings.apply', actorContext: actor('ops'), task: TASK, policyRevision: 'e'.repeat(64), immutable }), /Admin receipt/);
  const receipt = {
    id: 'ADMIN_1', digest: '3'.repeat(64), repo: TASK.repo, taskNodeId: TASK.taskNodeId,
    issuedAt: 10_000, expiresAt: 20_000, operationSet: ['repo.settings.apply'],
    preStateDigest: immutable.preStateDigest, changeDigest: immutable.profileDigest,
    endpoint: `PATCH /repos/${TASK.repo}`,
    steps: ['READ_PRESTATE', 'CAS_APPLY_SETTINGS', 'READ_POSTSTATE', 'ROLLBACK_SETTINGS'],
    rollbackDigest: '4'.repeat(64), claimState: 'UNCLAIMED', cursor: 0, attempts: 0,
  };
  const admin = buildGitHubOperation({
    operation: 'repo.settings.apply', actorContext: actor('ops'), task: TASK,
    policyRevision: 'e'.repeat(64), immutable, adminReceipt: receipt, now: 15_000,
  });
  assert.equal(admin.lane, 'ADMIN_LEASE');
  const ledgerState = { revision: 7, receiptDigest: receipt.digest, claimState: 'UNCLAIMED', cursor: 0, attempts: 0, expiresAt: receipt.expiresAt };
  const claim = planAdminLeaseClaim({ descriptor: admin, ledgerState, expectedRevision: 7, now: 15_000 });
  assert.equal(claim.nextState.claimState, 'CLAIMED');
  assert.equal(claim.nextState.revision, 8);
  assert.throws(() => planAdminLeaseClaim({ descriptor: admin, ledgerState: claim.nextState, expectedRevision: 8, now: 15_001 }), /already claimed/);
  for (const adminReceipt of [
    { ...receipt, operationSet: ['repo.settings.apply', 'ruleset.apply'] },
    { ...receipt, preStateDigest: '8'.repeat(64) },
    { ...receipt, issuedAt: 0, expiresAt: 2_000_000 },
    { ...receipt, claimState: 'CLAIMED' },
  ]) assert.throws(() => buildGitHubOperation({
    operation: 'repo.settings.apply', actorContext: actor('ops'), task: TASK,
    policyRevision: 'e'.repeat(64), immutable, adminReceipt, now: 15_000,
  }), /Admin receipt/);
});

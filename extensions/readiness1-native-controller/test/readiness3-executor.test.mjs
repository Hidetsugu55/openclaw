import test from 'node:test';
import assert from 'node:assert/strict';
import { admissionDescriptorDigest, behindDecisionDigest } from '../src/readiness3/admission.js';
import { createNormalGitHubExecutor } from '../src/readiness3/executor.js';
import { mergeDecisionDigest } from '../src/readiness3/merge.js';

const HEAD = 'a'.repeat(40); const BASE = 'b'.repeat(40); const RESULT = 'c'.repeat(40);
function admission(patch = {}) {
  const value = {
    schema: 'readiness3.admission.v3', taskNodeId: 'TASK', repo: 'Hidetsugu55/openclaw-setup',
    operation: 'branch.push', route: 'controller', writerId: 'writer', processIdentityDigest: '1'.repeat(64),
    branch: 'codex/task', defaultBranch: 'main', taskBranchPrefix: 'codex/', baseSha: BASE,
    headSha: HEAD, treeSha: 'e'.repeat(40), expectedOldOid: '0'.repeat(40), prNumber: null,
    changeDigest: '2'.repeat(64), authorityDigest: '3'.repeat(64), inventoryRevision: '4'.repeat(64),
    reviewDigest: null, activationDigest: null, behindAction: null, behindPathsDigest: null,
    behindDecisionDigest: null, currentBaseSha: null, policyRevision: '5'.repeat(64),
    taskRevision: '6'.repeat(64), risks: [], decision: 'ALLOW_NORMAL', mechanical: true, ...patch,
  };
  return { ...value, descriptorDigest: admissionDescriptorDigest(value) };
}
const authorize = descriptorDigest => async () => ({ invocationId: 'OP_1', descriptorDigest });

test('G03 effect boundary recomputes descriptor and rejects content substitution', async () => {
  const events = []; const admitted = admission();
  const executor = createNormalGitHubExecutor({
    transport: { async pushBranch(input) { events.push(input); }, async mergePullRequest() {}, async updatePullRequestBranch() {} },
    readback: { async branch() { return { oid: HEAD }; }, async pullRequest() { return null; } },
  });
  assert.equal((await executor.publishBranch({ admission: admitted, authorizeFirstEffect: authorize(admitted.descriptorDigest) })).confirmed, true);
  assert.equal(events[0].expectedOldOid, admitted.expectedOldOid);
  await assert.rejects(() => executor.publishBranch({ admission: { ...admitted, repo: 'Hidetsugu55/other' }, authorizeFirstEffect: authorize(admitted.descriptorDigest) }), /immutable admission/);
  await assert.rejects(() => executor.publishBranch({ admission: { ...admitted, branch: 'main' }, authorizeFirstEffect: authorize(admitted.descriptorDigest) }), /ref mismatch/);
});

test('G07 G16 response loss is read back and never retried', async () => {
  let pushes = 0; const admitted = admission();
  const executor = createNormalGitHubExecutor({
    transport: { async pushBranch() { pushes += 1; throw new Error('lost'); }, async mergePullRequest() {}, async updatePullRequestBranch() {} },
    readback: { async branch() { return { oid: BASE }; }, async pullRequest() { return null; } },
  });
  assert.deepEqual(await executor.publishBranch({ admission: admitted, authorizeFirstEffect: authorize(admitted.descriptorDigest) }), { confirmed: false, result: 'OUTCOME_UNKNOWN', retry: false });
  assert.equal(pushes, 1);
});

test('G05 G08 merge decision digest binds repo, PR, head, base and operation', async () => {
  const descriptor = { schema: 'readiness3.merge-decision.v3', operation: 'pr.merge', lane: 'NORMAL',
    request: { repo: 'Hidetsugu55/openclaw-setup', number: 108, sha: HEAD, merge_method: 'squash' },
    baseSha: BASE, testedSha: RESULT, admissionDigest: '7'.repeat(64), inventoryRevision: '8'.repeat(64),
    decision: 'MERGE_ALLOWED' };
  const decision = { ...descriptor, descriptorDigest: mergeDecisionDigest(descriptor) };
  const executor = createNormalGitHubExecutor({
    transport: { async pushBranch() {}, async updatePullRequestBranch() {}, async mergePullRequest() { return { merged: true }; } },
    readback: { async branch() {}, async pullRequest() { return { state: 'MERGED', headSha: HEAD, mergeMethod: 'SQUASH', mergeCommitSha: RESULT, mergeParents: [BASE], defaultContainsMerge: true }; } },
  });
  assert.equal((await executor.mergePullRequest({ decision, authorizeFirstEffect: authorize(decision.descriptorDigest) })).confirmed, true);
  await assert.rejects(() => executor.mergePullRequest({ decision: { ...decision, request: { ...decision.request, number: 999 } }, authorizeFirstEffect: authorize(decision.descriptorDigest) }), /merge not admitted/);
});

test('G07 update-branch binds behind decision and verifies actual merge parents', async () => {
  const behind = { schema: 'readiness3.behind-decision.v1', action: 'UPDATE_BRANCH', expectedHeadSha: HEAD,
    currentBaseSha: 'f'.repeat(40), pathsDigest: '9'.repeat(64), policyRevision: '5'.repeat(64) };
  behind.descriptorDigest = behindDecisionDigest(behind);
  const admitted = admission({ operation: 'pr.update_branch', prNumber: 108, behindAction: behind.action,
    behindPathsDigest: behind.pathsDigest, behindDecisionDigest: behind.descriptorDigest, currentBaseSha: behind.currentBaseSha });
  let observed = { state: 'OPEN', headSha: RESULT, parents: [HEAD, behind.currentBaseSha] };
  const executor = createNormalGitHubExecutor({
    transport: { async pushBranch() {}, async mergePullRequest() {}, async updatePullRequestBranch() {} },
    readback: { async branch() {}, async pullRequest() { return observed; } },
  });
  assert.equal((await executor.updatePullRequestBranch({ admission: admitted, authorizeFirstEffect: authorize(admitted.descriptorDigest) })).confirmed, true);
  observed = { ...observed, parents: [HEAD, BASE] };
  assert.equal((await executor.updatePullRequestBranch({ admission: admitted, authorizeFirstEffect: authorize(admitted.descriptorDigest) })).confirmed, false);
});

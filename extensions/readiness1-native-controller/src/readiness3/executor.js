import { requireThat } from '../contract.js';
import { admissionDescriptorDigest, behindDecisionDigest } from './admission.js';
import { mergeDecisionDigest } from './merge.js';

const SHA40 = /^[a-f0-9]{40}$/;
const SHA64 = /^[a-f0-9]{64}$/;
const SAFE_TASK_BRANCH = /^codex\/(?!.*(?:\/\/|\.\.|@\{|[\\\s~^:?*\[]))(?!.*(?:^|\/)\.)(?!.*\.lock(?:\/|$))(?!.*[\/.]$)[A-Za-z0-9._/-]+$/;

function validateBinding(binding, methods, label) {
  requireThat(binding && methods.every(method => typeof binding[method] === 'function'), `missing fixed ${label} binding`);
}

function validAdmission(admission, operation) {
  requireThat(admission?.decision === 'ALLOW_NORMAL' && admission?.mechanical === true && (admission?.risks ?? []).length === 0, 'normal publication not admitted');
  requireThat(admission.operation === operation && typeof admission.repo === 'string' && SAFE_TASK_BRANCH.test(admission.branch)
    && admission.branch.startsWith(admission.taskBranchPrefix) && admission.branch !== admission.defaultBranch, 'admission operation or ref mismatch');
  requireThat(SHA40.test(admission.headSha ?? '') && SHA40.test(admission.baseSha ?? '') && SHA40.test(admission.treeSha ?? '')
    && SHA40.test(admission.expectedOldOid ?? '') && SHA64.test(admission.descriptorDigest ?? '')
    && admission.descriptorDigest === admissionDescriptorDigest(admission), 'invalid immutable admission');
}

async function authorize(authorizeFirstEffect, descriptorDigest) {
  requireThat(typeof authorizeFirstEffect === 'function', 'missing first-effect authorization');
  const result = await authorizeFirstEffect();
  requireThat(typeof result?.invocationId === 'string' && result.invocationId.length > 0
    && result?.descriptorDigest === descriptorDigest, 'first-effect authorization mismatch');
}

async function observeBranch(readback, repo, ref) {
  try { return await readback.branch({ repo, ref }); } catch { return null; }
}

async function observePullRequest(readback, repo, number) {
  try { return await readback.pullRequest({ repo, number }); } catch { return null; }
}

export function createNormalGitHubExecutor({ transport, readback }) {
  validateBinding(transport, ['pushBranch', 'mergePullRequest', 'updatePullRequestBranch'], 'GitHub transport');
  validateBinding(readback, ['branch', 'pullRequest'], 'GitHub readback');

  async function publishBranch({ admission, authorizeFirstEffect }) {
    validAdmission(admission, 'branch.push');
    const ref = `refs/heads/${admission.branch}`;
    await authorize(authorizeFirstEffect, admission.descriptorDigest);
    try {
      await transport.pushBranch({ repo: admission.repo, ref, expectedOldOid: admission.expectedOldOid, newOid: admission.headSha, force: false });
    } catch { /* outcome is read back below */ }
    const observed = await observeBranch(readback, admission.repo, ref);
    if (observed?.oid === admission.headSha) return Object.freeze({ confirmed: true, result: 'BRANCH_PUBLISHED', oid: observed.oid });
    return Object.freeze({ confirmed: false, result: 'OUTCOME_UNKNOWN', retry: false });
  }

  async function mergePullRequest({ decision, authorizeFirstEffect }) {
    const { repo, number, sha, merge_method: mergeMethod } = decision?.request ?? {};
    requireThat(decision?.decision === 'MERGE_ALLOWED' && decision?.operation === 'pr.merge' && decision?.lane === 'NORMAL'
      && typeof repo === 'string' && Number.isSafeInteger(number) && number > 0
      && SHA40.test(sha ?? '') && SHA40.test(decision?.baseSha ?? '')
      && SHA64.test(decision?.descriptorDigest ?? '') && decision.descriptorDigest === mergeDecisionDigest(decision)
      && mergeMethod === 'squash', 'merge not admitted');
    await authorize(authorizeFirstEffect, decision.descriptorDigest);
    let response = null;
    try { response = await transport.mergePullRequest({ repo, number, sha, mergeMethod }); } catch { /* read back */ }
    const observed = await observePullRequest(readback, repo, number);
    if (observed?.state === 'MERGED' && observed?.headSha === sha && observed?.mergeMethod === 'SQUASH'
      && SHA40.test(observed?.mergeCommitSha ?? '') && Array.isArray(observed?.mergeParents)
      && observed.mergeParents.length === 1 && observed.mergeParents[0] === decision.baseSha
      && observed?.defaultContainsMerge === true) {
      return Object.freeze({ confirmed: true, result: 'MERGED', resultSha: observed.mergeCommitSha });
    }
    if (response?.merged === false && response?.definitive === true) return Object.freeze({ confirmed: false, result: 'FAILED_CONFIRMED', retry: false });
    return Object.freeze({ confirmed: false, result: 'OUTCOME_UNKNOWN', retry: false });
  }

  async function updatePullRequestBranch({ admission, authorizeFirstEffect }) {
    validAdmission(admission, 'pr.update_branch');
    requireThat(Number.isSafeInteger(admission.prNumber) && admission.prNumber > 0, 'invalid update-branch identity');
    requireThat(admission.behindAction === 'UPDATE_BRANCH' && SHA40.test(admission.currentBaseSha ?? '')
      && SHA64.test(admission.behindDecisionDigest ?? '')
      && admission.behindDecisionDigest === behindDecisionDigest({
        schema: 'readiness3.behind-decision.v1', action: admission.behindAction,
        expectedHeadSha: admission.headSha, currentBaseSha: admission.currentBaseSha,
        pathsDigest: admission.behindPathsDigest, policyRevision: admission.policyRevision,
      }), 'behind decision not bound');
    await authorize(authorizeFirstEffect, admission.descriptorDigest);
    try {
      await transport.updatePullRequestBranch({ repo: admission.repo, number: admission.prNumber, expectedHeadSha: admission.headSha });
    } catch { /* read back */ }
    const observed = await observePullRequest(readback, admission.repo, admission.prNumber);
    if (observed?.state === 'OPEN' && SHA40.test(observed?.headSha ?? '') && observed.headSha !== admission.headSha
      && Array.isArray(observed?.parents) && observed.parents.length === 2
      && observed.parents[0] === admission.headSha && observed.parents[1] === admission.currentBaseSha) {
      return Object.freeze({ confirmed: true, result: 'HEAD_UPDATED', headSha: observed.headSha, invalidateEvidence: true });
    }
    return Object.freeze({ confirmed: false, result: 'OUTCOME_UNKNOWN', retry: false });
  }

  return Object.freeze({ publishBranch, mergePullRequest, updatePullRequestBranch });
}

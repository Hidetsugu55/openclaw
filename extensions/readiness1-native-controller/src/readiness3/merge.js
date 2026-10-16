import { digest } from '../contract.js';
import { admissionDescriptorDigest, validReadiness3Policy } from './admission.js';

const SHA40 = /^[a-f0-9]{40}$/;
const SHA64 = /^[a-f0-9]{64}$/;

function block(reasons) { return Object.freeze({ decision: 'BLOCKED', reasons: [...new Set(reasons)] }); }
function withoutDigest(value) { const { digest: _digest, ...content } = value ?? {}; return content; }
function exactDigest(value) { try { return SHA64.test(value?.digest ?? '') && value.digest === digest(withoutDigest(value)); } catch { return false; } }

function requiredReviewKinds(admission) {
  const required = new Set(['REVIEWER']);
  if ((admission?.risks ?? []).length > 0) required.add('AUDITOR');
  return [...required];
}

function validReviewReceipt(receipt, kind, { task, pullRequest, verification, policy, admission }) {
  const source = receipt?.source;
  const binding = receipt?.binding;
  return receipt?.schema === 'readiness3.merge-review-adapter.v1' && exactDigest(receipt)
    && Array.isArray(task?.mergeReviewDigests) && task.mergeReviewDigests.includes(receipt.digest)
    && receipt.kind === kind && source?.schema === 'readiness1.audit-receipt.v1'
    && source.verdict === 'PASS' && source.head === pullRequest.headSha && source.scopeHash === task.scopeHash
    && SHA64.test(source.manifestHash ?? '') && SHA64.test(source.reportHash ?? '')
    && binding?.baseSha === pullRequest.baseSha && binding?.testedSha === verification.testedSha
    && binding?.policyRevision === policy.revision && binding?.changeDigest === admission.changeDigest
    && binding?.independent === true && binding?.fresh === true;
}

function mergeDecisionContent(value) {
  return {
    schema: value.schema, operation: value.operation, lane: value.lane, request: value.request,
    baseSha: value.baseSha, testedSha: value.testedSha, admissionDigest: value.admissionDigest,
    inventoryRevision: value.inventoryRevision,
  };
}

export function mergeDecisionDigest(value) { try { return digest(mergeDecisionContent(value)); } catch { return null; } }

export function decideExactMerge({ task, policy, admission, pullRequest, repository, checks, verification, reviews, inventoryProof, now = Date.now() }) {
  const reasons = [];
  if (!validReadiness3Policy(policy)) reasons.push('policy_unknown');
  if (admission?.decision !== 'ALLOW_NORMAL' || admission?.mechanical !== true || (admission?.risks ?? []).length !== 0
      || admission?.operation !== 'pr.merge' || admission?.descriptorDigest !== admissionDescriptorDigest(admission)) reasons.push('normal_merge_admission_missing');
  if (admission?.repo !== task?.repo || admission?.branch !== task?.branch) reasons.push('admission_scope_mismatch');
  if (!SHA64.test(admission?.descriptorDigest ?? '') || admission?.taskRevision !== task?.revisionHash) reasons.push('admission_revision_mismatch');
  if (inventoryProof?.decision !== 'NORMAL_VERIFIED' || inventoryProof?.route !== admission?.route
      || inventoryProof?.lanes?.[admission?.route] !== 'NORMAL_VERIFIED' || inventoryProof?.revision !== admission?.inventoryRevision
      || !Number.isSafeInteger(inventoryProof?.expiresAt) || inventoryProof.expiresAt <= now) reasons.push('inventory_not_verified');
  if (!Number.isSafeInteger(now) || task?.state !== 'ACTIVE' || task?.cancelled !== false
      || !Number.isSafeInteger(task?.receiptExpiresAt) || !Number.isSafeInteger(task?.deadline) || !Number.isSafeInteger(task?.hardSunset)
      || now >= task?.receiptExpiresAt || now >= task?.deadline || now >= task?.hardSunset) reasons.push('task_inactive_or_expired');
  if (pullRequest?.repo !== task?.repo || !Number.isSafeInteger(pullRequest?.number) || pullRequest.number <= 0
      || pullRequest.number !== admission?.prNumber || pullRequest?.headRepo !== task?.repo || pullRequest?.baseRepo !== task?.repo
      || pullRequest?.headRef !== task?.branch || pullRequest?.baseRef !== policy?.defaultBranch
      || pullRequest?.state !== 'OPEN' || pullRequest?.mergeable !== true || pullRequest?.behind !== false) reasons.push('pull_request_not_mergeable');
  if (pullRequest?.autoMerge !== false) reasons.push('auto_merge_must_be_off');
  if (pullRequest?.headSha !== task?.headSha || pullRequest?.headSha !== admission?.headSha) reasons.push('head_drift');
  if (pullRequest?.baseSha !== task?.baseSha || pullRequest?.baseSha !== admission?.baseSha) reasons.push('base_drift');
  if (repository?.defaultHeadSha !== pullRequest?.baseSha) reasons.push('default_advanced_after_verification');
  if (repository?.nativeProfileDecision !== 'MATCH' || repository?.rulesetEffective !== true
      || repository?.bypassVisibility !== 'COMPLETE' || !Array.isArray(repository?.bypassActors)
      || repository.bypassActors.length !== 0) reasons.push('native_ruleset_not_effective');
  if (admission?.policyRevision !== policy?.revision || verification?.acceptedRevision !== policy?.revision) reasons.push('policy_drift');
  if (verification?.headSha !== pullRequest?.headSha || verification?.baseSha !== pullRequest?.baseSha
      || !['HEAD', 'TEST_MERGE'].includes(verification?.kind) || !SHA40.test(verification?.testedSha ?? '')) reasons.push('verification_drift');
  if (verification?.kind === 'HEAD' && verification?.testedSha !== pullRequest?.headSha) reasons.push('verification_target_mismatch');
  if (verification?.kind === 'TEST_MERGE' && (!Array.isArray(verification?.parents) || verification.parents.length !== 2
      || verification.parents[0] !== pullRequest?.baseSha || verification.parents[1] !== pullRequest?.headSha)) reasons.push('test_merge_parent_mismatch');
  if (repository?.requiredCheck?.strict !== true || repository?.requiredCheck?.context !== policy?.verify?.context
      || repository?.requiredCheck?.integrationId !== policy?.verify?.integrationId) reasons.push('effective_required_check_mismatch');
  const acceptedCheck = Array.isArray(checks) && checks.find(check => check.context === policy?.verify?.context
    && check.integrationId === policy?.verify?.integrationId && check.conclusion === 'SUCCESS'
    && check.stepsExecuted === true && check.event === 'pull_request' && check.headSha === verification?.testedSha);
  if (!acceptedCheck) reasons.push('required_check_missing_or_wrong_source');
  if (!Array.isArray(reviews?.receipts)) reasons.push('required_review_missing');
  else for (const kind of requiredReviewKinds(admission)) {
    if (!reviews.receipts.some(receipt => validReviewReceipt(receipt, kind, { task, pullRequest, verification, policy, admission }))) reasons.push(`required_${kind.toLowerCase()}_missing`);
  }
  if (reasons.length > 0) return block(reasons);
  const request = Object.freeze({ repo: pullRequest.repo, number: pullRequest.number, sha: pullRequest.headSha, merge_method: 'squash' });
  const descriptor = { schema: 'readiness3.merge-decision.v3', operation: 'pr.merge', lane: 'NORMAL', request,
    baseSha: pullRequest.baseSha, testedSha: verification.testedSha,
    admissionDigest: admission.descriptorDigest, inventoryRevision: inventoryProof.revision };
  return Object.freeze({ ...descriptor, decision: 'MERGE_ALLOWED', descriptorDigest: mergeDecisionDigest(descriptor) });
}

export function reconcileMergeOutcome({ response, pullRequest, expectedHead, expectedBase }) {
  if (pullRequest?.state === 'MERGED' && pullRequest?.headSha === expectedHead
      && pullRequest?.mergeMethod === 'SQUASH' && SHA40.test(pullRequest?.mergeCommitSha ?? '')
      && Array.isArray(pullRequest?.mergeParents) && pullRequest.mergeParents.length === 1
      && pullRequest.mergeParents[0] === expectedBase && pullRequest?.defaultContainsMerge === true) {
    return Object.freeze({ state: 'MERGED_CONFIRMED', retry: false, resultSha: pullRequest.mergeCommitSha });
  }
  if (response?.merged === false && response?.definitive === true) return Object.freeze({ state: 'FAILED_CONFIRMED', retry: false, reason: response.message ?? 'merge refused' });
  return Object.freeze({ state: 'OUTCOME_UNKNOWN', retry: false, readbackRequired: true });
}

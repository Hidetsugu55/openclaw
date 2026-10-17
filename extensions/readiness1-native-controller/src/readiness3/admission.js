import path from 'node:path';
import { digest } from '../contract.js';
import { SNAPSHOT_CLOSURE } from '../readiness2/snapshot.js';

const SHA40 = /^[a-f0-9]{40}$/;
const SHA64 = /^[a-f0-9]{64}$/;
const SAFE_BRANCH = /^(?!\/)(?!.*(?:\/\/|\.\.|@\{|[\\\s~^:?*\[]))(?!.*(?:^|\/)\.)(?!.*\.lock(?:\/|$))(?!.*[\/.]$)[A-Za-z0-9._/-]+$/;
const ALLOWED_OPERATIONS = new Set(['branch.push', 'pr.create', 'pr.update', 'pr.update_branch', 'pr.merge']);
const PR_NUMBER_OPERATIONS = new Set(['pr.update', 'pr.update_branch', 'pr.merge']);
const RISK_ORDER = ['AUTO_LOADED_INSTRUCTION', 'WORKFLOW', 'CONTROLLER', 'PUBLISHER', 'VERIFICATION'];
const CANDIDATE_FIELDS = new Set(['operation', 'repo', 'branch', 'baseSha', 'headSha', 'treeSha', 'force', 'expectedOldOid', 'prNumber']);
const SNAPSHOT_PUBLISHER_PATHS = new Set(SNAPSHOT_CLOSURE.map(value => value.toLowerCase()));
const SNAPSHOT_PYTHON_PATHS = SNAPSHOT_CLOSURE.filter(value => value.endsWith('.py')).map(value => value.toLowerCase());
const SNAPSHOT_PYTHON_STEMS = Object.freeze(SNAPSHOT_PYTHON_PATHS.map(value => value.slice(0, -3)));
const SNAPSHOT_PYTHON_ROOTS = new Set(SNAPSHOT_PYTHON_PATHS.map(value => path.posix.dirname(value)));

function validBranch(branch) { return typeof branch === 'string' && SAFE_BRANCH.test(branch); }

export function policyRevision(policy) {
  if (!policy || typeof policy !== 'object') return null;
  const { revision: _revision, ...content } = policy;
  try { return digest(content); } catch { return null; }
}

export function validReadiness3Policy(policy) {
  return policy?.schema === 'readiness3.policy.v2'
    && SHA64.test(policy.revision ?? '') && policy.revision === policyRevision(policy)
    && /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(policy.repo ?? '')
    && validBranch(policy.defaultBranch)
    && typeof policy.taskBranchPrefix === 'string' && policy.taskBranchPrefix.endsWith('/')
    && validBranch(policy.taskBranchPrefix.slice(0, -1))
    && policy.acceptedAuthority === 'readiness3.authority-adapter.v1'
    && policy.appInventory === 'COMPLETE'
    && typeof policy.verify?.context === 'string' && policy.verify.context.length > 0
    && Number.isSafeInteger(policy.verify.integrationId) && policy.verify.integrationId > 0
    && policy.verify.strict === true
    && ['autoLoadedPaths', 'autoLoadedPrefixes', 'controllerPaths', 'controllerPrefixes',
      'publisherPaths', 'publisherPrefixes', 'verificationPaths', 'verificationPrefixes']
      .every(key => Array.isArray(policy[key]) && policy[key].every(value => typeof value === 'string' && value.length > 0));
}

function normalizeCandidatePath(value) {
  if (typeof value !== 'string' || value.length === 0 || value.startsWith('/')
      || value !== value.normalize('NFC') || value !== path.posix.normalize(value)
      || value.split('/').some(part => part === '' || part === '.' || part === '..')) throw new Error('invalid candidate path');
  return value.toLowerCase();
}

function configuredMatch(candidatePath, exact = [], prefixes = []) {
  return exact.some(value => normalizeCandidatePath(value) === candidatePath)
    || prefixes.some(value => candidatePath.startsWith(`${normalizeCandidatePath(value).replace(/\/$/, '')}/`));
}

function snapshotPublisherPath(candidatePath) {
  if (SNAPSHOT_PUBLISHER_PATHS.has(candidatePath)) return true;
  if (SNAPSHOT_PYTHON_STEMS.some(stem => candidatePath.startsWith(`${stem}.`) || candidatePath.startsWith(`${stem}/`))) return true;
  const inImportRoot = [...SNAPSHOT_PYTHON_ROOTS].some(root => candidatePath.startsWith(`${root}/`));
  return inImportRoot && (candidatePath.endsWith('.py') || candidatePath.endsWith('.pyc')
    || candidatePath.endsWith('.so') || candidatePath.split('/').includes('__pycache__'));
}

function pathRisks(value, policy) {
  const candidatePath = normalizeCandidatePath(value);
  const parts = candidatePath.split('/');
  const basename = parts.at(-1);
  const risks = [];
  if (['agents.md', 'agents.override.md', 'claude.md', 'claude.local.md', '.mcp.json', 'package.json'].includes(basename)
      || parts.some(part => ['.claude', '.codex', '.mcp', '.husky', '.githooks', 'hooks', 'hook'].includes(part))
      || configuredMatch(candidatePath, policy.autoLoadedPaths, policy.autoLoadedPrefixes)) risks.push('AUTO_LOADED_INSTRUCTION');
  if (candidatePath.startsWith('.github/workflows/') || candidatePath.startsWith('.github/actions/')) risks.push('WORKFLOW');
  if (candidatePath.startsWith('pilot/pilot-1/plugins/pilot1-controller/')
      || candidatePath.startsWith('pilot/pilot-1/plugins/readiness1-native-controller/')
      || configuredMatch(candidatePath, policy.controllerPaths, policy.controllerPrefixes)) risks.push('CONTROLLER');
  if (snapshotPublisherPath(candidatePath)
      || configuredMatch(candidatePath, policy.publisherPaths, policy.publisherPrefixes)) risks.push('PUBLISHER');
  if (configuredMatch(candidatePath, policy.verificationPaths, policy.verificationPrefixes)) risks.push('VERIFICATION');
  return risks;
}

function risksFor(paths, policy) {
  return [...new Set(paths.flatMap(candidatePath => pathRisks(candidatePath, policy)))]
    .sort((a, b) => RISK_ORDER.indexOf(a) - RISK_ORDER.indexOf(b));
}

function readonlyPermissions(value) {
  return value && !Array.isArray(value) && typeof value === 'object' && Object.keys(value).length > 0
    && Object.values(value).every(permission => permission === 'read' || permission === 'none');
}

function safeWorkflow(item) {
  return item?.kind === 'WORKFLOW' && readonlyPermissions(item.permissions)
    && Array.isArray(item.events) && item.events.length > 0
    && item.events.every(event => event?.name === 'pull_request' && Array.isArray(event.types) && event.types.length > 0
      && event.types.every(type => ['opened', 'reopened', 'synchronize'].includes(type)))
    && Array.isArray(item.jobs) && item.jobs.length > 0
    && item.jobs.every(job => job && readonlyPermissions(job.permissions) && job.runner === 'GITHUB_HOSTED'
      && job.secrets === false && job.oidc === false && job.persistCredentials === false
      && job.privilegedFollowOn === false && job.usesPinned === true);
}

function safeAction(item) {
  return item?.kind === 'ACTION' && item.secrets === false && item.oidc === false
    && item.usesPinned === true && item.shellCommandsSafe === true;
}

function safeAutomation(change, policy) {
  const required = change.paths.map(normalizeCandidatePath)
    .filter(candidatePath => pathRisks(candidatePath, policy).includes('WORKFLOW'));
  const entries = change.automation && typeof change.automation === 'object' && !Array.isArray(change.automation)
    ? Object.entries(change.automation) : [];
  if (entries.length !== required.length) return false;
  const observed = new Set();
  for (const [rawPath, item] of entries) {
    let candidatePath;
    try { candidatePath = normalizeCandidatePath(rawPath); } catch { return false; }
    if (!required.includes(candidatePath) || observed.has(candidatePath)) return false;
    observed.add(candidatePath);
    if (candidatePath.startsWith('.github/workflows/') ? !safeWorkflow(item) : !safeAction(item)) return false;
  }
  return true;
}

function blocked(reasons, extra = {}) {
  return Object.freeze({ decision: 'BLOCKED', mechanical: true, reasons: [...new Set(reasons)], ...extra });
}

function withoutDigest(value) { const { digest: _digest, ...content } = value ?? {}; return content; }
function exactDigest(value) { try { return SHA64.test(value?.digest ?? '') && value.digest === digest(withoutDigest(value)); } catch { return false; } }

function validAuthority(receipt, task, operation, now) {
  const approval = receipt?.approval;
  const operationBinding = receipt?.operation;
  return receipt?.schema === 'readiness3.authority-adapter.v1' && exactDigest(receipt)
    && task?.authorityDigests?.[operation] === receipt.digest
    && approval?.id === task.approvalId && approval?.valid === true && approval?.scopeHash === task.scopeHash
    && SHA64.test(approval?.renderedCardHash ?? '') && Number.isSafeInteger(approval?.expiresAt) && approval.expiresAt > now
    && Number.isSafeInteger(approval?.approvalExpiresAt) && approval.approvalExpiresAt > now
    && operationBinding?.kind === operation && operationBinding?.taskNodeId === task.taskNodeId
    && operationBinding?.taskRevision === task.revisionHash && Number.isSafeInteger(operationBinding?.expiresAt)
    && operationBinding.expiresAt > now;
}

function validExecutionContext(context, task) {
  return context?.schema === 'readiness3.execution-context.v1' && context.observedBy === 'native-controller'
    && context.taskNodeId === task?.taskNodeId && context.writerId === task?.writerId
    && typeof context.route === 'string' && context.route.length > 0
    && SHA64.test(context.processIdentityDigest ?? '')
    && context.processIdentityDigest === task?.processIdentityDigest;
}

function validInventory(proof, executionContext, now) {
  return proof?.decision === 'NORMAL_VERIFIED' && proof.route === executionContext?.route
    && proof.lanes?.[executionContext?.route] === 'NORMAL_VERIFIED' && SHA64.test(proof.revision ?? '')
    && Number.isSafeInteger(proof.expiresAt) && proof.expiresAt > now;
}

function validReview(receipt, task, candidate, change, policy) {
  const source = receipt?.source;
  const binding = receipt?.binding;
  return receipt?.schema === 'readiness3.review-adapter.v1' && exactDigest(receipt)
    && Array.isArray(task?.reviewDigests) && task.reviewDigests.includes(receipt.digest)
    && source?.schema === 'readiness1.audit-receipt.v1' && source.verdict === 'PASS'
    && source.head === candidate.headSha && source.scopeHash === task.scopeHash
    && SHA64.test(source.manifestHash ?? '') && SHA64.test(source.reportHash ?? '')
    && binding?.baseSha === candidate.baseSha && binding?.changeDigest === change.digest
    && binding?.policyRevision === policy.revision && binding?.independent === true && binding?.freshSession === true;
}

function validActivation(receipt, task, candidate, change) {
  return receipt?.schema === 'readiness3.activation-adapter.v1' && exactDigest(receipt)
    && Array.isArray(task?.activationDigests) && task.activationDigests.includes(receipt.digest)
    && receipt.ownerPresent === true && receipt.trustedDiff === true
    && receipt.headSha === candidate.headSha && receipt.changeDigest === change.digest;
}

function behindContent(value) {
  return {
    schema: value?.schema, action: value?.action, expectedHeadSha: value?.expectedHeadSha,
    currentBaseSha: value?.currentBaseSha, pathsDigest: value?.pathsDigest,
    policyRevision: value?.policyRevision,
  };
}

export function behindDecisionDigest(value) { try { return digest(behindContent(value)); } catch { return null; } }

function validBehindDecision(value, candidate, policy) {
  return value?.schema === 'readiness3.behind-decision.v1' && value.action === 'UPDATE_BRANCH'
    && value.expectedHeadSha === candidate.headSha && SHA40.test(value.currentBaseSha ?? '')
    && SHA64.test(value.pathsDigest ?? '') && value.policyRevision === policy.revision
    && value.descriptorDigest === behindDecisionDigest(value);
}

function descriptorContent(value) {
  return {
    schema: value.schema, taskNodeId: value.taskNodeId, repo: value.repo, operation: value.operation,
    route: value.route, writerId: value.writerId, processIdentityDigest: value.processIdentityDigest,
    branch: value.branch, defaultBranch: value.defaultBranch, taskBranchPrefix: value.taskBranchPrefix,
    baseSha: value.baseSha, headSha: value.headSha, treeSha: value.treeSha,
    expectedOldOid: value.expectedOldOid, prNumber: value.prNumber,
    changeDigest: value.changeDigest, authorityDigest: value.authorityDigest,
    inventoryRevision: value.inventoryRevision, reviewDigest: value.reviewDigest,
    activationDigest: value.activationDigest, behindAction: value.behindAction,
    behindPathsDigest: value.behindPathsDigest, behindDecisionDigest: value.behindDecisionDigest,
    currentBaseSha: value.currentBaseSha, policyRevision: value.policyRevision,
    taskRevision: value.taskRevision, risks: value.risks,
  };
}

export function admissionDescriptorDigest(value) { try { return digest(descriptorContent(value)); } catch { return null; } }

export function admitPublication({ task, policy, candidate, change, executionContext, authorityReceipt, reviewReceipt, activationReceipt, inventoryProof, behindDecision, now = Date.now() }) {
  const reasons = [];
  if (!validReadiness3Policy(policy)) reasons.push('policy_unknown');
  if (!candidate || Object.keys(candidate).some(key => !CANDIDATE_FIELDS.has(key))) reasons.push('candidate_has_untrusted_fields');
  if (!ALLOWED_OPERATIONS.has(candidate?.operation)) reasons.push('operation_not_admitted');
  if (candidate?.force !== false) reasons.push('force_not_allowed');
  if (!Number.isSafeInteger(now)) reasons.push('invalid_observation_time');
  if (task?.state !== 'ACTIVE' || task?.cancelled !== false || !Number.isSafeInteger(task?.receiptExpiresAt)
      || !Number.isSafeInteger(task?.deadline) || !Number.isSafeInteger(task?.hardSunset)
      || now >= task?.receiptExpiresAt || now >= task?.deadline || now >= task?.hardSunset) reasons.push('task_inactive_or_expired');
  if (!validExecutionContext(executionContext, task)) reasons.push('execution_identity_unverified');
  if (task?.repo !== policy?.repo || candidate?.repo !== task?.repo) reasons.push('repo_mismatch');
  if (!validBranch(task?.branch) || candidate?.branch !== task?.branch || task?.branch === policy?.defaultBranch
      || !task?.branch?.startsWith(policy?.taskBranchPrefix ?? '')) reasons.push('branch_mismatch_or_default');
  if (!SHA40.test(candidate?.baseSha ?? '') || candidate?.baseSha !== task?.baseSha) reasons.push('base_mismatch');
  if (!SHA40.test(candidate?.headSha ?? '') || candidate?.headSha !== task?.headSha) reasons.push('head_mismatch');
  if (!SHA40.test(candidate?.treeSha ?? '') || candidate?.treeSha !== task?.treeSha) reasons.push('tree_mismatch');
  if (!SHA40.test(task?.expectedOldOid ?? '') || candidate?.expectedOldOid !== task.expectedOldOid) reasons.push('expected_old_oid_unknown');
  if (!SHA64.test(task?.revisionHash ?? '') || !SHA64.test(task?.scopeHash ?? '')) reasons.push('task_revision_unknown');
  if (!validAuthority(authorityReceipt, task, candidate?.operation, now)) reasons.push('invalid_authority_receipt');
  if (!validInventory(inventoryProof, executionContext, now)) reasons.push('inventory_not_verified');
  if (PR_NUMBER_OPERATIONS.has(candidate?.operation)) {
    if (!Number.isSafeInteger(candidate?.prNumber) || candidate.prNumber <= 0) reasons.push('pr_identity_unknown');
  } else if (candidate?.prNumber !== undefined) reasons.push('unexpected_pr_identity');
  if (!change || change.baseSha !== candidate?.baseSha || change.headSha !== candidate?.headSha || change.treeSha !== candidate?.treeSha
      || change.digest !== task?.changeDigest || change.closureComplete !== true || change.symlinksResolved !== true
      || !Array.isArray(change.paths) || change.paths.length === 0 || !SHA64.test(change.digest ?? '')) reasons.push('change_metadata_unknown');
  if (candidate?.operation === 'pr.update_branch' && !validBehindDecision(behindDecision, candidate, policy)) reasons.push('behind_decision_missing');
  if (candidate?.operation !== 'pr.update_branch' && behindDecision !== undefined) reasons.push('unexpected_behind_decision');
  if (reasons.length > 0) return blocked(reasons);

  let risks;
  try {
    const changeContent = { baseSha: change.baseSha, headSha: change.headSha, treeSha: change.treeSha,
      paths: change.paths, closureComplete: change.closureComplete, symlinksResolved: change.symlinksResolved,
      automation: change.automation ?? {} };
    if (change.digest !== digest(changeContent)) return blocked(['change_metadata_digest_mismatch']);
    risks = risksFor(change.paths, policy);
  } catch { return blocked(['invalid_candidate_path']); }

  if (risks.length > 0 && !validReview(reviewReceipt, task, candidate, change, policy)) reasons.push('exact_independent_review_required');
  if (risks.includes('WORKFLOW') && !safeAutomation(change, policy)) reasons.push('workflow_policy_rejected');
  if (risks.some(risk => ['AUTO_LOADED_INSTRUCTION', 'VERIFICATION'].includes(risk))
      && !validActivation(activationReceipt, task, candidate, change)) reasons.push('trusted_activation_required');
  if (reasons.length > 0) return blocked(reasons, { risks });

  const descriptor = {
    schema: 'readiness3.admission.v3', taskNodeId: task.taskNodeId, repo: task.repo,
    operation: candidate.operation, route: executionContext.route, writerId: executionContext.writerId,
    processIdentityDigest: executionContext.processIdentityDigest, branch: candidate.branch,
    defaultBranch: policy.defaultBranch, taskBranchPrefix: policy.taskBranchPrefix,
    baseSha: candidate.baseSha, headSha: candidate.headSha, treeSha: candidate.treeSha,
    expectedOldOid: candidate.expectedOldOid, prNumber: candidate.prNumber ?? null,
    changeDigest: change.digest, authorityDigest: authorityReceipt.digest,
    inventoryRevision: inventoryProof.revision, reviewDigest: reviewReceipt?.digest ?? null,
    activationDigest: activationReceipt?.digest ?? null,
    behindAction: behindDecision?.action ?? null,
    behindPathsDigest: behindDecision?.pathsDigest ?? null,
    behindDecisionDigest: behindDecision?.descriptorDigest ?? null,
    currentBaseSha: behindDecision?.currentBaseSha ?? null,
    policyRevision: policy.revision, taskRevision: task.revisionHash, risks,
  };
  return Object.freeze({ ...descriptor, decision: risks.length > 0 ? 'ALLOW_L2_CANDIDATE' : 'ALLOW_NORMAL', mechanical: true, descriptorDigest: admissionDescriptorDigest(descriptor) });
}

export function decideBehind({ prPaths, baseAdvancePaths, policy, expectedHeadSha, currentBaseSha }) {
  if (!validReadiness3Policy(policy) || !Array.isArray(prPaths) || !Array.isArray(baseAdvancePaths)
      || !SHA40.test(expectedHeadSha ?? '') || !SHA40.test(currentBaseSha ?? '')) return Object.freeze({ action: 'BLOCKED', invalidateEvidence: true });
  try {
    const paths = [...prPaths, ...baseAdvancePaths];
    const risks = risksFor(paths, policy);
    const replacementRequired = risks.some(risk => ['WORKFLOW', 'AUTO_LOADED_INSTRUCTION', 'CONTROLLER', 'PUBLISHER', 'VERIFICATION'].includes(risk));
    const value = { schema: 'readiness3.behind-decision.v1', action: replacementRequired ? 'PRESERVE_CLOSE_REPLACE' : 'UPDATE_BRANCH',
      expectedHeadSha, currentBaseSha, pathsDigest: digest(paths), policyRevision: policy.revision };
    return Object.freeze({ ...value, invalidateEvidence: true, descriptorDigest: behindDecisionDigest(value) });
  } catch { return Object.freeze({ action: 'BLOCKED', invalidateEvidence: true }); }
}

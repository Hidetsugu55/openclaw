import { digest, requireThat } from '../contract.js';

const SHA40 = /^[a-f0-9]{40}$/;
const SHA64 = /^[a-f0-9]{64}$/;
const MAX_ADMIN_LEASE_MS = 30 * 60 * 1000;
const ADMIN_STEPS = Object.freeze({
  'repo.settings.apply': Object.freeze(['READ_PRESTATE', 'CAS_APPLY_SETTINGS', 'READ_POSTSTATE', 'ROLLBACK_SETTINGS']),
  'ruleset.apply': Object.freeze(['READ_PRESTATE', 'CAS_APPLY_RULESET', 'READ_POSTSTATE', 'ROLLBACK_RULESET']),
});

export const GITHUB_OPERATIONS = Object.freeze({
  'branch.push': Object.freeze({ lane: 'NORMAL', roles: ['dev-host'] }),
  'pr.create': Object.freeze({ lane: 'NORMAL', roles: ['dev-host'] }),
  'pr.update': Object.freeze({ lane: 'NORMAL', roles: ['dev-host'] }),
  'pr.update_branch': Object.freeze({ lane: 'NORMAL', roles: ['main'] }),
  'pr.merge': Object.freeze({ lane: 'NORMAL', roles: ['main'] }),
  'cleanup.local_ref': Object.freeze({ lane: 'NORMAL', roles: ['main'] }),
  'repo.settings.apply': Object.freeze({ lane: 'ADMIN_LEASE', roles: ['ops'] }),
  'ruleset.apply': Object.freeze({ lane: 'ADMIN_LEASE', roles: ['ops'] }),
});

const IMMUTABLE_FIELDS = Object.freeze({
  'branch.push': ['expectedOldOid', 'newOid', 'treeOid'],
  'pr.create': ['headSha', 'baseSha', 'metadataDigest'],
  'pr.update': ['prNumber', 'headSha', 'metadataDigest'],
  'pr.update_branch': ['prNumber', 'expectedHeadSha'],
  'pr.merge': ['prNumber', 'headSha', 'baseSha', 'testedSha'],
  'cleanup.local_ref': ['ref', 'oldOid', 'cleanupDigest'],
  'repo.settings.apply': ['profileDigest', 'preStateDigest'],
  'ruleset.apply': ['rulesetId', 'profileDigest', 'preStateDigest'],
});

function validateTask(task) {
  requireThat(task && typeof task.taskNodeId === 'string' && task.taskNodeId.length > 0, 'invalid Task');
  requireThat(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(task.repo ?? '')
    && /^codex\/(?!.*(?:\/\/|\.\.|@\{|[\\\s~^:?*\[]))(?!.*(?:^|\/)\.)(?!.*\.lock(?:\/|$))(?!.*[\/.]$)[A-Za-z0-9._/-]+$/.test(task.branch ?? ''), 'invalid Task repo/ref');
  for (const field of ['headSha', 'treeSha', 'baseSha']) requireThat(SHA40.test(task[field] ?? ''), `invalid Task ${field}`);
  requireThat(SHA40.test(task.expectedOldOid ?? ''), 'invalid Task expected old OID');
  requireThat(SHA64.test(task.revisionHash ?? ''), 'invalid Task revision');
}

function validateImmutable(operation, immutable) {
  const fields = IMMUTABLE_FIELDS[operation];
  requireThat(immutable && Object.keys(immutable).sort().join(',') === [...fields].sort().join(','), 'immutable operation shape mismatch');
  for (const [key, value] of Object.entries(immutable)) {
    if (key === 'prNumber' || key === 'rulesetId') requireThat(Number.isSafeInteger(value) && value > 0, `invalid ${key}`);
    else if (key === 'ref') requireThat(/^refs\/heads\/[A-Za-z0-9][A-Za-z0-9._\/-]*$/.test(value) && !value.includes('..'), 'invalid Task ref');
    else if (key.endsWith('Digest')) requireThat(SHA64.test(value), `invalid ${key}`);
    else requireThat(SHA40.test(value), `invalid ${key}`);
  }
}

function validateTaskBinding(operation, task, immutable) {
  if (operation === 'branch.push') requireThat(immutable.expectedOldOid === task.expectedOldOid && immutable.newOid === task.headSha && immutable.treeOid === task.treeSha, 'branch operation Task mismatch');
  if (operation === 'pr.create') requireThat(immutable.headSha === task.headSha && immutable.baseSha === task.baseSha, 'PR create Task mismatch');
  if (operation === 'pr.update') requireThat(immutable.headSha === task.headSha, 'PR update Task mismatch');
  if (operation === 'pr.update_branch') requireThat(immutable.expectedHeadSha === task.headSha, 'PR update-branch Task mismatch');
  if (operation === 'pr.merge') requireThat(immutable.headSha === task.headSha && immutable.baseSha === task.baseSha, 'PR merge Task mismatch');
  if (operation === 'cleanup.local_ref') requireThat(immutable.ref === `refs/heads/${task.branch}` && immutable.oldOid === task.headSha, 'cleanup Task mismatch');
}

function validateAdminReceipt(receipt, operation, task, immutable, now) {
  const expectedEndpoint = operation === 'repo.settings.apply'
    ? `PATCH /repos/${task.repo}`
    : `PUT /repos/${task.repo}/rulesets/${immutable.rulesetId}`;
  requireThat(receipt && typeof receipt.id === 'string' && receipt.id.length > 0 && SHA64.test(receipt.digest ?? ''), 'missing Admin receipt');
  requireThat(receipt.repo === task.repo && receipt.taskNodeId === task.taskNodeId, 'Admin receipt scope mismatch');
  requireThat(Array.isArray(receipt.operationSet) && receipt.operationSet.length === 1 && receipt.operationSet[0] === operation, 'Admin receipt operation mismatch');
  requireThat(receipt.preStateDigest === immutable.preStateDigest && receipt.changeDigest === immutable.profileDigest, 'Admin receipt state mismatch');
  requireThat(receipt.endpoint === expectedEndpoint && JSON.stringify(receipt.steps) === JSON.stringify(ADMIN_STEPS[operation]), 'Admin receipt endpoint or steps mismatch');
  requireThat(SHA64.test(receipt.rollbackDigest ?? '') && receipt.claimState === 'UNCLAIMED' && receipt.cursor === 0 && receipt.attempts === 0, 'Admin receipt recovery state invalid');
  requireThat(Number.isSafeInteger(receipt.issuedAt) && receipt.issuedAt <= now
    && Number.isSafeInteger(receipt.expiresAt) && receipt.expiresAt > now
    && receipt.expiresAt - receipt.issuedAt <= MAX_ADMIN_LEASE_MS, 'Admin receipt expiry invalid');
}

export function buildGitHubOperation({ operation, actorContext, task, policyRevision, immutable, adminReceipt, now = Date.now() }) {
  const contract = GITHUB_OPERATIONS[operation];
  requireThat(contract, 'unknown closed GitHub operation');
  requireThat(actorContext && contract.roles.includes(actorContext.authenticatedRole)
    && SHA64.test(actorContext.principalProofDigest ?? ''), 'GitHub role ceiling exceeded');
  validateTask(task);
  requireThat(SHA64.test(policyRevision ?? ''), 'invalid policy revision');
  validateImmutable(operation, immutable);
  validateTaskBinding(operation, task, immutable);
  if (contract.lane === 'ADMIN_LEASE') validateAdminReceipt(adminReceipt, operation, task, immutable, now);

  const descriptor = {
    schema: 'readiness3.github-operation.v1',
    taskNodeId: task.taskNodeId,
    taskRevision: task.revisionHash,
    repo: task.repo,
    branch: task.branch,
    commitOid: task.headSha,
    treeOid: task.treeSha,
    baseOid: task.baseSha,
    policyRevision,
    operation,
    lane: contract.lane,
    actorRole: actorContext.authenticatedRole,
    principalProofDigest: actorContext.principalProofDigest,
    immutable: structuredClone(immutable),
    ...(contract.lane === 'ADMIN_LEASE' ? { adminReceipt: {
      id: adminReceipt.id,
      digest: adminReceipt.digest,
      preStateDigest: adminReceipt.preStateDigest,
      changeDigest: adminReceipt.changeDigest,
      endpoint: adminReceipt.endpoint,
      steps: [...adminReceipt.steps],
      rollbackDigest: adminReceipt.rollbackDigest,
      cursor: adminReceipt.cursor,
      attempts: adminReceipt.attempts,
      issuedAt: adminReceipt.issuedAt,
      expiresAt: adminReceipt.expiresAt,
    } } : {}),
  };
  return Object.freeze({ ...descriptor, digest: digest(descriptor) });
}

export function planAdminLeaseClaim({ descriptor, ledgerState, expectedRevision, now = Date.now() }) {
  requireThat(descriptor?.lane === 'ADMIN_LEASE' && SHA64.test(descriptor?.digest ?? ''), 'not an Admin descriptor');
  requireThat(Number.isSafeInteger(expectedRevision) && ledgerState?.revision === expectedRevision, 'Admin claim revision mismatch');
  requireThat(ledgerState?.receiptDigest === descriptor.adminReceipt?.digest
    && ledgerState?.claimState === 'UNCLAIMED' && ledgerState?.cursor === 0 && ledgerState?.attempts === 0, 'Admin receipt already claimed or drifted');
  requireThat(Number.isSafeInteger(now) && now >= descriptor.adminReceipt.issuedAt
    && now < descriptor.adminReceipt.expiresAt && ledgerState.expiresAt === descriptor.adminReceipt.expiresAt, 'Admin lease expired or drifted');
  const nextState = Object.freeze({
    ...structuredClone(ledgerState),
    revision: expectedRevision + 1,
    claimState: 'CLAIMED',
    claimedAt: now,
    descriptorDigest: descriptor.digest,
  });
  return Object.freeze({ expectedRevision, nextState });
}

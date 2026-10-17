import test from 'node:test';
import assert from 'node:assert/strict';
import { digest } from '../src/contract.js';
import { SNAPSHOT_CLOSURE } from '../src/readiness2/snapshot.js';
import { admitPublication, decideBehind, policyRevision } from '../src/readiness3/admission.js';
import { decideExactMerge, reconcileMergeOutcome } from '../src/readiness3/merge.js';
import { buildNativeProfile, compareNativeProfile } from '../src/readiness3/settings.js';

const SHA = { base: '1'.repeat(40), head: '2'.repeat(40), tested: '3'.repeat(40), tree: '6'.repeat(40), revision: '4'.repeat(64), scope: '7'.repeat(64) };
const now = Date.parse('2026-10-10T15:00:00Z');
const withDigest = value => ({ ...value, digest: digest(value) });
const policy = (patch = {}) => {
  const requestedRevision = patch.revision;
  const content = {
    schema: 'readiness3.policy.v2', repo: 'Hidetsugu55/openclaw-setup', defaultBranch: 'main',
    taskBranchPrefix: 'codex/', acceptedAuthority: 'readiness3.authority-adapter.v1',
    verify: { context: 'verify', integrationId: 15368, strict: true }, appInventory: 'COMPLETE',
    autoLoadedPaths: [], autoLoadedPrefixes: ['config/agent-imports'],
    controllerPaths: [], controllerPrefixes: [], publisherPaths: [], publisherPrefixes: [],
    verificationPaths: ['scripts/verify.sh', 'tests/test_pilot1.sh', 'scripts/transitive-check.sh'],
    verificationPrefixes: ['pilot/pilot-1/plugins/pilot1-controller/test'], ...patch,
  };
  delete content.revision;
  return { ...content, revision: requestedRevision ?? policyRevision(content) };
};
const candidate = (patch = {}) => ({
  operation: 'branch.push', repo: 'Hidetsugu55/openclaw-setup', branch: 'codex/readiness-3-source-20261010',
  baseSha: SHA.base, headSha: SHA.head, treeSha: SHA.tree, force: false, expectedOldOid: '0'.repeat(40), ...patch,
});
const change = (patch = {}) => {
  const content = { baseSha: SHA.base, headSha: SHA.head, treeSha: SHA.tree,
    paths: ['docs/architecture/readiness3-source-bindings.md'], closureComplete: true,
    symlinksResolved: true, automation: {}, ...patch };
  return { ...content, digest: digest(content) };
};
const executionContext = (patch = {}) => ({
  schema: 'readiness3.execution-context.v1', observedBy: 'native-controller', taskNodeId: 'TASK_r3',
  writerId: 'root-writer', route: 'controller', processIdentityDigest: '8'.repeat(64), ...patch,
});
const inventory = (patch = {}) => ({
  decision: 'NORMAL_VERIFIED', route: 'controller', lanes: { controller: 'NORMAL_VERIFIED' },
  revision: '9'.repeat(64), expiresAt: now + 5_000, ...patch,
});
const authority = (operation, patch = {}) => withDigest({
  schema: 'readiness3.authority-adapter.v1',
  approval: { id: 'APPROVAL_1', valid: true, scopeHash: SHA.scope, expiresAt: now + 10_000,
    approvalExpiresAt: now + 5_000, renderedCardHash: 'a'.repeat(64) },
  operation: { kind: operation, taskNodeId: 'TASK_r3', taskRevision: SHA.revision, expiresAt: now + 5_000 },
  ...patch,
});
const review = (candidateValue, changeValue, policyValue, patch = {}) => withDigest({
  schema: 'readiness3.review-adapter.v1',
  source: { schema: 'readiness1.audit-receipt.v1', head: candidateValue.headSha, scopeHash: SHA.scope,
    manifestHash: 'b'.repeat(64), reportHash: 'c'.repeat(64), model: 'claude-opus-5-5', at: now, verdict: 'PASS' },
  binding: { baseSha: candidateValue.baseSha, changeDigest: changeValue.digest,
    policyRevision: policyValue.revision, independent: true, freshSession: true }, ...patch,
});
const activation = (candidateValue, changeValue, patch = {}) => withDigest({
  schema: 'readiness3.activation-adapter.v1', ownerPresent: true, trustedDiff: true,
  headSha: candidateValue.headSha, changeDigest: changeValue.digest, ...patch,
});
const task = ({ candidateValue = candidate(), changeValue = change(), authorityReceipt = authority(candidateValue.operation), reviewReceipt, activationReceipt, ...patch } = {}) => ({
  taskNodeId: 'TASK_r3', repo: candidateValue.repo, branch: candidateValue.branch, baseSha: candidateValue.baseSha,
  headSha: candidateValue.headSha, treeSha: candidateValue.treeSha, expectedOldOid: candidateValue.expectedOldOid,
  revisionHash: SHA.revision, scopeHash: SHA.scope, approvalId: 'APPROVAL_1',
  authorityDigests: { [candidateValue.operation]: authorityReceipt.digest },
  reviewDigests: reviewReceipt ? [reviewReceipt.digest] : [], activationDigests: activationReceipt ? [activationReceipt.digest] : [],
  mergeReviewDigests: [], changeDigest: changeValue.digest, writerId: 'root-writer', state: 'ACTIVE', cancelled: false,
  processIdentityDigest: '8'.repeat(64),
  receiptExpiresAt: now + 10_000, deadline: now + 20_000, hardSunset: now + 30_000, ...patch,
});
function admit(options = {}) {
  const candidateValue = options.candidateValue ?? candidate();
  const changeValue = options.changeValue ?? change();
  const policyValue = options.policyValue ?? policy();
  const authorityReceipt = options.authorityReceipt ?? authority(candidateValue.operation);
  const reviewReceipt = options.withReview ? review(candidateValue, changeValue, policyValue) : options.reviewReceipt;
  const activationReceipt = options.withActivation ? activation(candidateValue, changeValue) : options.activationReceipt;
  const taskValue = options.taskValue ?? task({ candidateValue, changeValue, authorityReceipt, reviewReceipt, activationReceipt, ...(options.taskPatch ?? {}) });
  return admitPublication({ task: taskValue, policy: policyValue, candidate: candidateValue, change: changeValue,
    executionContext: options.executionContextValue ?? executionContext(), authorityReceipt, reviewReceipt,
    activationReceipt, inventoryProof: options.inventoryProof ?? inventory(), behindDecision: options.behindDecision,
    now });
}
const workflow = () => ({ kind: 'WORKFLOW', permissions: { contents: 'read' },
  events: [{ name: 'pull_request', types: ['opened', 'reopened', 'synchronize'] }],
  jobs: [{ permissions: { contents: 'read' }, runner: 'GITHUB_HOSTED', secrets: false, oidc: false,
    persistCredentials: false, privilegedFollowOn: false, usesPinned: true }] });
const action = () => ({ kind: 'ACTION', secrets: false, oidc: false, usesPinned: true, shellCommandsSafe: true });

test('G02 G03 G04 exact Task branch passes while default, raw, malformed and unverified identities fail closed', () => {
  assert.equal(admit().decision, 'ALLOW_NORMAL');
  for (const input of [
    { candidateValue: candidate({ branch: 'main' }), taskPatch: { branch: 'main' } },
    { policyValue: policy({ defaultBranch: undefined }) },
    { candidateValue: candidate({ branch: 'other/task' }), taskPatch: { branch: 'other/task' } },
    { candidateValue: candidate({ force: true }) }, { candidateValue: candidate({ operation: 'git.refs.update' }) },
    { candidateValue: candidate({ command: 'git push origin HEAD:main' }) },
    { inventoryProof: inventory({ decision: 'UNKNOWN_UNSAFE' }) },
    { executionContextValue: executionContext({ route: 'forged' }) },
    { executionContextValue: executionContext({ processIdentityDigest: 'f'.repeat(64) }) },
    { candidateValue: candidate({ prNumber: 108 }) },
  ]) assert.equal(admit(input).decision, 'BLOCKED');
});

test('G06 G11 G23 G32 risk metadata requires canonical ledger-bound review and activation adapters', () => {
  const paths = ['nested/Agents.md', '.github/actions/hooks/action.yml'];
  const value = change({ paths, automation: { '.github/actions/hooks/action.yml': action() } });
  assert.equal(admit({ changeValue: value }).decision, 'BLOCKED');
  const result = admit({ changeValue: value, withReview: true, withActivation: true });
  assert.equal(result.decision, 'ALLOW_L2_CANDIDATE');
  assert.deepEqual(result.risks, ['AUTO_LOADED_INSTRUCTION', 'WORKFLOW']);
  const forged = authority('branch.push'); forged.operation.expiresAt += 1;
  assert.equal(admit({ authorityReceipt: forged }).decision, 'BLOCKED');
});

test('G06 normalized transitive closure covers imports, controller, publisher and verification', () => {
  for (const paths of [['claude.md'], ['.Claude/settings.json'], ['AGENTS.override.md'], ['config/agent-imports/imported.md'],
    ['pilot/pilot-1/plugins/pilot1-controller/src/core.js'], ['pilot/pilot-1/plugins/readiness1-native-controller/src/readiness3/admission.js'],
    ['scripts/update-consultation-snapshot.sh'],
    ['scripts/transitive-check.sh'], ['pilot/pilot-1/plugins/pilot1-controller/test/new.test.mjs'],
    ['./.github/workflows/verify.yml'], ['.github//workflows/verify.yml']]) {
    assert.equal(admit({ changeValue: change({ paths }) }).decision, 'BLOCKED');
  }
  assert.equal(admit({ changeValue: change({ closureComplete: false }) }).decision, 'BLOCKED');
});

test('G06 snapshot publisher closure and configured controller/publisher paths are always high risk', () => {
  const configuredPolicy = policy({
    controllerPaths: ['scripts/pilot1-env.sh'],
    publisherPrefixes: ['scripts/future-publisher'],
  });
  const publisherPaths = [
    ...SNAPSHOT_CLOSURE,
    'scripts/consultation_snapshot_safety/__init__.py',
    'scripts/consultation_snapshot_safety.cpython-312-darwin.so',
    'scripts/__pycache__/consultation_snapshot_safety.cpython-312.pyc',
    'scripts/json.py',
    'tests/json.py',
  ];
  for (const publisherPath of publisherPaths) {
    assert.equal(admit({ policyValue: configuredPolicy, changeValue: change({ paths: [publisherPath] }) }).decision, 'BLOCKED');
    const admitted = admit({ policyValue: configuredPolicy, changeValue: change({ paths: [publisherPath] }), withReview: true });
    assert.equal(admitted.decision, 'ALLOW_L2_CANDIDATE');
    assert.deepEqual(admitted.risks, ['PUBLISHER']);
  }
  for (const [configuredPath, expectedRisk] of [['scripts/pilot1-env.sh', 'CONTROLLER'], ['scripts/future-publisher/job.js', 'PUBLISHER']]) {
    assert.equal(admit({ policyValue: configuredPolicy, changeValue: change({ paths: [configuredPath] }) }).decision, 'BLOCKED');
    const admitted = admit({ policyValue: configuredPolicy, changeValue: change({ paths: [configuredPath] }), withReview: true });
    assert.equal(admitted.decision, 'ALLOW_L2_CANDIDATE');
    assert.deepEqual(admitted.risks, [expectedRisk]);
  }
  assert.equal(admit({ policyValue: configuredPolicy, changeValue: change({ paths: ['scripts/non-importable.txt'] }) }).decision, 'ALLOW_NORMAL');
});

test('G06 every workflow/action path needs its own safe derived descriptor', () => {
  const paths = ['.github/workflows/a.yml', '.github/workflows/b.yml', '.github/actions/local/action.yml'];
  const automation = { '.github/workflows/a.yml': workflow(), '.github/workflows/b.yml': workflow(), '.github/actions/local/action.yml': action() };
  const value = change({ paths, automation });
  assert.equal(admit({ changeValue: value, withReview: true }).decision, 'ALLOW_L2_CANDIDATE');
  const missing = change({ paths, automation: { '.github/workflows/a.yml': workflow() } });
  assert.equal(admit({ changeValue: missing, withReview: true }).decision, 'BLOCKED');
  const unsafe = change({ paths: ['.github/workflows/a.yml'], automation: { '.github/workflows/a.yml': { ...workflow(), events: [{ name: 'check_suite', types: ['completed'] }] } } });
  assert.equal(admit({ changeValue: unsafe, withReview: true }).decision, 'BLOCKED');
});

test('G07 behind decision is policy/head/current-base/path bound and sensitive paths replace', () => {
  const normal = decideBehind({ prPaths: ['src/a.js'], baseAdvancePaths: ['docs/a.md'], policy: policy(), expectedHeadSha: SHA.head, currentBaseSha: 'd'.repeat(40) });
  assert.equal(normal.action, 'UPDATE_BRANCH');
  assert.match(normal.descriptorDigest, /^[a-f0-9]{64}$/);
  assert.equal(decideBehind({ prPaths: undefined, baseAdvancePaths: [], policy: policy(), expectedHeadSha: SHA.head, currentBaseSha: 'd'.repeat(40) }).action, 'BLOCKED');
  assert.equal(decideBehind({ prPaths: ['src/a.js'], baseAdvancePaths: [], policy: undefined, expectedHeadSha: SHA.head, currentBaseSha: 'd'.repeat(40) }).action, 'BLOCKED');
  assert.equal(decideBehind({ prPaths: ['scripts/verify.sh'], baseAdvancePaths: [], policy: policy(), expectedHeadSha: SHA.head, currentBaseSha: 'd'.repeat(40) }).action, 'PRESERVE_CLOSE_REPLACE');
  for (const publisherPath of ['scripts/generate-consultation-snapshot.py',
    'scripts/consultation_snapshot_safety/__init__.py',
    'scripts/consultation_snapshot_safety.cpython-312-darwin.so',
    'scripts/__pycache__/consultation_snapshot_safety.cpython-312.pyc']) {
    assert.equal(decideBehind({ prPaths: [], baseAdvancePaths: [publisherPath], policy: policy(), expectedHeadSha: SHA.head, currentBaseSha: 'd'.repeat(40) }).action, 'PRESERVE_CLOSE_REPLACE');
  }
});

function mergeReview(kind, admission, policyValue, taskValue) {
  return withDigest({ schema: 'readiness3.merge-review-adapter.v1', kind,
    source: { schema: 'readiness1.audit-receipt.v1', head: SHA.head, scopeHash: taskValue.scopeHash,
      manifestHash: 'e'.repeat(64), reportHash: 'f'.repeat(64), model: 'reviewer', at: now, verdict: 'PASS' },
    binding: { baseSha: SHA.base, testedSha: SHA.tested, policyRevision: policyValue.revision,
      changeDigest: admission.changeDigest, independent: true, fresh: true } });
}
function mergeFixture(patch = {}) {
  const policyValue = policy(); const candidateValue = candidate({ operation: 'pr.merge', prNumber: 108 });
  const changeValue = change(); const authorityReceipt = authority('pr.merge');
  const taskValue = task({ candidateValue, changeValue, authorityReceipt });
  const admission = admitPublication({ task: taskValue, policy: policyValue, candidate: candidateValue, change: changeValue,
    executionContext: executionContext(), authorityReceipt, inventoryProof: inventory(), now });
  const reviewer = mergeReview('REVIEWER', admission, policyValue, taskValue);
  const finalTask = { ...taskValue, mergeReviewDigests: [reviewer.digest] };
  return { task: finalTask, policy: policyValue, admission, inventoryProof: inventory(),
    pullRequest: { repo: finalTask.repo, number: 108, headRepo: finalTask.repo, baseRepo: finalTask.repo,
      headRef: finalTask.branch, baseRef: 'main', headSha: SHA.head, baseSha: SHA.base,
      mergeable: true, behind: false, state: 'OPEN', autoMerge: false },
    repository: { defaultHeadSha: SHA.base, nativeProfileDecision: 'MATCH', rulesetEffective: true,
      bypassVisibility: 'COMPLETE', bypassActors: [], requiredCheck: { context: 'verify', integrationId: 15368, strict: true } },
    checks: [{ context: 'verify', integrationId: 15368, conclusion: 'SUCCESS', event: 'pull_request', headSha: SHA.tested, stepsExecuted: true }],
    verification: { kind: 'TEST_MERGE', parents: [SHA.base, SHA.head], testedSha: SHA.tested,
      headSha: SHA.head, baseSha: SHA.base, acceptedRevision: policyValue.revision },
    reviews: { receipts: [reviewer] }, now, ...patch };
}

test('G05 G07 G08 exact merge requires pr.merge authority, strict source and canonical review adapter', () => {
  const result = decideExactMerge(mergeFixture());
  assert.equal(result.decision, 'MERGE_ALLOWED');
  assert.equal(result.operation, 'pr.merge');
  assert.match(result.descriptorDigest, /^[a-f0-9]{64}$/);
});

test('G07 G11 missing policy fields, wrong operation and forged evidence fail closed', () => {
  const base = mergeFixture();
  const cases = [
    { reviews: undefined },
    { admission: { ...base.admission, operation: 'branch.push' } },
    { policy: policy({ verify: { strict: true } }), repository: { ...base.repository, requiredCheck: { strict: true } }, checks: [{ conclusion: 'SUCCESS', stepsExecuted: true, event: 'pull_request', headSha: SHA.tested }] },
    { repository: { ...base.repository, bypassVisibility: 'UNKNOWN' } },
    { verification: { ...base.verification, parents: [SHA.base, '9'.repeat(40)] } },
    { inventoryProof: inventory({ decision: 'UNKNOWN_UNSAFE' }) },
  ];
  for (const patch of cases) assert.equal(decideExactMerge({ ...base, ...patch }).decision, 'BLOCKED');
});

test('G16 merge response loss only confirms exact Squash shape and ancestry', () => {
  const merged = { state: 'MERGED', headSha: SHA.head, mergeMethod: 'SQUASH', mergeCommitSha: SHA.tested, mergeParents: [SHA.base], defaultContainsMerge: true };
  assert.equal(reconcileMergeOutcome({ response: null, pullRequest: { state: 'OPEN' }, expectedHead: SHA.head, expectedBase: SHA.base }).state, 'OUTCOME_UNKNOWN');
  assert.equal(reconcileMergeOutcome({ response: null, pullRequest: merged, expectedHead: SHA.head, expectedBase: SHA.base }).state, 'MERGED_CONFIRMED');
});

test('G05 G08 G09 native profile comparison requires complete visibility', () => {
  const native = buildNativeProfile({ repo: candidate().repo, defaultBranch: 'main', verifyContext: 'verify', integrationId: 15368 });
  assert.equal(compareNativeProfile(native, { visibility: 'COMPLETE', bypassVisibility: 'COMPLETE', profile: structuredClone(native) }).decision, 'MATCH');
  assert.equal(compareNativeProfile(native, { visibility: 'UNKNOWN', bypassVisibility: 'COMPLETE', profile: structuredClone(native) }).decision, 'UNKNOWN');
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateCleanup, cleanupSequence } from '../src/readiness3/cleanup.js';

const OID = 'a'.repeat(40);
const now = 1_000_000;
const facts = (patch = {}) => ({
  observedAt: now - 1,
  expiresAt: now + 1_000,
  taskOwned: true,
  repoBound: true,
  branchRef: 'refs/heads/codex/readiness-3-source-20261010',
  defaultRef: 'refs/heads/main',
  expectedOldOid: OID,
  localTip: OID,
  pullRequestHead: OID,
  durableResult: true,
  childrenStopped: true,
  processesStopped: true,
  containersStopped: true,
  mountsKnown: true,
  worktreeOwnerKnown: true,
  dirty: [],
  untracked: [],
  ignored: [],
  hiddenPrivate: [],
  stashes: [],
  otherWorktrees: [],
  unpushedCommits: [],
  remoteState: 'MERGED_HEAD_DELETED',
  ...patch,
});

test('G19 G20 G21 cleanup requires the complete preservation predicate', () => {
  const pass = evaluateCleanup(facts(), now);
  assert.equal(pass.decision, 'CLEANUP_ALLOWED');
  assert.equal(pass.taskRef, 'refs/heads/codex/readiness-3-source-20261010');
  assert.deepEqual(cleanupSequence(pass), [
    'READBACK_RESULT', 'STOP_TASK_WRITERS', 'INVENTORY_NON_FOLLOWING',
    'REMOVE_ELIGIBLE_WORKTREE', 'DELETE_LOCAL_REF_CAS', 'READBACK_REMOTE',
  ]);

  const failures = [
    { ignored: ['private.cache'] },
    { hiddenPrivate: ['.private'] },
    { dirty: ['source.js'] },
    { untracked: ['note.txt'] },
    { stashes: ['stash@{0}'] },
    { otherWorktrees: ['/tmp/other'] },
    { unpushedCommits: [OID] },
    { localTip: 'b'.repeat(40) },
    { pullRequestHead: 'b'.repeat(40) },
    { mountsKnown: false },
    { worktreeOwnerKnown: false },
    { branchRef: 'refs/heads/main' },
    { defaultRef: undefined },
    { branchRef: 'refs/heads/other/task' },
    { remoteState: 'OPEN' },
  ];
  for (const patch of failures) {
    const result = evaluateCleanup(facts(patch), now);
    assert.equal(result.decision, 'PRESERVE');
    assert.deepEqual(cleanupSequence(result), []);
  }
});

test('G20 cleanup never treats branch -d success as durable proof', () => {
  const result = evaluateCleanup(facts({ durableResult: false, branchDeleteCommandSucceeded: true }), now);
  assert.equal(result.decision, 'PRESERVE');
  assert.ok(result.reasons.includes('result_not_durable'));
});

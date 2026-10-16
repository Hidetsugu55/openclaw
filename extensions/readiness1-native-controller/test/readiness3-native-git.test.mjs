import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { deleteTaskRefCas } from '../src/readiness3/local-ref.js';
import { evaluateCleanup } from '../src/readiness3/cleanup.js';

function git(root, args, allowFailure = false) {
  const result = spawnSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgSign=false', ...args], {
    cwd: root,
    encoding: 'utf8',
    env: {
      PATH: process.env.PATH,
      HOME: root,
      TMPDIR: os.tmpdir(),
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_TERMINAL_PROMPT: '0',
    },
  });
  if (!allowFailure && result.status !== 0) throw new Error(result.stderr || `git ${args.join(' ')} failed`);
  return { status: result.status, stdout: result.stdout.trim(), stderr: result.stderr.trim() };
}

test('G20 native old-OID CAS preserves mismatches and deletes only the exact Task ref', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'readiness3-git-'));
  try {
    git(root, ['init', '-q', '-b', 'main']);
    git(root, ['config', 'user.name', 'Readiness Fixture']);
    git(root, ['config', 'user.email', 'fixture@example.invalid']);
    await writeFile(path.join(root, 'file.txt'), 'one');
    git(root, ['add', 'file.txt']); git(root, ['commit', '-qm', 'seed']);
    git(root, ['branch', 'codex/task']);
    const oid = git(root, ['rev-parse', 'refs/heads/codex/task']).stdout;
    const now = 1_000_000;
    const facts = {
      observedAt: now - 1, expiresAt: now + 1_000, taskOwned: true, repoBound: true,
      branchRef: 'refs/heads/codex/task', defaultRef: 'refs/heads/main', expectedOldOid: oid,
      localTip: oid, pullRequestHead: oid, durableResult: true, childrenStopped: true,
      processesStopped: true, containersStopped: true, mountsKnown: true, worktreeOwnerKnown: true,
      dirty: [], untracked: [], ignored: [], hiddenPrivate: [], stashes: [], otherWorktrees: [],
      unpushedCommits: [], remoteState: 'MERGED_HEAD_DELETED',
    };
    const cleanupDecision = evaluateCleanup(facts, now);
    const runGit = async args => git(root, args, true);

    git(root, ['commit', '--allow-empty', '-qm', 'advance-main']);
    const advanced = git(root, ['rev-parse', 'refs/heads/main']).stdout;
    git(root, ['update-ref', cleanupDecision.taskRef, advanced, oid]);
    const mismatch = await deleteTaskRefCas({ cleanupDecision, taskRef: cleanupDecision.taskRef, expectedOldOid: oid, readFacts: async () => facts, runGit, now });
    assert.deepEqual(mismatch, { deleted: false, reason: 'old_oid_mismatch' });
    assert.equal(git(root, ['rev-parse', cleanupDecision.taskRef]).stdout, advanced);

    git(root, ['update-ref', cleanupDecision.taskRef, oid, advanced]);

    const deleted = await deleteTaskRefCas({ cleanupDecision, taskRef: cleanupDecision.taskRef, expectedOldOid: oid, readFacts: async () => facts, runGit, now });
    assert.deepEqual(deleted, { deleted: true, ref: cleanupDecision.taskRef, oldOid: oid });
    assert.notEqual(git(root, ['show-ref', '--verify', cleanupDecision.taskRef], true).status, 0);
    assert.equal(git(root, ['rev-parse', 'refs/heads/main']).stdout, advanced);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

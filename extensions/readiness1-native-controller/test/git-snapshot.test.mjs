import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, realpath, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createGitSnapshotAdapter, deterministicIndexDigest } from '../src/git-snapshot.js';

const git = '/usr/bin/git';
const run = (root, args, encoding = 'utf8') => execFileSync(git, ['-C', root, ...args], { encoding, env: { PATH: '/usr/bin:/bin', LC_ALL: 'C', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' } });

test('fixed git adapter binds realpath, HEAD, index bytes, and dirty observation', async () => {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'readiness1-git-')));
  run(root, ['init', '-q']);
  await writeFile(path.join(root, 'tracked.txt'), 'one\n');
  run(root, ['add', 'tracked.txt']);
  run(root, ['-c', 'user.name=fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'fixture']);
  const head = run(root, ['rev-parse', 'HEAD']).trim();
  const indexDigest = deterministicIndexDigest(run(root, ['ls-files', '--stage', '-z'], null));
  const snapshot = createGitSnapshotAdapter({ gitBinary: git, root, repo: 'owner/repo', head, indexDigest });
  assert.deepEqual(await snapshot(), { repo: 'owner/repo', worktree: root, head, dirty: '', indexDigest });
  await writeFile(path.join(root, 'tracked.txt'), 'two\n');
  assert.match((await snapshot()).dirty, /^[a-f0-9]{64}$/);

  const link = `${root}-link`;
  await symlink(root, link);
  const linked = createGitSnapshotAdapter({ gitBinary: git, root: link, repo: 'owner/repo', head, indexDigest });
  await assert.rejects(linked(), /symlink\/path drift/);
  const wrongDigest = createGitSnapshotAdapter({ gitBinary: git, root, repo: 'owner/repo', head, indexDigest: '0'.repeat(64) });
  await assert.rejects(wrongDigest(), /index digest mismatch/);
});

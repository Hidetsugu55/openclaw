import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import { promisify } from 'node:util';
import { requireThat } from './contract.js';

const execFileAsync = promisify(execFile);
const sha256 = (value) => createHash('sha256').update(value).digest('hex');

const FIXED_ENV = Object.freeze({
  PATH: '/usr/bin:/bin',
  LC_ALL: 'C',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_TERMINAL_PROMPT: '0',
});

export function deterministicIndexDigest(indexBytes) {
  requireThat(Buffer.isBuffer(indexBytes), 'index bytes unavailable');
  return sha256(indexBytes);
}

export function createGitSnapshotAdapter({ gitBinary, root, repo, head, indexDigest, timeoutMs = 5_000, maxBuffer = 1024 * 1024 }) {
  requireThat(typeof gitBinary === 'string' && gitBinary.startsWith('/'), 'absolute git binary required');
  requireThat(typeof root === 'string' && root.startsWith('/'), 'absolute fixed git root required');
  requireThat(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo), 'invalid fixed repository');
  requireThat(/^[a-f0-9]{40}$/.test(head) && /^[a-f0-9]{64}$/.test(indexDigest), 'invalid fixed source digest binding');
  requireThat(Number.isSafeInteger(timeoutMs) && timeoutMs > 0 && timeoutMs <= 30_000, 'invalid git timeout');
  requireThat(Number.isSafeInteger(maxBuffer) && maxBuffer >= 4096 && maxBuffer <= 4 * 1024 * 1024, 'invalid git output bound');

  async function run(literalArgs, encoding = 'buffer') {
    const before = await realpath(root);
    requireThat(before === root, 'fixed git root symlink/path drift');
    let result;
    try {
      result = await execFileAsync(gitBinary, ['-C', root, ...literalArgs], {
        cwd: root, env: FIXED_ENV, shell: false, timeout: timeoutMs, maxBuffer, encoding,
      });
    } catch (error) {
      throw new Error(error?.killed ? 'fixed git command timeout' : 'fixed git command failed');
    }
    requireThat(await realpath(root) === before, 'fixed git root changed during observation');
    return result.stdout;
  }

  return Object.freeze(async function snapshot() {
    const top = (await run(['rev-parse', '--show-toplevel'], 'utf8')).trim();
    requireThat(top === root, 'fixed git top-level mismatch');
    const observedHead = (await run(['rev-parse', '--verify', 'HEAD'], 'utf8')).trim();
    requireThat(observedHead === head, 'fixed git HEAD mismatch');
    const dirtyBytes = await run(['status', '--porcelain=v1', '-z', '--untracked-files=all']);
    const indexBytes = await run(['ls-files', '--stage', '-z']);
    const observedIndexDigest = deterministicIndexDigest(indexBytes);
    requireThat(observedIndexDigest === indexDigest, 'fixed git index digest mismatch');
    return Object.freeze({
      repo,
      worktree: root,
      head: observedHead,
      dirty: dirtyBytes.length === 0 ? '' : sha256(dirtyBytes),
      indexDigest: observedIndexDigest,
    });
  });
}

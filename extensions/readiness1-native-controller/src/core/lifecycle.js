import { spawn } from 'node:child_process';
import path from 'node:path';
import { requireThat } from './contract.js';

export const unresolvedOperation = state => (state.gate?.operations ?? []).some(o => ['CLAIMED', 'STARTED', 'UNKNOWN'].includes(o.state));
export function activationEligible(state) {
  return !state || (['DONE', 'CANCELLED', 'CLAIMED', 'BLOCKED'].includes(state.status) && !state.writer && !state.ticket && state.reserved === 0 && state.cleanup !== 'pending' && !unresolvedOperation(state));
}
export function activationEligibleObserved(state) {
  if (state?.status === 'DONE') {
    const receipt = state.finishReceipt;
    if (receipt?.schema !== 'readiness1.finish-receipt.v1' || receipt.taskNodeId !== state.contract.taskNodeId || receipt.root !== state.contract.root || receipt.workspaceRemoved !== true || receipt.auditConfirmed !== true) return false;
  }
  return activationEligible(state);
}
export function cleanupDecision(state, evidence) {
  if (state.writer || state.ticket || state.reserved || state.status === 'OUTCOME_UNKNOWN' || unresolvedOperation(state)) return { allowed: false, cleanup: 'pending', reason: 'unresolved writer/usage/outcome' };
  if (!evidence?.taskNodeId || evidence.taskNodeId !== state.contract.taskNodeId || evidence.root !== state.contract.root || evidence.processStopped !== true || evidence.groupStopped !== true || evidence.containerRemoved !== true || evidence.durableResults !== true || evidence.cleanWorktree !== true) return { allowed: false, cleanup: 'pending', reason: 'unconfirmed exact Task resource cleanup' };
  return { allowed: true, cleanup: 'pass' };
}
export function cleanupDecisionObserved(state, evidence) {
  const base = cleanupDecision(state, evidence);
  if (!base.allowed) return base;
  if (evidence.lsofClear !== true || evidence.sideEffects !== 'none') return { allowed: false, cleanup: 'pending', reason: 'unconfirmed exact Task process/side-effect cleanup' };
  return base;
}
export function finishTask(state, evidence) {
  requireThat(state.status === 'ACTIVE' && state.cleanup === 'pass' && !state.writer && !state.ticket && state.reserved === 0, 'Task is not cleanup-complete');
  requireThat(evidence?.schema === 'readiness1.finish-receipt.v1' && evidence.taskNodeId === state.contract.taskNodeId && evidence.root === state.contract.root, 'finish receipt identity mismatch');
  requireThat(typeof evidence.receiptId === 'string' && evidence.receiptId.length >= 8 && Number.isSafeInteger(evidence.observedAt), 'finish receipt audit identity missing');
  requireThat(evidence.workspaceRemoved === true && evidence.releaseConfirmed === true && evidence.postRemovalLsofClear === true && evidence.auditConfirmed === true, 'finish receipt is incomplete');
  const next = structuredClone(state);
  next.finishReceipt = structuredClone(evidence);
  next.status = 'DONE';
  next.history.push({ kind: 'controller_finish_confirmed', id: evidence.receiptId, at: evidence.observedAt });
  return next;
}
export function processIdentityMatches(expected, observed, protectedGroups) {
  if (!expected || !observed || protectedGroups.includes(observed.pgid)) return false;
  return ['taskNodeId', 'pid', 'pgid', 'startTime', 'executable', 'realRoot'].every(k => expected[k] != null && expected[k] === observed[k]);
}
export function retirementPlan(inventory) {
  requireThat(['portfolio-review', 'openclaw-system'].includes(inventory.agentId), 'unsupported retirement');
  requireThat(inventory.routingStopped === true && inventory.cronStopped === true && inventory.activeRuns === 0, 'agent still active');
  const profileAccounted = (
    inventory.managedProfileState === 'present-and-preserved'
      ? inventory.managedProfilesPreserved === true && inventory.profileDirectoryMode === 0o700 && inventory.profileFileMode === 0o600
      : inventory.managedProfileState === 'absent-accounted' && inventory.managedProfilesPreserved === false && inventory.profileDirectoryMode === null && inventory.profileFileMode === null
  );
  requireThat(inventory.agentDirPreserved === true && inventory.sessionsPreserved === true && inventory.uniqueOutputsPreserved === true && profileAccounted && inventory.profilesOutsideGit === true && inventory.rollbackAvailable === true, 'private preservation incomplete');
  return Object.freeze({ agentId: inventory.agentId, operation: 'remove-config-references-only', deleteFiles: false, sharedWorkspace: 'preserve', managedProfiles: 'preserve-private', replacement: inventory.agentId === 'openclaw-system' ? 'ops' : null });
}
export function createGitLifecycle(binding) {
  requireThat(path.isAbsolute(binding.gitBinary) && path.isAbsolute(binding.gitDir) && path.isAbsolute(binding.workTree) && path.isAbsolute(binding.globalConfig), 'Git bindings must be absolute');
  requireThat(!binding.gitDir.startsWith(binding.workTree + path.sep) && binding.gitDir !== binding.workTree && binding.noModelMetadataWrite === true, 'worker-writable Git metadata');
  requireThat(/^git@github\.com:[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\.git$/.test(binding.remote) && /^refs\/heads\/codex\/[A-Za-z0-9_/-]+$/.test(binding.ref), 'unapproved Git remote/ref');
  const prefix = ['--git-dir=' + binding.gitDir, '--work-tree=' + binding.workTree, '-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-c', 'core.attributesFile=/dev/null', '-c', 'credential.helper=', '-c', 'credential.helper=' + binding.credentialHelper, '-c', 'core.pager=cat', '-c', 'commit.gpgSign=false', '-c', 'tag.gpgSign=false'];
  const env = { PATH: binding.fixedPath, HOME: binding.controllerHome, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: binding.globalConfig, GIT_TERMINAL_PROMPT: '0', GIT_SSH_COMMAND: binding.sshCommand, ...(binding.sshAuthSock ? { SSH_AUTH_SOCK: binding.sshAuthSock } : {}) };
  async function run(args) {
    requireThat(await binding.verifyMetadata() === true, 'Git metadata/config/helper drift');
    const result = await new Promise((resolve, reject) => {
      const child = spawn(binding.gitBinary, [...prefix, ...args], { cwd: binding.controllerRoot, env, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
      let out = ''; child.stdout.on('data', b => { out += b; if (out.length > 1024 * 1024) child.kill(); });
      // Git errors may contain private paths/credential hints: return a fixed error.
      child.stderr.resume(); child.on('error', reject); child.on('close', code => code === 0 ? resolve(out.trim()) : reject(new Error('fixed Git action failed')));
    });
    requireThat(await binding.verifyMetadata() === true, 'post-Git metadata drift'); return result;
  }
  return Object.freeze({
    head: () => run(['rev-parse', '--verify', 'HEAD']),
    diff: () => run(['diff', '--no-ext-diff', '--no-textconv', '--']),
    async push(expectedHead) {
      requireThat(/^[a-f0-9]{40}$/.test(expectedHead), 'invalid push head');
      const actual = await run(['rev-parse', '--verify', binding.ref]); requireThat(actual === expectedHead, 'push head drift');
      return run(['push', '--no-verify', binding.remote, `${expectedHead}:${binding.ref}`]);
    },
  });
}

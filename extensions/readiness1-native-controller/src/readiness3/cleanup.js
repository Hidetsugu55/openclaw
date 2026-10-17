const EMPTY_COLLECTIONS = ['dirty', 'untracked', 'ignored', 'hiddenPrivate', 'stashes', 'otherWorktrees', 'unpushedCommits'];

export function evaluateCleanup(facts, now = Date.now()) {
  const reasons = [];
  if (facts?.taskOwned !== true) reasons.push('not_task_owned');
  if (!Number.isSafeInteger(now) || !Number.isSafeInteger(facts?.observedAt)
      || !Number.isSafeInteger(facts?.expiresAt) || facts.observedAt > now || facts.expiresAt <= now) reasons.push('cleanup_observation_stale');
  if (facts?.repoBound !== true) reasons.push('repo_not_bound');
  if (typeof facts?.defaultRef !== 'string' || !facts.defaultRef.startsWith('refs/heads/')
      || typeof facts?.branchRef !== 'string' || !facts.branchRef.startsWith('refs/heads/codex/')
      || facts.branchRef === facts.defaultRef) reasons.push('unsafe_task_ref');
  if (!/^[a-f0-9]{40}$/.test(facts?.expectedOldOid ?? '') || facts?.localTip !== facts?.expectedOldOid || facts?.pullRequestHead !== facts?.expectedOldOid) reasons.push('old_oid_or_pr_head_mismatch');
  if (facts?.durableResult !== true) reasons.push('result_not_durable');
  if (facts?.childrenStopped !== true || facts?.processesStopped !== true || facts?.containersStopped !== true) reasons.push('writers_or_children_active');
  if (facts?.mountsKnown !== true) reasons.push('mounts_unknown');
  if (facts?.worktreeOwnerKnown !== true) reasons.push('owner_unknown');
  for (const name of EMPTY_COLLECTIONS) {
    if (!Array.isArray(facts?.[name]) || facts[name].length > 0) reasons.push(`${name}_not_empty`);
  }
  if (facts?.remoteState !== 'MERGED_HEAD_DELETED') reasons.push('remote_not_clean');
  if (reasons.length > 0) return Object.freeze({ decision: 'PRESERVE', reasons: [...new Set(reasons)] });
  return Object.freeze({ decision: 'CLEANUP_ALLOWED', reasons: [], taskRef: facts.branchRef, expectedOldOid: facts.expectedOldOid });
}

export function cleanupSequence(decision) {
  if (decision?.decision !== 'CLEANUP_ALLOWED') return [];
  return Object.freeze([
    'READBACK_RESULT',
    'STOP_TASK_WRITERS',
    'INVENTORY_NON_FOLLOWING',
    'REMOVE_ELIGIBLE_WORKTREE',
    'DELETE_LOCAL_REF_CAS',
    'READBACK_REMOTE',
  ]);
}

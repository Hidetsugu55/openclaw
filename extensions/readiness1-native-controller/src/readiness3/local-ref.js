import { requireThat } from '../contract.js';
import { evaluateCleanup } from './cleanup.js';

const SHA40 = /^[a-f0-9]{40}$/;
const SAFE_TASK_REF = /^refs\/heads\/[A-Za-z0-9][A-Za-z0-9._\/-]*$/;

export async function deleteTaskRefCas({ cleanupDecision, taskRef, expectedOldOid, readFacts, runGit, now = Date.now() }) {
  requireThat(cleanupDecision?.decision === 'CLEANUP_ALLOWED', 'cleanup not allowed');
  requireThat(taskRef === cleanupDecision.taskRef && expectedOldOid === cleanupDecision.expectedOldOid, 'cleanup binding mismatch');
  requireThat(SAFE_TASK_REF.test(taskRef) && !taskRef.includes('..') && SHA40.test(expectedOldOid ?? ''), 'invalid cleanup ref');
  requireThat(typeof runGit === 'function' && typeof readFacts === 'function', 'missing fixed Git binding or cleanup recheck');

  const current = evaluateCleanup(await readFacts(), now);
  requireThat(current?.decision === 'CLEANUP_ALLOWED' && current.taskRef === taskRef
    && current.expectedOldOid === expectedOldOid, 'cleanup state changed');

  const before = await runGit(['show-ref', '--verify', '--hash', taskRef]);
  if (before?.status !== 0) return Object.freeze({ deleted: false, reason: 'ref_missing' });
  if (before.stdout !== expectedOldOid) return Object.freeze({ deleted: false, reason: 'old_oid_mismatch' });

  const mutation = await runGit(['update-ref', '--no-deref', '-d', taskRef, expectedOldOid]);
  if (mutation?.status !== 0) return Object.freeze({ deleted: false, reason: 'delete_failed_or_conflicted' });
  const after = await runGit(['show-ref', '--verify', '--quiet', taskRef]);
  if (after?.status !== 1) return Object.freeze({ deleted: false, reason: 'delete_unverified' });
  return Object.freeze({ deleted: true, ref: taskRef, oldOid: expectedOldOid });
}

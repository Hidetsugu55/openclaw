import { digest, integer, requireThat } from './contract.js';

const KINDS = ['DONE', 'BLOCKED', 'OWNER_DECISION_REQUIRED', 'CRITICAL_ALERT'];
// Remove executable-looking spans rather than displaying an Admin command.
export function safeSummary(value) {
  return String(value).replace(/```[\s\S]*?```|`[^`]*`/g, ' ')
    .replace(/(?:https?:\/\/|www\.)\S+|<[^>]*>|@[\w.-]+/gi, ' ')
    .replace(/(?:^|[\s;|&])(?:sudo|curl|wget|ssh|bash|sh|zsh|python\d*|node|eval|exec|rm|chmod|chown|launchctl|docker|gh|git)(?:\s+[^\n]*)?/gi, ' ')
    .replace(/[$;&|<>\\`]/g, ' ').replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069]/g, ' ')
    .replace(/\s+/g, ' ').trim().slice(0, 400);
}
export function evidenceUrl(ref, repos) {
  requireThat(ref && repos.includes(ref.repo), 'unapproved evidence repo');
  const base = `https://github.com/${ref.repo}`;
  if (['issue', 'pr'].includes(ref.kind)) { integer(ref.number, 'reference'); requireThat(ref.number > 0, 'invalid reference'); return `${base}/${ref.kind === 'pr' ? 'pull' : 'issues'}/${ref.number}`; }
  requireThat(ref.kind === 'commit' && /^[a-f0-9]{40}$/.test(ref.sha), 'invalid evidence ref'); return `${base}/commit/${ref.sha}`;
}
export function renderNotification(taskNodeId, input, repos) {
  requireThat(KINDS.includes(input.kind) && Object.keys(input).every(k => ['kind', 'summary', 'evidence', 'purpose', 'target', 'operationKind', 'risk'].includes(k)), 'not a closed notification');
  const pieces = input.kind === 'OWNER_DECISION_REQUIRED' ? ['purpose', 'target', 'operationKind', 'risk'].map(k => `${k}: ${safeSummary(input[k] ?? '')}`) : [safeSummary(input.summary ?? '')];
  const links = (input.evidence ?? []).slice(0, 5).map(r => evidenceUrl(r, repos));
  return { text: `${input.kind} ${safeSummary(taskNodeId)}\n${pieces.join('\n')}\n${links.join('\n')}`, unfurl_links: false, unfurl_media: false };
}
export async function notifyOwner({ ledger, taskNodeId, expectedRevision, eventId, payload, policy, sendFixedOwnerDM, now }) {
  requireThat(typeof eventId === 'string' && eventId.length > 0, 'missing event ID');
  const key = digest({ taskNodeId, eventId }), rendered = renderNotification(taskNodeId, payload, policy.evidenceRepos);
  const reserved = await ledger.mutate(taskNodeId, expectedRevision, s => {
    const existing = s.notifications.find(n => n.key === key);
    requireThat(!existing || (existing.status === 'failed' && existing.attempts === 1), 'notification already claimed');
    requireThat(s.notifications.reduce((sum, n) => sum + n.attempts, 0) < policy.taskRateCap, 'notification rate cap');
    if (existing) { existing.status = 'pending'; existing.attempts++; } else s.notifications.push({ key, status: 'pending', at: now, attempts: 1 }); return s;
  });
  // The only sender is a native, pre-bound Owner DM closure; no channel or
  // recipient argument is accepted. Unknown send outcome is never blindly retried.
  let status = 'pending';
  try { const result = await sendFixedOwnerDM(rendered); status = result?.confirmed === true ? 'sent' : result?.definitelyNotSent === true ? 'failed' : 'pending'; } catch { /* unknown outcome stays pending */ }
  return ledger.mutate(taskNodeId, reserved.revision, s => { s.notifications.find(n => n.key === key).status = status; return s; });
}
export function auditReceipt({ head, scopeHash, bundleManifest, report, result, expectedModel, now }) {
  requireThat(/^[a-f0-9]{40}$/.test(head) && /^[a-f0-9]{64}$/.test(scopeHash), 'invalid audit identity');
  requireThat(bundleManifest.head === head && bundleManifest.scopeHash === scopeHash && bundleManifest.canonicalInputs === true && bundleManifest.partialReportsIncluded === false, 'audit bundle drift');
  requireThat(result.normalExit === true && result.exitCode === 0 && result.complete === true && result.capacityEvent === false && result.errorEvent === false && result.unknownEvent === false, 'partial auditor report');
  requireThat(result.model === expectedModel && result.freshSession === true && result.noPersistence === true && result.contextReused === false && result.toolsReadOnly === true, 'auditor independence unproved');
  requireThat(result.verdict === 'PASS' && result.findings.every(f => f.severity === 'LOW' || f.severity === 'INFO'), 'audit has unresolved findings');
  return { schema: 'readiness1.audit-receipt.v1', head, scopeHash, manifestHash: digest(bundleManifest), reportHash: digest(report), model: result.model, at: now, verdict: 'PASS' };
}

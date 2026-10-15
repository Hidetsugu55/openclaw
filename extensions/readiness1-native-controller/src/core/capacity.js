import { digest, equal, integer, PHASES, requireThat, scopeHash, validateContract } from './contract.js';

const PROVIDERS = ['claude-code', 'codex'];
export function initialState(contract, receipt) {
  const c = validateContract(contract);
  return { contract: c, receipt, scopeHash: scopeHash(c), status: 'CLAIMED', attempts: 0, spent: 0, reserved: 0, resumes: 0, writer: null, ticket: null, workspace: null, wait: null, cleanup: 'clear', snapshot: null, lastObservation: null, finishReceipt: null, lastConfirmedHead: c.head, lastConfirmedPhase: c.phase, burnedSessionKeys: [], history: [], notifications: [], audit: null };
}
export function validateState(s) {
  validateContract(s.contract);
  for (const k of ['attempts', 'spent', 'reserved', 'resumes']) integer(s[k], k);
  requireThat(s.attempts <= s.contract.limits.attempts && s.spent + s.reserved <= s.contract.limits.budget && s.resumes <= s.contract.limits.resumes, 'budget exceeded');
  requireThat(s.scopeHash === scopeHash(s.contract), 'scope drift');
  requireThat(['CLAIMED', 'ACTIVE', 'WORKSPACE_RESERVED', 'WORKSPACE_READY', 'DISPATCH_RESERVED', 'RUNNING', 'WAITING_PROVIDER_CAPACITY', 'OUTCOME_UNKNOWN', 'BLOCKED', 'DONE', 'CANCELLED'].includes(s.status), 'invalid state');
  requireThat(['clear', 'pending', 'pass'].includes(s.cleanup), 'invalid cleanup');
  requireThat(Array.isArray(s.history) && Array.isArray(s.notifications), 'invalid history');
  requireThat(/^[a-f0-9]{40}$/.test(s.lastConfirmedHead) && PHASES.includes(s.lastConfirmedPhase) && Array.isArray(s.burnedSessionKeys), 'invalid progress/resource history');
  if (s.workspace) {
    requireThat(typeof s.workspace.id === 'string' && s.workspace.id.length > 0 && s.workspace.path === s.contract.root && typeof s.workspace.branch === 'string' && s.workspace.branch.length > 0 && /^[a-z0-9][a-z0-9_-]{0,63}$/.test(s.workspace.agentId), 'invalid workspace');
    const legacyKey = `agent:${s.workspace.agentId}:task:${digest(s.contract.taskNodeId)}:${s.contract.phase}`;
    const nativeKey = `agent:${s.workspace.agentId}:subagent:workboard-readiness1-${digest(s.contract.taskNodeId).slice(0, 24)}`;
    requireThat([legacyKey, nativeKey].includes(s.workspace.sessionKey), 'invalid workspace session');
  }
  if (s.gate) {
    requireThat(Array.isArray(s.gate.operations) && Array.isArray(s.gate.refusals) && Array.isArray(s.gate.omissions) && Array.isArray(s.gate.requests) && typeof s.gate.stopRequested === 'boolean', 'invalid gate journal');
    if (Object.hasOwn(s.gate, 'activeBinding')) {
      const binding = s.gate.activeBinding;
      const keys = ['candidateId', 'descriptorDigest', 'catalogHash', 'resolverHash', 'profileHash', 'operation', 'mode', 'route', 'role'];
      requireThat(binding && typeof binding === 'object' && !Array.isArray(binding) && Object.keys(binding).sort().join(',') === [...keys].sort().join(','), 'invalid active gate binding');
      requireThat(typeof binding.candidateId === 'string' && binding.candidateId.length > 0 && binding.candidateId.length <= 256, 'invalid active gate candidate');
      for (const key of ['descriptorDigest', 'catalogHash', 'resolverHash', 'profileHash']) requireThat(/^[a-f0-9]{64}$/.test(binding[key] ?? ''), `invalid active gate ${key}`);
      requireThat(['operation', 'route', 'role'].every((key) => typeof binding[key] === 'string' && binding[key].length > 0) && ['READ', 'OPS'].includes(binding.mode), 'invalid active gate route');
    }
    for (const o of s.gate.operations) requireThat(typeof o.id === 'string' && /^[a-f0-9]{64}$/.test(o.descriptorDigest) && ['CLAIMED', 'STARTED', 'CONFIRMED', 'UNKNOWN', 'BLOCKED'].includes(o.state), 'invalid operation journal');
  }
  return s;
}
export function validateSnapshot(snapshot, c) {
  requireThat(snapshot?.repo === c.repo && snapshot.worktree === c.root && /^[a-f0-9]{40}$/.test(snapshot.head) && typeof snapshot.dirty === 'string' && /^[a-f0-9]{64}$/.test(snapshot.indexDigest), 'incomplete or wrong Task snapshot');
  return snapshot;
}
export function nativeStatus(value, versions) {
  requireThat(PROVIDERS.includes(value?.provider) && value.version === versions[value.provider] && value.source === 'native-structured' && value.workCalls === 0, 'unverified native status');
  requireThat(['available', 'exhausted', 'unknown'].includes(value.capacity), 'unknown native capacity');
  requireThat(['off', 'on', 'unknown'].includes(value.paidOverflow), 'unknown billing');
  return value;
}
function billing(s, status, now) {
  const paid = s.receipt.paid;
  if (status.paidOverflow !== 'off') requireThat(paid?.provider === status.provider && paid.existingCreditOnly === true && paid.noReload === true && paid.expiresAt > now && paid.cap >= s.spent + s.reserved && paid.cap <= s.contract.limits.budget, 'paid overflow lacks bounded Owner receipt');
}
function authority(s, now) {
  requireThat(s.receipt.valid === true && now < s.receipt.expiresAt && now < s.contract.deadline && now < s.contract.hardSunset, 'expired or revoked authority');
  requireThat(s.receipt.scopeHash === s.scopeHash, 'receipt scope mismatch');
  requireThat(s.cleanup !== 'pending' && !['DONE', 'CANCELLED', 'CLAIMED'].includes(s.status), 'inactive or cleanup pending');
}
export function reserveWorkspace(s, { now, claimId }) {
  authority(s, now);
  requireThat(s.status === 'ACTIVE' && !s.writer && !s.ticket && !s.workspace, 'Task workspace cannot be reserved');
  requireThat(typeof claimId === 'string' && claimId.length >= 8, 'invalid workspace claim');
  const next = structuredClone(s);
  next.status = 'WORKSPACE_RESERVED';
  next.ticket = { id: claimId, activeId: claimId, state: 'workspace_reserved' };
  next.history.push({ kind: 'workspace_reserved', id: claimId, at: now });
  return validateState(next);
}
export function confirmWorkspace(s, { claimId, workspace, snapshot, now }) {
  requireThat(s.status === 'WORKSPACE_RESERVED' && !s.writer && s.ticket?.id === claimId && s.ticket.state === 'workspace_reserved', 'workspace claim drift');
  requireThat(workspace && typeof workspace === 'object' && !Array.isArray(workspace), 'missing workspace');
  const accepted = { id: workspace.id, path: workspace.path, branch: workspace.branch, agentId: workspace.agentId, sessionKey: workspace.sessionKey };
  requireThat(typeof accepted.id === 'string' && accepted.id.length > 0 && accepted.path === s.contract.root && typeof accepted.branch === 'string' && accepted.branch.length > 0 && /^[a-z0-9][a-z0-9_-]{0,63}$/.test(accepted.agentId), 'workspace identity drift');
  const legacyKey = `agent:${accepted.agentId}:task:${digest(s.contract.taskNodeId)}:${s.contract.phase}`;
  const nativeKey = `agent:${accepted.agentId}:subagent:workboard-readiness1-${digest(s.contract.taskNodeId).slice(0, 24)}`;
  requireThat([legacyKey, nativeKey].includes(accepted.sessionKey), 'workspace session drift');
  validateSnapshot(snapshot, s.contract);
  requireThat(snapshot.head === s.lastConfirmedHead && (!s.snapshot || equal(snapshot, s.snapshot)), 'workspace snapshot drift');
  const next = structuredClone(s);
  next.workspace = structuredClone(accepted);
  next.snapshot = structuredClone(snapshot);
  next.ticket.state = 'workspace_ready';
  next.status = 'WORKSPACE_READY';
  next.history.push({ kind: 'workspace_confirmed', id: claimId, at: now });
  return validateState(next);
}
export function workspaceOutcomeUnknown(s, { claimId, now }) {
  requireThat(['WORKSPACE_RESERVED', 'WORKSPACE_READY'].includes(s.status) && s.ticket?.id === claimId && !s.writer, 'workspace outcome claim drift');
  const next = structuredClone(s);
  next.status = 'OUTCOME_UNKNOWN';
  next.cleanup = 'pending';
  next.history.push({ kind: 'workspace_outcome_unknown', id: claimId, at: now });
  return validateState(next);
}
export function launchOutcomeUnknown(s, { ticketId, now }) {
  requireThat(['DISPATCH_RESERVED', 'RUNNING'].includes(s.status) && s.ticket?.activeId === ticketId, 'launch outcome ticket drift');
  const next = structuredClone(s);
  next.status = 'OUTCOME_UNKNOWN';
  next.cleanup = 'pending';
  next.history.push({ kind: 'launch_outcome_unknown', id: ticketId, at: now });
  return validateState(next);
}
function preLaunchAbortable(s, ticketId) {
  const observation = s.ticket?.observation;
  return s.status === 'DISPATCH_RESERVED'
    && s.ticket?.id === ticketId
    && s.ticket.activeId === ticketId
    && s.ticket.state === 'reserved'
    && !!s.ticket.gate
    && !s.writer
    && s.reserved > 0
    && observation?.providerResponded === false
    && observation.toolCalls === 0
    && observation.outputTokens === 0
    && observation.capacityExhausted === false
    && observation.terminalStatus === null;
}
export function preLaunchAbortRecovered(s, { ticketId, cleanupReceipt, now }) {
  requireThat(preLaunchAbortable(s, ticketId), 'pre-launch abort ticket drift');
  requireThat(
    cleanupReceipt?.schema === 'readiness1.finish-receipt.v1'
      && cleanupReceipt.taskNodeId === s.contract.taskNodeId
      && cleanupReceipt.root === s.contract.root
      && typeof cleanupReceipt.receiptId === 'string'
      && cleanupReceipt.receiptId.length >= 8
      && Number.isSafeInteger(cleanupReceipt.observedAt)
      && cleanupReceipt.workspaceRemoved === true
      && cleanupReceipt.releaseConfirmed === true
      && cleanupReceipt.postRemovalLsofClear === true
      && cleanupReceipt.auditConfirmed === true,
    'pre-launch cleanup receipt incomplete',
  );
  const next = structuredClone(s);
  next.reserved = 0;
  next.ticket = null;
  next.wait = null;
  next.cleanup = 'pass';
  next.finishReceipt = structuredClone(cleanupReceipt);
  next.status = 'CANCELLED';
  next.history.push({ kind: 'pre_launch_abort_recovered', id: ticketId, receiptId: cleanupReceipt.receiptId, reason: 'active_binding_drift', at: now });
  return validateState(next);
}
export function preLaunchAbortOutcomeUnknown(s, { ticketId, now }) {
  requireThat(preLaunchAbortable(s, ticketId), 'pre-launch abort ticket drift');
  const next = structuredClone(s);
  next.status = 'OUTCOME_UNKNOWN';
  next.cleanup = 'pending';
  next.history.push({ kind: 'pre_launch_abort_cleanup_unknown', id: ticketId, reason: 'active_binding_drift', at: now });
  return validateState(next);
}
export function reserveDispatch(s, { native, versions, now, snapshot, ticketId, reservation }) {
  authority(s, now); const status = nativeStatus(native, versions); billing(s, status, now);
  const workspaceReady = s.status === 'WORKSPACE_READY';
  requireThat(!s.writer && ((s.status === 'ACTIVE' && !s.ticket) || (workspaceReady && s.ticket?.id === ticketId && s.ticket.state === 'workspace_ready')), 'writer or dispatch already reserved');
  requireThat(s.attempts < s.contract.limits.attempts, 'attempt limit');
  integer(reservation, 'reservation'); requireThat(reservation > 0 && s.spent + reservation <= s.contract.limits.budget, 'budget limit');
  validateSnapshot(snapshot, s.contract);
  requireThat(snapshot.head === s.lastConfirmedHead && (!s.snapshot || equal(snapshot, s.snapshot)), 'dispatch snapshot mismatch');
  const next = structuredClone(s); next.snapshot = structuredClone(snapshot);
  if (status.capacity === 'exhausted') {
    next.status = 'WAITING_PROVIDER_CAPACITY'; next.ticket = null; next.wait = { provider: status.provider, version: status.version, phase: 'pre_start', detectedAt: now, resetAt: status.resetAt ?? null, processStopped: true, sideEffects: 'none' }; return next;
  }
  requireThat(status.capacity === 'available', 'UNKNOWN provider capacity');
  requireThat(typeof ticketId === 'string' && ticketId.length >= 8, 'invalid dispatch ticket');
  next.status = 'DISPATCH_RESERVED'; next.reserved = reservation;
  billing(next, status, now); // Paid authority must cover the new reservation.
  next.ticket = { id: ticketId, activeId: ticketId, provider: status.provider, version: status.version, state: 'reserved', attemptsAtReservation: s.attempts, observation: { providerResponded: false, toolCalls: 0, outputTokens: 0, capacityExhausted: false, terminalStatus: null } };
  // CLI launch reservation is separate from work/attempt/writer authority.
  return next;
}
export function workStarted(s, { ticketId, writer }) {
  requireThat(s.status === 'DISPATCH_RESERVED' && s.ticket?.id === ticketId && s.ticket.state === 'reserved', 'invalid start');
  requireThat(writer?.id && writer.taskNodeId === s.contract.taskNodeId && writer.root === s.contract.root, 'invalid writer');
  const next = structuredClone(s); next.writer = structuredClone(writer); next.ticket.state = 'awaiting_provider'; next.status = 'RUNNING'; return validateState(next);
}
export function nativeRunObservation(s, { ticketId, event, now }) {
  requireThat(s.status === 'RUNNING' && s.ticket?.activeId === ticketId && s.writer, 'native run observation ticket drift');
  requireThat(event?.runId && (!s.writer.runId || s.writer.runId === event.runId), 'native run observation identity drift');
  const next = structuredClone(s); next.writer.runId = event.runId;
  const observation = next.ticket.observation ??= { providerResponded: false, toolCalls: 0, outputTokens: 0, capacityExhausted: false, terminalStatus: null };
  if (event.kind === 'provider_activity') {
    if (!observation.providerResponded) {
      requireThat(next.attempts === next.ticket.attemptsAtReservation && next.attempts < next.contract.limits.attempts, 'provider attempt drift');
      next.attempts++; observation.providerResponded = true; next.ticket.state = 'started';
      next.history.push({ kind: 'provider_responded', id: ticketId, at: now });
    }
    if (event.toolCallStarted === true) observation.toolCalls++;
    if (Number.isSafeInteger(event.outputTokens) && event.outputTokens >= observation.outputTokens) observation.outputTokens = event.outputTokens;
  } else if (event.kind === 'provider_error') {
    observation.capacityExhausted ||= event.capacityExhausted === true;
  } else if (event.kind === 'terminal') {
    requireThat(['ok', 'error'].includes(event.status), 'invalid native terminal event'); observation.terminalStatus = event.status;
  } else requireThat(false, 'unknown native run observation');
  return validateState(next);
}
export function attachNativeRun(s, { ticketId, runId, now }) {
  requireThat(s.status === 'RUNNING' && s.ticket?.activeId === ticketId && s.writer, 'native run attachment ticket drift');
  requireThat(typeof runId === 'string' && runId.length > 0 && (!s.writer.runId || s.writer.runId === runId), 'native run attachment identity drift');
  const next = structuredClone(s); next.writer.runId = runId;
  if (!next.history.some(x => x.kind === 'native_run_attached' && x.id === runId)) next.history.push({ kind: 'native_run_attached', id: runId, at: now });
  return validateState(next);
}
export function capacityEvent(s, e, versions) {
  requireThat(e.provider === s.ticket?.provider && e.version === versions[e.provider] && e.source === 'native-structured' && e.kind === 'subscription_exhausted', 'unverified capacity event');
  requireThat(['DISPATCH_RESERVED', 'RUNNING'].includes(s.status), 'not an active dispatch');
  integer(e.toolCalls, 'tool calls'); integer(e.usage, 'usage');
  requireThat(e.usage <= s.reserved, 'unreconciled usage');
  const next = structuredClone(s);
  if (e.processStopped !== true || e.sideEffects !== 'none') { next.status = 'OUTCOME_UNKNOWN'; return next; }
  next.spent += e.usage; next.reserved -= e.usage;
  const observed = s.ticket?.observation;
  const pre = e.toolCalls === 0 && observed?.providerResponded !== true && s.attempts === s.ticket?.attemptsAtReservation;
  if (pre) { next.reserved = 0; next.writer = null; next.ticket.state = 'settled_without_attempt'; }
  else {
    requireThat(s.status === 'RUNNING' && !!s.writer && observed?.providerResponded === true, 'work began without provider/writer authority');
    validateSnapshot(e.snapshot, s.contract); next.snapshot = structuredClone(e.snapshot); next.lastConfirmedHead = e.snapshot.head;
  }
  next.status = 'WAITING_PROVIDER_CAPACITY';
  next.wait = { provider: e.provider, version: e.version, phase: pre ? 'pre_start' : 'in_flight', detectedAt: e.at, resetAt: e.resetAt ?? null, processStopped: true, sideEffects: 'none' };
  // The in-flight writer and remaining reservation deliberately remain held.
  return validateState(next);
}
export function resumeCapacity(s, { native, versions, now, snapshot, oldProcessStopped, sideEffects, singleWriter, resumeId, reservation }) {
  authority(s, now); requireThat(s.status === 'WAITING_PROVIDER_CAPACITY', 'not waiting');
  const n = nativeStatus(native, versions); billing(s, n, now);
  requireThat(n.provider === s.wait.provider && n.version === s.wait.version && n.capacity === 'available', 'provider not recovered');
  requireThat(equal(snapshot, s.snapshot), 'repo/worktree/head/dirty/index drift');
  requireThat(oldProcessStopped === true && sideEffects === 'none' && singleWriter === true, 'unreconciled process/side effect/writer');
  requireThat(s.resumes < s.contract.limits.resumes && s.spent + s.reserved < s.contract.limits.budget, 'resume budget exhausted');
  const next = structuredClone(s); next.resumes++; next.history.push({ kind: 'resume_claimed', id: resumeId, at: now }); next.wait = null;
  if (s.wait.phase === 'pre_start') {
    requireThat(s.attempts < s.contract.limits.attempts, 'attempt limit'); integer(reservation, 'reservation');
    requireThat(reservation > 0 && s.spent + reservation <= s.contract.limits.budget, 'budget limit');
    next.reserved = reservation;
    billing(next, n, now); // Recheck the paid cap before accepting a new ticket.
    next.writer = null; next.ticket = { id: resumeId, activeId: resumeId, provider: n.provider, version: n.version, state: 'reserved', attemptsAtReservation: s.attempts, observation: { providerResponded: false, toolCalls: 0, outputTokens: 0, capacityExhausted: false, terminalStatus: null } }; next.status = 'DISPATCH_RESERVED';
  } else { next.status = 'RUNNING'; next.ticket.state = 'resume_claimed'; next.ticket.resumeId = resumeId; next.ticket.activeId = resumeId; }
  // A crash after this CAS leaves an outstanding reservation; it never replays.
  return validateState(next);
}
export function settle(s, e) {
  requireThat(s.status === 'RUNNING' && e.processStopped === true && e.sideEffects === 'none', 'unconfirmed terminal result');
  requireThat(s.ticket?.observation?.providerResponded === true && s.ticket.observation.terminalStatus === 'ok', 'unconfirmed provider terminal result');
  requireThat(e.ticketId === s.ticket.activeId && e.writerId === s.writer.id, 'terminal writer/ticket mismatch');
  validateSnapshot(e.snapshot, s.contract);
  integer(e.usage, 'usage'); requireThat(e.usage <= s.reserved, 'unconfirmed usage');
  const next = structuredClone(s); next.spent += e.usage; next.reserved = 0; next.writer = null; next.ticket = null; next.snapshot = structuredClone(e.snapshot); next.lastConfirmedHead = e.snapshot.head; next.status = 'ACTIVE'; next.cleanup = 'pending'; return next;
}
export function settleObserved(s, e) {
  requireThat(e.observation?.schema === 'readiness1.native-observation.v1' && e.observation.taskNodeId === s.contract.taskNodeId && e.observation.runId === s.writer?.runId && e.observation.sessionKey === s.writer?.sessionKey, 'terminal observation identity mismatch');
  requireThat(e.observation.processStopped === true && e.observation.groupStopped === true && e.observation.containerRemoved === true && e.observation.lsofClear === true && e.observation.cleanWorktree === true, 'terminal resources are not verified');
  requireThat(e.observation.usage === e.usage && equal(e.observation.snapshot, e.snapshot), 'terminal observation usage/snapshot mismatch');
  const next = settle(s, e);
  next.lastObservation = structuredClone(e.observation);
  return validateState(next);
}
export function transitionInvariant(current, next) {
  validateState(current); validateState(next);
  requireThat(equal(current.contract, next.contract) && equal(current.receipt, next.receipt), 'authority cannot change through normal CAS');
  requireThat(next.history.length >= current.history.length && equal(next.history.slice(0, current.history.length), current.history), 'Task history cannot reset/change');
  for (const k of ['attempts', 'spent', 'resumes']) requireThat(next[k] >= current[k], `${k} cannot reset`);
  if (current.workspace) requireThat(equal(current.workspace, next.workspace), 'workspace identity cannot change');
  requireThat(!['DONE', 'CANCELLED'].includes(current.status), 'terminal tombstone is sticky');
  requireThat(current.status !== 'CLAIMED', 'claimed receipt cannot activate through normal CAS');
  requireThat(equal(current.gate?.activeBinding ?? null, next.gate?.activeBinding ?? null), 'active gate binding cannot change through normal CAS');
  if (current.gate) {
    const old = current.gate, g = next.gate; requireThat(g && (!old.stopRequested || g.stopRequested), 'gate stop cannot reset');
    for (const key of ['operations', 'refusals', 'omissions', 'requests']) requireThat(g[key].length >= old[key].length, 'gate history cannot reset');
    for (const item of old.operations) {
      const n = g.operations.find(x => x.id === item.id); requireThat(n && equal({ ...n, state: item.state }, item) && (n.state === item.state || (item.state === 'CLAIMED' && ['STARTED', 'BLOCKED', 'UNKNOWN'].includes(n.state)) || (item.state === 'STARTED' && ['CONFIRMED', 'UNKNOWN'].includes(n.state))), 'operation receipt cannot replay/change');
    }
    for (let i = 0; i < old.refusals.length; i++) requireThat(g.refusals[i].reRequests >= old.refusals[i].reRequests && equal({ ...g.refusals[i], reRequests: old.refusals[i].reRequests }, old.refusals[i]), 'refusal cannot reset');
    requireThat(equal(g.omissions.slice(0, old.omissions.length), old.omissions) && equal(g.requests.slice(0, old.requests.length), old.requests), 'gate tombstone cannot change');
  }
}

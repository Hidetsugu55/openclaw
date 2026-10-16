import { digest, equal, requireThat, scopeHash, validateContract } from './contract.js';

// Server policy errors are local prerequisites, never an Owner first answer.
export function validatePaidCapability(c) {
  if (!c.caps.paid) return;
  const p = c.caps.paid;
  requireThat(['claude-code', 'codex'].includes(p.provider) && Number.isSafeInteger(p.cap) && p.cap > 0 && p.cap <= c.limits.budget && p.existingCreditOnly === true && p.noReload === true, 'invalid bounded billing capability');
}
export function validateApprovalPolicy(c, { pins, controllerDeviceId }) {
  requireThat(Array.isArray(pins) && pins.length > 0 && !pins.includes(controllerDeviceId), 'invalid Owner device pins');
  validatePaidCapability(c);
}

// These decisive bytes are generated only from a canonical server-read Task.
// No model text, URL, target device or arbitrary scope enters the native card.
export function approvalCard(contract, expiresAt, advisory = '', clock, operation = null, activation = null, pluginId = 'pilot1-controller') {
  const c = validateContract(contract);
  validatePaidCapability(c);
  requireThat(Number.isSafeInteger(clock) && clock >= 0 && Number.isSafeInteger(expiresAt) && expiresAt > clock && expiresAt <= c.deadline && expiresAt <= c.hardSunset, 'invalid approval expiry');
  const decisive = { taskNodeId: c.taskNodeId, repo: c.repo, ref: c.ref, head: c.head, root: c.root, phase: c.phase, role: c.role, actionClass: c.actionClass, caps: c.caps, limits: c.limits, deadline: c.deadline, expiresAt, originatingSession: c.originatingSession, revision: c.revisionHash.slice(0, 12), scopeHash: scopeHash(c) };
  const note = String(advisory).replace(/[<>&`\r\n]/g, ' ').slice(0, 240);
  if (operation) requireThat(operation.taskNodeId === c.taskNodeId && operation.scopeHash === scopeHash(c) && operation.contractRevision === c.revisionHash && Number.isSafeInteger(operation.epoch) && /^[a-f0-9]{64}$/.test(operation.descriptorDigest), 'invalid operation card');
  if (activation) requireThat(!operation && Number.isSafeInteger(activation.epoch) && activation.epoch > 0 && Number.isSafeInteger(activation.expectedRevision) && activation.expectedRevision >= -1, 'invalid activation epoch');
  const presentation = { kind: 'plugin', pluginId, title: `${operation ? 'Operation' : 'Task activation'}: ${c.taskNodeId}`.slice(0, 80), description: `${c.repo} ${c.phase} ${c.actionClass}; ${c.revisionHash.slice(0, 12)}`.slice(0, 512), detail: JSON.stringify({ decisive, purpose: operation ? 'operation' : 'activation', operation, activation, advisoryNote: note }, null, 2), severity: 'warning', allowedDecisions: ['allow-once', 'deny'] };
  requireThat(presentation.detail.length <= 16384, 'approval card too large');
  return { purpose: operation ? 'operation' : 'activation', ...(operation ? { operation: structuredClone(operation) } : {}), ...(activation ? { activation: structuredClone(activation) } : {}), presentation, taskNodeId: c.taskNodeId, revisionHash: c.revisionHash, scopeHash: scopeHash(c), expiresAt, renderedCardHash: digest(presentation) };
}
export function verifyApproval(snapshot, binding, c, { now, pins, controllerDeviceId }) {
  validateApprovalPolicy(c, { pins, controllerDeviceId });
  requireThat(snapshot?.id === binding.id && snapshot.status === 'allowed' && snapshot.decision === 'allow-once' && snapshot.reason === 'user', 'not native allow-once');
  for (const key of ['createdAtMs', 'resolvedAtMs', 'expiresAtMs']) requireThat(Number.isSafeInteger(snapshot[key]), 'invalid native approval clock');
  requireThat(snapshot.resolver?.kind === 'device' && pins.includes(snapshot.resolver.id), 'non-Owner device first answer');
  requireThat(snapshot.createdAtMs <= snapshot.resolvedAtMs && snapshot.resolvedAtMs < snapshot.expiresAtMs && now < snapshot.expiresAtMs && now < binding.expiresAt, 'expired native approval');
  requireThat(binding.taskNodeId === c.taskNodeId && binding.revisionHash === c.revisionHash && binding.scopeHash === scopeHash(c), 'approval binding mismatch');
  requireThat(equal(snapshot.presentation, binding.presentation) && digest(snapshot.presentation) === binding.renderedCardHash, 'rendered card mismatch');
  requireThat(snapshot.expiresAtMs === binding.expiresAt, 'native expiry mismatch');
  requireThat(!binding.operation || binding.purpose === 'operation', 'approval purpose mismatch');
  const receipt = { id: binding.id, valid: true, scopeHash: binding.scopeHash, expiresAt: Math.min(c.deadline, c.hardSunset), approvalExpiresAt: binding.expiresAt, renderedCardHash: binding.renderedCardHash };
  // The native approval window governs one activation. The activated Task's
  // explicitly displayed absolute deadline governs subsequent scoped work.
  if (binding.purpose === 'operation') receipt.expiresAt = Math.min(receipt.expiresAt, binding.expiresAt);
  if (c.caps.paid && binding.purpose !== 'operation') {
    const p = c.caps.paid;
    receipt.paid = { ...p, expiresAt: receipt.expiresAt };
  }
  return receipt;
}
export function createApprovalAdapter({ requestApprovalRpc, getApprovalRpc, now, pluginId = 'pilot1-controller' }) {
  function prepare(contract, advisory = '', operation = null, activation = null) {
      const clock = now(); const expiry = Math.min(clock + 600000, contract.deadline, contract.hardSunset);
      requireThat(expiry > clock, 'expired Task');
      const card = approvalCard(contract, expiry, advisory, clock, operation, activation, pluginId);
      requireThat(expiry - clock > 1000, 'insufficient approval window');
      return card;
  }
  async function requestPrepared(card) {
      const clock = now(), expiry = card.expiresAt;
      if (!(expiry - clock > 1000)) throw Object.assign(new Error('insufficient approval window'), { code: 'APPROVAL_NOT_SENT' });
      const { kind: _kind, ...params } = card.presentation;
      const result = await requestApprovalRpc({ ...params, timeoutMs: expiry - clock - 1000, twoPhase: true });
      requireThat(typeof result.id === 'string' && Number.isSafeInteger(result.expiresAtMs), 'unconfirmed native request');
      requireThat(result.expiresAtMs <= expiry && result.expiresAtMs > clock, 'native request expiry drift');
      const observed = (await getApprovalRpc({ id: result.id })).approval;
      requireThat(observed?.id === result.id && observed.expiresAtMs === result.expiresAtMs, 'unconfirmed request readback');
      for (const [key, value] of Object.entries(card.presentation)) requireThat(equal(observed.presentation[key], value), 'native rendered field mismatch');
      return { ...card, id: result.id, expiresAt: observed.expiresAtMs, presentation: observed.presentation, renderedCardHash: digest(observed.presentation) };
  }
  return Object.freeze({ prepare, requestPrepared,
    request: (contract, advisory = '', operation = null, activation = null) => requestPrepared(prepare(contract, advisory, operation, activation)),
    async get(id) { const result = await getApprovalRpc({ id }); return result.approval; },
  });
}

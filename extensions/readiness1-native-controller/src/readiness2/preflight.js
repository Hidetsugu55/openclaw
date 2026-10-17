import { digest, equal, scopeHash } from '../contract.js';
import {
  EFFECT_CLASSES,
  effectKey,
  validateDescriptor,
  validateExecutionGateCapability,
} from './catalog.js';

export const DECISIONS = Object.freeze([
  'BLOCKED',
  'UNKNOWN',
  'OWNER_APPROVAL_REQUIRED',
  'AUTONOMOUS_WITHIN_SCOPE',
]);

const ownerGate = (effect) => effect.category !== 'none';
const matches = (grant, descriptor, effect) => (
  grant.operation === descriptor.operation
  && grant.class === effect.class
  && grant.category === effect.category
  && grant.target === effect.target
  && Number.isSafeInteger(grant.maxAmount)
  && grant.maxAmount >= effect.amount
);

export function evaluatePreflight({
  descriptor,
  task,
  record,
  candidate = {},
  now,
}) {
  const reasons = [];
  const states = [];
  const mark = (state, reason) => {
    states.push(state);
    reasons.push(reason);
  };
  try {
    validateDescriptor(descriptor);
  } catch {
    return { decision: 'UNKNOWN', reasons: ['descriptor unknown'] };
  }

  const descriptorDigest = digest(descriptor);
  const state = record?.state;
  const contract = task ?? state?.contract;
  let caps = contract?.caps?.executionGate;
  if (caps) {
    try {
      validateExecutionGateCapability(caps);
    } catch {
      mark('BLOCKED', 'invalid Execution Gate capability');
      caps = null;
    }
  }
  if (candidate.toolFree) mark('BLOCKED', 'Owner requested no tools');

  if (!contract || !caps) {
    mark('UNKNOWN', 'canonical Task missing');
  } else {
    if (
      descriptor.taskNodeId !== contract.taskNodeId
      || descriptor.epoch !== (record?.epoch ?? 0)
      || descriptor.contractRevision !== contract.revisionHash
      || descriptor.scopeHash !== scopeHash(contract)
      || (
        state
        && (
          !equal(state.contract, contract)
          || state.scopeHash !== descriptor.scopeHash
          || state.receipt.scopeHash !== descriptor.scopeHash
        )
      )
    ) mark('BLOCKED', 'Task/epoch/contract/scope drift');
    if (
      caps.catalogHash !== descriptor.catalogHash
      || caps.resolverHash !== descriptor.resolverHash
      || !caps.profileHashes?.includes(descriptor.profileHash)
    ) mark('BLOCKED', 'catalog/resolver/profile pin drift');
    if (descriptor.role !== contract.role && descriptor.role !== 'main') {
      mark('BLOCKED', 'role ceiling mismatch');
    }
    if (
      ['specialist', 'read-specialist'].includes(descriptor.route)
      && descriptor.role !== contract.role
    ) mark('BLOCKED', 'specialist Task role mismatch');
    if (state) {
      if (
        state.gate?.stopRequested
        || ['DONE', 'CANCELLED', 'CLAIMED', 'BLOCKED', 'OUTCOME_UNKNOWN'].includes(state.status)
        || state.cleanup === 'pending'
        || state.gate?.operations.some((operation) => (
          ['CLAIMED', 'STARTED', 'UNKNOWN'].includes(operation.state)
        ))
      ) mark('BLOCKED', 'Task stopped or unresolved');
      if (state.writer && candidate.writerId !== state.writer.id) {
        mark('BLOCKED', 'writer conflict');
      }
      if (
        !Number.isSafeInteger(now)
        || now >= contract.deadline
        || now >= contract.hardSunset
        || now >= state.receipt.expiresAt
        || !state.receipt.valid
      ) mark('OWNER_APPROVAL_REQUIRED', 'authority expired; no autonomous extension');
    } else if (!(
      descriptor.mode === 'READ'
      && descriptor.route === 'safe-projection'
      && descriptor.role === 'main'
    )) mark('OWNER_APPROVAL_REQUIRED', 'Task activation required');
    if ((candidate.dependsOn ?? []).some((id) => state?.gate?.omissions.some(
      (entry) => entry.id === id && entry.protective && !caps.omissionOverrides?.includes(id),
    ))) mark('BLOCKED', 'protective prerequisite omitted');
  }

  if (descriptor.mode === 'READ') {
    for (const effect of descriptor.effects) {
      const safe = (
        (['command', 'permission'].includes(effect.class) && effect.scratch === true)
        || (
          ['api', 'egress', 'dataMovement'].includes(effect.class)
          && effect.readOnly === true
          && effect.safeView === true
        )
        || (['filesystem', 'cleanup'].includes(effect.class) && effect.scratch === true)
      );
      if (ownerGate(effect) || !safe) mark('BLOCKED', 'READ mutation/egress/credential effect');
    }
    if (candidate.toolFree) mark('BLOCKED', 'Owner requested no tools');
  } else if (descriptor.mode === 'OPS') {
    if (!state || !contract || !caps || !state.receipt?.valid) {
      mark('OWNER_APPROVAL_REQUIRED', 'Task activation required');
    } else {
      if (
        ['DONE', 'CANCELLED', 'CLAIMED', 'BLOCKED', 'OUTCOME_UNKNOWN'].includes(state.status)
        || state.gate?.stopRequested
        || state.gate?.operations.some((operation) => (
          ['CLAIMED', 'STARTED', 'UNKNOWN'].includes(operation.state)
        ))
        || state.cleanup === 'pending'
      ) mark('BLOCKED', 'Task stopped or unresolved');
      if (
        !Number.isSafeInteger(now)
        || now >= contract.deadline
        || now >= contract.hardSunset
        || now >= state.receipt.expiresAt
      ) mark('OWNER_APPROVAL_REQUIRED', 'authority expired; no autonomous extension');
      if (
        descriptor.taskNodeId !== record.taskNodeId
        || descriptor.epoch !== record.epoch
        || descriptor.contractRevision !== contract.revisionHash
        || descriptor.scopeHash !== scopeHash(contract)
        || state.scopeHash !== descriptor.scopeHash
        || state.receipt.scopeHash !== descriptor.scopeHash
      ) mark('BLOCKED', 'Task/epoch/contract/scope drift');
      if (
        caps.catalogHash !== descriptor.catalogHash
        || caps.resolverHash !== descriptor.resolverHash
        || !caps.profileHashes?.includes(descriptor.profileHash)
      ) mark('BLOCKED', 'catalog/resolver/profile pin drift');
      if (descriptor.role !== contract.role && descriptor.role !== 'main') {
        mark('BLOCKED', 'role ceiling mismatch');
      }
      if (state.writer && candidate.writerId !== state.writer.id) {
        mark('BLOCKED', 'writer conflict');
      }
      const continuingAttempt = Boolean(
        state.writer
        && (
          (
            state.status === 'RUNNING'
            && ['started', 'resume_claimed'].includes(state.ticket?.state)
          )
          || (
            state.status === 'WAITING_PROVIDER_CAPACITY'
            && state.wait?.phase === 'in_flight'
          )
        )
      );
      const requestedCost = descriptor.effects
        .filter((effect) => effect.class === 'cost')
        .reduce((total, effect) => total + effect.amount, 0);
      if (
        state.spent + state.reserved + requestedCost > contract.limits.budget
        || (!continuingAttempt && state.attempts >= contract.limits.attempts)
        || (state.gate?.operations.length ?? 0) >= caps.operationLimit
      ) mark('OWNER_APPROVAL_REQUIRED', 'Task limit; no counter reset');
      const missing = descriptor.effects.filter((effect) => (
        !(caps.grants ?? []).some((grant) => matches(grant, descriptor, effect))
        || (
          ownerGate(effect)
          && !(caps.grants ?? []).some((grant) => (
            matches(grant, descriptor, effect) && grant.ownerAuthorized === true
          ))
        )
      ));
      if (missing.length) {
        mark(
          candidate.coverageClaim?.kind === 'new'
            ? 'OWNER_APPROVAL_REQUIRED'
            : 'BLOCKED',
          'effects exceed claimed coverage',
        );
      }
      if (
        candidate.coverageClaim
        && candidate.coverageClaim.kind !== 'new'
        && (
          candidate.coverageClaim.receiptId !== state.receipt.id
          || !equal(
            [...(candidate.coverageClaim.effectKeys ?? [])].sort(),
            descriptor.effects.map(effectKey).sort(),
          )
        )
      ) mark('BLOCKED', 'coverage claim mismatch');
      if ((candidate.dependsOn ?? []).some((id) => (state.gate?.omissions ?? []).some(
        (entry) => entry.id === id
          && entry.protective
          && !caps.omissionOverrides?.includes(id),
      ))) mark('BLOCKED', 'protective prerequisite omitted');
    }
  } else {
    mark('UNKNOWN', 'mode unknown');
  }

  if (state && caps) {
    for (const effect of descriptor.effects) {
      const refusals = (state.gate?.refusals ?? []).filter(
        (entry) => entry.key === effectKey(effect) && !entry.reopened,
      );
      for (const refusal of refusals) {
        const group = (state.gate?.refusals ?? []).filter(
          (entry) => entry.descriptorDigest === refusal.descriptorDigest && !entry.reopened,
        );
        const narrowed = descriptor.effects.every((candidateEffect) => group.some(
          (entry) => (
            entry.key === effectKey(candidateEffect)
            && candidateEffect.amount <= entry.amount
          ),
        )) && descriptor.effects.some((candidateEffect) => group.some(
          (entry) => (
            entry.key === effectKey(candidateEffect)
            && candidateEffect.amount < entry.amount
          ),
        ));
        const narrowing = (
          candidate.coverageClaim?.kind === 'new'
          && narrowed
          && refusal.reRequests === 0
        );
        const expiryRetry = (
          refusal.reason === 'expiry'
          && refusal.reRequests === 0
          && candidate.coverageClaim?.kind === 'new'
        );
        const pendingReRequest = (state.gate?.requests ?? []).some((request) => (
          request.kind === 'request_bound'
          && request.descriptorDigest === descriptorDigest
          && request.reRequestKeys?.includes(refusal.key)
          && !(state.gate.requests ?? []).some(
            (entry) => entry.kind === 'request_closed' && entry.id === request.id,
          )
          && !(state.gate.operations ?? []).some((entry) => entry.id === request.id)
        ));
        if (!narrowing && !expiryRetry && !pendingReRequest) {
          mark('BLOCKED', 'sticky refusal/expiry');
        } else {
          mark(
            'OWNER_APPROVAL_REQUIRED',
            'one disclosed re-request only; exact new Owner receipt required',
          );
        }
      }
    }
  }

  if (candidate.mechanicalDigest && candidate.mechanicalDigest !== descriptorDigest) {
    mark('BLOCKED', 'request/mechanical descriptor mismatch');
  }
  if (candidate.advisoryDigest && candidate.advisoryDigest !== descriptorDigest) {
    mark('BLOCKED', 'advisory/mechanical mismatch');
  }
  const decision = DECISIONS.find((entry) => states.includes(entry))
    ?? 'AUTONOMOUS_WITHIN_SCOPE';
  return {
    decision,
    reasons,
    descriptorDigest,
    receiptId: state?.receipt?.id ?? null,
    mechanical: {
      descriptor: structuredClone(descriptor),
      effectClasses: Object.fromEntries(EFFECT_CLASSES.map((key) => [
        key,
        descriptor.effects.filter((effect) => effect.class === key),
      ])),
      priorRefusals: structuredClone(state?.gate?.refusals ?? []),
      descriptorDigest,
      expiry: contract ? Math.min(contract.deadline, contract.hardSunset) : null,
    },
    advisory: 'advisory, not approval',
  };
}

import { randomUUID } from 'node:crypto';
import { equal, requireThat } from '../contract.js';
import { validateApprovalPolicy } from '../core/approval.js';
import {
  effectKey,
  EFFECT_CLASSES,
  validateExecutionGateCapability,
} from './catalog.js';
import { evaluatePreflight } from './preflight.js';

export const GATE_ACTIONS = Object.freeze([
  'gate.preflight',
  'operation.request',
  'operation.apply',
  'gate.cancel',
  'gate.reconcile',
  'snapshot.update',
]);

const nativeUnknownCount = (state) => state.history.filter(
  (entry) => ['native_outcome_unknown', 'native_session_rejected'].includes(entry.kind),
).length;
const journal = (state) => state.gate ??= {
  operations: [],
  refusals: [],
  omissions: [],
  requests: [],
  stopRequested: false,
};
const unavailable = (error) => {
  const message = String(error?.message ?? error ?? 'UNKNOWN');
  return {
    decision: /BLOCKED/.test(message) ? 'BLOCKED' : 'UNKNOWN',
    reasons: [
      /BLOCKED/.test(message)
        ? 'canonical capability or artifact rejected'
        : 'canonical capability or artifact UNKNOWN',
    ],
    advisory: 'advisory, not approval',
  };
};

// Source-only fixture seam. The caller must inject the 10.3 invocation
// freshness assertion; this module is deliberately not registered as a public
// tool action until the required production closures exist.
export function createExecutionGate({
  ledger: nativeLedger,
  approval,
  resolver,
  readCandidate,
  invokeImmutable,
  policy,
  assertCurrent,
  now = Date.now,
}) {
  requireThat(
    nativeLedger?.consumeOperation
      && typeof resolver?.resolve === 'function'
      && typeof readCandidate === 'function'
      && typeof invokeImmutable === 'function'
      && typeof assertCurrent === 'function',
    'missing Execution Gate binding',
  );
  const ledger = Object.freeze({
    read: (taskNodeId) => nativeLedger.read(taskNodeId, assertCurrent),
    mutate: (taskNodeId, revision, reducer) => nativeLedger.mutate(
      taskNodeId,
      revision,
      reducer,
      assertCurrent,
    ),
    mutateLatest: (taskNodeId, reducer) => nativeLedger.mutateLatest(
      taskNodeId,
      reducer,
      assertCurrent,
    ),
    bindOperation: (...args) => nativeLedger.bindOperation(...args, assertCurrent),
    observeOperation: (...args) => nativeLedger.observeOperation(...args, assertCurrent),
    consumeOperation: (...args) => nativeLedger.consumeOperation(...args, assertCurrent),
  });

  async function prepare(task, record, candidateId, action) {
    try {
      const candidate = await readCandidate({ task, candidateId, action });
      requireThat(
        candidate?.taskNodeId === task.taskNodeId && candidate.id === candidateId,
        'BLOCKED canonical candidate mismatch',
      );
      const resolved = await resolver.resolve(candidate, task, record);
      const decision = evaluatePreflight({
        descriptor: resolved.descriptor,
        task,
        record,
        candidate,
        now: now(),
      });
      return { ...resolved, ...decision, candidate };
    } catch (error) {
      return unavailable(error);
    }
  }

  function publicResult(prepared) {
    const {
      decision,
      reasons,
      descriptorDigest,
      receiptId,
      mechanical,
      advisory,
    } = prepared;
    return {
      decision,
      reasons,
      ...(descriptorDigest ? { descriptorDigest, receiptId, mechanical } : {}),
      advisory,
    };
  }

  async function scopedPreparation(task, record, candidateId, action, expectedDigest) {
    const prepared = await prepare(task, record, candidateId, action);
    requireThat(
      prepared.descriptor
        && (!expectedDigest || prepared.descriptorDigest === expectedDigest),
      'descriptor drift/UNKNOWN; receipt not consumed',
    );
    return prepared;
  }

  function actionMatches(action, operation, task) {
    if (
      action?.endsWith('.read')
      || ['ready.consume', 'comment.append', 'task.status', 'snapshot.update'].includes(action)
    ) return operation === action;
    if (['dispatch', 'resume', 'approval.request', 'activate'].includes(action)) {
      return operation === ({
        source: 'source.work',
        audit: 'audit.review',
        read: 'research.read',
        diagnostic: 'diagnostic.read',
        repair: 'ops.repair',
      })[task.actionClass];
    }
    return true;
  }

  async function checkExisting({ task, record, action, candidateId }) {
    const prepared = await prepare(task, record, candidateId, action);
    requireThat(
      prepared.decision === 'AUTONOMOUS_WITHIN_SCOPE',
      `Execution Gate ${prepared.decision}`,
    );
    requireThat(
      actionMatches(action, prepared.descriptor?.operation, task),
      'action/candidate mismatch',
    );
    return prepared;
  }

  async function checkActivation(task, record, candidateId, action) {
    const candidate = await readCandidate({ task, candidateId, action });
    requireThat(
      candidate?.taskNodeId === task.taskNodeId && candidate.id === candidateId,
      'activation canonical candidate mismatch',
    );
    const activationRecord = {
      epoch: (record?.epoch ?? 0) + 1,
      state: record?.state ?? {},
    };
    const resolved = await resolver.resolve(candidate, task, activationRecord);
    requireThat(
      actionMatches(action, resolved.descriptor.operation, task),
      'activation candidate mismatch',
    );
    const capability = task.caps.executionGate;
    validateExecutionGateCapability(capability);
    const descriptor = resolved.descriptor;
    requireThat(
      capability
        && capability.catalogHash === descriptor.catalogHash
        && capability.resolverHash === descriptor.resolverHash
        && capability.profileHashes.includes(descriptor.profileHash)
        && Number.isSafeInteger(capability.operationLimit)
        && capability.operationLimit > 0,
      'activation catalog/resolver/profile mismatch',
    );
    requireThat(!candidate.toolFree, 'Owner requested no tools');
    requireThat(
      !['specialist', 'read-specialist'].includes(descriptor.route)
        || descriptor.role === task.role,
      'activation specialist role mismatch',
    );
    if (descriptor.mode === 'READ') {
      const safe = evaluatePreflight({
        descriptor,
        task,
        record: null,
        candidate,
        now: now(),
      });
      requireThat(
        !['BLOCKED', 'UNKNOWN'].includes(safe.decision),
        'activation READ boundary mismatch',
      );
    }
    return resolved;
  }

  async function cancel(task, record) {
    requireThat(
      record && !['DONE', 'CANCELLED', 'CLAIMED'].includes(record.state.status),
      'inactive Task',
    );
    return ledger.mutate(task.taskNodeId, record.revision, (state) => {
      journal(state).stopRequested = true;
      state.history.push({ kind: 'gate_stop_requested', at: now() });
      return state;
    });
  }

  async function reconcile(task, record) {
    requireThat(record, 'no Task');
    return {
      taskNodeId: task.taskNodeId,
      revision: record.revision,
      status: record.state.status,
      stopRequested: record.state.gate?.stopRequested ?? false,
      outstandingOperations: (record.state.gate?.operations ?? [])
        .filter((entry) => ['CLAIMED', 'STARTED', 'UNKNOWN'].includes(entry.state))
        .map((entry) => ({
          id: entry.id,
          descriptorDigest: entry.descriptorDigest,
          state: entry.state,
        })),
    };
  }

  async function request(task, record, candidateId, action) {
    for (
      const old of record?.state.gate?.requests.filter(
        (entry) => entry.kind === 'request_bound',
      ) ?? []
    ) {
      const observed = await ledger.observeOperation(
        task.taskNodeId,
        record.revision,
        old.id,
        approval.get,
        now(),
      );
      record = await ledger.read(task.taskNodeId);
      if (observed.state === 'requested') {
        const prepared = await prepare(task, record, candidateId, action);
        requireThat(
          prepared.descriptorDigest === old.descriptorDigest,
          'existing Owner decision unresolved; no new request',
        );
        return {
          ...publicResult(prepared),
          approvalId: old.id,
          revision: record.revision,
        };
      }
    }

    const prepared = await prepare(task, record, candidateId, action);
    if (prepared.descriptor) {
      requireThat(
        ['coordination', 'snapshot-runner'].includes(prepared.descriptor.route),
        'specialist operation request requires Task activation/dispatch',
      );
    }
    if (
      prepared.decision !== 'OWNER_APPROVAL_REQUIRED'
      || prepared.reasons.some((reason) => reason.startsWith('Task limit'))
    ) return publicResult(prepared);
    requireThat(
      record?.state.status === 'ACTIVE'
        && !record.state.writer
        && !record.state.ticket
        && record.state.receipt.valid
        && now() < record.state.receipt.expiresAt
        && now() < task.deadline
        && !record.state.gate?.stopRequested,
      'new activation required, not operation approval',
    );
    requireThat(
      ['coordination', 'snapshot-runner'].includes(prepared.descriptor.route),
      'specialist operation request requires Task activation/dispatch',
    );

    const operation = {
      taskNodeId: task.taskNodeId,
      epoch: record.epoch,
      contractRevision: task.revisionHash,
      scopeHash: record.state.scopeHash,
      descriptorDigest: prepared.descriptorDigest,
      descriptor: prepared.descriptor,
      mechanical: {
        enforcement: 'native',
        effectRows: '1-based indices into descriptor.effects',
        effectClasses: Object.fromEntries(EFFECT_CLASSES.map((effectClass) => {
          const rows = prepared.descriptor.effects.flatMap(
            (effect, index) => effect.class === effectClass ? [index + 1] : [],
          );
          return [effectClass, rows.length ? rows : 'NONE'];
        })),
      },
      priorRefusals: prepared.mechanical.priorRefusals,
    };
    validateApprovalPolicy(task, {
      pins: policy.ownerDevicePins,
      controllerDeviceId: policy.controllerDeviceId,
    });
    const card = approval.prepare(task, 'advisory, not approval', operation);
    const nonce = randomUUID();
    const reserved = await ledger.mutate(task.taskNodeId, record.revision, (state) => {
      const gate = journal(state);
      requireThat(
        !gate.operations.some(
          (entry) => ['CLAIMED', 'STARTED', 'UNKNOWN'].includes(entry.state),
        ),
        'unresolved operation',
      );
      requireThat(
        gate.requests.filter((entry) => entry.kind === 'request_reserved').length
          < task.caps.executionGate.operationLimit,
        'Owner request budget exhausted',
      );
      state.status = 'OUTCOME_UNKNOWN';
      gate.requests.push({
        kind: 'request_reserved',
        id: nonce,
        descriptorDigest: prepared.descriptorDigest,
        at: now(),
      });
      return state;
    });

    let binding;
    try {
      binding = await approval.requestPrepared(card);
    } catch (error) {
      if (error.code === 'APPROVAL_NOT_SENT') {
        await ledger.mutateLatest(task.taskNodeId, (state) => {
          requireThat(
            state.status === 'OUTCOME_UNKNOWN'
              && journal(state).requests.some(
                (entry) => entry.kind === 'request_reserved' && entry.id === nonce,
              ),
            'request reservation changed',
          );
          journal(state).requests.push({
            kind: 'request_not_sent',
            id: nonce,
            at: now(),
          });
          if (nativeUnknownCount(state) === nativeUnknownCount(reserved.state)) {
            state.status = 'ACTIVE';
          }
          return state;
        });
      }
      throw error;
    }
    requireThat(
      binding.purpose === 'operation'
        && binding.taskNodeId === task.taskNodeId
        && binding.operation?.taskNodeId === task.taskNodeId
        && binding.renderedCardHash === card.renderedCardHash
        && equal(binding.presentation, card.presentation)
        && equal(binding.operation, operation),
      'native operation binding mismatch',
    );
    const reRequestKeys = journal(reserved.state).refusals
      .filter(
        (refusal) => !refusal.reopened
          && prepared.descriptor.effects.some(
            (effect) => effectKey(effect) === refusal.key,
          ),
      )
      .map((refusal) => refusal.key);
    const bound = await ledger.bindOperation(
      binding,
      reserved.revision,
      nonce,
      prepared.descriptorDigest,
      prepared.candidate.id,
      reRequestKeys,
    );
    return {
      ...publicResult(prepared),
      approvalId: binding.id,
      revision: bound.revision,
    };
  }

  async function claimAutonomous(task, record, prepared, candidateId, action) {
    const id = randomUUID();
    return ledger.mutate(task.taskNodeId, record.revision, async (state) => {
      const latest = { ...record, state };
      const fresh = await scopedPreparation(
        task,
        latest,
        candidateId,
        action,
        prepared.descriptorDigest,
      );
      requireThat(
        fresh.decision === 'AUTONOMOUS_WITHIN_SCOPE'
          && state.status === 'ACTIVE'
          && !state.writer
          && !state.ticket,
        'operation cannot apply',
      );
      const gate = journal(state);
      requireThat(
        !gate.operations.some(
          (entry) => ['CLAIMED', 'STARTED', 'UNKNOWN'].includes(entry.state),
        ),
        'unresolved operation',
      );
      const maximumCost = prepared.descriptor.effects
        .filter((effect) => effect.class === 'cost')
        .reduce((total, effect) => total + effect.amount, 0);
      state.reserved += maximumCost;
      gate.operations.push({
        id,
        receiptId: state.receipt.id,
        expiresAt: state.receipt.expiresAt,
        descriptorDigest: prepared.descriptorDigest,
        descriptor: prepared.descriptor,
        maximumCost,
        state: 'CLAIMED',
      });
      return state;
    });
  }

  async function applyOperation(task, record, candidateId, action, approvalId) {
    const prepared = await prepare(task, record, candidateId, action);
    if (
      !prepared.descriptor
      || !['AUTONOMOUS_WITHIN_SCOPE', 'OWNER_APPROVAL_REQUIRED'].includes(
        prepared.decision,
      )
    ) return publicResult(prepared);
    requireThat(
      actionMatches(action, prepared.descriptor.operation, task),
      'action/candidate mismatch',
    );
    requireThat(
      ['coordination', 'snapshot-runner'].includes(prepared.descriptor.route),
      'specialist work requires existing dispatch/capacity/writer route',
    );

    let claimed;
    if (approvalId) {
      claimed = await ledger.consumeOperation(
        task.taskNodeId,
        record.revision,
        approvalId,
        prepared.descriptorDigest,
        async (current) => {
          const fresh = await scopedPreparation(
            task,
            current,
            candidateId,
            action,
            prepared.descriptorDigest,
          );
          requireThat(
            ['AUTONOMOUS_WITHIN_SCOPE', 'OWNER_APPROVAL_REQUIRED'].includes(
              fresh.decision,
            ),
            'operation no longer eligible',
          );
          return fresh;
        },
        approval.get,
        {
          now,
          pins: policy.ownerDevicePins,
          controllerDeviceId: policy.controllerDeviceId,
        },
      );
    } else {
      if (prepared.decision !== 'AUTONOMOUS_WITHIN_SCOPE') {
        return publicResult(prepared);
      }
      claimed = await claimAutonomous(
        task,
        record,
        prepared,
        candidateId,
        action,
      );
    }

    const operation = claimed.state.gate.operations.at(-1);
    let fresh;
    try {
      fresh = await scopedPreparation(
        task,
        claimed,
        candidateId,
        action,
        prepared.descriptorDigest,
      );
      requireThat(
        !claimed.state.gate.stopRequested
          && now() < task.deadline
          && now() < claimed.state.receipt.expiresAt
          && now() < operation.expiresAt,
        'stopped before use',
      );
    } catch {
      await ledger.mutateLatest(task.taskNodeId, (state) => {
        const current = journal(state).operations.find(
          (entry) => entry.id === operation.id,
        );
        requireThat(current?.state === 'CLAIMED', 'operation changed');
        current.state = 'BLOCKED';
        state.reserved -= operation.maximumCost ?? 0;
        return state;
      });
      return {
        decision: 'BLOCKED',
        reason: 'operation stopped or immutable binding changed before use',
        receiptBurned: true,
      };
    }

    let outcome;
    let started = null;
    const authorizeFirstEffect = async () => {
      requireThat(!started, 'first effect already authorized');
      const latest = await ledger.read(task.taskNodeId);
      started = await ledger.mutate(task.taskNodeId, latest.revision, async (state) => {
        requireThat(
          !state.gate.stopRequested
            && state.status === 'ACTIVE'
            && now() < task.deadline
            && now() < state.receipt.expiresAt
            && now() < operation.expiresAt
            && state.gate.operations.find(
              (entry) => entry.id === operation.id,
            )?.state === 'CLAIMED',
          'cancel/drift before first effect',
        );
        const verified = await scopedPreparation(
          task,
          { ...latest, state },
          candidateId,
          action,
          prepared.descriptorDigest,
        );
        requireThat(
          verified.descriptorDigest === prepared.descriptorDigest,
          'immutable IDs drift before first effect',
        );
        requireThat(
          now() < task.deadline
            && now() < task.hardSunset
            && now() < state.receipt.expiresAt
            && now() < operation.expiresAt,
          'authority expired during operation preflight',
        );
        state.gate.operations.find(
          (entry) => entry.id === operation.id,
        ).state = 'STARTED';
        state.status = 'OUTCOME_UNKNOWN';
        return state;
      });
      return {
        invocationId: operation.id,
        descriptorDigest: prepared.descriptorDigest,
      };
    };
    try {
      outcome = await invokeImmutable({
        task,
        descriptor: fresh.descriptor,
        descriptorDigest: fresh.descriptorDigest,
        immutable: structuredClone(fresh.immutable),
        invocationId: operation.id,
        authorizeFirstEffect,
      });
    } catch {
      outcome = null;
    }

    const confirmed = !!started
      && outcome?.confirmed === true
      && Array.isArray(outcome.immutableIds)
      && equal(outcome.immutableIds, fresh.descriptor.immutableIds)
      && Number.isSafeInteger(outcome.usage ?? 0)
      && (outcome.usage ?? 0) >= 0
      && (outcome.usage ?? 0) <= (operation.maximumCost ?? 0);
    const uncertain = !!started || outcome?.confirmed === true;
    const done = await ledger.mutateLatest(task.taskNodeId, (state) => {
      const current = journal(state).operations.find(
        (entry) => entry.id === operation.id,
      );
      requireThat(
        current && ['CLAIMED', 'STARTED'].includes(current.state),
        'operation finalization conflict',
      );
      current.state = confirmed ? 'CONFIRMED' : uncertain ? 'UNKNOWN' : 'BLOCKED';
      if (!confirmed && uncertain) {
        state.status = 'OUTCOME_UNKNOWN';
      } else {
        state.spent += confirmed ? (outcome.usage ?? 0) : 0;
        state.reserved -= operation.maximumCost ?? 0;
        if (
          confirmed
          && state.status === 'OUTCOME_UNKNOWN'
          && nativeUnknownCount(state) === nativeUnknownCount(started.state)
        ) state.status = 'ACTIVE';
      }
      state.history.push({
        kind: confirmed ? 'operation_confirmed' : 'operation_outcome_unknown',
        id: operation.id,
        result: confirmed ? outcome.result : null,
        at: now(),
      });
      return state;
    });
    return {
      decision: confirmed ? prepared.decision : 'UNKNOWN',
      observation: confirmed ? outcome.result : 'OUTCOME_UNKNOWN',
      revision: done.revision,
      descriptorDigest: prepared.descriptorDigest,
    };
  }

  async function rewrite(task, record, candidateId, action) {
    const prepared = await prepare(task, record, candidateId, action);
    if (!prepared.candidate?.saferAlternativeId) return publicResult(prepared);
    const alternate = await readCandidate({
      task,
      candidateId: prepared.candidate.saferAlternativeId,
      action,
    });
    requireThat(
      equal(alternate.intent, prepared.candidate.intent)
        && !prepared.candidate.ownerSelectedMethodChanged,
      'alternative changes Owner objective/result/method',
    );
    if (record) {
      await ledger.mutate(task.taskNodeId, record.revision, (state) => {
        const gate = journal(state);
        requireThat(
          gate.requests.filter((entry) => entry.kind === 'rewrite').length
            < state.contract.limits.attempts,
          'rewrite budget exhausted',
        );
        gate.requests.push({
          kind: 'rewrite',
          from: prepared.candidate.id,
          to: alternate.id,
          at: now(),
        });
        return state;
      });
    }
    const latest = await ledger.read(task.taskNodeId);
    const next = await prepare(task, latest, alternate.id, action);
    return {
      rewrite: {
        kind: 'PreflightRewrite',
        from: prepared.candidate.id,
        to: alternate.id,
      },
      ...publicResult(next),
    };
  }

  async function recordNotExecuted(task, record, candidateId) {
    const candidate = await readCandidate({
      task,
      candidateId,
      action: 'dispatch',
    });
    requireThat(
      candidate?.taskNodeId === task.taskNodeId
        && typeof candidate.step?.id === 'string'
        && candidate.step.id.length <= 256
        && typeof candidate.step.protective === 'boolean',
      'missing canonical step',
    );
    const prepared = await prepare(task, record, candidateId, 'dispatch');
    requireThat(
      ['BLOCKED', 'UNKNOWN', 'OWNER_APPROVAL_REQUIRED'].includes(
        prepared.decision,
      ),
      'step eligible; cannot claim omitted',
    );
    return ledger.mutate(task.taskNodeId, record.revision, (state) => {
      const gate = journal(state);
      const steps = state.history.filter(
        (entry) => entry.kind === 'gate_work_step',
      );
      requireThat(
        !gate.operations.some(
          (entry) => ['CLAIMED', 'STARTED', 'UNKNOWN'].includes(entry.state),
        )
          && !steps.some(
            (entry) => entry.candidateId === candidate.id
              || entry.stepId === candidate.step.id,
          ),
        'step already started/unresolved',
      );
      const ambiguous = steps.some(
        (entry) => typeof entry.candidateId !== 'string'
          || !entry.candidateId
          || !Object.hasOwn(entry, 'stepId')
          || (
            entry.stepId !== null
            && (typeof entry.stepId !== 'string' || !entry.stepId)
          ),
      );
      requireThat(
        gate.omissions.length < task.caps.executionGate.operationLimit
          && !gate.omissions.some((entry) => entry.id === candidate.step.id),
        'omission duplicate/limit',
      );
      gate.omissions.push({
        id: candidate.step.id,
        protective: candidate.step.protective,
        state: ambiguous ? 'EXECUTION_AMBIGUOUS' : 'NOT_EXECUTED',
        reason: prepared.decision,
      });
      return state;
    });
  }

  async function execute(task, record, args) {
    if (args.action === 'gate.cancel') return cancel(task, record);
    if (args.action === 'gate.reconcile') return reconcile(task, record);
    if (args.action === 'operation.request') {
      return request(task, record, args.candidateId, args.action);
    }
    if (['operation.apply', 'snapshot.update'].includes(args.action)) {
      return applyOperation(
        task,
        record,
        args.candidateId,
        args.action,
        args.approvalId,
      );
    }
    return rewrite(task, record, args.candidateId, args.action);
  }

  return Object.freeze({
    prepare,
    checkExisting,
    checkActivation,
    execute,
    apply: applyOperation,
    request,
    rewrite,
    recordNotExecuted,
  });
}

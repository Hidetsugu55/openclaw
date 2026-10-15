import { validateApprovalPolicy, verifyApproval } from './core/approval.js';
import { initialState, transitionInvariant, validateState } from './core/capacity.js';
import { activationEligibleObserved } from './core/lifecycle.js';
import { equal, LEDGER_SCHEMA, requireThat, scopeHash } from './contract.js';

const MAX_RECEIPTS = 128;

function blankRecord(taskNodeId, now) {
  return {
    schema: LEDGER_SCHEMA,
    taskNodeId,
    revision: 0,
    epoch: 0,
    state: null,
    approvals: {},
    activationRequests: [],
    appliedReceiptIds: [],
    blocker: null,
    createdAt: now,
    updatedAt: now,
  };
}

function validateRecord(record, taskNodeId = record?.taskNodeId) {
  requireThat(record?.schema === LEDGER_SCHEMA && record.taskNodeId === taskNodeId, 'corrupt canonical Task ledger');
  requireThat(Number.isSafeInteger(record.revision) && record.revision >= 0, 'invalid canonical Task revision');
  requireThat(Number.isSafeInteger(record.epoch) && record.epoch >= 0, 'invalid canonical Task epoch');
  requireThat(record.approvals && typeof record.approvals === 'object' && !Array.isArray(record.approvals), 'invalid approval tombstones');
  requireThat(Object.keys(record.approvals).length <= MAX_RECEIPTS, 'approval tombstone capacity exceeded');
  requireThat(Array.isArray(record.activationRequests) && Array.isArray(record.appliedReceiptIds), 'invalid authority journals');
  requireThat(record.activationRequests.length <= MAX_RECEIPTS && record.appliedReceiptIds.length <= MAX_RECEIPTS, 'authority journal capacity exceeded');
  if (record.state) validateState(record.state);
  return structuredClone(record);
}

export function createLedger(store, now = Date.now) {
  requireThat(store && typeof store.registerIfAbsent === 'function' && typeof store.lookup === 'function', 'native keyed authority store unavailable');
  requireThat(typeof store.observe === 'function' && typeof store.compareAndApply === 'function' && typeof store.withCurrent === 'function', 'native keyed CAS authority unavailable');

  function bound(assertCurrent) {
    requireThat(typeof assertCurrent === 'function', 'current authority assertion unavailable');
    assertCurrent();
    return store.withCurrent({ assertCurrent });
  }

  async function ensure(taskNodeId, assertCurrent) {
    const current = bound(assertCurrent);
    const initial = blankRecord(taskNodeId, now());
    await current.registerIfAbsent(taskNodeId, initial);
    return validateRecord(await current.lookup(taskNodeId), taskNodeId);
  }

  async function observe(taskNodeId, assertCurrent) {
    const current = bound(assertCurrent);
    const observed = await current.observe(taskNodeId);
    return { current, observed, record: observed.value ? validateRecord(observed.value, taskNodeId) : null };
  }

  async function apply(taskNodeId, observed, current, next, assertCurrent, advanceRevision = true) {
    assertCurrent();
    next.schema = LEDGER_SCHEMA;
    next.taskNodeId = taskNodeId;
    next.revision = current.revision + (advanceRevision ? 1 : 0);
    next.createdAt = current.createdAt;
    next.updatedAt = now();
    validateRecord(next, taskNodeId);
    const result = await bound(assertCurrent).compareAndApply(taskNodeId, observed.comparison, { operation: 'update', action: 'set', value: next });
    requireThat(result.status === 'applied', 'canonical Task revision conflict');
    return validateRecord(next, taskNodeId);
  }

  async function read(taskNodeId, assertCurrent) {
    requireThat(typeof taskNodeId === 'string' && taskNodeId.length > 0, 'invalid canonical Task id');
    const value = await bound(assertCurrent).lookup(taskNodeId);
    return value ? validateRecord(value, taskNodeId) : null;
  }

  async function requestActivation(contract, card, send, nativeGet, clock, prepareCard, assertCurrent) {
    requireThat(contract.taskNodeId === card.taskNodeId && card.activation, 'activation card mismatch');
    await ensure(contract.taskNodeId, assertCurrent);
    let snapshot = await observe(contract.taskNodeId, assertCurrent);
    const current = snapshot.record;
    requireThat(activationEligibleObserved(current.state), 'Task already active or old resources unresolved');
    requireThat(card.activation.epoch === current.epoch + 1 && card.activation.expectedRevision === current.revision, 'activation epoch/preimage mismatch');
    requireThat(current.activationRequests.length < Math.min(MAX_RECEIPTS, contract.caps.executionGate?.operationLimit ?? MAX_RECEIPTS), 'Owner activation request budget exhausted');
    const unresolved = current.activationRequests.find((entry) => entry.state !== 'closed');
    if (unresolved) {
      requireThat(unresolved.id, 'activation request outcome UNKNOWN; no blind retry');
      const approval = current.approvals[unresolved.id];
      requireThat(approval, 'activation request outcome UNKNOWN');
      if (approval.state === 'requested') {
        const native = await nativeGet(unresolved.id);
        if (native?.status === 'pending' || native?.status === 'allowed') {
          requireThat(unresolved.epoch === card.activation.epoch && unresolved.scopeHash === card.scopeHash && unresolved.revisionHash === card.revisionHash, 'existing Owner decision unresolved; no new request');
          return approval.binding;
        }
      }
      requireThat(false, 'sticky activation refusal/expiry; new Owner scope required');
    }
    const reservation = {
      state: 'reserved', id: null, epoch: card.activation.epoch,
      preimage: card.activation.expectedRevision, scopeHash: card.scopeHash,
      revisionHash: card.revisionHash, renderedCardHash: card.renderedCardHash,
    };
    const reserved = structuredClone(current);
    reserved.activationRequests.push(reservation);
    reserved.blocker = 'OWNER_APPROVAL_PENDING';
    const reservedRecord = await apply(contract.taskNodeId, snapshot.observed, current, reserved, assertCurrent, false);

    let binding;
    try {
      binding = await send(card);
    } catch (error) {
      snapshot = await observe(contract.taskNodeId, assertCurrent);
      if (snapshot.record.revision === reservedRecord.revision) {
        const failed = structuredClone(snapshot.record);
        const entry = failed.activationRequests.at(-1);
        if (error?.code === 'APPROVAL_NOT_SENT') {
          entry.state = 'closed'; entry.reason = 'not_sent'; failed.blocker = 'OWNER_APPROVAL_NOT_SENT';
        } else {
          failed.blocker = 'OWNER_APPROVAL_REQUEST_OUTCOME_UNKNOWN';
        }
        await apply(contract.taskNodeId, snapshot.observed, snapshot.record, failed, assertCurrent, false).catch(() => undefined);
      }
      throw error;
    }

    snapshot = await observe(contract.taskNodeId, assertCurrent);
    requireThat(snapshot.record.revision === reservedRecord.revision, 'approval binding revision conflict; outcome UNKNOWN');
    const next = structuredClone(snapshot.record);
    const entry = next.activationRequests.at(-1);
    requireThat(entry.state === 'reserved' && !entry.id && !next.approvals[binding.id], 'approval binding conflict');
    entry.state = 'bound'; entry.id = binding.id;
    next.approvals[binding.id] = { state: 'requested', binding: structuredClone(binding) };
    next.blocker = 'OWNER_DECISION_REQUIRED';
    await apply(contract.taskNodeId, snapshot.observed, snapshot.record, next, assertCurrent, false);
    return binding;
  }

  async function activate(contract, approvalId, expectedRevision, nativeGet, policy, assertCurrent) {
    const first = await observe(contract.taskNodeId, assertCurrent);
    const current = first.record;
    requireThat(current?.revision === expectedRevision, 'canonical Task revision conflict');
    requireThat(activationEligibleObserved(current.state), 'Task already active or old resources unresolved');
    const approval = current.approvals[approvalId];
    requireThat(approval?.state === 'requested', 'approval spent or unknown');
    const binding = approval.binding;
    requireThat(binding.purpose === 'activation' && binding.taskNodeId === contract.taskNodeId && binding.scopeHash === scopeHash(contract) && binding.revisionHash === contract.revisionHash, 'approval binding mismatch');
    requireThat(binding.activation?.epoch === current.epoch + 1 && binding.activation.expectedRevision === expectedRevision, 'activation epoch/preimage mismatch');
    validateApprovalPolicy(contract, policy);
    const native = await nativeGet(approvalId);
    const clock = typeof policy.now === 'function' ? policy.now() : policy.now;
    if (native?.status === 'denied' || native?.status === 'expired' || clock >= binding.expiresAt) {
      const latest = await observe(contract.taskNodeId, assertCurrent);
      if (latest.record.revision === current.revision) {
        const burned = structuredClone(latest.record);
        burned.approvals[approvalId].state = 'burned';
        burned.approvals[approvalId].reason = native?.status === 'denied' ? 'refusal' : 'expiry';
        burned.activationRequests.find((entry) => entry.id === approvalId).state = 'closed';
        burned.blocker = 'OWNER_APPROVAL_REFUSED_OR_EXPIRED';
        await apply(contract.taskNodeId, latest.observed, latest.record, burned, assertCurrent, false);
      }
      throw new Error('Owner activation refused or expired');
    }
    requireThat(native?.status === 'allowed', 'Owner approval still pending or UNKNOWN');
    const receipt = verifyApproval(native, binding, contract, { ...policy, now: clock });
    if (policy.ownerOrigin) {
      requireThat(JSON.stringify(binding.activation?.ownerOrigin) === JSON.stringify(policy.ownerOrigin), 'Owner origin receipt mismatch');
      receipt.ownerOrigin = structuredClone(policy.ownerOrigin);
    }
    const latest = await observe(contract.taskNodeId, assertCurrent);
    requireThat(latest.record.revision === current.revision && latest.record.approvals[approvalId]?.state === 'requested', 'approval/revision changed before spend');
    const activated = structuredClone(latest.record);
    const state = initialState(contract, receipt);
    if (current.state) {
      requireThat(
        current.state.writer === null
          && current.state.ticket === null
          && current.state.reserved === 0
          && current.state.cleanup !== 'pending',
        'old resources unresolved',
      );
      const previous = current.state.contract;
      requireThat(
        [
          'taskNodeId', 'repo', 'ref', 'head', 'root', 'phase', 'role',
          'actionClass', 'originatingSession', 'hardSunset',
        ].every((key) => contract[key] === previous[key])
          && contract.deadline >= previous.deadline
          && contract.limits.attempts >= current.state.attempts
          && contract.limits.budget >= current.state.spent
          && contract.limits.resumes >= current.state.resumes,
        'invalid reauthorization',
      );
      if (current.state.gate?.stopRequested) {
        requireThat(
          binding.activation?.previousStopRequested === true
            && binding.activation?.clearsStop === true,
          'stop clearance requires explicit activation card',
        );
      }
      for (const key of [
        'attempts', 'spent', 'resumes', 'history', 'notifications', 'snapshot',
        'lastConfirmedHead', 'lastConfirmedPhase', 'burnedSessionKeys', 'gate',
      ]) {
        if (current.state[key] !== undefined) state[key] = structuredClone(current.state[key]);
      }
      if (state.gate) {
        state.gate.stopRequested = false;
        for (const refusal of state.gate.refusals) {
          if (contract.caps.executionGate?.reopenKeys?.includes(refusal.key)) {
            refusal.reopened = true;
          }
        }
      }
    }
    if (binding.activation?.executionGate) {
      state.gate ??= {
        operations: [],
        refusals: [],
        omissions: [],
        requests: [],
        stopRequested: false,
      };
      state.gate.activeBinding = structuredClone(binding.activation.executionGate);
    } else if (state.gate?.activeBinding) {
      delete state.gate.activeBinding;
    }
    state.status = 'ACTIVE';
    activated.state = state;
    activated.epoch = current.epoch + 1;
    activated.approvals[approvalId].state = 'spent';
    activated.appliedReceiptIds.push(approvalId);
    activated.activationRequests.find((entry) => entry.id === approvalId).state = 'closed';
    activated.blocker = null;
    return apply(contract.taskNodeId, latest.observed, latest.record, activated, assertCurrent);
  }

  async function mutate(taskNodeId, expectedRevision, reducer, assertCurrent) {
    const snapshot = await observe(taskNodeId, assertCurrent);
    const current = snapshot.record;
    requireThat(current?.state && current.revision === expectedRevision, 'canonical Task revision conflict');
    const next = structuredClone(current);
    next.state = await reducer(structuredClone(current.state));
    transitionInvariant(current.state, next.state);
    return apply(taskNodeId, snapshot.observed, current, next, assertCurrent);
  }

  async function mutateLatest(taskNodeId, reducer, assertCurrent) {
    const snapshot = await observe(taskNodeId, assertCurrent);
    const current = snapshot.record;
    requireThat(current?.state, 'missing canonical Task');
    const next = structuredClone(current);
    next.state = await reducer(structuredClone(current.state), structuredClone(current));
    transitionInvariant(current.state, next.state);
    return apply(taskNodeId, snapshot.observed, current, next, assertCurrent);
  }

  async function bindOperation(
    binding,
    expectedRevision,
    nonce,
    descriptorDigest,
    candidateId,
    reRequestKeys,
    assertCurrent,
  ) {
    requireThat(
      binding?.purpose === 'operation'
        && typeof binding.id === 'string'
        && typeof binding.taskNodeId === 'string'
        && binding.taskNodeId === binding.operation?.taskNodeId
        && /^[a-f0-9]{64}$/.test(binding.renderedCardHash),
      'invalid operation approval binding',
    );
    const snapshot = await observe(binding.taskNodeId, assertCurrent);
    const current = snapshot.record;
    requireThat(
      current?.state
        && current.revision === expectedRevision
        && current.state.status === 'OUTCOME_UNKNOWN'
        && !current.approvals[binding.id],
      'approval already bound, Task missing, or reservation changed',
    );
    const next = structuredClone(current);
    const gate = gateJournal(next.state);
    requireThat(
      gate.requests.some(
        (entry) => entry.kind === 'request_reserved'
          && entry.id === nonce
          && entry.descriptorDigest === descriptorDigest,
      )
        && !gate.requests.some(
          (entry) => entry.kind === 'request_bound' && entry.nonce === nonce,
        ),
      'operation approval reservation mismatch',
    );
    next.approvals[binding.id] = { state: 'requested', binding: structuredClone(binding) };
    next.state.status = 'ACTIVE';
    gate.requests.push({
      kind: 'request_bound',
      nonce,
      id: binding.id,
      descriptorDigest,
      candidateId,
      reRequestKeys: [...reRequestKeys],
      at: now(),
    });
    for (const refusal of gate.refusals) {
      if (reRequestKeys.includes(refusal.key)) refusal.reRequests += 1;
    }
    return apply(binding.taskNodeId, snapshot.observed, current, next, assertCurrent);
  }

  function gateJournal(state) {
    return state.gate ??= {
      operations: [],
      refusals: [],
      omissions: [],
      requests: [],
      stopRequested: false,
    };
  }

  async function observeOperation(taskNodeId, expectedRevision, approvalId, nativeGet, clock, assertCurrent) {
    const snapshot = await observe(taskNodeId, assertCurrent);
    const current = snapshot.record;
    requireThat(current?.state && current.revision === expectedRevision, 'canonical Task revision conflict');
    const approval = current.approvals[approvalId];
    requireThat(
      approval?.binding?.purpose === 'operation'
        && approval.binding.taskNodeId === taskNodeId,
      'operation request mismatch',
    );
    if (approval.state !== 'requested') return { state: approval.state };

    const operation = approval.binding.operation;
    const next = structuredClone(current);
    const gate = gateJournal(next.state);
    if (
      operation.epoch !== current.epoch
      || operation.contractRevision !== current.state.contract.revisionHash
      || operation.scopeHash !== current.state.scopeHash
    ) {
      gate.requests.push({ kind: 'request_closed', id: approvalId, reason: 'epoch_superseded' });
      next.approvals[approvalId].state = 'burned';
      await apply(taskNodeId, snapshot.observed, current, next, assertCurrent);
      return { state: 'burned' };
    }

    const native = await nativeGet(approvalId);
    if (
      !['denied', 'expired'].includes(native?.status)
      && clock < approval.binding.expiresAt
    ) {
      return {
        state: 'requested',
        status: ['allowed', 'pending'].includes(native?.status) ? native.status : 'UNKNOWN',
      };
    }
    const reason = native?.status === 'denied' ? 'refusal' : 'expiry';
    for (const effect of operation.descriptor.effects) {
      gate.refusals.push({
        key: JSON.stringify([effect.class, effect.target, effect.category]),
        amount: effect.amount,
        reason,
        descriptorDigest: operation.descriptorDigest,
        reRequests: 0,
        reopened: false,
      });
    }
    gate.requests.push({ kind: 'request_closed', id: approvalId, reason });
    next.approvals[approvalId].state = 'burned';
    next.approvals[approvalId].reason = reason;
    await apply(taskNodeId, snapshot.observed, current, next, assertCurrent);
    return { state: 'burned' };
  }

  async function consumeOperation(
    taskNodeId,
    expectedRevision,
    approvalId,
    expectedDigest,
    prepare,
    nativeGet,
    policy,
    assertCurrent,
  ) {
    const snapshot = await observe(taskNodeId, assertCurrent);
    const current = snapshot.record;
    const approval = current?.approvals[approvalId];
    requireThat(approval?.state === 'requested' && approval.binding?.purpose === 'operation', 'not an unused operation approval');
    requireThat(current.revision === expectedRevision, 'canonical Task revision conflict');
    validateApprovalPolicy(current.state.contract, policy);

    const operation = approval.binding.operation;
    requireThat(
      operation?.taskNodeId === taskNodeId
        && operation.epoch === current.epoch
        && operation.contractRevision === current.state.contract.revisionHash
        && operation.scopeHash === current.state.scopeHash
        && operation.descriptorDigest === expectedDigest,
      'operation Task/epoch/digest mismatch',
    );
    const prepared = await prepare(structuredClone(current));
    requireThat(
      prepared.descriptorDigest === expectedDigest
        && equal(prepared.descriptor, operation.descriptor),
      'operation descriptor drift; not consumed',
    );

    const native = await nativeGet(approvalId);
    const clock = typeof policy.now === 'function' ? policy.now() : policy.now;
    const next = structuredClone(current);
    const gate = gateJournal(next.state);
    const refuse = async (reason, error) => {
      for (const effect of operation.descriptor.effects) {
        gate.refusals.push({
          key: JSON.stringify([effect.class, effect.target, effect.category]),
          amount: effect.amount,
          reason: reason === 'invalid_native_answer' ? 'refusal' : reason,
          descriptorDigest: expectedDigest,
          reRequests: reason === 'invalid_native_answer' ? 1 : 0,
          reopened: false,
        });
      }
      gate.requests.push({ kind: 'request_closed', id: approvalId, reason });
      next.approvals[approvalId].state = 'burned';
      next.approvals[approvalId].reason = reason;
      await apply(taskNodeId, snapshot.observed, current, next, assertCurrent);
      throw error;
    };

    if (native?.status === 'denied' || native?.status === 'expired' || clock >= approval.binding.expiresAt) {
      const reason = native?.status === 'denied' ? 'refusal' : 'expiry';
      return refuse(reason, new Error('Owner refusal/expiry recorded'));
    }

    let receipt;
    try {
      requireThat(native?.status === 'allowed', 'Owner decision pending or UNKNOWN; not consumed');
      receipt = verifyApproval(native, approval.binding, current.state.contract, { ...policy, now: clock });
    } catch (error) {
      if (native?.status !== 'allowed') throw error;
      return refuse('invalid_native_answer', error);
    }

    requireThat(
      current.state.status === 'ACTIVE'
        && !current.state.writer
        && !current.state.ticket
        && !current.state.gate?.stopRequested
        && clock < current.state.contract.deadline
        && clock < current.state.contract.hardSunset
        && clock < current.state.receipt.expiresAt,
      'Task cannot apply operation',
    );
    const maximumCost = prepared.descriptor.effects
      .filter((effect) => effect.class === 'cost')
      .reduce((total, effect) => total + effect.amount, 0);
    requireThat(
      current.state.spent + current.state.reserved + maximumCost <= current.state.contract.limits.budget
        && current.state.attempts < current.state.contract.limits.attempts
        && gate.operations.length < current.state.contract.caps.executionGate.operationLimit,
      'Task limits require new activation',
    );
    requireThat(
      !gate.operations.some((operationEntry) => ['CLAIMED', 'STARTED', 'UNKNOWN'].includes(operationEntry.state)),
      'unresolved operation',
    );
    next.state.reserved += maximumCost;
    gate.operations.push({
      id: approvalId,
      descriptorDigest: expectedDigest,
      descriptor: prepared.descriptor,
      receiptId: approvalId,
      expiresAt: receipt.expiresAt,
      maximumCost,
      state: 'CLAIMED',
    });
    gate.requests.push({ kind: 'request_closed', id: approvalId, reason: 'consumed' });
    next.approvals[approvalId].state = 'spent';
    next.appliedReceiptIds.push(approvalId);
    return apply(taskNodeId, snapshot.observed, current, next, assertCurrent);
  }

  return Object.freeze({
    read,
    requestActivation,
    activate,
    mutate,
    mutateLatest,
    bindOperation,
    observeOperation,
    consumeOperation,
  });
}

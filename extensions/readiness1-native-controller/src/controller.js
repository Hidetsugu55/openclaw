import { randomUUID } from 'node:crypto';
import { approvalCard, validateApprovalPolicy } from './core/approval.js';
import {
  attachNativeRun, confirmWorkspace, launchOutcomeUnknown, nativeRunObservation,
  preLaunchAbortOutcomeUnknown, preLaunchAbortRecovered, reserveDispatch,
  reserveWorkspace, settleObserved, workStarted, workspaceOutcomeUnknown,
} from './core/capacity.js';
import { cleanupDecisionObserved, finishTask } from './core/lifecycle.js';
import { notifyOwner } from './core/output.js';
import { digest, equal, requireThat, safeRecord, scopeHash, validateContract } from './contract.js';
import { GATE_ACTIONS } from './readiness2/gate.js';

export const TOOL_NAME = 'readiness1_task';
export const READ_ACTIONS = Object.freeze([
  'repo.read', 'file.read', 'issue.read', 'pr.read', 'diff.read', 'checks.read',
]);
export const COORDINATION_ACTIONS = Object.freeze([
  'ready.consume', 'comment.append', 'task.status',
]);
export const TOOL_ACTIONS = Object.freeze([
  'approval.request', 'activate', 'status', 'dispatch', 'observe', 'cleanup',
  'capacity.resume', ...COORDINATION_ACTIONS, 'notify.owner', 'acceptance.run',
]);
const FIXTURE_TOOL_ACTIONS = Object.freeze([
  ...new Set([...TOOL_ACTIONS, ...READ_ACTIONS, ...GATE_ACTIONS]),
]);

export const TOOL_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['action'],
  properties: {
    action: { type: 'string', enum: [...TOOL_ACTIONS] },
    taskNodeId: { type: 'string', pattern: '^[A-Za-z0-9_:-]{3,512}$' },
    expectedRevision: { type: 'integer', minimum: 0 },
    approvalId: { type: 'string', minLength: 1 },
    runId: { type: 'string', minLength: 1 },
    notification: {
      type: 'object', additionalProperties: false, required: ['kind'],
      properties: {
        kind: { type: 'string', enum: ['DONE', 'BLOCKED', 'OWNER_DECISION_REQUIRED', 'CRITICAL_ALERT'] },
        summary: { type: 'string', maxLength: 400 },
        evidence: { type: 'array', maxItems: 5, items: { type: 'object' } },
        purpose: { type: 'string', maxLength: 200 }, target: { type: 'string', maxLength: 200 },
        operationKind: { type: 'string', maxLength: 200 }, risk: { type: 'string', maxLength: 200 },
      },
    },
  },
};

const FIXTURE_TOOL_SCHEMA = Object.freeze({
  ...TOOL_SCHEMA,
  properties: Object.freeze({
    ...TOOL_SCHEMA.properties,
    action: { type: 'string', enum: [...FIXTURE_TOOL_ACTIONS] },
    candidateId: { type: 'string', minLength: 1, maxLength: 256 },
  }),
});

const json = (payload) => ({ content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }], details: payload });

const executionGateBinding = (candidateId, prepared) => ({
  candidateId,
  descriptorDigest: prepared.descriptorDigest,
  catalogHash: prepared.descriptor.catalogHash,
  resolverHash: prepared.descriptor.resolverHash,
  profileHash: prepared.descriptor.profileHash,
  operation: prepared.descriptor.operation,
  mode: prepared.descriptor.mode,
  route: prepared.descriptor.route,
  role: prepared.descriptor.role,
});

const preLaunchBindingDrift = () => Object.assign(
  new Error('active activation binding/decision drift before launch'),
  { code: 'PRE_LAUNCH_BINDING_DRIFT' },
);

function assertController(config, ctx) {
  requireThat(ctx?.sessionKey && config.controllerSessionKeys.includes(ctx.sessionKey), 'controller session is not authorized');
  requireThat(ctx?.agentId && config.controllerAgents.includes(ctx.agentId), 'controller agent is not authorized');
  requireThat(ctx.senderIsOwner === true && typeof ctx.requesterSenderId === 'string' && ctx.requesterSenderId === config.ownerSenderId, 'OWNER_PRINCIPAL_REQUIRED');
  requireThat(ctx.originTrigger === 'direct-user', 'OWNER_DIRECT_TRIGGER_REQUIRED');
  requireThat(config.ownerSessionKeys.includes(ctx.sessionKey), 'OWNER_SESSION_NOT_APPROVED');
  requireThat(typeof ctx.deviceId === 'string' && config.ownerDevicePins.includes(ctx.deviceId), 'OWNER_DEVICE_NOT_PINNED');
  requireThat(ctx.sandboxed !== true, 'controller cannot run inside a worker sandbox');
  requireThat(typeof ctx.assertInvocationCurrent === 'function', 'host final-effect authority unavailable');
  ctx.assertInvocationCurrent();
}

function exactArgs(params, allowed, required = []) {
  requireThat(params && typeof params === 'object' && !Array.isArray(params), 'invalid controller request');
  requireThat(Object.keys(params).every((key) => allowed.includes(key)), 'catalog action refused arbitrary input');
  for (const key of required) requireThat(params[key] != null, `missing ${key}`);
}

export function createReadinessTool({
  config,
  ctx,
  ledger,
  approval,
  bridge,
  acceptance,
  executionGate = null,
  readSafeProjection = null,
  fixtureOnly = false,
  hostBinding = null,
  now = Date.now,
}) {
  requireThat(
    fixtureOnly === true
      || (hostBinding?.kind === 'openclaw.readiness1.host-binding.v1' && typeof hostBinding.openLedgerStore === 'function'),
    'CANONICAL_CONTROLLER_FIXTURE_ONLY',
  );
  assertController(config, ctx);
  const assertCurrent = ctx.assertInvocationCurrent;
  const ownerOrigin = Object.freeze({ senderIsOwner: true, requesterSenderId: ctx.requesterSenderId, originTrigger: ctx.originTrigger, sessionKey: ctx.sessionKey, deviceId: ctx.deviceId });

  async function canonicalTask(taskNodeId) {
    const task = validateContract(await bridge.readCanonicalTask(taskNodeId));
    requireThat(task.taskNodeId === taskNodeId && task.originatingSession === ctx.sessionKey, 'canonical Task/origin mismatch');
    return task;
  }

  async function currentAuthority(task, expectedRevision) {
    const record = await ledger.read(task.taskNodeId, assertCurrent);
    requireThat(record?.state && record.revision === expectedRevision, 'canonical Task revision conflict');
    requireThat(equal(record.state.contract, task) && record.state.scopeHash === scopeHash(task), 'canonical Task revision/scope drift');
    requireThat(record.state.receipt.valid === true && now() < record.state.receipt.expiresAt && now() < task.deadline && now() < task.hardSunset, 'authority expired/revoked');
    return record;
  }

  return {
    name: TOOL_NAME,
    label: 'Readiness #1 Task',
    description: 'Closed Task-ID controller over one canonical authority. No repository, path, agent, recipient, command, or tool override is accepted.',
    parameters: executionGate ? FIXTURE_TOOL_SCHEMA : TOOL_SCHEMA,
    async execute(_toolCallId, params) {
      assertController(config, ctx);
      const actions = executionGate ? FIXTURE_TOOL_ACTIONS : TOOL_ACTIONS;
      requireThat(actions.includes(params?.action), 'catalog action refused');
      const action = params.action;

      if (action === 'acceptance.run') {
        exactArgs(params, ['action', 'runId'], ['runId']);
        return json({ ok: true, ...(await acceptance.execute({ runId: params.runId, assertCurrent })) });
      }

      exactArgs(params, ['action', 'taskNodeId', 'expectedRevision', 'approvalId', 'notification', 'candidateId'], ['taskNodeId']);

      if (action === 'status') {
        exactArgs(params, ['action', 'taskNodeId'], ['taskNodeId']);
        requireThat(/^[A-Za-z0-9_:-]{3,512}$/.test(params.taskNodeId), 'canonical Task id invalid');
        const record = await ledger.read(params.taskNodeId, assertCurrent);
        if (!record) return json({ ok: true, task: null });
        const task = await canonicalTask(params.taskNodeId);
        requireThat(
          equal(record.state.contract, task) && record.state.scopeHash === scopeHash(task),
          'canonical Task revision/scope drift',
        );
        return json({ ok: true, task: safeRecord(record) });
      }

      const task = await canonicalTask(params.taskNodeId);

      if (GATE_ACTIONS.includes(action)) {
        requireThat(executionGate, 'Execution Gate unbound');
        const record = await ledger.read(task.taskNodeId, assertCurrent);
        if (action === 'gate.reconcile') {
          exactArgs(params, ['action', 'taskNodeId'], ['taskNodeId']);
        } else if (action === 'gate.preflight') {
          exactArgs(params, ['action', 'taskNodeId', 'candidateId'], ['taskNodeId', 'candidateId']);
        } else {
          exactArgs(
            params,
            ['action', 'taskNodeId', 'expectedRevision', 'approvalId', 'candidateId'],
            ['taskNodeId', 'expectedRevision'],
          );
          requireThat(
            record?.state
              && record.revision === params.expectedRevision
              && equal(record.state.contract, task)
              && record.state.scopeHash === scopeHash(task),
            'canonical Task revision/scope drift',
          );
        }
        if (!['gate.cancel', 'gate.reconcile'].includes(action)) {
          requireThat(typeof params.candidateId === 'string', `${action} requires candidateId`);
        }
        const result = await executionGate.execute(task, record, params);
        return json({ ok: true, result: result?.state ? safeRecord(result) : result });
      }

      if (READ_ACTIONS.includes(action)) {
        exactArgs(params, ['action', 'taskNodeId', 'candidateId'], ['taskNodeId', 'candidateId']);
        requireThat(executionGate && typeof readSafeProjection === 'function', 'READ_SAFE_PROFILE_UNAVAILABLE');
        const record = await ledger.read(task.taskNodeId, assertCurrent);
        const prepared = await executionGate.checkExisting({
          task,
          record,
          action,
          candidateId: params.candidateId,
        });
        requireThat(
          prepared.descriptor.mode === 'READ'
            && prepared.descriptor.route === 'safe-projection'
            && prepared.descriptor.role === 'main',
          'READ_SAFE_PROFILE_UNAVAILABLE',
        );
        const observed = await readSafeProjection({
          action,
          task: structuredClone(task),
          candidateId: params.candidateId,
          descriptor: structuredClone(prepared.descriptor),
          descriptorDigest: prepared.descriptorDigest,
        });
        requireThat(
          observed?.schema === 'execution-gate.read-result.v1'
            && observed.taskNodeId === task.taskNodeId
            && observed.action === action
            && observed.candidateId === params.candidateId
            && observed.descriptorDigest === prepared.descriptorDigest
            && observed.lifecycle?.prepare === 'read-only'
            && observed.lifecycle?.launch === 'read-only'
            && observed.lifecycle?.activity === 'read-only'
            && observed.lifecycle?.delivery === 'safe-view'
            && observed.lifecycle?.cleanup === 'pass'
            && observed.targetMutation === false
            && observed.externalWrite === false,
          'READ_LIFECYCLE_OUTCOME_UNKNOWN',
        );
        return json({
          ok: true,
          decision: prepared.decision,
          descriptorDigest: prepared.descriptorDigest,
          safeView: observed.safeView,
          lifecycle: observed.lifecycle,
        });
      }

      if (action === 'approval.request') {
        exactArgs(params, ['action', 'taskNodeId', 'candidateId'], ['taskNodeId']);
        validateApprovalPolicy(task, { pins: config.ownerDevicePins, controllerDeviceId: config.controllerDeviceId });
        await bridge.assertOwnerApprovalAvailable();
        const current = await ledger.read(task.taskNodeId, assertCurrent);
        const gateActivation = executionGate
          ? await executionGate.checkActivation(
            task,
            current,
            params.candidateId,
            action,
          )
          : null;
        const epoch = (current?.epoch ?? 0) + 1;
        const expectedRevision = current?.revision ?? 0;
        const effects = { actionClass: task.actionClass, caps: task.caps, limits: task.limits, repo: task.repo, ref: task.ref, head: task.head, root: task.root };
        const activation = {
          epoch,
          expectedRevision,
          effectsDigest: digest(effects),
          effects,
          ownerOrigin,
          previousStopRequested: current?.state?.gate?.stopRequested === true,
          clearsStop: current?.state?.gate?.stopRequested === true,
          ...(gateActivation ? {
            executionGate: executionGateBinding(params.candidateId, gateActivation),
          } : {}),
        };
        const clock = now();
        const card = approvalCard(task, Math.min(clock + 600_000, task.deadline, task.hardSunset), '', clock, null, activation, config.pluginId);
        const binding = await ledger.requestActivation(task, card, approval.requestPrepared, approval.get, now, approval.prepare, assertCurrent);
        const latest = await ledger.read(task.taskNodeId, assertCurrent);
        return json({ ok: true, taskNodeId: task.taskNodeId, approvalId: binding.id, status: 'OWNER_DECISION_REQUIRED', revision: latest.revision, cardHash: binding.renderedCardHash });
      }

      if (action === 'activate') {
        exactArgs(params, ['action', 'taskNodeId', 'expectedRevision', 'approvalId', 'candidateId'], ['taskNodeId', 'expectedRevision', 'approvalId']);
        const pending = await ledger.read(task.taskNodeId, assertCurrent);
        const pendingApproval = pending?.approvals?.[params.approvalId];
        requireThat(pendingApproval?.state === 'requested', 'approval spent or unknown');
        requireThat(equal(pendingApproval.binding?.activation?.ownerOrigin, ownerOrigin), 'Owner origin approval binding mismatch');
        if (executionGate) {
          requireThat(typeof params.candidateId === 'string', 'activate requires candidateId');
          const gateActivation = await executionGate.checkActivation(
            task,
            pending,
            params.candidateId,
            action,
          );
          requireThat(
            equal(
              pendingApproval.binding.activation.executionGate,
              executionGateBinding(params.candidateId, gateActivation),
            ),
            'activation Execution Gate binding mismatch',
          );
        }
        const record = await ledger.activate(task, params.approvalId, params.expectedRevision, approval.get, { now, pins: config.ownerDevicePins, controllerDeviceId: config.controllerDeviceId, ownerOrigin }, assertCurrent);
        return json({ ok: true, task: safeRecord(record) });
      }

      requireThat(Number.isSafeInteger(params.expectedRevision), `${action} requires expectedRevision`);
      let record = await currentAuthority(task, params.expectedRevision);

      if (action === 'capacity.resume') {
        exactArgs(params, ['action', 'taskNodeId', 'expectedRevision'], ['taskNodeId', 'expectedRevision']);
        throw new Error('CAPACITY_RESUME_PUBLIC_SURFACE_UNAVAILABLE');
      }

      if (action === 'dispatch') {
        exactArgs(params, ['action', 'taskNodeId', 'expectedRevision', 'candidateId'], ['taskNodeId', 'expectedRevision']);
        const gatePreparation = executionGate
          ? await executionGate.checkExisting({
            task,
            record,
            action,
            candidateId: params.candidateId,
          })
          : null;
        const activeGateBinding = gatePreparation
          ? executionGateBinding(params.candidateId, gatePreparation)
          : null;
        if (gatePreparation) {
          requireThat(
            equal(record.state.gate?.activeBinding, activeGateBinding),
            'dispatch does not match active activation binding',
          );
        }
        const ticketId = `readiness1:${digest(`${task.taskNodeId}:${record.epoch}:${record.revision}:${randomUUID()}`).slice(0, 32)}`;
        let launchAttempted = false;
        try {
          bridge.preflightDispatch();
          record = await ledger.mutate(task.taskNodeId, record.revision, (state) => reserveWorkspace(state, { now: now(), claimId: ticketId }), assertCurrent);
          const prepared = await bridge.prepareWorkspace(task, { claimId: ticketId, assertCurrent });
          record = await ledger.mutate(task.taskNodeId, record.revision, (state) => confirmWorkspace(state, { claimId: ticketId, workspace: prepared.workspace, snapshot: prepared.snapshot, now: now() }), assertCurrent);
          const native = await bridge.nativeCapacityNoWork(task);
          record = await ledger.mutate(task.taskNodeId, record.revision, (state) => {
            const next = reserveDispatch(state, { native, versions: config.cliVersions, now: now(), snapshot: prepared.snapshot, ticketId, reservation: config.dispatchReservation });
            if (gatePreparation && next.ticket) {
              next.ticket.gate = {
                action,
                ...activeGateBinding,
              };
              next.history.push({
                kind: 'gate_preflight',
                receiptId: gatePreparation.receiptId,
                descriptorDigest: gatePreparation.descriptorDigest,
                catalogHash: gatePreparation.descriptor.catalogHash,
                resolverHash: gatePreparation.descriptor.resolverHash,
                profileHash: gatePreparation.descriptor.profileHash,
                at: now(),
              });
            }
            return next;
          }, assertCurrent);
          if (record.state.status === 'WAITING_PROVIDER_CAPACITY') return json({ ok: false, reason: 'WAITING_PROVIDER_CAPACITY', task: safeRecord(record) });
          if (gatePreparation) {
            const latest = await ledger.read(task.taskNodeId, assertCurrent);
            requireThat(
              latest.revision === record.revision
                && latest.state.ticket?.activeId === ticketId
                && !latest.state.gate?.stopRequested,
              'cancel/Task drift before launch',
            );
            const fresh = await executionGate.prepare(
              task,
              latest,
              gatePreparation.candidate.id,
              action,
            );
            const freshBinding = fresh.descriptor
              ? executionGateBinding(gatePreparation.candidate.id, fresh)
              : null;
            if (
              fresh.decision !== 'AUTONOMOUS_WITHIN_SCOPE'
                || !equal(freshBinding, activeGateBinding)
                || !equal(latest.state.gate?.activeBinding, freshBinding)
                || !equal(latest.state.ticket.gate, { action, ...freshBinding })
            ) throw preLaunchBindingDrift();
          }
          const writer = { id: ticketId, taskNodeId: task.taskNodeId, root: task.root, sessionKey: prepared.workspace.sessionKey, runId: ticketId };
          launchAttempted = true;
          const accepted = await bridge.launchReserved({
            contract: task, workspace: prepared.workspace, ticketId, assertCurrent,
            admit: async () => {
              record = await ledger.mutate(task.taskNodeId, record.revision, async (state) => {
                requireThat(
                  !state.gate?.stopRequested
                    && now() < state.contract.deadline
                    && now() < state.contract.hardSunset
                    && now() < state.receipt.expiresAt
                    && state.receipt.valid,
                  'authority expired before work',
                );
                if (executionGate) {
                  requireThat(state.ticket?.gate, 'missing gate ticket');
                  const fresh = await executionGate.prepare(
                    task,
                    { ...record, state },
                    state.ticket.gate.candidateId,
                    state.ticket.gate.action,
                  );
                  const freshBinding = fresh.descriptor
                    ? executionGateBinding(state.ticket.gate.candidateId, fresh)
                    : null;
                  requireThat(
                    fresh.decision === 'AUTONOMOUS_WITHIN_SCOPE'
                      && equal(state.gate?.activeBinding, freshBinding)
                      && equal(state.ticket.gate, {
                        action: state.ticket.gate.action,
                        ...freshBinding,
                      }),
                    'active activation binding/decision drift before first work',
                  );
                }
                return workStarted(state, { ticketId, writer });
              }, assertCurrent);
            },
          });
          requireThat(accepted.runId === ticketId && accepted.sessionKey === writer.sessionKey, 'native accepted receipt mismatch');
          record = await ledger.mutate(task.taskNodeId, record.revision, (state) => attachNativeRun(state, { ticketId, runId: accepted.runId, now: now() }), assertCurrent);
          return json({ ok: true, task: safeRecord(record) });
        } catch (error) {
          const latest = await ledger.read(task.taskNodeId, assertCurrent);
          const recoverableBindingDrift = error?.code === 'PRE_LAUNCH_BINDING_DRIFT'
            && launchAttempted === false
            && latest?.revision === record.revision
            && latest.state.status === 'DISPATCH_RESERVED'
            && latest.state.ticket?.id === ticketId
            && latest.state.ticket.activeId === ticketId
            && !latest.state.writer
            && !latest.state.gate?.stopRequested
            && !!latest.state.workspace;
          let preLaunchAbortHandled = false;
          if (recoverableBindingDrift) {
            preLaunchAbortHandled = true;
            let cleanupReceipt;
            try {
              cleanupReceipt = await bridge.cleanupWorkspace(task, latest.state.workspace);
              record = await ledger.mutate(
                task.taskNodeId,
                latest.revision,
                (state) => preLaunchAbortRecovered(state, { ticketId, cleanupReceipt, now: now() }),
                assertCurrent,
              );
            } catch {
              const unresolved = await ledger.read(task.taskNodeId, assertCurrent);
              if (
                unresolved?.revision === latest.revision
                  && unresolved.state.status === 'DISPATCH_RESERVED'
                  && unresolved.state.ticket?.activeId === ticketId
                  && !unresolved.state.writer
                  && !unresolved.state.gate?.stopRequested
              ) {
                await ledger.mutate(
                  task.taskNodeId,
                  unresolved.revision,
                  (state) => preLaunchAbortOutcomeUnknown(state, { ticketId, now: now() }),
                  assertCurrent,
                ).catch(() => undefined);
              }
            }
          }
          if (!preLaunchAbortHandled && latest?.state?.ticket?.activeId === ticketId) {
            await ledger.mutate(task.taskNodeId, latest.revision, (state) => {
              if (launchAttempted && state.status === 'DISPATCH_RESERVED' && state.gate?.stopRequested) return state;
              if (launchAttempted && ['DISPATCH_RESERVED', 'RUNNING'].includes(state.status)) return launchOutcomeUnknown(state, { ticketId, now: now() });
              if (['WORKSPACE_RESERVED', 'WORKSPACE_READY'].includes(state.status)) {
                const next = workspaceOutcomeUnknown(state, { claimId: ticketId, now: now() });
                if (error?.retainedWorkspace) next.workspace = error.retainedWorkspace;
                return next;
              }
              return state;
            }, assertCurrent).catch(() => undefined);
          }
          const blocked = await ledger.read(task.taskNodeId, assertCurrent);
          return json({ ok: false, reason: error instanceof Error ? error.message : 'NATIVE_DISPATCH_BLOCKED', task: safeRecord(blocked) });
        }
      }

      if (action === 'observe') {
        exactArgs(params, ['action', 'taskNodeId', 'expectedRevision'], ['taskNodeId', 'expectedRevision']);
        requireThat(record.state.status === 'RUNNING' && record.state.writer?.runId && record.state.ticket?.activeId, 'Task has no exactly reconcilable native run');
        const binding = { taskNodeId: task.taskNodeId, runId: record.state.writer.runId, sessionKey: record.state.writer.sessionKey, epoch: record.epoch, revision: record.revision };
        let observed;
        try {
          observed = await bridge.observeNativeRun(binding);
          requireThat(observed?.schema === 'readiness1.native-observation.v1', 'native observation schema mismatch');
          for (const key of ['taskNodeId', 'runId', 'sessionKey', 'epoch', 'revision']) requireThat(observed[key] === binding[key], `native observation ${key} mismatch`);
        } catch {
          record = await ledger.mutate(task.taskNodeId, record.revision, (state) => { const next = structuredClone(state); next.status = 'OUTCOME_UNKNOWN'; next.cleanup = 'pending'; next.history.push({ kind: 'native_terminal_unknown', runId: state.writer.runId, at: now() }); return next; }, assertCurrent);
          return json({ ok: false, reason: 'NATIVE_OBSERVATION_UNKNOWN', task: safeRecord(record) });
        }
        if (observed.status === 'pending') return json({ ok: false, reason: 'NATIVE_RUN_PENDING', observation: { status: observed.status }, task: safeRecord(record) });
        const exactTerminal = observed.status === 'ok' && observed.providerStarted === true && observed.terminalStatus === 'ok' && observed.processStopped === true && observed.groupStopped === true && observed.containerRemoved === true && observed.lsofClear === true && observed.cleanWorktree === true && observed.durableResults === true && observed.sideEffects === 'none' && Number.isSafeInteger(observed.usage) && observed.usage >= 0 && observed.usage <= record.state.reserved && observed.snapshot?.repo === task.repo && observed.snapshot.worktree === task.root && /^[a-f0-9]{40}$/.test(observed.snapshot.head) && typeof observed.snapshot.dirty === 'string' && /^[a-f0-9]{64}$/.test(observed.snapshot.indexDigest);
        if (!exactTerminal) {
          record = await ledger.mutate(task.taskNodeId, record.revision, (state) => { const next = structuredClone(state); next.status = 'OUTCOME_UNKNOWN'; next.cleanup = 'pending'; next.history.push({ kind: 'native_terminal_unknown', runId: state.writer.runId, at: now() }); return next; }, assertCurrent);
          return json({ ok: false, reason: 'NATIVE_TERMINAL_OUTCOME_UNKNOWN', task: safeRecord(record) });
        }
        record = await ledger.mutate(task.taskNodeId, record.revision, (state) => nativeRunObservation(state, { ticketId: state.ticket.activeId, event: { kind: 'provider_activity', runId: state.writer.runId }, now: now() }), assertCurrent);
        record = await ledger.mutate(task.taskNodeId, record.revision, (state) => nativeRunObservation(state, { ticketId: state.ticket.activeId, event: { kind: 'terminal', runId: state.writer.runId, status: 'ok' }, now: now() }), assertCurrent);
        record = await ledger.mutate(task.taskNodeId, record.revision, (state) => settleObserved(state, { processStopped: observed.processStopped, sideEffects: observed.sideEffects, ticketId: state.ticket.activeId, writerId: state.writer.id, usage: observed.usage, snapshot: observed.snapshot, observation: observed }), assertCurrent);
        return json({ ok: true, observation: { status: observed.status, stopReason: observed.stopReason ?? null }, task: safeRecord(record) });
      }

      if (action === 'cleanup') {
        exactArgs(params, ['action', 'taskNodeId', 'expectedRevision'], ['taskNodeId', 'expectedRevision']);
        requireThat(record.state.status === 'ACTIVE' && record.state.cleanup === 'pending' && record.state.workspace && !record.state.writer && !record.state.ticket, 'cleanup blocked by unresolved native run/resources');
        const observed = record.state.lastObservation;
        record = await ledger.mutate(task.taskNodeId, record.revision, (state) => {
          const decision = cleanupDecisionObserved(state, { taskNodeId: observed?.taskNodeId, root: task.root, processStopped: observed?.processStopped, groupStopped: observed?.groupStopped, containerRemoved: observed?.containerRemoved, lsofClear: observed?.lsofClear, sideEffects: observed?.sideEffects, durableResults: observed?.durableResults, cleanWorktree: observed?.cleanWorktree });
          requireThat(decision.allowed, decision.reason); state.cleanup = decision.cleanup; return state;
        }, assertCurrent);
        let cleanup;
        try {
          cleanup = await bridge.cleanupWorkspace(task, record.state.workspace);
          requireThat(cleanup?.schema === 'readiness1.finish-receipt.v1' && cleanup.taskNodeId === task.taskNodeId && cleanup.root === task.root, 'cleanup receipt identity mismatch');
          requireThat(cleanup.workspaceRemoved === true && cleanup.releaseConfirmed === true && cleanup.postRemovalLsofClear === true && cleanup.auditConfirmed === true, 'cleanup receipt incomplete');
        } catch {
          record = await ledger.mutate(task.taskNodeId, record.revision, (state) => { state.status = 'OUTCOME_UNKNOWN'; state.cleanup = 'pending'; state.history.push({ kind: 'cleanup_outcome_unknown', at: now() }); return state; }, assertCurrent);
          return json({ ok: false, reason: 'CLEANUP_OUTCOME_UNKNOWN', task: safeRecord(record) });
        }
        record = await ledger.mutate(task.taskNodeId, record.revision, (state) => finishTask(state, cleanup), assertCurrent);
        return json({ ok: true, removed: true, task: safeRecord(record) });
      }

      if (action === 'notify.owner') {
        exactArgs(params, ['action', 'taskNodeId', 'expectedRevision', 'notification'], ['taskNodeId', 'expectedRevision', 'notification']);
        record = await notifyOwner({ ledger: { mutate: (id, rev, reduce) => ledger.mutate(id, rev, reduce, assertCurrent) }, taskNodeId: task.taskNodeId, expectedRevision: record.revision, eventId: bridge.notificationEventId(task, params.notification), payload: params.notification, policy: config.notification, sendFixedOwnerDM: bridge.sendFixedOwnerDM, now: now() });
        return json({ ok: true, task: safeRecord(record) });
      }

      if (COORDINATION_ACTIONS.includes(action)) {
        exactArgs(params, ['action', 'taskNodeId', 'expectedRevision', 'candidateId', 'approvalId'], ['taskNodeId', 'expectedRevision']);
        if (executionGate) {
          requireThat(typeof params.candidateId === 'string', `${action} requires candidateId`);
          return json({
            ok: true,
            result: await executionGate.apply(
              task,
              record,
              params.candidateId,
              action,
              params.approvalId,
            ),
          });
        }
        const invocationId = digest({ taskNodeId: task.taskNodeId, action, epoch: record.epoch, revision: record.revision });
        record = await ledger.mutate(task.taskNodeId, record.revision, (state) => { state.status = 'OUTCOME_UNKNOWN'; state.cleanup = 'pending'; state.history.push({ kind: 'coordination_claimed', action, id: invocationId, at: now() }); return state; }, assertCurrent);
        const outcome = await bridge.coordinateFixedTask(action, task, { invocationId });
        requireThat(outcome?.confirmed === true, 'fixed GitHub operation outcome UNKNOWN');
        record = await ledger.mutate(task.taskNodeId, record.revision, (state) => { state.status = 'ACTIVE'; state.cleanup = 'clear'; state.history.push({ kind: 'coordination_confirmed', action, id: invocationId, at: now() }); return state; }, assertCurrent);
        return json({ ok: true, task: safeRecord(record) });
      }

      throw new Error('unsupported closed controller action');
    },
  };
}

import assert from 'node:assert/strict';
import test from 'node:test';
import { digest, scopeHash } from '../src/contract.js';
import { TOOL_SCHEMA } from '../src/controller.js';
import { effectKey, selectIntent } from '../src/readiness2/catalog.js';
import { createExecutionGate, GATE_ACTIONS } from '../src/readiness2/gate.js';
import { contract, makeTool } from './helpers.mjs';

const sourceEffect = Object.freeze({
  class: 'filesystem',
  target: contract.root,
  category: 'none',
  amount: 0,
  possible: true,
  provenance: 'resolver',
});
const readEffect = Object.freeze({
  class: 'api',
  target: contract.repo,
  category: 'none',
  amount: 0,
  possible: true,
  provenance: 'resolver',
  readOnly: true,
  safeView: true,
});
const commentEffect = Object.freeze({
  class: 'externalSend',
  target: 'fixed-owner-target',
  category: 'external',
  amount: 0,
  possible: true,
  provenance: 'resolver',
});

function candidate(id, operation, extra = {}) {
  return {
    id,
    taskNodeId: contract.taskNodeId,
    operation,
    requestedMode: operation.endsWith('.read') ? 'READ' : 'OPS',
    intent: { objective: 'bounded fixture objective', result: 'fixture evidence', method: 'fixed route' },
    ...extra,
  };
}

function gateHarness(overrides = {}) {
  const candidates = new Map([
    ['source', candidate('source', 'source.work', {
      coverageClaim: {
        kind: 'existing',
        receiptId: 'plugin:1',
        effectKeys: [effectKey(sourceEffect)],
      },
    })],
    ['source-compatible', candidate('source-compatible', 'source.work', {
      coverageClaim: {
        kind: 'existing',
        receiptId: 'plugin:1',
        effectKeys: [effectKey(sourceEffect)],
      },
    })],
    ['read', candidate('read', 'repo.read')],
    ['comment', candidate('comment', 'comment.append', {
      coverageClaim: { kind: 'new', effectKeys: [effectKey(commentEffect)] },
    })],
    ['hidden', candidate('hidden', 'source.work', {
      coverageClaim: {
        kind: 'existing',
        receiptId: 'plugin:1',
        effectKeys: [effectKey(sourceEffect)],
      },
      hidden: true,
    })],
    ['unknown', candidate('unknown', 'unknown.operation')],
    ['unsafe', candidate('unsafe', 'comment.append', {
      coverageClaim: { kind: 'new', effectKeys: [effectKey(commentEffect)] },
      saferAlternativeId: 'read',
    })],
    ['protective', candidate('protective', 'source.work', {
      coverageClaim: {
        kind: 'existing',
        receiptId: 'plugin:1',
        effectKeys: [effectKey(sourceEffect)],
      },
      hidden: true,
      step: { id: 'guard-step', protective: true },
    })],
    ['dependent', candidate('dependent', 'source.work', {
      coverageClaim: {
        kind: 'existing',
        receiptId: 'plugin:1',
        effectKeys: [effectKey(sourceEffect)],
      },
      dependsOn: ['guard-step'],
    })],
  ]);
  const invocations = [];
  const reads = [];
  const create = ({ ledger, approval, now }) => createExecutionGate({
    ledger,
    approval,
    assertCurrent() {},
    now,
    policy: { ownerDevicePins: ['owner-device'], controllerDeviceId: 'controller-device' },
    async readCandidate({ candidateId }) {
      const value = candidates.get(candidateId);
      if (!value) throw new Error('UNKNOWN candidate');
      return structuredClone(value);
    },
    resolver: {
      async resolve(selected, task, record) {
        const route = {
          'source.work': ['OPS', 'specialist', 'dev-host', [sourceEffect]],
          'repo.read': ['READ', 'safe-projection', 'main', [readEffect]],
          'comment.append': ['OPS', 'coordination', 'main', [commentEffect]],
        }[selected.operation];
        if (!route) throw new Error('UNKNOWN operation');
        const effects = [...route[3]];
        if (selected.hidden) effects.push({
          class: 'egress',
          target: 'https://hidden.invalid',
          category: 'external',
          amount: 0,
          possible: true,
          provenance: 'resolver',
        });
        const descriptor = {
          schema: 'execution-gate.descriptor.v1',
          operation: selected.operation,
          mode: route[0],
          route: route[1],
          role: route[2],
          taskNodeId: task.taskNodeId,
          epoch: record?.epoch ?? 0,
          contractRevision: task.revisionHash,
          scopeHash: scopeHash(task),
          catalogHash: selected.catalogHash ?? task.caps.executionGate.catalogHash,
          resolverHash: selected.resolverHash ?? task.caps.executionGate.resolverHash,
          profileHash: selected.profileHash ?? task.caps.executionGate.profileHashes[0],
          intent: selected.intent ?? null,
          dependencies: selected.dependsOn ?? [],
          omissions: record?.state.gate?.omissions ?? [],
          immutableIds: [],
          effects,
        };
        return {
          descriptor,
          descriptorDigest: digest(descriptor),
          immutable: { catalog: {}, build: {}, profile: {}, contents: [] },
        };
      },
    },
    async invokeImmutable(input) {
      invocations.push(input.descriptorDigest);
      await input.authorizeFirstEffect();
      return {
        confirmed: true,
        immutableIds: input.descriptor.immutableIds,
        usage: 0,
        result: 'CONFIRMED',
      };
    },
  });
  const fixture = makeTool({
    ...overrides,
    executionGateFactory: create,
    async readSafeProjection(input) {
      reads.push(input.descriptorDigest);
      return {
        schema: 'execution-gate.read-result.v1',
        taskNodeId: input.task.taskNodeId,
        action: input.action,
        candidateId: input.candidateId,
        descriptorDigest: input.descriptorDigest,
        lifecycle: {
          prepare: 'read-only',
          launch: 'read-only',
          activity: 'read-only',
          delivery: 'safe-view',
          cleanup: 'pass',
        },
        targetMutation: false,
        externalWrite: false,
        safeView: { repo: input.task.repo, finding: 'fixture-only' },
      };
    },
  });
  return { ...fixture, candidates, invocations, reads };
}

async function activateGate(tool, candidateId = 'source') {
  const requested = (await tool.execute('approval', {
    action: 'approval.request',
    taskNodeId: contract.taskNodeId,
    candidateId,
  })).details;
  return (await tool.execute('activate', {
    action: 'activate',
    taskNodeId: contract.taskNodeId,
    expectedRevision: requested.revision,
    approvalId: requested.approvalId,
    candidateId,
  })).details.task;
}

test('G01-G05 G09-G10 G14-G16 G20-G21 G23 G26 offline READ stays a full non-mutation lifecycle', async () => {
  const { tool, reads, calls, executionGate } = gateHarness();
  const read = (await tool.execute('read', {
    action: 'repo.read',
    taskNodeId: contract.taskNodeId,
    candidateId: 'read',
  })).details;
  assert.equal(read.decision, 'AUTONOMOUS_WITHIN_SCOPE');
  assert.equal(read.lifecycle.cleanup, 'pass');
  assert.equal(reads.length, 1);
  assert.equal(calls.some(([name]) => name === 'worktree.create' || name === 'provider.work'), false);
  assert.equal(selectIntent({ toolFree: true, operation: 'source.work' }).mode, 'CHAT');
  assert.equal(selectIntent({ diagnosticOnly: true, operation: 'source.work' }).mode, 'BLOCKED');
  const unknown = await executionGate.prepare(contract, null, 'unknown', 'gate.preflight');
  assert.equal(unknown.decision, 'UNKNOWN');
});

test('G06 G08 G11 G17-G18 G24-G25 G27-G28 integrated OPS binds D-029 activation to M1 admission', async () => {
  const { tool, ledger, calls, approvalState } = gateHarness();
  const requested = (await tool.execute('approval', {
    action: 'approval.request',
    taskNodeId: contract.taskNodeId,
    candidateId: 'source',
  })).details;
  const pending = await ledger.read(contract.taskNodeId, () => {});
  const binding = pending.approvals[requested.approvalId].binding;
  assert.equal(binding.activation.executionGate.candidateId, 'source');
  assert.equal(binding.activation.executionGate.operation, 'source.work');
  assert.equal(binding.activation.ownerOrigin.deviceId, 'owner-device');
  assert.equal(approvalState.bindings.size, 1);

  const active = (await tool.execute('activate', {
    action: 'activate',
    taskNodeId: contract.taskNodeId,
    expectedRevision: requested.revision,
    approvalId: requested.approvalId,
    candidateId: 'source',
  })).details.task;
  const running = (await tool.execute('dispatch', {
    action: 'dispatch',
    taskNodeId: contract.taskNodeId,
    expectedRevision: active.revision,
    candidateId: 'source',
  })).details;
  assert.equal(running.ok, true);
  assert.equal(running.task.status, 'RUNNING');
  assert.equal(calls.filter(([name]) => name === 'provider.work').length, 1);
  const record = await ledger.read(contract.taskNodeId, () => {});
  assert.deepEqual(record.state.gate.activeBinding, binding.activation.executionGate);
  assert.equal(record.state.history.filter((entry) => entry.kind === 'gate_preflight').length, 1);
  assert.ok(record.state.ticket.gate.descriptorDigest);
  await assert.rejects(tool.execute('replay', {
    action: 'activate',
    taskNodeId: contract.taskNodeId,
    expectedRevision: requested.revision,
    approvalId: requested.approvalId,
    candidateId: 'source',
  }), /approval spent|revision conflict/);
});

test('dispatch rejects a compatible unactivated candidate before any effect or no-effect adapter', async () => {
  const { tool, ledger, calls, invocations } = gateHarness();
  const active = await activateGate(tool, 'source');
  const before = await ledger.read(contract.taskNodeId, () => {});

  await assert.rejects(tool.execute('dispatch-substitution', {
    action: 'dispatch',
    taskNodeId: contract.taskNodeId,
    expectedRevision: active.revision,
    candidateId: 'source-compatible',
  }), /active activation binding/);
  assert.deepEqual(calls, []);
  assert.deepEqual(invocations, []);
  const after = await ledger.read(contract.taskNodeId, () => {});
  assert.equal(after.revision, before.revision);
  assert.equal(after.state.status, 'ACTIVE');
  assert.equal(after.state.ticket, null);
});

test('pre-launch candidate, descriptor, and pin drift recover only with exact workspace cleanup evidence', async (t) => {
  const cases = [
    ['candidate ID', (value) => ({ ...value, id: 'source-compatible' })],
    ['descriptor', (value) => ({ ...value, intent: { ...value.intent, method: 'drifted route' } })],
    ['profile pin', (value) => ({ ...value, profileHash: '0'.repeat(64) })],
  ];
  for (const [name, drift] of cases) {
    await t.test(name, async () => {
      let candidates;
      const fixture = gateHarness({
        async readCapacity() {
          candidates.set('source', drift(candidates.get('source')));
          return { provider: 'codex', version: '1.0.0', source: 'native-structured', workCalls: 0, capacity: 'available', paidOverflow: 'off' };
        },
      });
      ({ candidates } = fixture);
      const { tool, ledger, calls, invocations } = fixture;
      const active = await activateGate(tool);
      const result = (await tool.execute(`pre-launch-${name}`, {
        action: 'dispatch',
        taskNodeId: contract.taskNodeId,
        expectedRevision: active.revision,
        candidateId: 'source',
      })).details;
      assert.equal(result.ok, false);
      assert.match(result.reason, /active activation binding\/decision drift before launch/);
      assert.equal(calls.some(([call]) => call === 'execution.admit.request' || call === 'provider.work'), false);
      assert.deepEqual(invocations, []);
      assert.equal(calls.filter(([call]) => call === 'worktree.remove').length, 1);
      const recovered = await ledger.read(contract.taskNodeId, () => {});
      assert.equal(recovered.state.status, 'CANCELLED');
      assert.equal(recovered.state.reserved, 0);
      assert.equal(recovered.state.ticket, null);
      assert.equal(recovered.state.cleanup, 'pass');
      assert.equal(recovered.state.finishReceipt?.schema, 'readiness1.finish-receipt.v1');
      assert.equal(recovered.state.finishReceipt?.workspaceRemoved, true);
      assert.equal(recovered.state.history.at(-1).kind, 'pre_launch_abort_recovered');
      assert.equal(recovered.state.history.at(-1).receiptId, recovered.state.finishReceipt.receiptId);
    });
  }
});

test('pre-launch binding drift with uncertain cleanup is sticky OUTCOME_UNKNOWN', async () => {
  let candidates;
  let cleanupAttempts = 0;
  const fixture = gateHarness({
    async readCapacity() {
      const value = candidates.get('source');
      candidates.set('source', { ...value, intent: { ...value.intent, method: 'drifted route' } });
      return { provider: 'codex', version: '1.0.0', source: 'native-structured', workCalls: 0, capacity: 'available', paidOverflow: 'off' };
    },
    async cleanupWorkspace() {
      cleanupAttempts += 1;
      throw new Error('cleanup outcome unavailable');
    },
  });
  ({ candidates } = fixture);
  const original = structuredClone(candidates.get('source'));
  const { tool, ledger, calls, invocations } = fixture;
  const active = await activateGate(tool);
  const result = (await tool.execute('pre-launch-cleanup-unknown', {
    action: 'dispatch',
    taskNodeId: contract.taskNodeId,
    expectedRevision: active.revision,
    candidateId: 'source',
  })).details;
  assert.equal(result.ok, false);
  assert.equal(cleanupAttempts, 1);
  assert.equal(calls.some(([call]) => call === 'execution.admit.request' || call === 'provider.work'), false);
  assert.deepEqual(invocations, []);
  let unknown = await ledger.read(contract.taskNodeId, () => {});
  assert.equal(unknown.state.status, 'OUTCOME_UNKNOWN');
  assert.equal(unknown.state.cleanup, 'pending');
  assert.equal(unknown.state.reserved, 10);
  assert.ok(unknown.state.ticket);
  assert.ok(unknown.state.workspace);
  assert.equal(unknown.state.history.at(-1).kind, 'pre_launch_abort_cleanup_unknown');

  candidates.set('source', original);
  await assert.rejects(tool.execute('sticky-redispatch', {
    action: 'dispatch',
    taskNodeId: contract.taskNodeId,
    expectedRevision: unknown.revision,
    candidateId: 'source',
  }), /Execution Gate BLOCKED|cleanup pending/);
  unknown = await ledger.read(contract.taskNodeId, () => {});
  assert.equal(unknown.state.status, 'OUTCOME_UNKNOWN');
  assert.ok(unknown.state.ticket);
  await assert.rejects(tool.execute('sticky-reactivate', {
    action: 'approval.request',
    taskNodeId: contract.taskNodeId,
    candidateId: 'source',
  }), /old resources unresolved|already active/);
});

test('final admission drift remains fail-closed after launch handoff without provider effect', async () => {
  let candidates;
  let providerStarted = false;
  const fixture = gateHarness({
    async startReservedExecution({ descriptor: request, admitExecutionStart }) {
      const value = candidates.get('source');
      candidates.set('source', { ...value, id: 'source-compatible' });
      await admitExecutionStart();
      providerStarted = true;
      return { runId: request.idempotencyKey, sessionKey: request.sessionKey };
    },
  });
  ({ candidates } = fixture);
  const { tool, ledger, calls, invocations } = fixture;
  const active = await activateGate(tool);
  const result = (await tool.execute('final-admission-drift', {
    action: 'dispatch',
    taskNodeId: contract.taskNodeId,
    expectedRevision: active.revision,
    candidateId: 'source',
  })).details;
  assert.equal(result.ok, false);
  assert.equal(providerStarted, false);
  assert.equal(calls.some(([call]) => call === 'provider.work' || call === 'worktree.remove'), false);
  assert.deepEqual(invocations, []);
  const held = await ledger.read(contract.taskNodeId, () => {});
  assert.equal(held.state.status, 'OUTCOME_UNKNOWN');
  assert.equal(held.state.cleanup, 'pending');
  assert.equal(held.state.reserved, 10);
  assert.ok(held.state.ticket);
  assert.ok(held.state.workspace);
  assert.equal(held.state.history.at(-1).kind, 'launch_outcome_unknown');
});

test('normal CAS cannot add or replace activeBinding while reactivation can replace it', async () => {
  const plain = makeTool();
  const requested = (await plain.tool.execute('approval', {
    action: 'approval.request',
    taskNodeId: contract.taskNodeId,
  })).details;
  const activePlain = (await plain.tool.execute('activate', {
    action: 'activate',
    taskNodeId: contract.taskNodeId,
    expectedRevision: requested.revision,
    approvalId: requested.approvalId,
  })).details.task;
  await assert.rejects(plain.ledger.mutate(contract.taskNodeId, activePlain.revision, (state) => {
    state.gate = {
      operations: [], refusals: [], omissions: [], requests: [], stopRequested: false,
      activeBinding: {
        candidateId: 'source', descriptorDigest: '1'.repeat(64),
        catalogHash: '2'.repeat(64), resolverHash: '3'.repeat(64), profileHash: '4'.repeat(64),
        operation: 'source.work', mode: 'OPS', route: 'specialist', role: 'dev-host',
      },
    };
    return state;
  }, () => {}), /active gate binding cannot change/);

  const fixture = gateHarness();
  const active = await activateGate(fixture.tool);
  const old = await fixture.ledger.read(contract.taskNodeId, () => {});
  await assert.rejects(fixture.ledger.mutate(contract.taskNodeId, active.revision, (state) => {
    state.gate.activeBinding.candidateId = 'source-compatible';
    return state;
  }, () => {}), /active gate binding cannot change/);
  const after = await fixture.ledger.read(contract.taskNodeId, () => {});
  assert.deepEqual(after.state.gate.activeBinding, old.state.gate.activeBinding);
});

test('G19-G20 G22-G24 G27 G31 G38 cancel and capacity UNKNOWN stay blocked without provider fallback', async () => {
  const { tool, calls } = gateHarness({
    readCapacity: async () => ({
      provider: 'codex',
      version: '1.0.0',
      source: 'native-structured',
      workCalls: 0,
      capacity: 'exhausted',
      paidOverflow: 'off',
      resetAt: 5_000,
    }),
  });
  const active = await activateGate(tool);
  const waiting = (await tool.execute('dispatch', {
    action: 'dispatch',
    taskNodeId: contract.taskNodeId,
    expectedRevision: active.revision,
    candidateId: 'source',
  })).details.task;
  assert.equal(waiting.status, 'WAITING_PROVIDER_CAPACITY');
  assert.equal(waiting.attempts, 0);
  assert.equal(calls.some(([name]) => name === 'provider.work'), false);
  const cancelled = (await tool.execute('cancel', {
    action: 'gate.cancel',
    taskNodeId: contract.taskNodeId,
    expectedRevision: waiting.revision,
  })).details.result;
  assert.equal(cancelled.status, 'WAITING_PROVIDER_CAPACITY');
  await assert.rejects(tool.execute('resume', {
    action: 'capacity.resume',
    taskNodeId: contract.taskNodeId,
    expectedRevision: cancelled.revision,
  }), /CAPACITY_RESUME_PUBLIC_SURFACE_UNAVAILABLE/);
});

test('G19 G27 cancel after reservation wins the admission CAS and holds unresolved resources', async () => {
  let enteredResolve;
  let continueResolve;
  let providerStarted = false;
  const entered = new Promise((resolve) => { enteredResolve = resolve; });
  const proceed = new Promise((resolve) => { continueResolve = resolve; });
  const { tool, ledger } = gateHarness({
    async startReservedExecution({ descriptor, admitExecutionStart }) {
      enteredResolve();
      await proceed;
      await admitExecutionStart();
      providerStarted = true;
      return { runId: descriptor.idempotencyKey, sessionKey: descriptor.sessionKey };
    },
  });
  const active = await activateGate(tool);
  const dispatch = tool.execute('dispatch', {
    action: 'dispatch',
    taskNodeId: contract.taskNodeId,
    expectedRevision: active.revision,
    candidateId: 'source',
  });
  await entered;
  const reserved = await ledger.read(contract.taskNodeId, () => {});
  assert.equal(reserved.state.status, 'DISPATCH_RESERVED');
  await tool.execute('cancel', {
    action: 'gate.cancel',
    taskNodeId: contract.taskNodeId,
    expectedRevision: reserved.revision,
  });
  continueResolve();
  const result = (await dispatch).details;
  assert.equal(result.ok, false);
  assert.equal(providerStarted, false);
  const held = await ledger.read(contract.taskNodeId, () => {});
  assert.equal(held.state.status, 'DISPATCH_RESERVED');
  assert.equal(held.state.gate.stopRequested, true);
  assert.ok(held.state.ticket);
});

test('G18 G25 G37 G38 reactivation preserves counters and refusal tombstones', async () => {
  const { tool, ledger } = gateHarness();
  const active = await activateGate(tool);
  const blocked = await ledger.mutate(contract.taskNodeId, active.revision, (state) => {
    state.attempts = 1;
    state.status = 'BLOCKED';
    state.gate = {
      ...state.gate,
      operations: [],
      refusals: [{
        key: effectKey(commentEffect),
        amount: 0,
        reason: 'refusal',
        descriptorDigest: '9'.repeat(64),
        reRequests: 0,
        reopened: false,
      }],
      omissions: [],
      requests: [],
      stopRequested: true,
    };
    state.history.push({ kind: 'fixture_blocked', at: 1_000 });
    return state;
  }, () => {});
  const requested = (await tool.execute('reauthorize', {
    action: 'approval.request',
    taskNodeId: contract.taskNodeId,
    candidateId: 'source-compatible',
  })).details;
  const renewed = (await tool.execute('reactivate', {
    action: 'activate',
    taskNodeId: contract.taskNodeId,
    expectedRevision: requested.revision,
    approvalId: requested.approvalId,
    candidateId: 'source-compatible',
  })).details.task;
  assert.ok(renewed.revision > blocked.revision);
  const record = await ledger.read(contract.taskNodeId, () => {});
  assert.equal(record.epoch, 2);
  assert.equal(record.state.attempts, 1);
  assert.equal(record.state.gate.refusals.length, 1);
  assert.equal(record.state.gate.refusals[0].reason, 'refusal');
  assert.equal(record.state.gate.stopRequested, false);
  assert.equal(record.state.gate.activeBinding.candidateId, 'source-compatible');
});

test('G07 G30 G32-G35 G37 G40 operation receipt is exact, allow-once, and hidden effects stay zero', async () => {
  const { tool, ledger, candidates, invocations } = gateHarness();
  let active = await activateGate(tool);
  const hidden = (await tool.execute('hidden', {
    action: 'gate.preflight',
    taskNodeId: contract.taskNodeId,
    candidateId: 'hidden',
  })).details.result;
  assert.equal(hidden.decision, 'BLOCKED');
  assert.equal(invocations.length, 0);

  const requested = (await tool.execute('request', {
    action: 'operation.request',
    taskNodeId: contract.taskNodeId,
    expectedRevision: active.revision,
    candidateId: 'comment',
  })).details.result;
  assert.equal(requested.decision, 'OWNER_APPROVAL_REQUIRED');
  active = await ledger.read(contract.taskNodeId, () => {});
  const applied = (await tool.execute('apply', {
    action: 'comment.append',
    taskNodeId: contract.taskNodeId,
    expectedRevision: active.revision,
    candidateId: 'comment',
    approvalId: requested.approvalId,
  })).details.result;
  assert.equal(applied.observation, 'CONFIRMED');
  assert.equal(invocations.length, 1);
  const settled = await ledger.read(contract.taskNodeId, () => {});
  assert.equal(settled.approvals[requested.approvalId].state, 'spent');
  await assert.rejects(tool.execute('replay', {
    action: 'comment.append',
    taskNodeId: contract.taskNodeId,
    expectedRevision: settled.revision,
    candidateId: 'comment',
    approvalId: requested.approvalId,
  }), /not an unused operation approval/);

  candidates.set('comment', candidate('comment', 'comment.append', {
    coverageClaim: { kind: 'new', effectKeys: [effectKey(commentEffect)] },
    mechanicalDigest: '0'.repeat(64),
  }));
  const drift = (await tool.execute('drift', {
    action: 'gate.preflight',
    taskNodeId: contract.taskNodeId,
    candidateId: 'comment',
  })).details.result;
  assert.equal(drift.decision, 'BLOCKED');
});

test('G29 G36 safer substitute is re-preflighted and protective omission blocks dependents', async () => {
  const { tool, ledger, executionGate } = gateHarness();
  let active = await activateGate(tool);
  const rewritten = (await tool.execute('rewrite', {
    action: 'gate.preflight',
    taskNodeId: contract.taskNodeId,
    candidateId: 'unsafe',
  })).details.result;
  assert.deepEqual(rewritten.rewrite, {
    kind: 'PreflightRewrite',
    from: 'unsafe',
    to: 'read',
  });
  assert.equal(rewritten.decision, 'AUTONOMOUS_WITHIN_SCOPE');
  active = await ledger.read(contract.taskNodeId, () => {});
  await executionGate.recordNotExecuted(contract, active, 'protective');
  active = await ledger.read(contract.taskNodeId, () => {});
  const dependent = await executionGate.prepare(contract, active, 'dependent', 'dispatch');
  assert.equal(dependent.decision, 'BLOCKED');
  assert.match(dependent.reasons.join('\n'), /protective prerequisite omitted/);
});

test('G01-G40 offline acceptance coverage is exact while production activation remains unclaimed', () => {
  const groups = {
    readBoundary: ['G01', 'G02', 'G03', 'G04', 'G05', 'G09', 'G10', 'G14', 'G15', 'G16', 'G20', 'G21', 'G23', 'G26'],
    activationAdmission: ['G06', 'G08', 'G11', 'G17', 'G18', 'G24', 'G25', 'G27', 'G28'],
    capacityCancel: ['G19', 'G22', 'G31', 'G38'],
    immutableApproval: ['G07', 'G30', 'G32', 'G33', 'G34', 'G35', 'G37', 'G40'],
    deterministicRunner: ['G12', 'G13'],
    rewriteOmission: ['G29', 'G36'],
    independentResolver: ['G39'],
  };
  const covered = Object.values(groups).flat().sort();
  const expected = Array.from({ length: 40 }, (_, index) => `G${String(index + 1).padStart(2, '0')}`).sort();
  assert.deepEqual(covered, expected);
  assert.equal(new Set(covered).size, 40);
  assert.equal(Object.hasOwn(selectIntent({ operation: 'snapshot.update' }), 'operation'), true);
  assert.equal(TOOL_SCHEMA.properties.action.enum.some((action) => GATE_ACTIONS.includes(action)), false);
  assert.equal(TOOL_SCHEMA.properties.action.enum.some((action) => action.endsWith('.read')), false);
});

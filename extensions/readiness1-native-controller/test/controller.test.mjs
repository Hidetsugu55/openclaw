import assert from 'node:assert/strict';
import test from 'node:test';
import { createReadinessTool } from '../src/controller.js';
import { createLedger } from '../src/ledger.js';
import { createNativeBridge } from '../src/native-bridge.js';
import { activate, config, contract, makeTool, memoryStore } from './helpers.mjs';

test('injected canonical controller path is explicitly fixture-only', () => {
  assert.throws(() => createReadinessTool({}), /CANONICAL_CONTROLLER_FIXTURE_ONLY/);
});

test('host-issued ledger binding is the only non-fixture constructor path', () => {
  assert.doesNotThrow(() => createReadinessTool({
    config,
    ctx: {
      agentId: 'main', sessionKey: 'agent:main:main', senderIsOwner: true,
      requesterSenderId: 'owner-1', originTrigger: 'direct-user', deviceId: 'owner-device',
      sandboxed: false, assertInvocationCurrent() {},
    },
    ledger: createLedger(memoryStore()),
    bridge: createNativeBridge({ config }),
    hostBinding: Object.freeze({
      kind: 'openclaw.readiness1.host-binding.v1',
      openLedgerStore: () => memoryStore(),
      readCanonicalTask: async () => contract,
    }),
  }));
});

test('thin adapter preserves canonical authority through native receipt, terminal readback, and cleanup', async () => {
  const { tool, calls } = makeTool();
  let task = await activate(tool);
  assert.equal(task.status, 'ACTIVE');
  assert.equal(task.epoch, 1);

  task = (await tool.execute('dispatch', { action: 'dispatch', taskNodeId: contract.taskNodeId, expectedRevision: task.revision })).details.task;
  assert.equal(task.status, 'RUNNING');
  const runRequest = calls.find(([name]) => name === 'provider.work')[1];
  const sandboxRequest = calls.find(([name]) => name === 'sandbox.prepare')[1];
  assert.match(runRequest.sessionKey, /^agent:dev-host:subagent:workboard-readiness1-[a-f0-9]{24}$/);
  assert.equal(runRequest.cwd, contract.root);
  assert.equal(runRequest.toolsAlsoAllow, undefined);
  assert.deepEqual(sandboxRequest.requiredToolNames, ['read', 'exec', 'apply_patch']);
  assert.deepEqual(sandboxRequest.confinedToolNames, []);

  task = (await tool.execute('observe', { action: 'observe', taskNodeId: contract.taskNodeId, expectedRevision: task.revision })).details.task;
  assert.equal(task.status, 'ACTIVE');
  assert.equal(task.attempts, 1);
  assert.equal(task.spent, 3);
  assert.equal(task.cleanup, 'pending');

  task = (await tool.execute('cleanup', { action: 'cleanup', taskNodeId: contract.taskNodeId, expectedRevision: task.revision })).details.task;
  assert.equal(task.cleanup, 'pass');
  assert.equal(task.status, 'DONE');
  assert.ok(calls.some(([name]) => name === 'worktree.remove'));

  const requested = (await tool.execute('approval-2', { action: 'approval.request', taskNodeId: contract.taskNodeId })).details;
  task = (await tool.execute('activate-2', { action: 'activate', taskNodeId: contract.taskNodeId, expectedRevision: requested.revision, approvalId: requested.approvalId })).details.task;
  assert.equal(task.status, 'ACTIVE');
  assert.equal(task.epoch, 2);
});

test('lost or mismatched native spawn is sticky OUTCOME_UNKNOWN and cannot retry or cleanup', async () => {
  for (const overrides of [
    { runError: new Error('response lost') },
    { runReceipt: { runId: 'foreign-run', sessionKey: 'agent:other:subagent:foreign' } },
  ]) {
    const { tool } = makeTool(overrides);
    let task = await activate(tool);
    const failed = (await tool.execute('dispatch', { action: 'dispatch', taskNodeId: contract.taskNodeId, expectedRevision: task.revision })).details;
    assert.equal(failed.task.status, 'OUTCOME_UNKNOWN');
    task = failed.task;
    const retry = (await tool.execute('retry', { action: 'dispatch', taskNodeId: contract.taskNodeId, expectedRevision: task.revision })).details;
    assert.equal(retry.ok, false);
    assert.equal(retry.task.status, 'OUTCOME_UNKNOWN');
    await assert.rejects(tool.execute('cleanup', { action: 'cleanup', taskNodeId: contract.taskNodeId, expectedRevision: task.revision }), /unresolved native run\/resources/);
  }
});

test('terminal mismatch and absent provider evidence become OUTCOME_UNKNOWN', async () => {
  const { tool } = makeTool({ waitResult: { status: 'ok', providerStarted: false } });
  let task = await activate(tool);
  task = (await tool.execute('dispatch', { action: 'dispatch', taskNodeId: contract.taskNodeId, expectedRevision: task.revision })).details.task;
  const result = (await tool.execute('observe', { action: 'observe', taskNodeId: contract.taskNodeId, expectedRevision: task.revision })).details;
  assert.equal(result.reason, 'NATIVE_OBSERVATION_UNKNOWN');
  assert.equal(result.task.status, 'OUTCOME_UNKNOWN');
});

test('typed observation mismatches, unobserved usage, and uncertain cleanup stay sticky unknown', async () => {
  for (const observeNativeRun of [
    async (binding) => ({ schema: 'readiness1.native-observation.v1', ...binding, revision: binding.revision + 1, status: 'ok' }),
    async (binding) => ({ schema: 'readiness1.native-observation.v1', ...binding, status: 'ok', providerStarted: true, terminalStatus: 'ok', processStopped: true, groupStopped: true, containerRemoved: true, lsofClear: true, cleanWorktree: true, durableResults: true, sideEffects: 'none', usage: 11, snapshot: { repo: contract.repo, worktree: contract.root, head: contract.head, dirty: '', indexDigest: 'c'.repeat(64) } }),
  ]) {
    const { tool } = makeTool({ observeNativeRun });
    let task = await activate(tool);
    task = (await tool.execute('dispatch', { action: 'dispatch', taskNodeId: contract.taskNodeId, expectedRevision: task.revision })).details.task;
    const result = (await tool.execute('observe', { action: 'observe', taskNodeId: contract.taskNodeId, expectedRevision: task.revision })).details;
    assert.equal(result.task.status, 'OUTCOME_UNKNOWN');
    assert.equal(result.task.spent, 0);
  }

  const { tool } = makeTool({ cleanupWorkspace: async () => { throw new Error('removal outcome uncertain'); } });
  let task = await activate(tool);
  task = (await tool.execute('dispatch', { action: 'dispatch', taskNodeId: contract.taskNodeId, expectedRevision: task.revision })).details.task;
  task = (await tool.execute('observe', { action: 'observe', taskNodeId: contract.taskNodeId, expectedRevision: task.revision })).details.task;
  const cleanup = (await tool.execute('cleanup', { action: 'cleanup', taskNodeId: contract.taskNodeId, expectedRevision: task.revision })).details;
  assert.equal(cleanup.reason, 'CLEANUP_OUTCOME_UNKNOWN');
  assert.equal(cleanup.task.status, 'OUTCOME_UNKNOWN');
  assert.equal(cleanup.task.cleanup, 'pending');
});

test('closed catalog rejects TaskFlow ids, fallback Tasks, and arbitrary overrides', async () => {
  const { tool } = makeTool();
  await assert.rejects(tool.execute('flow', { action: 'status', taskNodeId: contract.taskNodeId, flowId: 'legacy' }), /arbitrary input/);
  await assert.rejects(tool.execute('fallback', { action: 'status', taskNodeId: 'TASK_unknown' }), /not configured/);
  await assert.rejects(tool.execute('repo', { action: 'approval.request', taskNodeId: contract.taskNodeId, repo: 'evil/repo' }), /arbitrary input/);
  await assert.rejects(tool.execute('path', { action: 'approval.request', taskNodeId: contract.taskNodeId, path: '/tmp/evil' }), /arbitrary input/);
  await assert.rejects(tool.execute('agent', { action: 'approval.request', taskNodeId: contract.taskNodeId, agentId: 'other' }), /arbitrary input/);
  await assert.rejects(tool.execute('recipient', { action: 'notify.owner', taskNodeId: contract.taskNodeId, expectedRevision: 0, recipient: 'other' }), /arbitrary input/);
});

test('public-surface gaps fail closed instead of simulating capacity or source PASS', async () => {
  const { tool, calls } = makeTool({ startReservedExecution: null, readCapacity: null, snapshotWorkspace: null });
  const task = await activate(tool);
  const result = (await tool.execute('dispatch', { action: 'dispatch', taskNodeId: contract.taskNodeId, expectedRevision: task.revision })).details;
  assert.equal(result.ok, false);
  assert.match(result.reason, /EXECUTION_START_ADMISSION_CONTROLLER_WIRING_UNAVAILABLE/);
  assert.equal(result.task.status, 'ACTIVE');
  assert.equal(calls.some(([name]) => name === 'worktree.create' || name === 'provider.work'), false);
});

test('fixture-only pre-start capacity wait consumes no attempt or writer', async () => {
  const { tool, calls } = makeTool({
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
  const task = await activate(tool);
  const waiting = (await tool.execute('dispatch', {
    action: 'dispatch',
    taskNodeId: contract.taskNodeId,
    expectedRevision: task.revision,
  })).details.task;
  assert.equal(waiting.status, 'WAITING_PROVIDER_CAPACITY');
  assert.equal(waiting.attempts, 0);
  assert.equal(waiting.run, null);
  assert.equal(calls.some(([name]) => name === 'provider.work'), false);
});

test('fixture-only execution callback performs no provider work when admission is cancelled or conflicts', async () => {
  for (const admissionError of [new Error('cancelled before start'), new Error('canonical Task revision conflict')]) {
    const { tool, calls } = makeTool({ admissionError });
    const task = await activate(tool);
    const result = (await tool.execute('dispatch', { action: 'dispatch', taskNodeId: contract.taskNodeId, expectedRevision: task.revision })).details;
    assert.equal(result.ok, false);
    assert.equal(calls.filter(([name]) => name === 'provider.work').length, 0);
  }
});

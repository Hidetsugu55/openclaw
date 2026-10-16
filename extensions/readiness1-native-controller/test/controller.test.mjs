import assert from 'node:assert/strict';
import test from 'node:test';
import { createReadinessTool } from '../src/controller.js';
import { createLedger } from '../src/ledger.js';
import { createNativeBridge, nativeWorkerSessionKey } from '../src/native-bridge.js';
import { activate, config, contract, descriptor, makeTool, memoryStore } from './helpers.mjs';

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
    bridge: createNativeBridge({ config, readCanonicalDescriptor: async () => descriptor }),
    hostBinding: Object.freeze({
      kind: 'openclaw.readiness1.host-binding.v1',
      openLedgerStore: () => memoryStore(),
      readCanonicalDescriptor: async () => descriptor,
    }),
  }));
});

test('host canonical descriptor, rather than plugin config, selects the public Task', async () => {
  const hostContract = Object.freeze({ ...contract, revisionHash: '9'.repeat(64) });
  const hostDescriptor = Object.freeze({ ...descriptor, contract: hostContract, instructions: 'Host-owned canonical instructions.' });
  let reads = 0;
  const bridge = createNativeBridge({
    config: Object.freeze({ ...config, tasks: [] }),
    readCanonicalDescriptor: async (taskNodeId) => {
      reads += 1;
      assert.equal(taskNodeId, contract.taskNodeId);
      return hostDescriptor;
    },
  });

  assert.deepEqual(await bridge.readCanonicalTask(contract.taskNodeId), hostContract);
  assert.equal(reads, 1);
});

test('public host descriptor read rejects a partial or mismatched fixed Task', async () => {
  const partial = createNativeBridge({
    config,
    readCanonicalDescriptor: async () => ({ contract }),
  });
  await assert.rejects(partial.readCanonicalTask(contract.taskNodeId), /unexpected fixed Task descriptor fields/);

  const mismatch = createNativeBridge({
    config,
    readCanonicalDescriptor: async () => ({ ...descriptor, contract: { ...contract, taskNodeId: 'TASK_other_456' } }),
  });
  await assert.rejects(mismatch.readCanonicalTask(contract.taskNodeId), /descriptor\/key mismatch/);
});

test('bridge forwards a host-stored READ Task only through native pre-provider admission', async () => {
  const readContract = Object.freeze({ ...contract, actionClass: 'read' });
  const readDescriptor = Object.freeze({ ...descriptor, contract: readContract });
  const calls = [];
  const bridge = createNativeBridge({
    config: Object.freeze({ ...config, tasks: [] }),
    readCanonicalDescriptor: async () => readDescriptor,
    runCanonicalReadOnly: async (request) => {
      calls.push(request);
      const identity = Object.freeze({ sessionKey: nativeWorkerSessionKey(config.workerAgentId, readContract.taskNodeId) });
      await request.beforeProvider(identity);
      return { runId: 'native-read-run', sessionKey: identity.sessionKey, execution: identity };
    },
  });
  let admitted = 0;

  const result = await bridge.runCanonicalReadOnly({
    taskNodeId: readContract.taskNodeId,
    ticketId: 'ticket-read-456',
    admit: async () => { admitted += 1; },
  });
  assert.equal(admitted, 1);
  assert.equal(result.runId, 'native-read-run');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].taskNodeId, readContract.taskNodeId);
  assert.equal(calls[0].ticketId, 'ticket-read-456');
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

test('fixture-only V7 lifecycle defers physical cleanup until final cleanup evidence', async () => {
  const runId = 'native-source-v7-run';
  const sessionKey = nativeWorkerSessionKey(config.workerAgentId, contract.taskNodeId);
  let finalReads = 0;
  let cleanupReads = 0;
  const sourceRunBinding = Object.freeze({
    kind: 'openclaw.readiness1.source-run-binding.v7',
    async launch(request) {
      assert.equal(request.taskNodeId, contract.taskNodeId);
      await request.beforeProvider(Object.freeze({ runId, sessionKey }));
      return Object.freeze({
        kind: 'openclaw.readiness1.source-run-binding.v7',
        runId,
        sessionKey,
        workspaceDir: contract.root,
        async readFinalEvidence() {
          finalReads += 1;
          return Object.freeze({
            kind: 'openclaw.readiness1.source-run-final-evidence.v1', state: 'CONFIRMED',
            runId, sessionKey, workspaceDir: contract.root, providerStarted: true,
            endedAt: 1_000, usage: 3,
            result: Object.freeze({ runId, sessionKey, digest: 'd'.repeat(64), byteLength: 12 }),
            snapshot: Object.freeze({ workspaceDir: contract.root, head: contract.head, indexDigest: 'c'.repeat(64), dirty: '' }),
          });
        },
        async readCleanupEvidence() {
          cleanupReads += 1;
          return Object.freeze({
            kind: 'openclaw.readiness1.source-run-cleanup-evidence.v1', state: 'CONFIRMED',
            runId, sessionKey, workspaceDir: contract.root,
          });
        },
      });
    },
  });
  const { tool, calls } = makeTool({ sourceRunBinding });
  let task = await activate(tool);
  task = (await tool.execute('dispatch', { action: 'dispatch', taskNodeId: contract.taskNodeId, expectedRevision: task.revision })).details.task;
  assert.equal(task.status, 'RUNNING');
  assert.equal(task.run.runId, runId);
  assert.equal(calls.some(([name]) => name === 'provider.work'), false);
  task = (await tool.execute('observe', { action: 'observe', taskNodeId: contract.taskNodeId, expectedRevision: task.revision })).details.task;
  assert.equal(task.status, 'ACTIVE');
  assert.equal(task.cleanup, 'pending');
  assert.equal(finalReads, 1);
  assert.equal(cleanupReads, 0);
  task = (await tool.execute('cleanup', { action: 'cleanup', taskNodeId: contract.taskNodeId, expectedRevision: task.revision })).details.task;
  assert.equal(task.status, 'DONE');
  assert.equal(task.cleanup, 'pass');
  assert.equal(cleanupReads, 1);
  assert.equal(calls.some(([name]) => name === 'worktree.remove'), false);
});

test('fixture-only V7 lifecycle keeps an unconfirmed final result OUTCOME_UNKNOWN', async () => {
  const runId = 'native-source-v7-unknown';
  const sessionKey = nativeWorkerSessionKey(config.workerAgentId, contract.taskNodeId);
  let cleanupReads = 0;
  const sourceRunBinding = Object.freeze({
    kind: 'openclaw.readiness1.source-run-binding.v7',
    async launch(request) {
      await request.beforeProvider(Object.freeze({ runId, sessionKey }));
      return Object.freeze({
        kind: 'openclaw.readiness1.source-run-binding.v7', runId, sessionKey, workspaceDir: contract.root,
        async readFinalEvidence() {
          return Object.freeze({ kind: 'openclaw.readiness1.source-run-final-evidence.v1', state: 'UNKNOWN', runId, sessionKey, workspaceDir: contract.root, providerStarted: false });
        },
        async readCleanupEvidence() {
          cleanupReads += 1;
          return Object.freeze({ kind: 'openclaw.readiness1.source-run-cleanup-evidence.v1', state: 'CONFIRMED', runId, sessionKey, workspaceDir: contract.root });
        },
      });
    },
  });
  const { tool } = makeTool({ sourceRunBinding });
  let task = await activate(tool);
  task = (await tool.execute('dispatch', { action: 'dispatch', taskNodeId: contract.taskNodeId, expectedRevision: task.revision })).details.task;
  const observed = (await tool.execute('observe', { action: 'observe', taskNodeId: contract.taskNodeId, expectedRevision: task.revision })).details;
  assert.equal(observed.reason, 'NATIVE_OBSERVATION_UNKNOWN');
  assert.equal(observed.task.status, 'OUTCOME_UNKNOWN');
  assert.equal(cleanupReads, 0);
});

test('fixture-only V7 lifecycle keeps an unconfirmed cleanup receipt OUTCOME_UNKNOWN', async () => {
  const runId = 'native-source-v7-cleanup-unknown';
  const sessionKey = nativeWorkerSessionKey(config.workerAgentId, contract.taskNodeId);
  const sourceRunBinding = Object.freeze({
    kind: 'openclaw.readiness1.source-run-binding.v7',
    async launch(request) {
      await request.beforeProvider(Object.freeze({ runId, sessionKey }));
      return Object.freeze({
        kind: 'openclaw.readiness1.source-run-binding.v7', runId, sessionKey, workspaceDir: contract.root,
        async readFinalEvidence() {
          return Object.freeze({
            kind: 'openclaw.readiness1.source-run-final-evidence.v1', state: 'CONFIRMED', runId, sessionKey, workspaceDir: contract.root, providerStarted: true, endedAt: 1_000, usage: 3,
            result: Object.freeze({ runId, sessionKey, digest: 'd'.repeat(64), byteLength: 12 }),
            snapshot: Object.freeze({ workspaceDir: contract.root, head: contract.head, indexDigest: 'c'.repeat(64), dirty: '' }),
          });
        },
        async readCleanupEvidence() {
          return Object.freeze({ kind: 'openclaw.readiness1.source-run-cleanup-evidence.v1', state: 'UNKNOWN', runId, sessionKey, workspaceDir: contract.root });
        },
      });
    },
  });
  const { tool } = makeTool({ sourceRunBinding });
  let task = await activate(tool);
  task = (await tool.execute('dispatch', { action: 'dispatch', taskNodeId: contract.taskNodeId, expectedRevision: task.revision })).details.task;
  task = (await tool.execute('observe', { action: 'observe', taskNodeId: contract.taskNodeId, expectedRevision: task.revision })).details.task;
  const cleanup = (await tool.execute('cleanup', { action: 'cleanup', taskNodeId: contract.taskNodeId, expectedRevision: task.revision })).details;
  assert.equal(cleanup.reason, 'CLEANUP_OUTCOME_UNKNOWN');
  assert.equal(cleanup.task.status, 'OUTCOME_UNKNOWN');
  assert.equal(cleanup.task.cleanup, 'pending');
});

test('closed catalog admits no fallback Task and rejects arbitrary overrides', async () => {
  const { tool } = makeTool();
  await assert.rejects(tool.execute('flow', { action: 'status', taskNodeId: contract.taskNodeId, flowId: 'legacy' }), /arbitrary input/);
  const unknown = await tool.execute('fallback', { action: 'status', taskNodeId: 'TASK_unknown' });
  assert.deepEqual(unknown.details, { ok: true, task: null });
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

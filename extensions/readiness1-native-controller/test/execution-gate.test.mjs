import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { EFFECT_CLASSES, OPERATIONS, selectIntent } from '../src/readiness2/catalog.js';
import { evaluatePreflight } from '../src/readiness2/preflight.js';
import { createResolver } from '../src/readiness2/resolver.js';
import { createExecutionGate } from '../src/readiness2/gate.js';
import {
  createSnapshotRunner,
  SNAPSHOT_CLOSURE,
} from '../src/readiness2/snapshot.js';
import { digest, scopeHash } from '../src/contract.js';
import {
  activate,
  contract as fixtureTask,
  makeTool,
} from './helpers.mjs';

function task() {
  return {
    schema: 'readiness1.task.v1',
    taskNodeId: 'TASK_execution_gate',
    repo: 'owner/repo',
    ref: 'refs/heads/codex/task',
    head: 'a'.repeat(40),
    root: '/state/worktrees/execution-gate',
    phase: 'work',
    role: 'dev-host',
    actionClass: 'source',
    originatingSession: 'agent:main:main',
    revisionHash: 'b'.repeat(64),
    deadline: 9_000,
    hardSunset: 10_000,
    limits: { attempts: 2, budget: 50, resumes: 1 },
    caps: {
      provider: 'codex',
      executionGate: {
        catalogHash: 'c'.repeat(64),
        resolverHash: 'd'.repeat(64),
        profileHashes: ['e'.repeat(64)],
        operationLimit: 8,
        grants: [{
          operation: 'source.work',
          class: 'filesystem',
          target: '/state/worktrees/execution-gate',
          category: 'none',
          maxAmount: 0,
        }],
      },
    },
  };
}

function descriptor(contract, effects = [{
  class: 'filesystem',
  target: contract.root,
  category: 'none',
  amount: 0,
  provenance: 'resolver',
  possible: true,
}]) {
  return {
    schema: 'execution-gate.descriptor.v1',
    operation: 'source.work',
    mode: 'OPS',
    route: 'specialist',
    role: 'dev-host',
    taskNodeId: contract.taskNodeId,
    epoch: 1,
    contractRevision: contract.revisionHash,
    scopeHash: scopeHash(contract),
    catalogHash: contract.caps.executionGate.catalogHash,
    resolverHash: contract.caps.executionGate.resolverHash,
    profileHash: contract.caps.executionGate.profileHashes[0],
    intent: null,
    dependencies: [],
    omissions: [],
    immutableIds: [],
    effects,
  };
}

function record(contract) {
  return {
    taskNodeId: contract.taskNodeId,
    epoch: 1,
    state: {
      contract,
      scopeHash: scopeHash(contract),
      receipt: { id: 'activation', valid: true, expiresAt: 8_000, scopeHash: scopeHash(contract) },
      status: 'ACTIVE',
      attempts: 0,
      spent: 0,
      reserved: 0,
      writer: null,
      cleanup: 'clear',
      gate: { operations: [], refusals: [], omissions: [], requests: [], stopRequested: false },
    },
  };
}

test('10.3 source port keeps the closed CHAT/READ/OPS catalog', () => {
  assert.equal(EFFECT_CLASSES.length, 14);
  assert.deepEqual(OPERATIONS['source.work'], ['OPS', 'specialist']);
  assert.deepEqual(selectIntent({ toolFree: true, operation: 'source.work' }), {
    mode: 'CHAT', operation: null, tools: false,
  });
  assert.equal(selectIntent({ requestedMode: 'READ', operation: 'source.work' }).mode, 'BLOCKED');
  assert.equal(selectIntent({ operation: 'unknown.operation' }).mode, 'UNKNOWN');
});

test('10.3 source port admits only an exact in-scope effect descriptor', () => {
  const contract = task();
  const resolved = descriptor(contract);
  const result = evaluatePreflight({
    descriptor: resolved,
    task: contract,
    record: record(contract),
    candidate: {},
    now: 1_000,
  });
  assert.equal(result.decision, 'AUTONOMOUS_WITHIN_SCOPE');
  assert.equal(result.descriptorDigest, digest(resolved));
  assert.equal(result.receiptId, 'activation');
});

test('10.3 source port blocks hidden effects without consuming authority', () => {
  const contract = task();
  const effects = [
    ...descriptor(contract).effects,
    {
      class: 'egress',
      target: 'https://unapproved.invalid',
      category: 'external',
      amount: 0,
      provenance: 'resolver',
      possible: true,
    },
  ];
  const result = evaluatePreflight({
    descriptor: descriptor(contract, effects),
    task: contract,
    record: record(contract),
    candidate: {},
    now: 1_000,
  });
  assert.equal(result.decision, 'BLOCKED');
  assert.match(result.reasons.join('\n'), /effects exceed claimed coverage/);
});

test('10.3 source port fails closed on incomplete descriptors and expired authority', () => {
  assert.equal(evaluatePreflight({ descriptor: null, now: 1_000 }).decision, 'UNKNOWN');
  const contract = task();
  const result = evaluatePreflight({
    descriptor: descriptor(contract),
    task: contract,
    record: record(contract),
    candidate: {},
    now: 8_000,
  });
  assert.equal(result.decision, 'OWNER_APPROVAL_REQUIRED');
  assert.match(result.reasons.join('\n'), /expired/);
});

test('G35 G38 G40 descriptor and capability schemas reject unknown or mutable fields', () => {
  const contract = task();
  const unknownField = { ...descriptor(contract), mutableHint: 'ignore-me' };
  assert.deepEqual(
    evaluatePreflight({
      descriptor: unknownField,
      task: contract,
      record: record(contract),
      now: 1_000,
    }),
    { decision: 'UNKNOWN', reasons: ['descriptor unknown'] },
  );
  const missingProvenance = descriptor(contract, [{
    class: 'filesystem',
    target: contract.root,
    category: 'none',
    amount: 0,
    possible: true,
  }]);
  assert.equal(evaluatePreflight({
    descriptor: missingProvenance,
    task: contract,
    record: record(contract),
    now: 1_000,
  }).decision, 'UNKNOWN');
  const invalidContract = structuredClone(contract);
  invalidContract.caps.executionGate.grants.push({
    operation: 'arbitrary.shell',
    class: 'command',
    target: 'sh',
    category: 'none',
    maxAmount: 0,
  });
  const invalid = evaluatePreflight({
    descriptor: descriptor(invalidContract),
    task: invalidContract,
    record: record(invalidContract),
    now: 1_000,
  });
  assert.equal(invalid.decision, 'BLOCKED');
  assert.match(invalid.reasons.join('\n'), /invalid Execution Gate capability/);
});

test('10.3 source port resolves only hash-pinned artifacts and complete native capability states', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'readiness2-native-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const taskRoot = path.join(root, 'task');
  const artifactRoot = path.join(root, 'artifacts');
  await fs.mkdir(taskRoot);
  await fs.mkdir(artifactRoot);

  const writePinned = async (name, value) => {
    const file = path.join(artifactRoot, name);
    const content = typeof value === 'string' ? value : JSON.stringify(value);
    await fs.writeFile(file, content);
    return { path: await fs.realpath(file), sha256: createHash('sha256').update(content).digest('hex') };
  };
  const contentId = await writePinned('source.mjs', 'export const fixture = true;\n');
  const profile = await writePinned('profile.json', {
    schema: 'execution-gate.profile.v1',
    id: 'source-profile',
    route: 'specialist',
    capabilities: [{
      class: 'filesystem',
      target: '$TASK_ROOT',
      category: 'none',
      amount: 0,
    }],
  });
  const catalog = await writePinned('catalog.json', {
    schema: 'execution-gate.catalog.v1',
    version: 1,
    entries: {
      'source.work': {
        mode: 'OPS',
        route: 'specialist',
        role: 'dev-host',
        profile: 'source-profile',
        enforcement: 'native',
        contentIds: [contentId],
      },
    },
  });
  const build = await writePinned('resolver.mjs', 'export const resolverBuild = 1;\n');
  const contract = { ...task(), root: taskRoot };
  const completeStates = Object.fromEntries(EFFECT_CLASSES.map((name) => [
    name,
    name === 'filesystem' ? 'POSSIBLE' : 'DENIED',
  ]));
  const inspectNative = async (ids) => ({
    source: 'native',
    enforcement: 'accepted',
    states: completeStates,
    ...ids,
  });
  const resolver = createResolver({
    catalog,
    build,
    profiles: { 'source-profile': profile },
    inspectNative,
  });
  const resolved = await resolver.resolve({
    operation: 'source.work',
    requestedMode: 'OPS',
  }, contract, record(contract));
  assert.equal(resolved.descriptor.effects.length, 1);
  assert.equal(resolved.descriptor.effects[0].target, taskRoot);
  assert.deepEqual(resolved.descriptor.immutableIds, [contentId]);

  const incompleteResolver = createResolver({
    catalog,
    build,
    profiles: { 'source-profile': profile },
    inspectNative: async (ids) => ({
      source: 'native',
      enforcement: 'accepted',
      states: { ...completeStates, egress: 'POSSIBLE' },
      ...ids,
    }),
  });
  await assert.rejects(
    incompleteResolver.resolve({ operation: 'source.work', requestedMode: 'OPS' }, contract, record(contract)),
    /unmodelled capability/,
  );
});

function coordinationDescriptor(record, effects) {
  return {
    schema: 'execution-gate.descriptor.v1',
    operation: 'comment.append',
    mode: 'OPS',
    route: 'coordination',
    role: 'main',
    taskNodeId: fixtureTask.taskNodeId,
    epoch: record.epoch,
    contractRevision: fixtureTask.revisionHash,
    scopeHash: scopeHash(fixtureTask),
    catalogHash: fixtureTask.caps.executionGate.catalogHash,
    resolverHash: fixtureTask.caps.executionGate.resolverHash,
    profileHash: fixtureTask.caps.executionGate.profileHashes[0],
    intent: null,
    dependencies: [],
    omissions: record.state.gate?.omissions ?? [],
    immutableIds: [],
    effects,
  };
}

function fixtureGate({
  ledger,
  approval,
  invokeImmutable,
  effects = [{
    class: 'filesystem',
    target: fixtureTask.root,
    category: 'none',
    amount: 0,
    provenance: 'resolver',
    possible: true,
  }],
  candidate = {},
  now = () => 1_000,
}) {
  return createExecutionGate({
    ledger,
    approval,
    assertCurrent() {},
    now,
    policy: {
      ownerDevicePins: ['owner-device'],
      controllerDeviceId: 'controller-device',
    },
    readCandidate: async ({ candidateId }) => ({
      id: candidateId,
      taskNodeId: fixtureTask.taskNodeId,
      operation: 'comment.append',
      requestedMode: 'OPS',
      ...candidate,
    }),
    resolver: {
      async resolve(_candidate, _task, record) {
        return {
          descriptor: coordinationDescriptor(record, effects),
          immutable: { contents: [] },
        };
      },
    },
    invokeImmutable,
  });
}

test('fixture-only gate binds the v2 ledger, authorizes once, and cancel blocks later effects', async () => {
  const { tool, ledger, approval } = makeTool();
  await activate(tool);
  const assertCurrent = () => {};
  let record = await ledger.read(fixtureTask.taskNodeId, assertCurrent);
  let invocations = 0;
  const gate = fixtureGate({
    ledger,
    approval,
    async invokeImmutable(input) {
      invocations += 1;
      await input.authorizeFirstEffect();
      return {
        confirmed: true,
        immutableIds: input.descriptor.immutableIds,
        usage: 0,
        result: 'CONFIRMED',
      };
    },
  });

  const result = await gate.execute(fixtureTask, record, {
    action: 'operation.apply',
    candidateId: 'fixture-operation',
  });
  assert.equal(result.decision, 'AUTONOMOUS_WITHIN_SCOPE');
  assert.equal(result.observation, 'CONFIRMED');
  assert.equal(invocations, 1);

  record = await ledger.read(fixtureTask.taskNodeId, assertCurrent);
  assert.equal(record.state.gate.operations.at(-1).state, 'CONFIRMED');
  record = await gate.execute(fixtureTask, record, { action: 'gate.cancel' });
  assert.equal(record.state.gate.stopRequested, true);

  const blocked = await gate.execute(fixtureTask, record, {
    action: 'operation.apply',
    candidateId: 'fixture-operation',
  });
  assert.equal(blocked.decision, 'BLOCKED');
  assert.equal(invocations, 1);
});

test('fixture-only gate keeps a started but unconfirmed operation sticky UNKNOWN', async () => {
  const { tool, ledger, approval } = makeTool();
  await activate(tool);
  const assertCurrent = () => {};
  const record = await ledger.read(fixtureTask.taskNodeId, assertCurrent);
  let invocations = 0;
  const gate = fixtureGate({
    ledger,
    approval,
    async invokeImmutable(input) {
      invocations += 1;
      await input.authorizeFirstEffect();
      return { confirmed: false };
    },
  });

  const first = await gate.execute(fixtureTask, record, {
    action: 'operation.apply',
    candidateId: 'uncertain-operation',
  });
  assert.equal(first.decision, 'UNKNOWN');
  assert.equal(first.observation, 'OUTCOME_UNKNOWN');

  const unknown = await ledger.read(fixtureTask.taskNodeId, assertCurrent);
  assert.equal(unknown.state.status, 'OUTCOME_UNKNOWN');
  assert.equal(unknown.state.gate.operations.at(-1).state, 'UNKNOWN');
  const retry = await gate.execute(fixtureTask, unknown, {
    action: 'operation.apply',
    candidateId: 'uncertain-operation',
  });
  assert.equal(retry.decision, 'BLOCKED');
  assert.equal(invocations, 1);
});

test('fixture-only operation approval is bound and consumed once in the v2 ledger', async () => {
  const { tool, ledger, approval } = makeTool();
  await activate(tool);
  const assertCurrent = () => {};
  let record = await ledger.read(fixtureTask.taskNodeId, assertCurrent);
  const effects = [{
    class: 'externalSend',
    target: 'fixed-owner-target',
    category: 'external',
    amount: 0,
    provenance: 'resolver',
    possible: true,
  }];
  const gate = fixtureGate({
    ledger,
    approval,
    effects,
    candidate: { coverageClaim: { kind: 'new' } },
    async invokeImmutable(input) {
      await input.authorizeFirstEffect();
      return {
        confirmed: true,
        immutableIds: input.descriptor.immutableIds,
        usage: 0,
        result: 'SENT',
      };
    },
  });

  const requested = await gate.execute(fixtureTask, record, {
    action: 'operation.request',
    candidateId: 'owner-operation',
  });
  assert.equal(requested.decision, 'OWNER_APPROVAL_REQUIRED');
  assert.match(requested.approvalId, /^plugin:/);
  record = await ledger.read(fixtureTask.taskNodeId, assertCurrent);
  assert.equal(record.approvals[requested.approvalId].state, 'requested');

  const applied = await gate.execute(fixtureTask, record, {
    action: 'operation.apply',
    candidateId: 'owner-operation',
    approvalId: requested.approvalId,
  });
  assert.equal(applied.decision, 'OWNER_APPROVAL_REQUIRED');
  assert.equal(applied.observation, 'SENT');
  record = await ledger.read(fixtureTask.taskNodeId, assertCurrent);
  assert.equal(record.approvals[requested.approvalId].state, 'spent');
  assert.equal(
    record.appliedReceiptIds.filter((id) => id === requested.approvalId).length,
    1,
  );
  await assert.rejects(
    gate.execute(fixtureTask, record, {
      action: 'operation.apply',
      candidateId: 'owner-operation',
      approvalId: requested.approvalId,
    }),
    /not an unused operation approval/,
  );
});

test('native-expired operation approval remains a refusal tombstone before local expiry', async () => {
  const clock = 1_000;
  const { tool, ledger, approval } = makeTool({ now: () => clock });
  await activate(tool);
  const assertCurrent = () => {};
  let record = await ledger.read(fixtureTask.taskNodeId, assertCurrent);
  const effects = [{
    class: 'externalSend',
    target: 'fixed-owner-target',
    category: 'external',
    amount: 0,
    provenance: 'resolver',
    possible: true,
  }];
  const gate = fixtureGate({
    ledger,
    approval,
    effects,
    candidate: { coverageClaim: { kind: 'new' } },
    now: () => clock,
    async invokeImmutable() {
      throw new Error('expired approval must not execute');
    },
  });
  const requested = await gate.execute(fixtureTask, record, {
    action: 'operation.request',
    candidateId: 'expiring-operation',
  });
  record = await ledger.read(fixtureTask.taskNodeId, assertCurrent);
  const observed = await ledger.observeOperation(
    fixtureTask.taskNodeId,
    record.revision,
    requested.approvalId,
    async () => ({ status: 'expired' }),
    clock,
    assertCurrent,
  );
  assert.equal(observed.state, 'burned');
  record = await ledger.read(fixtureTask.taskNodeId, assertCurrent);
  assert.equal(record.approvals[requested.approvalId].reason, 'expiry');
  assert.deepEqual(
    record.state.gate.refusals.map(({ reason, descriptorDigest }) => ({
      reason,
      descriptorDigest,
    })),
    [{ reason: 'expiry', descriptorDigest: requested.descriptorDigest }],
  );
});

test('mismatched top-level operation Task ID cannot bind another ledger', async () => {
  const { tool, ledger, approval } = makeTool();
  await activate(tool);
  const assertCurrent = () => {};
  const record = await ledger.read(fixtureTask.taskNodeId, assertCurrent);
  const mismatchedApproval = {
    ...approval,
    async requestPrepared(card) {
      const binding = await approval.requestPrepared(card);
      return { ...binding, taskNodeId: 'TASK_foreign' };
    },
  };
  const gate = fixtureGate({
    ledger,
    approval: mismatchedApproval,
    effects: [{
      class: 'externalSend',
      target: 'fixed-owner-target',
      category: 'external',
      amount: 0,
      provenance: 'resolver',
      possible: true,
    }],
    candidate: { coverageClaim: { kind: 'new' } },
    async invokeImmutable() {
      throw new Error('mismatched approval must not execute');
    },
  });
  await assert.rejects(
    gate.execute(fixtureTask, record, {
      action: 'operation.request',
      candidateId: 'mismatched-operation',
    }),
    /native operation binding mismatch/,
  );
  const blocked = await ledger.read(fixtureTask.taskNodeId, assertCurrent);
  assert.equal(blocked.state.status, 'OUTCOME_UNKNOWN');
  assert.deepEqual(Object.keys(blocked.approvals), ['plugin:1']);
  assert.equal(blocked.approvals['plugin:1'].binding.purpose, 'activation');
  assert.equal(blocked.approvals['plugin:1'].state, 'spent');
  assert.equal(await ledger.read('TASK_foreign', assertCurrent), null);
});

test('operation approval cannot substitute the prepared Owner-visible card', async () => {
  const { tool, ledger, approval } = makeTool();
  await activate(tool);
  const assertCurrent = () => {};
  const record = await ledger.read(fixtureTask.taskNodeId, assertCurrent);
  const substitutedApproval = {
    ...approval,
    async requestPrepared(card) {
      const binding = await approval.requestPrepared(card);
      const presentation = {
        ...binding.presentation,
        title: 'Substituted operation approval',
      };
      return {
        ...binding,
        presentation,
        renderedCardHash: digest(presentation),
      };
    },
  };
  const gate = fixtureGate({
    ledger,
    approval: substitutedApproval,
    effects: [{
      class: 'externalSend',
      target: 'fixed-owner-target',
      category: 'external',
      amount: 0,
      provenance: 'resolver',
      possible: true,
    }],
    candidate: { coverageClaim: { kind: 'new' } },
    async invokeImmutable() {
      throw new Error('substituted approval must not execute');
    },
  });
  await assert.rejects(
    gate.execute(fixtureTask, record, {
      action: 'operation.request',
      candidateId: 'substituted-card-operation',
    }),
    /native operation binding mismatch/,
  );
  const blocked = await ledger.read(fixtureTask.taskNodeId, assertCurrent);
  assert.equal(blocked.state.status, 'OUTCOME_UNKNOWN');
  assert.deepEqual(Object.keys(blocked.approvals), ['plugin:1']);
});

test('G12 G13 fixed snapshot runner classifies unchanged and busy without retry', async () => {
  const approvedBase = '1'.repeat(40);
  const entries = SNAPSHOT_CLOSURE.map((relativePath, index) => {
    const content = `fixture-${index}`;
    return {
      relativePath,
      path: `/immutable/${index}`,
      sha256: digest(content),
      content,
    };
  });
  const expectedIds = entries.map(({ path: entryPath, sha256 }) => ({
    path: entryPath,
    sha256,
  }));
  const observation = {
    source: 'native',
    dedicated: true,
    snapshotPath: 'docs/consultation/current-runtime-snapshot.md',
    head: approvedBase,
    remoteHead: approvedBase,
    snapshotDigest: '2'.repeat(64),
    changedPaths: [],
    identity: { checkout: 'fixed-snapshot-fixture' },
  };
  let launches = 0;
  let effects = 0;
  const reports = [
    { status: 'UNCHANGED', publication: 'not_attempted', reason: 'snapshot_unchanged' },
    { status: 'BUSY', publication: 'not_attempted', reason: 'snapshot_busy' },
  ];
  const runner = createSnapshotRunner({
    scriptId: {
      path: entries[0].path,
      sha256: entries[0].sha256,
    },
    dependencies: entries.slice(1).map(
      ({ relativePath, path: entryPath, sha256 }) => ({
        relativePath,
        path: entryPath,
        sha256,
      }),
    ),
    approvedBase,
    readback: async () => structuredClone(observation),
    launchFixed: async () => {
      launches += 1;
      return {
        source: 'native',
        exitCode: 0,
        loadedImmutableIds: expectedIds,
        syncBaseObserved: approvedBase,
        stdout: JSON.stringify(reports.shift()),
        stderr: '',
      };
    },
  });
  const input = {
    descriptor: {
      operation: 'snapshot.update',
      route: 'snapshot-runner',
      snapshotBase: approvedBase,
      immutableIds: expectedIds,
    },
    immutable: {
      contents: entries.map(({ path: entryPath, sha256, content }) => ({
        path: entryPath,
        sha256,
        content,
      })),
    },
    async authorizeFirstEffect() {
      effects += 1;
    },
  };
  const result = await runner(input);
  assert.deepEqual(result, {
    confirmed: true,
    result: 'UNCHANGED',
    immutableIds: expectedIds,
    usage: 0,
  });
  const busy = await runner(input);
  assert.equal(busy.result, 'BUSY');
  assert.equal(busy.confirmed, true);
  assert.equal(launches, 2);
  assert.equal(effects, 2);
});

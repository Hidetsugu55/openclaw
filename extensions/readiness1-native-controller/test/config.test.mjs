import assert from 'node:assert/strict';
import test from 'node:test';
import plugin from '../index.js';
import { TOOL_ACTIONS } from '../src/controller.js';
import { config, descriptor, memoryStore } from './helpers.mjs';

const { pluginId: _pluginId, ...base } = config;

function register(pluginConfig) {
  plugin.register({
    pluginConfig,
    runtime: {
      version: '2026.10.3', state: { openKeyedStore: () => memoryStore() },
      config: { current: () => ({}) }, gateway: {}, worktrees: {}, sandbox: {}, subagent: {},
    },
    registerTool() {},
  });
}

function directOwnerContext(overrides = {}) {
  const { originTrigger = 'direct-user', deviceId = 'owner-device', ...rest } = overrides;
  const ctx = {
    agentId: 'main',
    sessionKey: 'agent:main:main',
    senderIsOwner: true,
    requesterSenderId: 'owner-1',
    messageChannel: 'webchat',
    sandboxed: false,
    assertInvocationCurrent() {},
    ...rest,
  };
  Object.defineProperties(ctx, {
    originTrigger: { configurable: false, enumerable: true, value: originTrigger, writable: false },
    deviceId: { configurable: false, enumerable: true, value: deviceId, writable: false },
  });
  return ctx;
}

function captureRegistration(apiOverrides = {}) {
  let registration;
  const api = {
    pluginConfig: base,
    registerTool(value) { registration = value; },
  };
  Object.defineProperties(api, Object.getOwnPropertyDescriptors(apiOverrides));
  plugin.register(api);
  assert.ok(registration?.create);
  assert.equal(registration.contextVersion, 2);
  return { api, registration };
}

test('plugin config accepts only fixed canonical Tasks, worker, approval pins, budgets, and routes', () => {
  assert.doesNotThrow(() => register(base));
  assert.throws(() => register({ ...base, workerAgentId: 'dev:host' }), /invalid workerAgentId/);
  assert.throws(() => register({ ...base, controllerDeviceId: 'owner-device' }), /invalid controllerDeviceId/);
  assert.throws(() => register({ ...base, dispatchReservation: 101 }), /exceeds canonical Task budget/);
  assert.throws(() => register({ ...base, tasks: [{ ...descriptor, repoRoot: '/override' }] }), /unexpected fixed Task descriptor fields/);
  assert.throws(() => register({ ...base, arbitraryRecipient: 'someone' }), /unexpected Readiness/);
});

test('manifest exports only the closed readiness1_task surface', async () => {
  const manifest = JSON.parse(await (await import('node:fs/promises')).readFile(new URL('../openclaw.plugin.json', import.meta.url), 'utf8'));
  assert.deepEqual(manifest.contracts.tools, ['readiness1_task']);
  const serialized = JSON.stringify(manifest);
  assert.doesNotMatch(serialized, /pilot_flow|managedFlows|TaskFlow/);
});

test('host-attested direct paired owner reaches only the no-effect controller entry', async () => {
  let effectAdapterReads = 0;
  const poison = () => {
    effectAdapterReads += 1;
    throw new Error('effect adapter must not be reachable');
  };
  const { registration } = captureRegistration({
    get runtime() { return poison(); },
    get sessions() { return poison(); },
    get gateway() { return poison(); },
    get message() { return poison(); },
  });
  let current = true;
  let currentAssertions = 0;
  const tool = registration.create(directOwnerContext({
    assertInvocationCurrent() {
      currentAssertions += 1;
      if (!current) throw new Error('stale host provenance');
    },
  }));
  assert.ok(tool);
  assert.equal(tool.name, 'readiness1_task');
  assert.equal(currentAssertions, 1);
  await assert.rejects(tool.execute('arbitrary', { action: 'dispatch', repo: 'evil/repo' }), /arbitrary input/);
  await assert.rejects(tool.execute('dispatch', { action: 'dispatch' }), /EXECUTION_START_ADMISSION_CONTROLLER_WIRING_UNAVAILABLE/);
  await assert.rejects(tool.execute('coordination', { action: 'ready.consume' }), /FIXED_GITHUB_PUBLIC_SURFACE_UNAVAILABLE/);
  for (const action of TOOL_ACTIONS.filter((action) => action !== 'status')) {
    await assert.rejects(tool.execute('production-route', { action }), /UNAVAILABLE/);
  }
  await assert.rejects(
    tool.execute('status', { action: 'status', taskNodeId: descriptor.contract.taskNodeId }),
    /effect adapter must not be reachable/,
  );
  assert.equal(effectAdapterReads, 1);

  current = false;
  await assert.rejects(tool.execute('stale', { action: 'status' }), /OWNER_DIRECT_CONTEXT_STALE_OR_UNATTESTED/);
  assert.equal(effectAdapterReads, 1);
  assert.ok(currentAssertions >= TOOL_ACTIONS.length + 5);
});

test('only a host-issued runtime binding makes the durable status route available', async () => {
  const store = memoryStore();
  const binding = Object.freeze({
    kind: 'openclaw.readiness1.host-binding.v1',
    openLedgerStore() { return store; },
    async readCanonicalDescriptor() { return descriptor; },
    async runCanonicalReadOnly() { throw new Error('read-only run must stay unreachable from status'); },
  });
  const { registration } = captureRegistration({ runtime: { readiness1HostBinding: binding } });
  const tool = registration.create(directOwnerContext());
  const result = await tool.execute('status', { action: 'status', taskNodeId: descriptor.contract.taskNodeId });
  assert.deepEqual(result.details, { ok: true, task: null });
  await assert.rejects(
    tool.execute('dispatch', { action: 'dispatch', taskNodeId: descriptor.contract.taskNodeId, expectedRevision: 0 }),
    /EXECUTION_START_ADMISSION_CONTROLLER_WIRING_UNAVAILABLE/,
  );
});

test('a partial or config-derived binding remains fail closed', async () => {
  const partial = captureRegistration({ runtime: { readiness1HostBinding: Object.freeze({ kind: 'openclaw.readiness1.host-binding.v1' }) } });
  const partialTool = partial.registration.create(directOwnerContext());
  await assert.rejects(
    partialTool.execute('status', { action: 'status', taskNodeId: descriptor.contract.taskNodeId }),
    /READINESS1_HOST_BINDING_INVALID/,
  );

  const configured = captureRegistration({ runtime: {} });
  const configuredTool = configured.registration.create(directOwnerContext());
  await assert.rejects(
    configuredTool.execute('status', { action: 'status', taskNodeId: descriptor.contract.taskNodeId }),
    /CANONICAL_LEDGER_PUBLIC_SURFACE_UNAVAILABLE/,
  );
});

test('direct owner receives no tool unless sandboxed is exactly false', () => {
  const { registration } = captureRegistration();
  const absent = directOwnerContext();
  delete absent.sandboxed;

  for (const { label, context } of [
    { label: 'absent', context: absent },
    { label: 'null', context: directOwnerContext({ sandboxed: null }) },
    { label: 'string', context: directOwnerContext({ sandboxed: 'false' }) },
    { label: 'numeric', context: directOwnerContext({ sandboxed: 0 }) },
    { label: 'true', context: directOwnerContext({ sandboxed: true }) },
  ]) assert.equal(registration.create(context), null, label);
});

test('forged, missing, foreign, stale, channel, cron, queue, and subagent origins are not registered', () => {
  const { registration } = captureRegistration();
  const forged = {
    agentId: 'main', sessionKey: 'agent:main:main', senderIsOwner: true,
    requesterSenderId: 'owner-1', originTrigger: 'direct-user', deviceId: 'owner-device',
    sandboxed: false, assertInvocationCurrent() {},
  };
  assert.equal(registration.create(forged), null);

  for (const mutation of [
    { senderIsOwner: false },
    { requesterSenderId: '' },
    { sessionKey: 'agent:main:other' },
    { agentId: 'worker' },
    { deviceId: 'foreign-device' },
    { assertInvocationCurrent() { throw new Error('stale'); } },
  ]) assert.equal(registration.create(directOwnerContext(mutation)), null);

  const routeBase = {
    agentId: 'main', sessionKey: 'agent:main:main', senderIsOwner: true,
    requesterSenderId: 'owner-1', sandboxed: false, assertInvocationCurrent() {},
  };
  for (const route of [
    { label: 'missing', context: routeBase },
    { label: 'channel', context: { ...routeBase, messageChannel: 'slack' } },
    { label: 'cron', context: { ...routeBase, messageChannel: 'cron' } },
    { label: 'queue', context: { ...routeBase, toolBindings: { origin: 'followup-queue' } } },
    { label: 'subagent', context: { ...routeBase, toolBindings: { spawnedBy: 'agent:main:main' } } },
  ]) assert.equal(registration.create(route.context), null, route.label);
});

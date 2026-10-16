import { createApprovalAdapter } from '../src/core/approval.js';
import { approvalCard } from '../src/core/approval.js';
import { createAcceptanceExecutor } from '../src/acceptance.js';
import { createReadinessTool } from '../src/controller.js';
import { createLedger } from '../src/ledger.js';
import { createNativeBridge } from '../src/native-bridge.js';

export function memoryStore() {
  const values = new Map();
  const generations = new Map();
  const store = {
    withCurrent({ assertCurrent }) { assertCurrent(); return store; },
    async registerIfAbsent(key, value) {
      if (values.has(key)) return false;
      values.set(key, structuredClone(value)); generations.set(key, 1); return true;
    },
    async register(key, value) { values.set(key, structuredClone(value)); generations.set(key, (generations.get(key) ?? 0) + 1); },
    async lookup(key) { return values.has(key) ? structuredClone(values.get(key)) : undefined; },
    async observe(key) { return { value: values.has(key) ? structuredClone(values.get(key)) : undefined, comparison: `${generations.get(key) ?? 0}` }; },
    async compareAndApply(key, comparison, intent) {
      if (`${generations.get(key) ?? 0}` !== comparison) return { status: 'conflict', current: await this.observe(key) };
      if (intent.action === 'set') { values.set(key, structuredClone(intent.value)); generations.set(key, (generations.get(key) ?? 0) + 1); return { status: 'applied' }; }
      return { status: 'unchanged' };
    },
  };
  return store;
}

export const contract = Object.freeze({
  schema: 'readiness1.task.v1', taskNodeId: 'TASK_node_123', repo: 'owner/repo',
  ref: 'refs/heads/main', head: 'a'.repeat(40), revisionHash: 'b'.repeat(64),
  root: '/state/worktrees/wt-1', phase: 'work', role: 'dev-host', actionClass: 'source',
  originatingSession: 'agent:main:main', deadline: 900_000, hardSunset: 1_000_000,
  limits: { attempts: 2, budget: 100, resumes: 1 },
  caps: {
    provider: 'codex',
    executionGate: {
      operationLimit: 8,
      catalogHash: 'd'.repeat(64),
      resolverHash: 'e'.repeat(64),
      profileHashes: ['f'.repeat(64)],
      grants: [
        {
          operation: 'source.work',
          class: 'filesystem',
          target: '/state/worktrees/wt-1',
          category: 'none',
          maxAmount: 0,
        },
        {
          operation: 'comment.append',
          class: 'filesystem',
          target: '/state/worktrees/wt-1',
          category: 'none',
          maxAmount: 0,
        },
        {
          operation: 'comment.append',
          class: 'externalSend',
          target: 'fixed-owner-target',
          category: 'external',
          maxAmount: 0,
        },
      ],
    },
  },
});

export const descriptor = Object.freeze({
  contract,
  indexDigest: 'c'.repeat(64),
  instructions: 'Implement the bounded canonical Task and return a concise result.',
  sourceRoot: '/repo', worktreeName: 'readiness1-task-node-123', worktreeBranch: 'codex/task-node-123',
});

export const config = Object.freeze({
  pluginId: 'readiness1-native-controller', controllerAgents: ['main'],
  controllerSessionKeys: ['agent:main:main'], workerAgentId: 'dev-host',
  ownerSenderId: 'owner-1', ownerSessionKeys: ['agent:main:main'],
  ownerTarget: { channel: 'slack', accountId: 'primary', recipientId: 'UOWNER' },
  ownerDevicePins: ['owner-device'], controllerDeviceId: 'controller-device',
  cliVersions: { 'claude-code': '2.0.0', codex: '1.0.0' }, dispatchReservation: 10,
  notification: { evidenceRepos: ['owner/repo'], taskRateCap: 4 }, tasks: [descriptor],
});

export function approvalHarness(now = () => 1_000) {
  const bindings = new Map();
  const adapter = createApprovalAdapter({
    pluginId: config.pluginId, now,
    async requestApprovalRpc(params) {
      const id = `plugin:${bindings.size + 1}`;
      const binding = { id, expiresAtMs: now() + 10_000, presentation: { kind: 'plugin', ...params, timeoutMs: undefined, twoPhase: undefined } };
      delete binding.presentation.timeoutMs; delete binding.presentation.twoPhase;
      bindings.set(id, binding);
      return { id, expiresAtMs: binding.expiresAtMs };
    },
    async getApprovalRpc({ id }) {
      const binding = bindings.get(id);
      if (!binding) return { approval: undefined };
      return { approval: { id, status: 'allowed', decision: 'allow-once', reason: 'user', createdAtMs: now(), resolvedAtMs: now() + 1, expiresAtMs: binding.expiresAtMs, resolver: { kind: 'device', id: 'owner-device' }, presentation: binding.presentation } };
    },
  });
  return { adapter, bindings };
}

export function makeTool(overrides = {}) {
  const now = overrides.now ?? (() => 1_000);
  const ledger = createLedger(memoryStore(), now);
  const calls = [];
  const runtime = {
    config: { current: () => ({}) },
    gateway: { isAvailable: async () => true },
    worktrees: {
      async resolveCheckoutRoot({ path }) { calls.push(['resolve', path]); return overrides.checkoutRoot ?? path; },
      async create(params) { calls.push(['worktree.create', params]); return overrides.worktree ?? { id: 'wt-1', path: contract.root, branch: descriptor.worktreeBranch }; },
      async release(params) { calls.push(['worktree.release', params]); },
      async removeIfLossless(params) { calls.push(['worktree.remove', params]); return overrides.removeIfLossless ?? true; },
    },
    sandbox: {
      async prepareWorkspaceAuthority(params) { calls.push(['sandbox.prepare', params]); if (overrides.sandboxError) throw overrides.sandboxError; return { sandboxed: true, workspaceAccess: 'rw' }; },
    },
  };
  const bridge = createNativeBridge({
    config,
    prepareWorkspaceFixture: Object.hasOwn(overrides, 'prepareWorkspaceFixture') ? overrides.prepareWorkspaceFixture : async ({ sourceRoot, worktreeName, worktreeBranch, sessionKey, requiredToolNames }) => {
      const resolved = await runtime.worktrees.resolveCheckoutRoot({ path: sourceRoot });
      if (resolved !== sourceRoot) throw new Error('fixed repository root identity mismatch');
      const created = await runtime.worktrees.create({ repoRoot: sourceRoot, name: worktreeName, baseRef: contract.ref });
      const authority = await runtime.sandbox.prepareWorkspaceAuthority({ agentId: config.workerAgentId, sessionKey, workspaceDir: created.path, confinedToolNames: [], requiredToolNames });
      return { ...created, branch: created.branch ?? worktreeBranch, ...authority };
    },
    snapshotWorkspace: Object.hasOwn(overrides, 'snapshotWorkspace') ? overrides.snapshotWorkspace : async () => ({ repo: contract.repo, worktree: contract.root, head: contract.head, dirty: '', indexDigest: 'c'.repeat(64) }),
    readCapacity: Object.hasOwn(overrides, 'readCapacity') ? overrides.readCapacity : async () => ({ provider: 'codex', version: '1.0.0', source: 'native-structured', workCalls: 0, capacity: 'available', paidOverflow: 'off' }),
    startReservedExecution: Object.hasOwn(overrides, 'startReservedExecution') ? overrides.startReservedExecution : async ({ descriptor: request, admitExecutionStart }) => {
      calls.push(['execution.admit.request', request]);
      if (overrides.admissionError) throw overrides.admissionError;
      await admitExecutionStart();
      calls.push(['provider.work', request]);
      if (overrides.runError) throw overrides.runError;
      return overrides.runReceipt ?? { runId: request.idempotencyKey, sessionKey: request.sessionKey };
    },
    observeNativeRun: Object.hasOwn(overrides, 'observeNativeRun') ? overrides.observeNativeRun : async (binding) => {
      calls.push(['native.observe', binding]);
      return overrides.waitResult ?? {
        schema: 'readiness1.native-observation.v1', ...binding, status: 'ok', providerStarted: true,
        terminalStatus: 'ok', stopReason: 'completed', processStopped: true, groupStopped: true,
        containerRemoved: true, lsofClear: true, cleanWorktree: true, durableResults: true,
        sideEffects: 'none', usage: 3,
        snapshot: { repo: contract.repo, worktree: contract.root, head: contract.head, dirty: '', indexDigest: 'c'.repeat(64) },
      };
    },
    cleanupWorkspace: Object.hasOwn(overrides, 'cleanupWorkspace') ? overrides.cleanupWorkspace : async ({ taskNodeId, root }) => {
      calls.push(['worktree.remove', { taskNodeId, root }]);
      return { schema: 'readiness1.finish-receipt.v1', receiptId: 'finish-0001', taskNodeId, root, workspaceRemoved: true, releaseConfirmed: true, postRemovalLsofClear: true, auditConfirmed: true, observedAt: now() };
    },
    ownerApprovalAvailable: async () => true,
    sendFixedOwnerDM: async () => ({ confirmed: true }),
    coordinateFixedTask: overrides.coordinateFixedTask ?? (async () => ({ confirmed: true })),
  });
  const approvalState = approvalHarness(now);
  const approval = overrides.approval ?? approvalState.adapter;
  const executionGate = overrides.executionGateFactory?.({
    approval,
    bridge,
    ledger,
    now,
  }) ?? null;
  const acceptance = createAcceptanceExecutor({ publicationStore: memoryStore(), runtimeVersion: '2026.10.3', getConfig: () => ({}) });
  const ctx = { agentId: 'main', sessionKey: 'agent:main:main', senderIsOwner: true, requesterSenderId: 'owner-1', originTrigger: 'direct-user', deviceId: 'owner-device', sandboxed: false, assertInvocationCurrent() {} };
  const tool = createReadinessTool({
    config,
    ctx,
    ledger,
    approval,
    bridge,
    acceptance,
    executionGate,
    readSafeProjection: overrides.readSafeProjection,
    fixtureOnly: true,
    now,
  });
  return { tool, ledger, calls, runtime, approval, approvalState, executionGate };
}

export async function activate(tool) {
  const requested = (await tool.execute('approval', { action: 'approval.request', taskNodeId: contract.taskNodeId })).details;
  const activated = (await tool.execute('activate', { action: 'activate', taskNodeId: contract.taskNodeId, expectedRevision: requested.revision, approvalId: requested.approvalId })).details;
  return activated.task;
}

import { createAcceptanceExecutor } from './src/acceptance.js';
import { PLUGIN_ID, requireThat, validateTaskDescriptor } from './src/contract.js';
import { createReadinessTool, TOOL_NAME, TOOL_SCHEMA } from './src/controller.js';
import { createLedger } from './src/ledger.js';
import { createNativeBridge } from './src/native-bridge.js';
import { createExecutionGate } from './src/readiness2/gate.js';
import { createResolver } from './src/readiness2/resolver.js';
import { createSnapshotRunner } from './src/readiness2/snapshot.js';

function stringList(value, name) {
  requireThat(Array.isArray(value) && value.length > 0 && value.every((item) => typeof item === 'string' && item.length > 0), `invalid ${name}`);
  requireThat(new Set(value).size === value.length, `duplicate ${name}`);
  return [...value];
}

function hasImmutableHostValue(ctx, name, expected) {
  const descriptor = Object.getOwnPropertyDescriptor(ctx, name);
  return descriptor?.value === expected
    && descriptor.enumerable === true
    && descriptor.configurable === false
    && descriptor.writable === false;
}

function isAttestedDirectOwner(config, ctx) {
  if (!ctx?.sessionKey || !ctx?.agentId || ctx.sandboxed !== false || ctx.senderIsOwner !== true) return false;
  if (!config.controllerAgents.includes(ctx.agentId) || !config.controllerSessionKeys.includes(ctx.sessionKey)) return false;
  if (ctx.requesterSenderId !== config.ownerSenderId || !config.ownerSessionKeys.includes(ctx.sessionKey)) return false;
  if (!hasImmutableHostValue(ctx, 'originTrigger', 'direct-user')) return false;
  if (typeof ctx.deviceId !== 'string' || !config.ownerDevicePins.includes(ctx.deviceId)) return false;
  if (!hasImmutableHostValue(ctx, 'deviceId', ctx.deviceId)) return false;
  if (typeof ctx.assertInvocationCurrent !== 'function') return false;
  try {
    ctx.assertInvocationCurrent();
    return true;
  } catch {
    return false;
  }
}

function configOf(value) {
  requireThat(value && typeof value === 'object' && !Array.isArray(value), 'Readiness #1 plugin config unavailable');
  const exact = ['cliVersions', 'controllerAgents', 'controllerDeviceId', 'controllerSessionKeys', 'dispatchReservation', 'notification', 'ownerDevicePins', 'ownerSenderId', 'ownerSessionKeys', 'ownerTarget', 'tasks', 'workerAgentId'];
  requireThat(Object.keys(value).sort().join(',') === exact.sort().join(','), 'unexpected Readiness #1 plugin config fields');
  const workerAgentId = value.workerAgentId;
  requireThat(typeof workerAgentId === 'string' && /^[a-z0-9][a-z0-9_-]{0,63}$/.test(workerAgentId), 'invalid workerAgentId');
  const ownerDevicePins = stringList(value.ownerDevicePins, 'ownerDevicePins');
  const ownerSessionKeys = stringList(value.ownerSessionKeys, 'ownerSessionKeys');
  requireThat(typeof value.ownerSenderId === 'string' && value.ownerSenderId.length > 0, 'invalid ownerSenderId');
  requireThat(value.ownerTarget && Object.keys(value.ownerTarget).sort().join(',') === 'accountId,channel,recipientId', 'invalid fixed owner target');
  requireThat(['accountId', 'channel', 'recipientId'].every((key) => typeof value.ownerTarget[key] === 'string' && value.ownerTarget[key].length > 0), 'invalid fixed owner target');
  requireThat(typeof value.controllerDeviceId === 'string' && value.controllerDeviceId.length > 0 && !ownerDevicePins.includes(value.controllerDeviceId), 'invalid controllerDeviceId');
  requireThat(value.cliVersions && Object.keys(value.cliVersions).sort().join(',') === 'claude-code,codex' && Object.values(value.cliVersions).every((item) => typeof item === 'string' && item.length > 0), 'invalid fixed CLI versions');
  requireThat(Number.isSafeInteger(value.dispatchReservation) && value.dispatchReservation > 0, 'invalid dispatch reservation');
  requireThat(value.notification && Object.keys(value.notification).sort().join(',') === 'evidenceRepos,taskRateCap', 'invalid fixed notification policy');
  const evidenceRepos = stringList(value.notification.evidenceRepos, 'notification evidenceRepos');
  requireThat(evidenceRepos.every((repo) => /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)), 'invalid evidence repository');
  requireThat(Number.isSafeInteger(value.notification.taskRateCap) && value.notification.taskRateCap > 0, 'invalid notification rate cap');
  requireThat(Array.isArray(value.tasks) && value.tasks.length > 0, 'fixed canonical Tasks unavailable');
  const tasks = value.tasks.map(validateTaskDescriptor);
  requireThat(new Set(tasks.map((task) => task.contract.taskNodeId)).size === tasks.length, 'duplicate canonical Task');
  for (const task of tasks) {
    requireThat(task.contract.role === workerAgentId, 'canonical Task role/worker mismatch');
    requireThat(['claude-code', 'codex'].includes(task.contract.caps.provider), 'canonical Task provider unavailable');
    requireThat(task.contract.limits.budget >= value.dispatchReservation, 'dispatch reservation exceeds canonical Task budget');
  }
  return Object.freeze({
    pluginId: PLUGIN_ID,
    controllerAgents: stringList(value.controllerAgents, 'controllerAgents'),
    controllerSessionKeys: stringList(value.controllerSessionKeys, 'controllerSessionKeys'),
    workerAgentId,
    ownerDevicePins,
    ownerSenderId: value.ownerSenderId,
    ownerSessionKeys,
    ownerTarget: Object.freeze({ ...value.ownerTarget }),
    controllerDeviceId: value.controllerDeviceId,
    cliVersions: Object.freeze({ ...value.cliVersions }),
    dispatchReservation: value.dispatchReservation,
    notification: Object.freeze({ evidenceRepos, taskRateCap: value.notification.taskRateCap }),
    tasks,
  });
}

function hostBindingOf(api) {
  const binding = api?.runtime?.readiness1HostBinding;
  if (binding == null) return null;
  requireThat(
    binding
      && typeof binding === 'object'
      && Object.isFrozen(binding)
      && Object.keys(binding).sort().join(',') === 'kind,openLedgerStore,readCanonicalDescriptor,runCanonicalReadOnly'
      && binding.kind === 'openclaw.readiness1.host-binding.v1'
      && typeof binding.openLedgerStore === 'function'
      && typeof binding.readCanonicalDescriptor === 'function'
      && typeof binding.runCanonicalReadOnly === 'function',
    'READINESS1_HOST_BINDING_INVALID',
  );
  return binding;
}

function createStatusTool({ config, ctx, binding }) {
  const ledger = createLedger(binding.openLedgerStore());
  const bridge = createNativeBridge({
    config,
    readCanonicalDescriptor: binding.readCanonicalDescriptor,
    runCanonicalReadOnly: binding.runCanonicalReadOnly,
  });
  return createReadinessTool({
    config,
    ctx,
    ledger,
    bridge,
    hostBinding: binding,
  });
}

const plugin = {
  id: PLUGIN_ID,
  name: 'Readiness #1 native controller',
  description: 'Fail-closed OpenClaw 2026.10.3 public adapter around the canonical Readiness #1 authority.',
  register(api) {
    const config = configOf(api.pluginConfig);
    api.registerTool({
      contextVersion: 2,
      create: (ctx) => {
        if (!isAttestedDirectOwner(config, ctx)) return null;
        return {
          name: TOOL_NAME,
          label: 'Readiness #1 Task (direct owner; no effects)',
          description: 'Host-attested direct-owner entry. Every unavailable execution, observation, approval, coordination, notification, and acceptance adapter remains fail closed.',
          parameters: TOOL_SCHEMA,
          async execute(_id, params) {
            requireThat(isAttestedDirectOwner(config, ctx), 'OWNER_DIRECT_CONTEXT_STALE_OR_UNATTESTED');
            requireThat(params && typeof params === 'object' && !Array.isArray(params) && TOOL_SCHEMA.properties.action.enum.includes(params.action), 'catalog action refused');
            requireThat(Object.keys(params).every((key) => Object.hasOwn(TOOL_SCHEMA.properties, key)), 'catalog action refused arbitrary input');
            if (params.action === 'status') {
              const binding = hostBindingOf(api);
              if (binding) return createStatusTool({ config, ctx, binding }).execute(_id, params);
            }
            const routeBlocker = {
              dispatch: 'EXECUTION_START_ADMISSION_CONTROLLER_WIRING_UNAVAILABLE',
              observe: 'NATIVE_OBSERVATION_CONTROLLER_WIRING_UNAVAILABLE',
              cleanup: 'LOSSLESS_CLEANUP_PUBLIC_SURFACE_UNAVAILABLE',
              'capacity.resume': 'CAPACITY_RESUME_PUBLIC_SURFACE_UNAVAILABLE',
              'approval.request': 'OWNER_APPROVAL_PUBLIC_SURFACE_UNAVAILABLE',
              activate: 'OWNER_APPROVAL_PUBLIC_SURFACE_UNAVAILABLE',
              status: 'CANONICAL_LEDGER_PUBLIC_SURFACE_UNAVAILABLE',
              'ready.consume': 'FIXED_GITHUB_PUBLIC_SURFACE_UNAVAILABLE',
              'comment.append': 'FIXED_GITHUB_PUBLIC_SURFACE_UNAVAILABLE',
              'task.status': 'FIXED_GITHUB_PUBLIC_SURFACE_UNAVAILABLE',
              'notify.owner': 'FIXED_OWNER_NOTIFICATION_PUBLIC_SURFACE_UNAVAILABLE',
              'acceptance.run': 'ACCEPTANCE_EVIDENCE_PUBLIC_SURFACE_UNAVAILABLE',
            }[params.action];
            throw new Error(routeBlocker);
          },
        };
      },
    }, { name: TOOL_NAME });
  },
};

Object.defineProperty(plugin, Symbol.for('openclaw.plugin-sdk.tool-plugin.metadata'), {
  enumerable: false,
  value: {
    id: PLUGIN_ID,
    name: plugin.name,
    description: plugin.description,
    activation: { onStartup: true },
    tools: [{ name: TOOL_NAME, label: 'Readiness #1 Task', description: 'Closed canonical Task lifecycle action.', parameters: TOOL_SCHEMA }],
  },
});

export default plugin;
// Source-only constructors are intentionally not registered by the production
// plugin entrypoint. They let the offline M2 route exercise the same M1 ledger
// and admission controller without manufacturing unavailable host adapters.
export {
  createAcceptanceExecutor,
  createExecutionGate,
  createLedger,
  createNativeBridge,
  createResolver,
  createSnapshotRunner,
  configOf,
};

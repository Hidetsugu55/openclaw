import { digest, requireThat } from './contract.js';

export function nativeWorkerSessionKey(agentId, taskNodeId) {
  requireThat(/^[a-z0-9][a-z0-9_-]{0,63}$/.test(agentId), 'invalid fixed worker agent');
  return `agent:${agentId}:subagent:workboard-readiness1-${digest(taskNodeId).slice(0, 24)}`;
}

export function createNativeBridge({ config, prepareWorkspaceFixture, snapshotWorkspace, readCapacity, startReservedExecution, observeNativeRun, cleanupWorkspace, ownerApprovalAvailable, sendFixedOwnerDM, coordinateFixedTask }) {
  const descriptors = new Map(config.tasks.map((descriptor) => [descriptor.contract.taskNodeId, descriptor]));

  function descriptor(taskNodeId) {
    const value = descriptors.get(taskNodeId);
    requireThat(value, 'canonical Task is not configured');
    return value;
  }

  async function snapshot(task, workspace) {
    requireThat(typeof snapshotWorkspace === 'function', 'SOURCE_INTEGRITY_NATIVE_SURFACE_UNAVAILABLE');
    const result = await snapshotWorkspace(task, workspace);
    requireThat(result?.repo === task.repo && result.worktree === task.root && result.head === task.head, 'source integrity snapshot mismatch');
    requireThat(result.dirty === '' && result.indexDigest === descriptor(task.taskNodeId).indexDigest, 'source integrity dirty/index mismatch');
    return result;
  }

  return Object.freeze({
    readCanonicalTask: async (taskNodeId) => descriptor(taskNodeId).contract,

    async assertOwnerApprovalAvailable() {
      requireThat(typeof ownerApprovalAvailable === 'function' && await ownerApprovalAvailable() === true, 'OWNER_APPROVAL_PUBLIC_SURFACE_UNAVAILABLE');
    },

    preflightDispatch() {
      requireThat(typeof startReservedExecution === 'function', 'EXECUTION_START_ADMISSION_CONTROLLER_WIRING_UNAVAILABLE');
      requireThat(typeof snapshotWorkspace === 'function', 'SOURCE_INTEGRITY_PUBLIC_SURFACE_UNAVAILABLE');
      requireThat(typeof readCapacity === 'function', 'PROVIDER_CAPACITY_PUBLIC_SURFACE_UNAVAILABLE');
      requireThat(typeof prepareWorkspaceFixture === 'function', 'WORKSPACE_PUBLIC_SURFACE_UNAVAILABLE');
    },

    async prepareWorkspace(task, { claimId, assertCurrent }) {
      const fixed = descriptor(task.taskNodeId);
      assertCurrent();
      const sessionKey = nativeWorkerSessionKey(config.workerAgentId, task.taskNodeId);
      requireThat(typeof prepareWorkspaceFixture === 'function', 'WORKSPACE_PUBLIC_SURFACE_UNAVAILABLE');
      const prepared = await prepareWorkspaceFixture(Object.freeze({ fixtureOnly: true, task: structuredClone(task), sourceRoot: fixed.sourceRoot, worktreeName: fixed.worktreeName, worktreeBranch: fixed.worktreeBranch, workerAgentId: config.workerAgentId, sessionKey, claimId, requiredToolNames: Object.freeze(['read', 'exec', 'apply_patch']) }));
      const workspace = { id: prepared.id, path: prepared.path, branch: prepared.branch, agentId: config.workerAgentId, sessionKey, claimId };
      requireThat(workspace.path === task.root && workspace.branch === fixed.worktreeBranch, 'managed worktree identity mismatch');
      requireThat(prepared.sandboxed === true && prepared.workspaceAccess === 'rw' && !prepared.confinementError, 'required native worker sandbox unavailable');
      return { workspace, snapshot: await snapshot(task, workspace) };
    },

    exactSnapshot: snapshot,

    async nativeCapacityNoWork(task) {
      requireThat(typeof readCapacity === 'function', 'PROVIDER_CAPACITY_PUBLIC_SURFACE_UNAVAILABLE');
      return readCapacity(task);
    },

    async launchReserved({ contract, workspace, ticketId, assertCurrent, admit }) {
      const fixed = descriptor(contract.taskNodeId);
      requireThat(workspace.path === contract.root && workspace.sessionKey === nativeWorkerSessionKey(config.workerAgentId, contract.taskNodeId), 'native launch workspace/session mismatch');
      requireThat(typeof startReservedExecution === 'function', 'EXECUTION_START_ADMISSION_CONTROLLER_WIRING_UNAVAILABLE');
      let admitted = false;
      const accepted = await startReservedExecution({
        fixtureOnly: true,
        descriptor: Object.freeze({ sessionKey: workspace.sessionKey, instructions: fixed.instructions, lane: `workboard:readiness1:${digest(contract.taskNodeId).slice(0, 24)}`, idempotencyKey: ticketId, cwd: workspace.path, promptMode: 'minimal', lightContext: true, deliver: false }),
        async admitExecutionStart() {
          requireThat(!admitted, 'execution-start admission replay');
          assertCurrent();
          await admit();
          admitted = true;
        },
      });
      requireThat(admitted, 'provider work attempted without execution-start admission');
      requireThat(accepted.runId === ticketId && (accepted.sessionKey ?? workspace.sessionKey) === workspace.sessionKey, 'native accepted receipt identity mismatch');
      return { runId: accepted.runId, sessionKey: accepted.sessionKey ?? workspace.sessionKey };
    },

    async observeNativeRun(binding) {
      requireThat(typeof observeNativeRun === 'function', 'NATIVE_OBSERVATION_CONTROLLER_WIRING_UNAVAILABLE');
      return observeNativeRun(Object.freeze({ ...binding }));
    },

    async cleanupWorkspace(task, workspace) {
      requireThat(workspace.path === task.root, 'cleanup worktree mismatch');
      requireThat(typeof cleanupWorkspace === 'function', 'LOSSLESS_CLEANUP_PUBLIC_SURFACE_UNAVAILABLE');
      return cleanupWorkspace(Object.freeze({ taskNodeId: task.taskNodeId, root: task.root, workspace: structuredClone(workspace) }));
    },

    async sendFixedOwnerDM(payload) {
      requireThat(typeof sendFixedOwnerDM === 'function', 'FIXED_OWNER_NOTIFICATION_PUBLIC_SURFACE_UNAVAILABLE');
      return sendFixedOwnerDM(payload);
    },

    notificationEventId(task, payload) {
      return digest({ taskNodeId: task.taskNodeId, kind: payload.kind, evidence: payload.evidence ?? [] });
    },

    async coordinateFixedTask(action, task, reservation) {
      requireThat(typeof coordinateFixedTask === 'function', 'FIXED_GITHUB_PUBLIC_SURFACE_UNAVAILABLE');
      return coordinateFixedTask(action, task, reservation);
    },
  });
}

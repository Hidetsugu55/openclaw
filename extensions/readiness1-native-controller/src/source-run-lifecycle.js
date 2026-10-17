import { digest, requireThat } from "./contract.js";

const SOURCE_RUN_BINDING_V7_KIND = "openclaw.readiness1.source-run-binding.v7";
const FINAL_EVIDENCE_KIND = "openclaw.readiness1.source-run-final-evidence.v1";
const CLEANUP_EVIDENCE_KIND = "openclaw.readiness1.source-run-cleanup-evidence.v1";
const SHA1 = /^[a-f0-9]{40}$/;
const SHA256 = /^[a-f0-9]{64}$/;

function identityKey(taskNodeId, runId) {
  return `${taskNodeId}\u0000${runId}`;
}

function requireIdentity(value, { taskNodeId, sessionKey, workspaceDir }) {
  requireThat(
    value &&
      typeof value.runId === "string" &&
      value.runId.length > 0 &&
      value.sessionKey === sessionKey &&
      value.workspaceDir === workspaceDir,
    "source run identity mismatch",
  );
  requireThat(
    typeof taskNodeId === "string" && taskNodeId.length > 0,
    "source task identity missing",
  );
}

function requireFinalEvidence(value, entry) {
  requireIdentity(value, entry);
  requireThat(
    value.kind === FINAL_EVIDENCE_KIND &&
      value.state === "CONFIRMED" &&
      value.providerStarted === true &&
      Number.isSafeInteger(value.usage) &&
      value.usage >= 0 &&
      value.result?.runId === entry.runId &&
      value.result?.sessionKey === entry.sessionKey &&
      SHA256.test(value.result?.digest ?? "") &&
      Number.isSafeInteger(value.result?.byteLength) &&
      value.result.byteLength >= 0 &&
      value.snapshot?.workspaceDir === entry.workspaceDir &&
      SHA1.test(value.snapshot?.head ?? "") &&
      SHA256.test(value.snapshot?.indexDigest ?? "") &&
      value.snapshot.dirty === "",
    "source final evidence is incomplete",
  );
}

function requireCleanupEvidence(value, entry) {
  requireIdentity(value, entry);
  requireThat(
    value.kind === CLEANUP_EVIDENCE_KIND && value.state === "CONFIRMED",
    "source cleanup evidence is incomplete",
  );
}

/**
 * Fixture-only adapter for the private V7 host binding. It keeps the opaque
 * launch capability local, publishes only controller-shaped receipts, and
 * lets V7 perform physical cleanup only after final evidence is confirmed.
 */
export function createSourceRunLifecycle({ sourceRunBinding, now = Date.now }) {
  requireThat(
    sourceRunBinding?.kind === SOURCE_RUN_BINDING_V7_KIND &&
      typeof sourceRunBinding.launch === "function",
    "SOURCE_RUN_V7_BINDING_UNAVAILABLE",
  );
  requireThat(typeof now === "function", "SOURCE_RUN_CLOCK_UNAVAILABLE");
  const runs = new Map();

  function entryFor(binding) {
    requireThat(
      binding &&
        typeof binding.taskNodeId === "string" &&
        typeof binding.runId === "string" &&
        typeof binding.sessionKey === "string",
      "source run binding is invalid",
    );
    const entry = runs.get(identityKey(binding.taskNodeId, binding.runId));
    requireThat(
      entry && entry.sessionKey === binding.sessionKey && entry.taskNodeId === binding.taskNodeId,
      "source run binding is unknown",
    );
    return entry;
  }

  return Object.freeze({
    async launch({ contract, workspace, ticketId, assertCurrent, admit }) {
      requireThat(
        contract &&
          typeof contract.taskNodeId === "string" &&
          typeof contract.repo === "string" &&
          typeof contract.root === "string" &&
          workspace?.path === contract.root &&
          typeof workspace.sessionKey === "string" &&
          typeof ticketId === "string" &&
          typeof assertCurrent === "function" &&
          typeof admit === "function",
        "source launch request is invalid",
      );
      let admitted = false;
      let admittedIdentity;
      const launched = await sourceRunBinding.launch({
        taskNodeId: contract.taskNodeId,
        ticketId,
        beforeProvider: async (identity) => {
          assertCurrent();
          requireThat(!admitted, "source provider admission replay");
          requireThat(
            identity?.sessionKey === workspace.sessionKey &&
              typeof identity.runId === "string" &&
              identity.runId.length > 0,
            "source provider admission identity mismatch",
          );
          admittedIdentity = Object.freeze({
            runId: identity.runId,
            sessionKey: identity.sessionKey,
          });
          await admit(admittedIdentity);
          admitted = true;
        },
      });
      assertCurrent();
      requireThat(admitted && admittedIdentity, "source provider work attempted without admission");
      requireIdentity(launched, {
        taskNodeId: contract.taskNodeId,
        sessionKey: admittedIdentity.sessionKey,
        workspaceDir: workspace.path,
      });
      requireThat(
        launched.runId === admittedIdentity.runId &&
          typeof launched.readFinalEvidence === "function" &&
          typeof launched.readCleanupEvidence === "function",
        "source launch receipt is incomplete",
      );
      const key = identityKey(contract.taskNodeId, launched.runId);
      requireThat(!runs.has(key), "source launch receipt replay");
      runs.set(key, {
        taskNodeId: contract.taskNodeId,
        repo: contract.repo,
        root: contract.root,
        runId: launched.runId,
        sessionKey: launched.sessionKey,
        workspaceDir: launched.workspaceDir,
        launched,
        cleanupReceipt: undefined,
      });
      return Object.freeze({ runId: launched.runId, sessionKey: launched.sessionKey });
    },

    async observe(binding) {
      const entry = entryFor(binding);
      const terminal = await entry.launched.readFinalEvidence();
      requireFinalEvidence(terminal, entry);
      return Object.freeze({
        schema: "readiness1.native-observation.v1",
        taskNodeId: entry.taskNodeId,
        runId: entry.runId,
        sessionKey: entry.sessionKey,
        epoch: binding.epoch,
        revision: binding.revision,
        status: "ok",
        providerStarted: true,
        terminalStatus: "ok",
        stopReason: "completed",
        cleanupDeferred: true,
        cleanWorktree: true,
        durableResults: true,
        sideEffects: "none",
        usage: terminal.usage,
        snapshot: Object.freeze({
          repo: entry.repo,
          worktree: entry.root,
          head: terminal.snapshot.head,
          dirty: "",
          indexDigest: terminal.snapshot.indexDigest,
        }),
      });
    },

    async cleanup({ taskNodeId, root, workspace, admitWorkspaceCleanup }) {
      requireThat(
        typeof taskNodeId === "string" &&
          typeof root === "string" &&
          workspace?.path === root &&
          typeof workspace.sessionKey === "string" &&
          typeof admitWorkspaceCleanup === "function",
        "source cleanup request is invalid",
      );
      const candidates = [...runs.values()].filter(
        (entry) =>
          entry.taskNodeId === taskNodeId &&
          entry.root === root &&
          entry.workspaceDir === workspace.path &&
          entry.sessionKey === workspace.sessionKey,
      );
      requireThat(candidates.length === 1, "source cleanup custody is unavailable");
      const [entry] = candidates;
      if (!entry.cleanupReceipt) {
        await admitWorkspaceCleanup();
        entry.cleanupReceipt = (async () => {
          const evidence = await entry.launched.readCleanupEvidence();
          requireCleanupEvidence(evidence, entry);
          return Object.freeze({
            schema: "readiness1.finish-receipt.v1",
            receiptId: digest({
              kind: "readiness1.v7.cleanup",
              taskNodeId,
              runId: entry.runId,
              sessionKey: entry.sessionKey,
              workspaceDir: entry.workspaceDir,
            }),
            taskNodeId,
            root,
            workspaceRemoved: true,
            releaseConfirmed: true,
            postRemovalLsofClear: true,
            auditConfirmed: true,
            observedAt: now(),
          });
        })();
      }
      return entry.cleanupReceipt;
    },
  });
}

import type { AgentRuntimeDirectLocalProcessCustody } from "../agents/command/types.js";
import type {
  Readiness1SourceRunCleanupFinalizer,
  Readiness1SourceRunCleanupReceipt,
} from "./readiness1-host-binding.js";
import type { Readiness1SourceRunIdentity } from "./readiness1-source-run-evidence.js";

type SourceRunCustodyRecord = Readonly<{
  expected: Readiness1SourceRunIdentity;
  finalize: Readiness1SourceRunCleanupFinalizer;
}>;

const sourceRunCustody = new Map<string, SourceRunCustodyRecord>();

function hasExpectedIdentity(
  expected: Readiness1SourceRunIdentity,
  observed: Readiness1SourceRunIdentity,
): boolean {
  return (
    expected.runId === observed.runId &&
    expected.sessionKey === observed.sessionKey &&
    expected.workspaceDir === observed.workspaceDir
  );
}

/**
 * Retain only a host-created finalizer for one run. The opaque custody object
 * itself never leaves the agent/runtime call chain and no controller input can
 * name a run, workspace, PID, process group, or cleanup action here.
 */
export function registerReadiness1SourceRunCustody(params: {
  expected: Readiness1SourceRunIdentity;
  custody: AgentRuntimeDirectLocalProcessCustody;
  finalizeWorkspace: (
    physical: Awaited<ReturnType<AgentRuntimeDirectLocalProcessCustody["cleanupAndObserve"]>>,
  ) => Promise<Omit<Readiness1SourceRunCleanupReceipt, "runId" | "sessionKey" | "workspaceDir">>;
}): void {
  if (sourceRunCustody.has(params.expected.runId)) {
    throw new Error("Readiness #1 source run custody already exists for this run.");
  }
  const expected = Object.freeze({ ...params.expected });
  let finalization: Promise<Readiness1SourceRunCleanupReceipt> | undefined;
  const record: SourceRunCustodyRecord = Object.freeze({
    expected,
    finalize: (requested) => {
      if (!hasExpectedIdentity(expected, requested)) {
        return Promise.reject(new Error("Readiness #1 source run cleanup identity drift."));
      }
      return (finalization ??= (async () => {
        const physical = await params.custody.cleanupAndObserve();
        const finalized = await params.finalizeWorkspace(physical);
        return Object.freeze({
          runId: expected.runId,
          sessionKey: expected.sessionKey,
          workspaceDir: expected.workspaceDir,
          ...finalized,
        });
      })());
    },
  });
  sourceRunCustody.set(expected.runId, record);
}

/** Return only the exact run's retained host finalizer; unknown/mismatched runs have no capability. */
export async function finalizeReadiness1SourceRunCustody(
  expected: Readiness1SourceRunIdentity,
): Promise<Readiness1SourceRunCleanupReceipt> {
  const record = sourceRunCustody.get(expected.runId);
  if (!record || !hasExpectedIdentity(record.expected, expected)) {
    throw new Error("Readiness #1 source run custody is unavailable.");
  }
  const receipt = await record.finalize(expected);
  if (
    receipt.processStopped &&
    receipt.groupStopped &&
    receipt.containerRemoved &&
    receipt.lsofClear &&
    receipt.runLeaseReleased &&
    receipt.workspaceReleased &&
    receipt.workspaceRemoved
  ) {
    sourceRunCustody.delete(expected.runId);
  }
  return receipt;
}

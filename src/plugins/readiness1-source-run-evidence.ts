import type { AgentWaitResult } from "../agents/run-wait.types.js";

export const READINESS1_SOURCE_RUN_FINAL_EVIDENCE_KIND =
  "openclaw.readiness1.source-run-final-evidence.v1" as const;
export const READINESS1_SOURCE_RUN_CLEANUP_EVIDENCE_KIND =
  "openclaw.readiness1.source-run-cleanup-evidence.v1" as const;

type SourceRunIdentity = Readonly<{
  runId: string;
  sessionKey: string;
  workspaceDir: string;
}>;

type DurableResult = Readonly<{
  runId: string;
  sessionKey: string;
  digest: string;
  byteLength: number;
}>;

type FinalSnapshot = Readonly<{
  workspaceDir: string;
  head: string;
  indexDigest: string;
  dirty: string;
}>;

export type Readiness1SourceRunFinalEvidence = Readonly<{
  kind: typeof READINESS1_SOURCE_RUN_FINAL_EVIDENCE_KIND;
  state: "CONFIRMED" | "UNKNOWN";
  runId: string;
  sessionKey: string;
  workspaceDir: string;
  providerStarted: boolean;
  endedAt?: number;
  usage?: number;
  result?: DurableResult;
  snapshot?: FinalSnapshot;
}>;

export type Readiness1SourceRunCleanupEvidence = Readonly<{
  kind: typeof READINESS1_SOURCE_RUN_CLEANUP_EVIDENCE_KIND;
  state: "CONFIRMED" | "UNKNOWN";
  runId: string;
  sessionKey: string;
  workspaceDir: string;
}>;

export type Readiness1SourceRunFinalEvidenceInput = Readonly<{
  expected: SourceRunIdentity;
  observed: Readonly<{
    runId: string;
    sessionKey: string;
    wait: AgentWaitResult;
    usage?: number;
    result?: DurableResult;
    snapshot?: FinalSnapshot;
  }>;
}>;

export type Readiness1SourceRunCleanupEvidenceInput = Readonly<{
  expected: SourceRunIdentity;
  terminal: Readiness1SourceRunFinalEvidence;
  observed: Readonly<{
    runId: string;
    sessionKey: string;
    processStopped?: boolean;
    groupStopped?: boolean;
    containerRemoved?: boolean;
    lsofClear?: boolean;
    runLeaseReleased?: boolean;
    workspaceReleased?: boolean;
    workspaceRemoved?: boolean;
  }>;
}>;

const SHA1 = /^[a-f0-9]{40}$/;
const SHA256 = /^[a-f0-9]{64}$/;

function validIdentity(value: SourceRunIdentity): boolean {
  return (
    typeof value.runId === "string" &&
    value.runId.length > 0 &&
    typeof value.sessionKey === "string" &&
    value.sessionKey.length > 0 &&
    typeof value.workspaceDir === "string" &&
    value.workspaceDir.startsWith("/")
  );
}

function sameIdentity(
  expected: SourceRunIdentity,
  observed: Pick<SourceRunIdentity, "runId" | "sessionKey">,
): boolean {
  return observed.runId === expected.runId && observed.sessionKey === expected.sessionKey;
}

function unknownFinal(expected: SourceRunIdentity): Readiness1SourceRunFinalEvidence {
  return Object.freeze({
    kind: READINESS1_SOURCE_RUN_FINAL_EVIDENCE_KIND,
    state: "UNKNOWN",
    runId: expected.runId,
    sessionKey: expected.sessionKey,
    workspaceDir: expected.workspaceDir,
    providerStarted: false,
  });
}

/**
 * `agent.wait` alone is deliberately insufficient. A future host-only runner
 * must provide a durable result digest, an exact final snapshot, and measured
 * usage before this contract can attest a successful source run.
 */
export function assessReadiness1SourceRunFinalEvidence(
  input: Readiness1SourceRunFinalEvidenceInput,
): Readiness1SourceRunFinalEvidence {
  const expected = input?.expected;
  const observed = input?.observed;
  if (!expected || !observed || !validIdentity(expected) || !sameIdentity(expected, observed)) {
    return unknownFinal(expected ?? { runId: "", sessionKey: "", workspaceDir: "" });
  }
  const { wait, result, snapshot, usage } = observed;
  if (
    wait?.status !== "ok" ||
    wait.providerStarted !== true ||
    !Number.isFinite(wait.endedAt) ||
    wait.terminalReceipt?.runId !== expected.runId ||
    !wait.terminalReply ||
    typeof usage !== "number" ||
    !Number.isSafeInteger(usage) ||
    usage < 0 ||
    !result ||
    !sameIdentity(expected, result) ||
    !SHA256.test(result.digest) ||
    !Number.isSafeInteger(result.byteLength) ||
    result.byteLength < 0 ||
    !snapshot ||
    snapshot.workspaceDir !== expected.workspaceDir ||
    !SHA1.test(snapshot.head) ||
    !SHA256.test(snapshot.indexDigest) ||
    snapshot.dirty !== ""
  ) {
    return unknownFinal(expected);
  }
  return Object.freeze({
    kind: READINESS1_SOURCE_RUN_FINAL_EVIDENCE_KIND,
    state: "CONFIRMED",
    runId: expected.runId,
    sessionKey: expected.sessionKey,
    workspaceDir: expected.workspaceDir,
    providerStarted: true,
    endedAt: wait.endedAt,
    usage,
    result: Object.freeze({ ...result }),
    snapshot: Object.freeze({ ...snapshot }),
  });
}

/**
 * Cleanup is a separate receipt. A terminal result never authorizes removal
 * until every process, the exclusive lease, and the managed worktree are known
 * to be gone.
 */
export function assessReadiness1SourceRunCleanupEvidence(
  input: Readiness1SourceRunCleanupEvidenceInput,
): Readiness1SourceRunCleanupEvidence {
  const expected = input?.expected;
  const terminal = input?.terminal;
  const observed = input?.observed;
  const unknown = Object.freeze({
    kind: READINESS1_SOURCE_RUN_CLEANUP_EVIDENCE_KIND,
    state: "UNKNOWN" as const,
    runId: expected?.runId ?? "",
    sessionKey: expected?.sessionKey ?? "",
    workspaceDir: expected?.workspaceDir ?? "",
  });
  if (
    !expected ||
    !terminal ||
    !observed ||
    !validIdentity(expected) ||
    terminal.kind !== READINESS1_SOURCE_RUN_FINAL_EVIDENCE_KIND ||
    terminal.state !== "CONFIRMED" ||
    terminal.runId !== expected.runId ||
    terminal.sessionKey !== expected.sessionKey ||
    terminal.workspaceDir !== expected.workspaceDir ||
    !sameIdentity(expected, observed) ||
    observed.processStopped !== true ||
    observed.groupStopped !== true ||
    observed.containerRemoved !== true ||
    observed.lsofClear !== true ||
    observed.runLeaseReleased !== true ||
    observed.workspaceReleased !== true ||
    observed.workspaceRemoved !== true
  ) {
    return unknown;
  }
  return Object.freeze({
    kind: READINESS1_SOURCE_RUN_CLEANUP_EVIDENCE_KIND,
    state: "CONFIRMED",
    runId: expected.runId,
    sessionKey: expected.sessionKey,
    workspaceDir: expected.workspaceDir,
  });
}

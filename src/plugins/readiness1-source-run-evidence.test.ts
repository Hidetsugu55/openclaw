import { describe, expect, it } from "vitest";
import {
  assessReadiness1SourceRunCleanupEvidence,
  assessReadiness1SourceRunFinalEvidence,
  READINESS1_SOURCE_RUN_CLEANUP_EVIDENCE_KIND,
  READINESS1_SOURCE_RUN_FINAL_EVIDENCE_KIND,
} from "./readiness1-source-run-evidence.js";

const expected = Object.freeze({
  runId: "source-run-123",
  sessionKey: "agent:dev-host:subagent:workboard-readiness1-123",
  workspaceDir: "/state/worktrees/readiness1-123",
});

function completeFinalInput() {
  return {
    expected,
    observed: {
      runId: expected.runId,
      sessionKey: expected.sessionKey,
      wait: {
        status: "ok" as const,
        providerStarted: true,
        endedAt: 1_700_000_000_000,
        terminalReceipt: {
          runId: expected.runId,
          sessionId: "native-session-123",
          turnId: "native-turn-123",
          requested: { provider: "codex", model: "gpt-5" },
          effective: { provider: "codex", model: "gpt-5", responseModel: "gpt-5" },
          successfulToolNames: [],
          rerouted: false,
          terminalDisposition: "silent" as const,
        },
        terminalReply: { disposition: "silent" as const },
      },
      usage: 42,
      result: {
        runId: expected.runId,
        sessionKey: expected.sessionKey,
        digest: "a".repeat(64),
        byteLength: 128,
      },
      snapshot: {
        workspaceDir: expected.workspaceDir,
        head: "b".repeat(40),
        indexDigest: "c".repeat(64),
        dirty: "",
      },
    },
  };
}

describe("Readiness #1 source run evidence", () => {
  it("does not treat agent.wait success as a durable final result", () => {
    const input = completeFinalInput();
    delete input.observed.result;
    delete input.observed.snapshot;

    const evidence = assessReadiness1SourceRunFinalEvidence(input);

    expect(evidence).toEqual({
      kind: READINESS1_SOURCE_RUN_FINAL_EVIDENCE_KIND,
      state: "UNKNOWN",
      runId: expected.runId,
      sessionKey: expected.sessionKey,
      workspaceDir: expected.workspaceDir,
      providerStarted: false,
    });
  });

  it("confirms final evidence only for one exact terminal receipt, durable result, and clean snapshot", () => {
    const evidence = assessReadiness1SourceRunFinalEvidence(completeFinalInput());

    expect(evidence).toMatchObject({
      kind: READINESS1_SOURCE_RUN_FINAL_EVIDENCE_KIND,
      state: "CONFIRMED",
      runId: expected.runId,
      sessionKey: expected.sessionKey,
      workspaceDir: expected.workspaceDir,
      providerStarted: true,
      usage: 42,
    });
    expect(Object.isFrozen(evidence)).toBe(true);
    expect(Object.isFrozen(evidence.result)).toBe(true);
    expect(Object.isFrozen(evidence.snapshot)).toBe(true);
  });

  it("keeps identity, terminal receipt, usage, and dirty-worktree drift UNKNOWN", () => {
    for (const mutate of [
      (input: ReturnType<typeof completeFinalInput>) => {
        input.observed.runId = "other-run";
      },
      (input: ReturnType<typeof completeFinalInput>) => {
        input.observed.wait.terminalReceipt.runId = "other-run";
      },
      (input: ReturnType<typeof completeFinalInput>) => {
        input.observed.usage = -1;
      },
      (input: ReturnType<typeof completeFinalInput>) => {
        input.observed.snapshot.dirty = " M source.ts";
      },
    ]) {
      const input = completeFinalInput();
      mutate(input);
      expect(assessReadiness1SourceRunFinalEvidence(input).state).toBe("UNKNOWN");
    }
  });

  it("requires a separate lossless cleanup receipt after final evidence", () => {
    const terminal = assessReadiness1SourceRunFinalEvidence(completeFinalInput());
    const completeCleanup = {
      expected,
      terminal,
      observed: {
        runId: expected.runId,
        sessionKey: expected.sessionKey,
        processStopped: true,
        groupStopped: true,
        containerRemoved: true,
        lsofClear: true,
        runLeaseReleased: true,
        workspaceReleased: true,
        workspaceRemoved: true,
      },
    };

    expect(assessReadiness1SourceRunCleanupEvidence(completeCleanup)).toEqual({
      kind: READINESS1_SOURCE_RUN_CLEANUP_EVIDENCE_KIND,
      state: "CONFIRMED",
      runId: expected.runId,
      sessionKey: expected.sessionKey,
      workspaceDir: expected.workspaceDir,
    });

    completeCleanup.observed.workspaceRemoved = false;
    expect(assessReadiness1SourceRunCleanupEvidence(completeCleanup).state).toBe("UNKNOWN");
  });
});

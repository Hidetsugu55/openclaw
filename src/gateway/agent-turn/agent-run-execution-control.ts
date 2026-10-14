import type {
  AgentRuntimeExecutionIdentity,
  AgentRuntimeExecutionObservation,
} from "../../agents/command/types.js";
import type { StartAgentRunExecutionParams } from "./agent-run-execution-types.js";

export function createAgentRunExecutionControl(params: StartAgentRunExecutionParams) {
  const { prepared } = params;
  let executionIdentity: AgentRuntimeExecutionIdentity | undefined;
  let executionStartGate: Promise<void> | undefined;
  let executionObservationSequence = 0;
  const requireExecutionIdentity = (): AgentRuntimeExecutionIdentity => {
    if (executionIdentity) {
      return executionIdentity;
    }
    const runId = params.runId.trim();
    const sessionKey = params.resolvedSessionKey?.trim();
    const sessionId = params.resolvedSessionId?.trim();
    const lifecycleGeneration = params.lifecycleGeneration.trim();
    const owner = prepared.activeRunAbort.entry;
    if (
      !runId ||
      !sessionKey ||
      !sessionId ||
      !lifecycleGeneration ||
      !prepared.activeRunAbort.registered ||
      !owner ||
      owner.sessionKey !== sessionKey ||
      owner.sessionId !== sessionId ||
      typeof prepared.activeRunAbort.cleanup !== "function"
    ) {
      throw new Error(
        "Agent execution identity or resource ownership is UNKNOWN; provider execution is blocked.",
      );
    }
    executionIdentity = Object.freeze({
      runId,
      sessionKey,
      sessionId,
      lifecycleGeneration,
      resourceOwnership: Object.freeze({
        run: "gateway" as const,
        session: "gateway" as const,
        cleanup: "gateway" as const,
      }),
    });
    return executionIdentity;
  };
  const passExecutionStartGate = (): Promise<void> =>
    (executionStartGate ??= Promise.resolve().then(async () => {
      if (params.executionStartGuard) {
        await params.executionStartGuard(requireExecutionIdentity());
      }
    }));
  const publishExecutionObservation = async (
    observation: AgentRuntimeExecutionObservation,
  ): Promise<void> => {
    if (!params.runtimeExecutionObserver) {
      return;
    }
    await params.runtimeExecutionObserver(
      Object.freeze({
        identity: requireExecutionIdentity(),
        sequence: ++executionObservationSequence,
        observation: Object.freeze({ ...observation }),
      }),
    );
  };
  const markExecutionStarted = async (assertCurrent: () => void): Promise<boolean> => {
    if (params.executionStartGuard) {
      assertCurrent();
      await passExecutionStartGate();
      // The authority claim can yield while the native owner is revoked.
      assertCurrent();
    }
    const started = prepared.activeRunAbort.markExecutionStarted();
    if (!started && params.executionStartGuard) {
      throw new Error("Agent execution ownership is UNKNOWN before provider start.");
    }
    return started;
  };
  return { markExecutionStarted, publishExecutionObservation };
}

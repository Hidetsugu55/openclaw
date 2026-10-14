import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { classifyFailoverReason } from "../failover/classify.js";
import type { AgentMessage } from "../runtime/index.js";
import type { AgentRuntimeExecutionObservation } from "./types.js";

export type AgentAttemptLifecycleState = {
  currentTurnUserMessagePersisted: boolean;
  lifecycleError?: string;
  lifecycleErrorObservation?: Record<string, unknown>;
  lifecycleFinishing: boolean;
  lifecycleEnded: boolean;
};

export function resetAgentAttemptLifecycle(state: AgentAttemptLifecycleState): void {
  state.lifecycleError = undefined;
  state.lifecycleErrorObservation = undefined;
  state.lifecycleFinishing = false;
  state.lifecycleEnded = false;
}

type AgentAttemptLifecycleEvent = {
  stream: string;
  data?: Record<string, unknown>;
  sessionKey?: string;
};

export function emitAgentAttemptRuntimeStart(
  info: { phase: string },
  onAgentEvent: (evt: AgentAttemptLifecycleEvent) => void | Promise<void>,
): void {
  // CLI preparation and child launch do not prove a native turn. Parsed
  // assistant/tool activity does, even when the backend omits lifecycle events.
  if (info.phase === "assistant_output_started" || info.phase === "tool_execution_started") {
    void onAgentEvent({ stream: "lifecycle", data: { phase: "start" } });
  }
}

export function createAgentAttemptLifecycleCallbacks(
  state: AgentAttemptLifecycleState,
  onRuntimeTurnStarted?: () => void | Promise<void>,
  runtimeExecutionObserver?: (event: AgentRuntimeExecutionObservation) => unknown,
): {
  onUserMessagePersisted: (message: Extract<AgentMessage, { role: "user" }>) => void;
  onAgentEvent: (evt: AgentAttemptLifecycleEvent) => void | Promise<void>;
} {
  return {
    onUserMessagePersisted: () => {
      state.currentTurnUserMessagePersisted = true;
    },
    onAgentEvent: async (evt) => {
      if (
        evt.stream === "assistant" ||
        evt.stream === "usage" ||
        (evt.stream === "tool" && evt.data?.phase === "start")
      ) {
        const outputTokens =
          evt.stream === "usage" &&
          Number.isSafeInteger(evt.data?.outputTokens) &&
          Number(evt.data?.outputTokens) >= 0
            ? Number(evt.data?.outputTokens)
            : undefined;
        await runtimeExecutionObserver?.({
          kind: "provider_activity",
          toolCallStarted: evt.stream === "tool",
          ...(outputTokens === undefined ? {} : { outputTokens }),
        });
      }
      if (evt.stream !== "lifecycle" || typeof evt.data?.phase !== "string") {
        return;
      }
      if (evt.data.phase === "start") {
        // A same-candidate retry replaces deferred terminal state from the
        // preceding attempt; retaining it would abort a recovered run.
        resetAgentAttemptLifecycle(state);
        await onRuntimeTurnStarted?.();
        return;
      }
      if (typeof evt.data.error === "string" && evt.data.error.trim()) {
        state.lifecycleError = evt.data.error;
        state.lifecycleErrorObservation = asOptionalRecord(evt.data.errorObservation);
        const reason = classifyFailoverReason(evt.data.error);
        await runtimeExecutionObserver?.({
          kind: "provider_error",
          capacityExhausted: reason === "rate_limit" || reason === "billing",
        });
      }
      // Finishing means output ended but transcript/session persistence may still
      // need to run; end/error means the runtime lifecycle is complete.
      if (evt.data.phase === "finishing") {
        state.lifecycleFinishing = true;
        return;
      }
      if (evt.data.phase === "end" || evt.data.phase === "error") {
        state.lifecycleEnded = true;
        await runtimeExecutionObserver?.({
          kind: "terminal",
          status: evt.data.phase === "error" || state.lifecycleError ? "error" : "ok",
        });
      }
    },
  };
}

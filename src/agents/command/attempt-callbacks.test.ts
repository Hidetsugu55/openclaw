// Verifies the small lifecycle callback adapter used during agent attempts.
import { describe, expect, it, vi } from "vitest";
import {
  createAgentAttemptLifecycleCallbacks,
  type AgentAttemptLifecycleState,
} from "./attempt-callbacks.js";
import type { AgentRuntimeExecutionObservation } from "./types.js";

describe("createAgentAttemptLifecycleCallbacks", () => {
  it("tracks user-message persistence without closing over the agent command scope", () => {
    const state: AgentAttemptLifecycleState = {
      currentTurnUserMessagePersisted: false,
      lifecycleFinishing: false,
      lifecycleEnded: false,
    };
    const callbacks = createAgentAttemptLifecycleCallbacks(state);

    // The callback mutates only the shared lifecycle state object; it should not
    // need access to the wider runAgentAttempt closure.
    callbacks.onUserMessagePersisted?.({
      role: "user",
      content: "hello",
      timestamp: Date.now(),
    });

    expect(state.currentTurnUserMessagePersisted).toBe(true);
    expect(state.lifecycleEnded).toBe(false);
  });

  it("tracks terminal lifecycle phases", async () => {
    const state = {
      currentTurnUserMessagePersisted: false,
      lifecycleFinishing: false,
      lifecycleEnded: false,
    };
    const callbacks = createAgentAttemptLifecycleCallbacks(state);

    await callbacks.onAgentEvent({ stream: "lifecycle", data: { phase: "start" } });
    expect(state.lifecycleEnded).toBe(false);

    await callbacks.onAgentEvent({ stream: "lifecycle", data: { phase: "end" } });
    expect(state.lifecycleEnded).toBe(true);
  });

  it("retains deferred lifecycle errors without marking the attempt terminal", async () => {
    const state: AgentAttemptLifecycleState = {
      currentTurnUserMessagePersisted: false,
      lifecycleFinishing: false,
      lifecycleEnded: false,
    };
    const callbacks = createAgentAttemptLifecycleCallbacks(state);

    await callbacks.onAgentEvent({
      stream: "lifecycle",
      data: { phase: "finishing", error: "provider failed" },
    });

    expect(state.lifecycleError).toBe("provider failed");
    expect(state.lifecycleFinishing).toBe(true);
    expect(state.lifecycleEnded).toBe(false);
  });

  it("replaces a failed candidate lifecycle when a retry starts", async () => {
    const state: AgentAttemptLifecycleState = {
      currentTurnUserMessagePersisted: true,
      lifecycleError: "provider failed",
      lifecycleErrorObservation: { provider: "openai", httpStatus: 502 },
      lifecycleFinishing: true,
      lifecycleEnded: false,
    };
    const callbacks = createAgentAttemptLifecycleCallbacks(state);

    await callbacks.onAgentEvent({ stream: "lifecycle", data: { phase: "start" } });

    expect(state).toEqual({
      currentTurnUserMessagePersisted: true,
      lifecycleError: undefined,
      lifecycleErrorObservation: undefined,
      lifecycleFinishing: false,
      lifecycleEnded: false,
    });
  });

  it("emits only bounded provider activity and terminal observations", async () => {
    const state: AgentAttemptLifecycleState = {
      currentTurnUserMessagePersisted: false,
      lifecycleFinishing: false,
      lifecycleEnded: false,
    };
    const observe = vi.fn<(event: AgentRuntimeExecutionObservation) => Promise<void>>(
      async () => {},
    );
    const callbacks = createAgentAttemptLifecycleCallbacks(state, undefined, observe);

    await callbacks.onAgentEvent({ stream: "assistant", data: { text: "must not escape" } });
    await callbacks.onAgentEvent({ stream: "usage", data: { outputTokens: 12, inputTokens: 99 } });
    await callbacks.onAgentEvent({ stream: "tool", data: { phase: "start", name: "hidden" } });
    await callbacks.onAgentEvent({ stream: "lifecycle", data: { phase: "end" } });

    expect(observe.mock.calls.map(([event]) => event)).toEqual([
      { kind: "provider_activity", toolCallStarted: false },
      { kind: "provider_activity", toolCallStarted: false, outputTokens: 12 },
      { kind: "provider_activity", toolCallStarted: true },
      { kind: "terminal", status: "ok" },
    ]);
  });

  it("classifies capacity failure without exposing provider error text", async () => {
    const state: AgentAttemptLifecycleState = {
      currentTurnUserMessagePersisted: false,
      lifecycleFinishing: false,
      lifecycleEnded: false,
    };
    const observe = vi.fn<(event: AgentRuntimeExecutionObservation) => Promise<void>>(
      async () => {},
    );
    const callbacks = createAgentAttemptLifecycleCallbacks(state, undefined, observe);

    await callbacks.onAgentEvent({
      stream: "lifecycle",
      data: { phase: "error", error: "rate limit exceeded: private provider detail" },
    });

    expect(observe.mock.calls.map(([event]) => event)).toEqual([
      { kind: "provider_error", capacityExhausted: true },
      { kind: "terminal", status: "error" },
    ]);
  });

  it("reports an error terminal even when the runtime supplies no error text", async () => {
    const state: AgentAttemptLifecycleState = {
      currentTurnUserMessagePersisted: false,
      lifecycleFinishing: false,
      lifecycleEnded: false,
    };
    const observe = vi.fn<(event: AgentRuntimeExecutionObservation) => Promise<void>>(
      async () => {},
    );
    const callbacks = createAgentAttemptLifecycleCallbacks(state, undefined, observe);
    await callbacks.onAgentEvent({ stream: "lifecycle", data: { phase: "error" } });
    expect(observe).toHaveBeenCalledExactlyOnceWith({ kind: "terminal", status: "error" });
  });
});

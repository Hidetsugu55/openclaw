export const AGENT_RUN_EXECUTION_CANARY_OBSERVER = Symbol.for(
  "openclaw.test.agentRunExecutionCanaryObserver",
);

export type AgentRunExecutionCanaryEvent = {
  kind: "mark-execution-started" | "provider-start-hook";
  runId: string;
};

/** Test-process-only observation seam for the isolated Gateway execution canary. */
export function notifyAgentRunExecutionCanary(event: AgentRunExecutionCanaryEvent): void {
  if (process.env.VITEST !== "1") {
    return;
  }
  const observer = Reflect.get(globalThis, AGENT_RUN_EXECUTION_CANARY_OBSERVER);
  if (typeof observer !== "function") {
    return;
  }
  try {
    observer(Object.freeze({ ...event }));
  } catch {
    // Test observation must never alter execution behavior.
  }
}

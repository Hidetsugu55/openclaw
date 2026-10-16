import { createHash } from "node:crypto";
import type {
  AgentRuntimeExecutionEvent,
  AgentRuntimeExecutionIdentity,
} from "../agents/command/types.js";
import type { PluginStateKeyedStore } from "../plugin-state/plugin-state-store.types.js";
import type { PluginRecord } from "./registry-types.js";
import type {
  PluginRuntime,
  PluginSubagentExecutionResult,
} from "./runtime/types.js";

const READINESS1_PLUGIN_ID = "readiness1-native-controller";
const READINESS1_HOST_BINDING_KIND = "openclaw.readiness1.host-binding.v1";
const TASK_NODE_ID = /^[A-Za-z0-9_:-]{3,512}$/;
const TICKET_ID = /^[A-Za-z0-9:_-]{8,160}$/;
const READ_ONLY_ACTION_CLASSES = new Set(["read", "diagnostic"]);

export type Readiness1ReadOnlyRunRequest = Readonly<{
  taskNodeId: string;
  ticketId: string;
  beforeProvider: (identity: AgentRuntimeExecutionIdentity) => Promise<void>;
  onObservation?: (event: AgentRuntimeExecutionEvent) => void | Promise<void>;
}>;

type CanonicalReadOnlyTask = Readonly<{
  provider: "claude-code" | "codex";
  instructions: string;
  role: string;
  taskNodeId: string;
}>;

function canonicalReadOnlyTask(taskNodeId: string, value: unknown): CanonicalReadOnlyTask {
  const descriptor = value as {
    contract?: {
      actionClass?: unknown;
      caps?: { provider?: unknown };
      role?: unknown;
      taskNodeId?: unknown;
    };
    instructions?: unknown;
  } | undefined;
  const contract = descriptor?.contract;
  const provider = contract?.caps?.provider;
  if (
    contract?.taskNodeId !== taskNodeId
    || typeof contract.role !== "string"
    || !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(contract.role)
    || !READ_ONLY_ACTION_CLASSES.has(String(contract.actionClass))
    || (provider !== "claude-code" && provider !== "codex")
    || typeof descriptor?.instructions !== "string"
    || descriptor.instructions.trim().length === 0
    || descriptor.instructions.length > 64 * 1024
  ) {
    throw new Error("Readiness #1 canonical read-only Task is invalid.");
  }
  return Object.freeze({
    taskNodeId,
    role: contract.role,
    provider,
    instructions: descriptor.instructions,
  });
}

function readOnlySessionKey(task: CanonicalReadOnlyTask): string {
  const suffix = createHash("sha256").update(task.taskNodeId).digest("hex").slice(0, 24);
  return `agent:${task.role}:subagent:workboard-readiness1-${suffix}`;
}

function requireExpectedIdentity(identity: AgentRuntimeExecutionIdentity, sessionKey: string): void {
  if (
    identity.sessionKey !== sessionKey
    || identity.resourceOwnership.run !== "gateway"
    || identity.resourceOwnership.session !== "gateway"
    || identity.resourceOwnership.cleanup !== "gateway"
  ) {
    throw new Error("Readiness #1 native execution identity drift.");
  }
}

/**
 * A deliberately tiny private surface for the bundled Readiness #1 controller.
 * It is injected by the runtime resolver, never produced from plugin config or
 * a tool invocation. Additional lifecycle capabilities stay absent until their
 * own host-side admission and observation implementations are accepted.
 */
export type Readiness1HostBinding = Readonly<{
  kind: typeof READINESS1_HOST_BINDING_KIND;
  openLedgerStore: () => PluginStateKeyedStore<unknown>;
  /**
   * Canonical Tasks are written only by a future host-admin apply transaction.
   * The controller can read a fixed node but cannot supply, mutate, or mint a
   * descriptor from config, model output, or tool input.
   */
  readCanonicalDescriptor: (taskNodeId: string) => Promise<unknown>;
  /**
   * Starts only a host-stored read/diagnostic Task with no tools and no delivery.
   * The public controller does not yet expose this capability; a later accepted
   * lifecycle route must provide the pre-provider ledger admission callback.
   */
  runCanonicalReadOnly: (
    request: Readiness1ReadOnlyRunRequest,
  ) => Promise<PluginSubagentExecutionResult>;
}>;

export function createReadiness1HostBinding(params: {
  record: Pick<PluginRecord, "id" | "origin">;
  assertCurrent: () => void;
  openLedgerStore: () => PluginStateKeyedStore<unknown>;
  openCanonicalTaskStore: () => PluginStateKeyedStore<unknown>;
  runWithExecutionControl: PluginRuntime["subagent"]["runWithExecutionControl"];
}): Readiness1HostBinding | undefined {
  if (params.record.id !== READINESS1_PLUGIN_ID || params.record.origin !== "bundled") {
    return undefined;
  }
  return Object.freeze({
    kind: READINESS1_HOST_BINDING_KIND,
    openLedgerStore: () => {
      params.assertCurrent();
      return params.openLedgerStore();
    },
    readCanonicalDescriptor: async (taskNodeId) => {
      if (!TASK_NODE_ID.test(taskNodeId)) {
        throw new Error("Readiness #1 canonical Task id is invalid.");
      }
      params.assertCurrent();
      const task = await params.openCanonicalTaskStore().lookup(taskNodeId);
      if (task == null) {
        throw new Error("Readiness #1 canonical Task is unavailable.");
      }
      return structuredClone(task);
    },
    runCanonicalReadOnly: async (request) => {
      if (
        !request
        || !TASK_NODE_ID.test(request.taskNodeId)
        || !TICKET_ID.test(request.ticketId)
        || typeof request.beforeProvider !== "function"
        || (request.onObservation !== undefined && typeof request.onObservation !== "function")
      ) {
        throw new Error("Readiness #1 read-only run request is invalid.");
      }
      params.assertCurrent();
      const task = canonicalReadOnlyTask(
        request.taskNodeId,
        await params.openCanonicalTaskStore().lookup(request.taskNodeId),
      );
      const sessionKey = readOnlySessionKey(task);
      const accepted = await params.runWithExecutionControl(
        {
          assertCurrent: params.assertCurrent,
          sessionKey,
          message: task.instructions,
          provider: task.provider,
          disableTools: true,
          promptMode: "minimal",
          lightContext: true,
          deliver: false,
          idempotencyKey: request.ticketId,
        },
        {
          beforeProvider: async (identity) => {
            params.assertCurrent();
            requireExpectedIdentity(identity, sessionKey);
            await request.beforeProvider(identity);
          },
          ...(request.onObservation
            ? {
                onObservation: async (event) => {
                  params.assertCurrent();
                  requireExpectedIdentity(event.identity, sessionKey);
                  await request.onObservation?.(event);
                },
              }
            : {}),
        },
      );
      requireExpectedIdentity(accepted.execution, sessionKey);
      if (accepted.sessionKey !== sessionKey) {
        throw new Error("Readiness #1 accepted read-only session identity drift.");
      }
      return accepted;
    },
  });
}

export { READINESS1_HOST_BINDING_KIND, READINESS1_PLUGIN_ID };

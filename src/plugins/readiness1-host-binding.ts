import { createHash } from "node:crypto";
import type {
  AgentRuntimeExecutionEvent,
  AgentRuntimeExecutionIdentity,
} from "../agents/command/types.js";
import type { AgentWaitResult } from "../agents/run-wait.types.js";
import type { PluginStateKeyedStore } from "../plugin-state/plugin-state-store.types.js";
import { registerReadiness1SourceRunCustody } from "./readiness1-source-run-custody.js";
import {
  assessReadiness1SourceRunCleanupEvidence,
  assessReadiness1SourceRunFinalEvidence,
  READINESS1_SOURCE_RUN_CLEANUP_EVIDENCE_KIND,
  READINESS1_SOURCE_RUN_FINAL_EVIDENCE_KIND,
  type Readiness1SourceRunCleanupEvidence,
  type Readiness1SourceRunDurableResult,
  type Readiness1SourceRunFinalEvidence,
  type Readiness1SourceRunFinalSnapshot,
  type Readiness1SourceRunIdentity,
} from "./readiness1-source-run-evidence.js";
import type { PluginRecord } from "./registry-types.js";
import type { PluginRuntime, PluginSubagentExecutionResult } from "./runtime/types.js";

const READINESS1_PLUGIN_ID = "readiness1-native-controller";
const READINESS1_HOST_BINDING_KIND = "openclaw.readiness1.host-binding.v1";
const READINESS1_SOURCE_RUN_BINDING_V2_KIND = "openclaw.readiness1.source-run-binding.v2";
const READINESS1_SOURCE_RUN_BINDING_V3_KIND = "openclaw.readiness1.source-run-binding.v3";
const READINESS1_SOURCE_RUN_BINDING_V4_KIND = "openclaw.readiness1.source-run-binding.v4";
const READINESS1_SOURCE_RUN_BINDING_V5_KIND = "openclaw.readiness1.source-run-binding.v5";
const READINESS1_SOURCE_RUN_BINDING_V6_KIND = "openclaw.readiness1.source-run-binding.v6";
const READINESS1_SOURCE_RUN_BINDING_V7_KIND = "openclaw.readiness1.source-run-binding.v7";
const TASK_NODE_ID = /^[A-Za-z0-9_:-]{3,512}$/;
const TICKET_ID = /^[A-Za-z0-9:_-]{8,160}$/;
const READ_ONLY_ACTION_CLASSES = new Set(["read", "diagnostic"]);
const SOURCE_ACTION_CLASSES = new Set(["source"]);
const SHA1 = /^[a-f0-9]{40}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const WORKTREE_NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;
const WORKTREE_BRANCH = /^[A-Za-z0-9._/-]{1,256}$/;
const REQUIRED_SOURCE_TOOLS = Object.freeze(["read", "exec", "apply_patch"] as const);
const SOURCE_TERMINAL_WAIT_TIMEOUT_MS = 30_000;

export type Readiness1ReadOnlyRunRequest = Readonly<{
  taskNodeId: string;
  ticketId: string;
  beforeProvider: (identity: AgentRuntimeExecutionIdentity) => Promise<void>;
  onObservation?: (event: AgentRuntimeExecutionEvent) => void | Promise<void>;
}>;

export type Readiness1WorkspacePrepareRequest = Readonly<{
  taskNodeId: string;
  claimId: string;
}>;

export type Readiness1WorkspacePrepareResult = Readonly<{
  id: string;
  path: string;
  branch: string;
  sandboxed: boolean;
  workspaceAccess: "none" | "ro" | "rw";
  confinementError?: string;
}>;

export type Readiness1SourceRunPrepareRequest = Readonly<{
  taskNodeId: string;
  claimId: string;
}>;

/**
 * The host derives these values from one retained Task and one managed worktree.
 * They are delivered only to a host callback, never serialized into controller
 * state, tool input, or plugin configuration.
 */
export type Readiness1SourceRunContext = Readonly<{
  agentId: string;
  provider: "claude-code" | "codex";
  sessionKey: string;
  sessionRoot: string;
  workspaceDir: string;
  cwd: string;
  sandboxed: true;
  workspaceAccess: "rw";
  requiredToolNames: readonly ["read", "exec", "apply_patch"];
}>;

/** An opaque, exclusive managed-worktree lease; no registry ID or token is exposed. */
export type Readiness1SourceRunLease = Readonly<{
  kind: typeof READINESS1_SOURCE_RUN_BINDING_V2_KIND;
  withContext: <T>(run: (context: Readiness1SourceRunContext) => Promise<T> | T) => Promise<T>;
  /** Rejects if either the run lease or its managed-worktree reference is uncertain. */
  release: () => Promise<void>;
}>;

export type Readiness1SourceRunBindingV2 = Readonly<{
  kind: typeof READINESS1_SOURCE_RUN_BINDING_V2_KIND;
  /**
   * Builds a host-owned, exclusive pre-spawn binding only. This contract never
   * calls a provider or a public Gateway dispatch route.
   */
  prepare: (request: Readiness1SourceRunPrepareRequest) => Promise<Readiness1SourceRunLease>;
}>;

/**
 * v3 adds the Gateway session-root binding before any future provider launch.
 * It deliberately returns the v2 opaque lease rather than accepting a caller
 * supplied path, session, or worktree identifier.
 */
export type Readiness1SourceRunBindingV3 = Readonly<{
  kind: typeof READINESS1_SOURCE_RUN_BINDING_V3_KIND;
  prepare: (request: Readiness1SourceRunPrepareRequest) => Promise<Readiness1SourceRunLease>;
}>;

export type Readiness1SourceRunLaunchRequest = Readonly<{
  taskNodeId: string;
  ticketId: string;
  beforeProvider: (identity: AgentRuntimeExecutionIdentity) => Promise<void>;
  onObservation?: (event: AgentRuntimeExecutionEvent) => void | Promise<void>;
}>;

/**
 * The opaque launch receipt retains the exclusive workspace lease. It exposes
 * no release operation: a later host-only lifecycle binding must first prove
 * final and cleanup evidence before it can introduce a separately reviewed
 * lossless release path. This binding never accepts a path or lease ID.
 */
export type Readiness1SourceRunLaunch = Readonly<{
  kind: typeof READINESS1_SOURCE_RUN_BINDING_V4_KIND;
  runId: string;
  sessionKey: string;
  workspaceDir: string;
  /** Waits only for this exact held run with a host-fixed observation budget. */
  awaitTerminal: () => Promise<AgentWaitResult>;
}>;

/**
 * v4 is the host-only launch half of the source-run contract. It composes v3's
 * opaque lease with the same Gateway run that reaches the native pre-provider
 * hook. No public tool, plugin configuration, or controller dispatch reads it.
 */
export type Readiness1SourceRunBindingV4 = Readonly<{
  kind: typeof READINESS1_SOURCE_RUN_BINDING_V4_KIND;
  launch: (request: Readiness1SourceRunLaunchRequest) => Promise<Readiness1SourceRunLaunch>;
}>;

export type Readiness1SourceRunSnapshotReader = (
  expected: Readonly<{ workspaceDir: string }>,
) => Promise<Readiness1SourceRunFinalSnapshot>;

/**
 * V5 reads one final worktree snapshot after a run-owned terminal receipt.
 * It intentionally has no result, usage, cleanup, or lease-release capability:
 * those require separately reviewed host-owned evidence producers.
 */
export type Readiness1SourceRunFinalSnapshotLaunch = Readonly<{
  kind: typeof READINESS1_SOURCE_RUN_BINDING_V5_KIND;
  runId: string;
  sessionKey: string;
  workspaceDir: string;
  /** Reads the fixed workspace only after an exact, successful terminal receipt. */
  readFinalSnapshot: () => Promise<Readiness1SourceRunFinalSnapshot>;
}>;

export type Readiness1SourceRunBindingV5 = Readonly<{
  kind: typeof READINESS1_SOURCE_RUN_BINDING_V5_KIND;
  launch: (
    request: Readiness1SourceRunLaunchRequest,
  ) => Promise<Readiness1SourceRunFinalSnapshotLaunch>;
}>;

/** A durable, run-owned result record with no model text or provider payload. */
export type Readiness1SourceRunFinalObservation = Readonly<{
  runId: string;
  sessionKey: string;
  usage: number;
  result: Readiness1SourceRunDurableResult;
}>;

export type Readiness1SourceRunFinalObservationReader = (
  expected: Readonly<{ runId: string; sessionKey: string }>,
) => Promise<Readiness1SourceRunFinalObservation | undefined>;

export type Readiness1SourceRunFinalObservationWriter = (
  event: AgentRuntimeExecutionEvent,
) => Promise<void>;

/**
 * V6 binds the final result digest and measured usage to the held V5 run.
 * It does not expose result text, cleanup operations, or lease release.
 */
export type Readiness1SourceRunFinalEvidenceLaunch = Readonly<{
  kind: typeof READINESS1_SOURCE_RUN_BINDING_V6_KIND;
  runId: string;
  sessionKey: string;
  workspaceDir: string;
  readFinalEvidence: () => Promise<Readiness1SourceRunFinalEvidence>;
}>;

export type Readiness1SourceRunBindingV6 = Readonly<{
  kind: typeof READINESS1_SOURCE_RUN_BINDING_V6_KIND;
  launch: (
    request: Readiness1SourceRunLaunchRequest,
  ) => Promise<Readiness1SourceRunFinalEvidenceLaunch>;
}>;

/**
 * The host finalizer is the only place that may perform lossless cleanup. Its
 * receipt is intentionally run-bound. It exposes only the fixed workspace
 * identity; lease IDs, PIDs, provider payloads, and an operation handle never
 * cross the controller-facing surface.
 */
export type Readiness1SourceRunCleanupReceipt = Readonly<{
  runId: string;
  sessionKey: string;
  workspaceDir: string;
  processStopped?: boolean;
  groupStopped?: boolean;
  containerRemoved?: boolean;
  lsofClear?: boolean;
  runLeaseReleased?: boolean;
  workspaceReleased?: boolean;
  workspaceRemoved?: boolean;
}>;

export type Readiness1SourceRunCleanupFinalizer = (
  expected: Readiness1SourceRunIdentity,
) => Promise<Readiness1SourceRunCleanupReceipt>;

/**
 * V7 adds a separately owned cleanup receipt after V6 final evidence. The
 * finalizer stays absent until the native runner can attest every physical
 * resource for this exact run; callers never infer facts from a terminal run.
 */
export type Readiness1SourceRunCleanupEvidenceLaunch = Readonly<{
  kind: typeof READINESS1_SOURCE_RUN_BINDING_V7_KIND;
  runId: string;
  sessionKey: string;
  workspaceDir: string;
  readCleanupEvidence: () => Promise<Readiness1SourceRunCleanupEvidence>;
}>;

export type Readiness1SourceRunBindingV7 = Readonly<{
  kind: typeof READINESS1_SOURCE_RUN_BINDING_V7_KIND;
  launch: (
    request: Readiness1SourceRunLaunchRequest,
  ) => Promise<Readiness1SourceRunCleanupEvidenceLaunch>;
}>;

type Readiness1SourceRunLeaseGuard = Readonly<{
  release: () => Promise<boolean>;
}>;

type CanonicalReadOnlyTask = Readonly<{
  provider: "claude-code" | "codex";
  instructions: string;
  role: string;
  taskNodeId: string;
}>;

type CanonicalSourceTask = Readonly<{
  taskNodeId: string;
  role: string;
  provider: "claude-code" | "codex";
  ref: string;
  head: string;
  root: string;
  sourceRoot: string;
  worktreeName: string;
  worktreeBranch: string;
  indexDigest: string;
}>;

type CanonicalSourceLaunchTask = Readonly<{
  task: CanonicalSourceTask;
  instructions: string;
}>;

function canonicalReadOnlyTask(taskNodeId: string, value: unknown): CanonicalReadOnlyTask {
  const descriptor = value as
    | {
        contract?: {
          actionClass?: unknown;
          caps?: { provider?: unknown };
          role?: unknown;
          taskNodeId?: unknown;
        };
        instructions?: unknown;
      }
    | undefined;
  const contract = descriptor?.contract;
  const provider = contract?.caps?.provider;
  if (
    contract?.taskNodeId !== taskNodeId ||
    typeof contract.role !== "string" ||
    !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(contract.role) ||
    !READ_ONLY_ACTION_CLASSES.has(String(contract.actionClass)) ||
    (provider !== "claude-code" && provider !== "codex") ||
    typeof descriptor?.instructions !== "string" ||
    descriptor.instructions.trim().length === 0 ||
    descriptor.instructions.length > 64 * 1024
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

function canonicalSourceTask(taskNodeId: string, value: unknown): CanonicalSourceTask {
  const descriptor = value as
    | {
        contract?: {
          actionClass?: unknown;
          caps?: { provider?: unknown };
          head?: unknown;
          ref?: unknown;
          role?: unknown;
          root?: unknown;
          taskNodeId?: unknown;
        };
        indexDigest?: unknown;
        sourceRoot?: unknown;
        worktreeBranch?: unknown;
        worktreeName?: unknown;
      }
    | undefined;
  const contract = descriptor?.contract;
  const provider = contract?.caps?.provider;
  if (
    contract?.taskNodeId !== taskNodeId ||
    typeof contract.role !== "string" ||
    !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(contract.role) ||
    !SOURCE_ACTION_CLASSES.has(String(contract.actionClass)) ||
    (provider !== "claude-code" && provider !== "codex") ||
    typeof contract.ref !== "string" ||
    !contract.ref.startsWith("refs/heads/") ||
    typeof contract.head !== "string" ||
    !SHA1.test(contract.head) ||
    !isAbsoluteCanonicalPath(contract.root) ||
    !isAbsoluteCanonicalPath(descriptor?.sourceRoot) ||
    typeof descriptor.worktreeName !== "string" ||
    !WORKTREE_NAME.test(descriptor.worktreeName) ||
    typeof descriptor.worktreeBranch !== "string" ||
    !WORKTREE_BRANCH.test(descriptor.worktreeBranch) ||
    descriptor.worktreeBranch !== `openclaw/${descriptor.worktreeName}` ||
    !SHA256.test(String(descriptor.indexDigest))
  ) {
    throw new Error("Readiness #1 canonical source Task is invalid.");
  }
  return Object.freeze({
    taskNodeId,
    role: contract.role,
    provider,
    ref: contract.ref,
    head: contract.head,
    root: contract.root,
    sourceRoot: descriptor.sourceRoot,
    worktreeName: descriptor.worktreeName,
    worktreeBranch: descriptor.worktreeBranch,
    indexDigest: String(descriptor.indexDigest),
  });
}

function canonicalSourceLaunchTask(taskNodeId: string, value: unknown): CanonicalSourceLaunchTask {
  const instructions = (value as { instructions?: unknown } | undefined)?.instructions;
  if (
    typeof instructions !== "string" ||
    instructions.trim().length === 0 ||
    instructions.length > 64 * 1024
  ) {
    throw new Error("Readiness #1 canonical source Task instructions are invalid.");
  }
  return Object.freeze({ task: canonicalSourceTask(taskNodeId, value), instructions });
}

function sameCanonicalSourceTask(left: CanonicalSourceTask, right: CanonicalSourceTask): boolean {
  return (
    left.taskNodeId === right.taskNodeId &&
    left.role === right.role &&
    left.provider === right.provider &&
    left.ref === right.ref &&
    left.head === right.head &&
    left.root === right.root &&
    left.sourceRoot === right.sourceRoot &&
    left.worktreeName === right.worktreeName &&
    left.worktreeBranch === right.worktreeBranch &&
    left.indexDigest === right.indexDigest
  );
}

function hasExactRequiredSourceTools(value: readonly string[]): boolean {
  return (
    value.length === REQUIRED_SOURCE_TOOLS.length &&
    value.every((toolName, index) => toolName === REQUIRED_SOURCE_TOOLS[index])
  );
}

function isAbsoluteCanonicalPath(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.startsWith("/") &&
    !value.split("/").some((part) => part === "." || part === "..")
  );
}

function readiness1WorkerSessionKey(
  task: Pick<CanonicalReadOnlyTask, "taskNodeId" | "role">,
): string {
  const suffix = createHash("sha256").update(task.taskNodeId).digest("hex").slice(0, 24);
  return `agent:${task.role}:subagent:workboard-readiness1-${suffix}`;
}

function requireExpectedIdentity(
  identity: AgentRuntimeExecutionIdentity,
  sessionKey: string,
): void {
  if (
    identity.sessionKey !== sessionKey ||
    identity.resourceOwnership.run !== "gateway" ||
    identity.resourceOwnership.session !== "gateway" ||
    identity.resourceOwnership.cleanup !== "gateway"
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
  /**
   * Creates only the host-stored source Task's managed worktree, with the
   * runtime's normal workboard owner and sandbox authority. It remains private
   * until later source and terminal-observation bindings are accepted.
   */
  prepareCanonicalWorkspace: (
    request: Readiness1WorkspacePrepareRequest,
  ) => Promise<Readiness1WorkspacePrepareResult>;
}>;

export function createReadiness1HostBinding(params: {
  record: Pick<PluginRecord, "id" | "origin">;
  assertCurrent: () => void;
  openLedgerStore: () => PluginStateKeyedStore<unknown>;
  openCanonicalTaskStore: () => PluginStateKeyedStore<unknown>;
  runWithExecutionControl: PluginRuntime["subagent"]["runWithExecutionControl"];
  workspace?: Pick<PluginRuntime, "sandbox" | "worktrees" | "config">;
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
        !request ||
        !TASK_NODE_ID.test(request.taskNodeId) ||
        !TICKET_ID.test(request.ticketId) ||
        typeof request.beforeProvider !== "function" ||
        (request.onObservation !== undefined && typeof request.onObservation !== "function")
      ) {
        throw new Error("Readiness #1 read-only run request is invalid.");
      }
      params.assertCurrent();
      const task = canonicalReadOnlyTask(
        request.taskNodeId,
        await params.openCanonicalTaskStore().lookup(request.taskNodeId),
      );
      const sessionKey = readiness1WorkerSessionKey(task);
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
    prepareCanonicalWorkspace: async (request) => {
      if (!request || !TASK_NODE_ID.test(request.taskNodeId) || !TICKET_ID.test(request.claimId)) {
        throw new Error("Readiness #1 workspace request is invalid.");
      }
      const workspaceRuntime = params.workspace;
      if (!workspaceRuntime) {
        throw new Error("Readiness #1 workspace runtime is unavailable.");
      }
      params.assertCurrent();
      const task = canonicalSourceTask(
        request.taskNodeId,
        await params.openCanonicalTaskStore().lookup(request.taskNodeId),
      );
      params.assertCurrent();
      const resolvedRoot = await workspaceRuntime.worktrees.resolveCheckoutRoot({
        path: task.sourceRoot,
      });
      params.assertCurrent();
      if (resolvedRoot !== task.sourceRoot) {
        throw new Error("Readiness #1 source checkout identity mismatch.");
      }
      const ownerId = `readiness1:${task.taskNodeId}:${request.claimId}`;
      let created: Awaited<ReturnType<PluginRuntime["worktrees"]["create"]>> | undefined;
      try {
        created = await workspaceRuntime.worktrees.create({
          repoRoot: task.sourceRoot,
          name: task.worktreeName,
          baseRef: task.head,
          ownerKind: "workboard",
          ownerId,
          commitGuard: params.assertCurrent,
        });
        params.assertCurrent();
        const resolvedWorkspaceRoot = await workspaceRuntime.worktrees.resolveCheckoutRoot({
          path: created.path,
        });
        params.assertCurrent();
        if (
          created.path !== task.root ||
          resolvedWorkspaceRoot !== created.path ||
          created.branch !== task.worktreeBranch
        ) {
          throw new Error("Readiness #1 managed worktree identity mismatch.");
        }
        const authority = await workspaceRuntime.sandbox.prepareWorkspaceAuthority({
          config: workspaceRuntime.config.current() as Parameters<
            PluginRuntime["sandbox"]["prepareWorkspaceAuthority"]
          >[0]["config"],
          agentId: task.role,
          sessionKey: readiness1WorkerSessionKey(task),
          workspaceDir: created.path,
          confinedToolNames: [],
          requiredToolNames: REQUIRED_SOURCE_TOOLS,
          modelProvider: task.provider,
        });
        params.assertCurrent();
        if (
          authority.sandboxed !== true ||
          authority.workspaceAccess !== "rw" ||
          authority.confinementError
        ) {
          throw new Error("Readiness #1 required worker sandbox is unavailable.");
        }
        return Object.freeze({
          id: created.id,
          path: created.path,
          branch: created.branch,
          sandboxed: authority.sandboxed,
          workspaceAccess: authority.workspaceAccess,
        });
      } catch (error) {
        if (created) {
          try {
            await workspaceRuntime.worktrees.release({ path: created.path });
            const removed = await workspaceRuntime.worktrees.removeIfLossless({
              path: created.path,
              ownerKind: "workboard",
              ownerId,
            });
            if (!removed) {
              throw new Error("Readiness #1 workspace cleanup was not confirmed.");
            }
          } catch (cleanupError) {
            throw new AggregateError(
              [error, cleanupError],
              "Readiness #1 workspace preparation failed with uncertain cleanup.",
            );
          }
        }
        throw error;
      }
    },
  });
}

/**
 * A separate v2 contract so the v1 binding's exact key set remains stable.
 * It owns the worktree run lease until a later, separately reviewed host launch
 * path consumes it. No extension currently receives or calls this binding.
 */
export function createReadiness1SourceRunBindingV2(params: {
  record: Pick<PluginRecord, "id" | "origin">;
  assertCurrent: () => void;
  openLedgerStore: () => PluginStateKeyedStore<unknown>;
  openCanonicalTaskStore: () => PluginStateKeyedStore<unknown>;
  runWithExecutionControl: PluginRuntime["subagent"]["runWithExecutionControl"];
  workspace?: Pick<PluginRuntime, "sandbox" | "worktrees" | "config">;
  /** Injected by the host resolver; intentionally absent from PluginRuntime. */
  acquireSourceRunLease?: (worktreeId: string) => Promise<Readiness1SourceRunLeaseGuard>;
}): Readiness1SourceRunBindingV2 | undefined {
  const v1 = createReadiness1HostBinding(params);
  const workspaceRuntime = params.workspace;
  const acquireSourceRunLease = params.acquireSourceRunLease;
  if (!v1 || !workspaceRuntime || !acquireSourceRunLease) {
    return undefined;
  }
  return Object.freeze({
    kind: READINESS1_SOURCE_RUN_BINDING_V2_KIND,
    prepare: async (request) => {
      if (!request || !TASK_NODE_ID.test(request.taskNodeId) || !TICKET_ID.test(request.claimId)) {
        throw new Error("Readiness #1 source run request is invalid.");
      }
      params.assertCurrent();
      const task = canonicalSourceTask(
        request.taskNodeId,
        await params.openCanonicalTaskStore().lookup(request.taskNodeId),
      );
      const prepared = await v1.prepareCanonicalWorkspace(request);
      let runLease: Readiness1SourceRunLeaseGuard | undefined;
      try {
        params.assertCurrent();
        runLease = await acquireSourceRunLease(prepared.id);
        params.assertCurrent();
      } catch (error) {
        try {
          if (runLease) {
            const released = await runLease.release();
            if (!released) {
              throw new Error("Readiness #1 source run lease cleanup was not confirmed.");
            }
          }
          await workspaceRuntime.worktrees.release({ path: prepared.path });
          const removed = await workspaceRuntime.worktrees.removeIfLossless({
            path: prepared.path,
            ownerKind: "workboard",
            ownerId: `readiness1:${task.taskNodeId}:${request.claimId}`,
          });
          if (!removed) {
            throw new Error("Readiness #1 source run cleanup was not confirmed.");
          }
        } catch (cleanupError) {
          throw new AggregateError(
            [error, cleanupError],
            "Readiness #1 source run preparation failed with uncertain cleanup.",
          );
        }
        throw error;
      }
      if (!runLease) {
        throw new Error("Readiness #1 source run lease is UNKNOWN.");
      }
      const heldRunLease = runLease;
      const context: Readiness1SourceRunContext = Object.freeze({
        agentId: task.role,
        provider: task.provider,
        sessionKey: readiness1WorkerSessionKey(task),
        sessionRoot: prepared.path,
        workspaceDir: prepared.path,
        cwd: prepared.path,
        sandboxed: true,
        workspaceAccess: "rw",
        requiredToolNames: REQUIRED_SOURCE_TOOLS,
      });
      let released = false;
      let release: Promise<void> | undefined;
      return Object.freeze({
        kind: READINESS1_SOURCE_RUN_BINDING_V2_KIND,
        withContext: async (run) => {
          if (released || typeof run !== "function") {
            throw new Error("Readiness #1 source run lease is unavailable.");
          }
          params.assertCurrent();
          const result = await run(context);
          params.assertCurrent();
          return result;
        },
        release: () =>
          (release ??= (async () => {
            const confirmed = await heldRunLease.release();
            if (!confirmed) {
              throw new Error("Readiness #1 source run lease release is UNKNOWN.");
            }
            await workspaceRuntime.worktrees.release({ path: prepared.path });
            released = true;
          })()),
      });
    },
  });
}

/**
 * A separate contract keeps v2's lease shape stable. It binds the Gateway
 * session root before a later private launch path can call a provider. No
 * bundled extension code or public dispatch route currently reads this capability.
 */
export function createReadiness1SourceRunBindingV3(params: {
  record: Pick<PluginRecord, "id" | "origin">;
  assertCurrent: () => void;
  openLedgerStore: () => PluginStateKeyedStore<unknown>;
  openCanonicalTaskStore: () => PluginStateKeyedStore<unknown>;
  runWithExecutionControl: PluginRuntime["subagent"]["runWithExecutionControl"];
  workspace?: Pick<PluginRuntime, "sandbox" | "worktrees" | "config">;
  acquireSourceRunLease?: (worktreeId: string) => Promise<Readiness1SourceRunLeaseGuard>;
  /** Host resolver closure; never part of PluginRuntime or plugin input. */
  bindSourceSession?: (context: Readiness1SourceRunContext) => Promise<void>;
}): Readiness1SourceRunBindingV3 | undefined {
  const v2 = createReadiness1SourceRunBindingV2(params);
  if (!v2 || !params.bindSourceSession) {
    return undefined;
  }
  return Object.freeze({
    kind: READINESS1_SOURCE_RUN_BINDING_V3_KIND,
    prepare: async (request) => {
      const lease = await v2.prepare(request);
      try {
        await lease.withContext(async (context) => {
          await params.bindSourceSession?.(context);
        });
        return lease;
      } catch (error) {
        try {
          await lease.release();
        } catch (cleanupError) {
          throw new AggregateError(
            [error, cleanupError],
            "Readiness #1 source session binding failed with uncertain cleanup.",
          );
        }
        throw error;
      }
    },
  });
}

/**
 * v4 deliberately remains a separate capability from v3 preparation. The
 * future launch must use the very same host-held session/worktree authority at
 * the final native pre-provider boundary; descriptor or session drift releases
 * the lease without starting provider work.
 */
export function createReadiness1SourceRunBindingV4(params: {
  record: Pick<PluginRecord, "id" | "origin">;
  assertCurrent: () => void;
  openLedgerStore: () => PluginStateKeyedStore<unknown>;
  openCanonicalTaskStore: () => PluginStateKeyedStore<unknown>;
  runWithExecutionControl: PluginRuntime["subagent"]["runWithExecutionControl"];
  waitForRun?: PluginRuntime["subagent"]["waitForRun"];
  workspace?: Pick<PluginRuntime, "sandbox" | "worktrees" | "config">;
  acquireSourceRunLease?: (worktreeId: string) => Promise<Readiness1SourceRunLeaseGuard>;
  bindSourceSession?: (context: Readiness1SourceRunContext) => Promise<void>;
  /** Rechecks the persisted source session immediately before provider start. */
  assertSourceSession?: (context: Readiness1SourceRunContext) => Promise<void>;
  /** Host-only exact-path readback after a lossless worktree removal. */
  isWorkspaceAbsent?: (context: Readonly<{ workspaceDir: string }>) => Promise<boolean>;
}): Readiness1SourceRunBindingV4 | undefined {
  const v3 = createReadiness1SourceRunBindingV3(params);
  const assertSourceSession = params.assertSourceSession;
  const waitForRun = params.waitForRun;
  const workspaceRuntime = params.workspace;
  const isWorkspaceAbsent = params.isWorkspaceAbsent;
  if (!v3 || !assertSourceSession || !waitForRun) {
    return undefined;
  }
  return Object.freeze({
    kind: READINESS1_SOURCE_RUN_BINDING_V4_KIND,
    launch: async (request) => {
      if (
        !request ||
        !TASK_NODE_ID.test(request.taskNodeId) ||
        !TICKET_ID.test(request.ticketId) ||
        typeof request.beforeProvider !== "function" ||
        (request.onObservation !== undefined && typeof request.onObservation !== "function")
      ) {
        throw new Error("Readiness #1 source launch request is invalid.");
      }
      params.assertCurrent();
      const initial = canonicalSourceLaunchTask(
        request.taskNodeId,
        await params.openCanonicalTaskStore().lookup(request.taskNodeId),
      );
      params.assertCurrent();
      const lease = await v3.prepare({ taskNodeId: request.taskNodeId, claimId: request.ticketId });
      let providerAdmissionPassed = false;
      let custodyRegistered = false;
      try {
        const accepted = await lease.withContext(async (context) => {
          if (
            context.agentId !== initial.task.role ||
            context.provider !== initial.task.provider ||
            context.sessionRoot !== initial.task.root ||
            context.workspaceDir !== initial.task.root ||
            context.cwd !== initial.task.root ||
            context.sandboxed !== true ||
            context.workspaceAccess !== "rw" ||
            !hasExactRequiredSourceTools(context.requiredToolNames)
          ) {
            throw new Error("Readiness #1 source launch context drift.");
          }
          params.assertCurrent();
          await assertSourceSession(context);
          params.assertCurrent();
          const result = await params.runWithExecutionControl(
            {
              assertCurrent: params.assertCurrent,
              sessionKey: context.sessionKey,
              message: initial.instructions,
              provider: context.provider,
              promptMode: "minimal",
              lightContext: true,
              deliver: false,
              idempotencyKey: request.ticketId,
              cwd: context.cwd,
            },
            {
              beforeProvider: async (identity) => {
                params.assertCurrent();
                const current = canonicalSourceLaunchTask(
                  request.taskNodeId,
                  await params.openCanonicalTaskStore().lookup(request.taskNodeId),
                );
                if (
                  !sameCanonicalSourceTask(initial.task, current.task) ||
                  current.instructions !== initial.instructions
                ) {
                  throw new Error("Readiness #1 canonical source Task drift before provider.");
                }
                await assertSourceSession(context);
                requireExpectedIdentity(identity, context.sessionKey);
                await request.beforeProvider(identity);
                // Once the native start admission has returned, provider work may
                // begin even if a later lifecycle check fails. Keep the lease
                // retained for the future terminal/cleanup owner in that case.
                providerAdmissionPassed = true;
                params.assertCurrent();
              },
              requireDirectLocalProcessCustody: true,
              onObservation: async (event) => {
                params.assertCurrent();
                requireExpectedIdentity(event.identity, context.sessionKey);
                if (event.observation.kind === "direct_local_process_custody") {
                  if (custodyRegistered || !workspaceRuntime || !isWorkspaceAbsent) {
                    throw new Error("Readiness #1 source process custody is unavailable.");
                  }
                  const expected = Object.freeze({
                    runId: event.identity.runId,
                    sessionKey: event.identity.sessionKey,
                    workspaceDir: context.workspaceDir,
                  });
                  registerReadiness1SourceRunCustody({
                    expected,
                    custody: event.observation.custody,
                    finalizeWorkspace: async (physical) => {
                      const processConfirmed =
                        physical.processStopped &&
                        physical.groupStopped &&
                        physical.containerAbsent &&
                        physical.lsofClear;
                      if (!processConfirmed) {
                        return Object.freeze({
                          processStopped: physical.processStopped,
                          groupStopped: physical.groupStopped,
                          containerRemoved: physical.containerAbsent,
                          lsofClear: physical.lsofClear,
                          runLeaseReleased: false,
                          workspaceReleased: false,
                          workspaceRemoved: false,
                        });
                      }
                      let runLeaseReleased = false;
                      try {
                        // V2 converts its underlying boolean receipt into a
                        // rejection on false, so a fulfilled release here is
                        // the exact retained lease receipt.
                        await lease.release();
                        runLeaseReleased = true;
                      } catch {
                        // The receipt remains UNKNOWN; never infer a release.
                      }
                      if (!runLeaseReleased) {
                        return Object.freeze({
                          processStopped: true,
                          groupStopped: true,
                          containerRemoved: true,
                          lsofClear: true,
                          runLeaseReleased: false,
                          workspaceReleased: false,
                          workspaceRemoved: false,
                        });
                      }
                      let removed = false;
                      let absent = false;
                      try {
                        removed = await workspaceRuntime.worktrees.removeIfLossless({
                          path: context.workspaceDir,
                          ownerKind: "workboard",
                          ownerId: `readiness1:${initial.task.taskNodeId}:${request.ticketId}`,
                        });
                        absent =
                          removed &&
                          (await isWorkspaceAbsent({ workspaceDir: context.workspaceDir }));
                      } catch {
                        // Lossless removal/readback must be explicit before confirmation.
                      }
                      return Object.freeze({
                        processStopped: true,
                        groupStopped: true,
                        containerRemoved: true,
                        lsofClear: true,
                        runLeaseReleased: true,
                        workspaceReleased: absent,
                        workspaceRemoved: removed && absent,
                      });
                    },
                  });
                  custodyRegistered = true;
                }
                await request.onObservation?.(event);
              },
            },
          );
          requireExpectedIdentity(result.execution, context.sessionKey);
          if (result.sessionKey !== context.sessionKey) {
            throw new Error("Readiness #1 accepted source session identity drift.");
          }
          return Object.freeze({ result, context });
        });
        return Object.freeze({
          kind: READINESS1_SOURCE_RUN_BINDING_V4_KIND,
          runId: accepted.result.runId,
          sessionKey: accepted.result.sessionKey,
          workspaceDir: accepted.context.workspaceDir,
          awaitTerminal: async () => {
            params.assertCurrent();
            const wait = await waitForRun({
              runId: accepted.result.runId,
              timeoutMs: SOURCE_TERMINAL_WAIT_TIMEOUT_MS,
            });
            params.assertCurrent();
            return wait;
          },
        });
      } catch (error) {
        if (providerAdmissionPassed) {
          throw new AggregateError(
            [error],
            "Readiness #1 source launch is UNKNOWN after provider admission; workspace remains retained.",
          );
        }
        try {
          await lease.release();
        } catch (cleanupError) {
          throw new AggregateError(
            [error, cleanupError],
            "Readiness #1 source launch failed with uncertain cleanup.",
          );
        }
        throw error;
      }
    },
  });
}

/**
 * A separate v5 capability consumes v4's held source run only after its exact
 * terminal receipt is available. It reads one final worktree snapshot through
 * a host closure, never through plugin input. It does not infer a durable
 * result or successful final evidence from session history.
 */
export function createReadiness1SourceRunBindingV5(params: {
  record: Pick<PluginRecord, "id" | "origin">;
  assertCurrent: () => void;
  openLedgerStore: () => PluginStateKeyedStore<unknown>;
  openCanonicalTaskStore: () => PluginStateKeyedStore<unknown>;
  runWithExecutionControl: PluginRuntime["subagent"]["runWithExecutionControl"];
  waitForRun?: PluginRuntime["subagent"]["waitForRun"];
  workspace?: Pick<PluginRuntime, "sandbox" | "worktrees" | "config">;
  acquireSourceRunLease?: (worktreeId: string) => Promise<Readiness1SourceRunLeaseGuard>;
  bindSourceSession?: (context: Readiness1SourceRunContext) => Promise<void>;
  assertSourceSession?: (context: Readiness1SourceRunContext) => Promise<void>;
  isWorkspaceAbsent?: (context: Readonly<{ workspaceDir: string }>) => Promise<boolean>;
  /** Host closure that reads one exact managed-worktree final state. */
  captureFinalSnapshot?: Readiness1SourceRunSnapshotReader;
}): Readiness1SourceRunBindingV5 | undefined {
  const v4 = createReadiness1SourceRunBindingV4(params);
  const captureFinalSnapshot = params.captureFinalSnapshot;
  if (!v4 || !captureFinalSnapshot) {
    return undefined;
  }
  return Object.freeze({
    kind: READINESS1_SOURCE_RUN_BINDING_V5_KIND,
    launch: async (request) => {
      const launched = await v4.launch(request);
      const expected = Object.freeze({
        runId: launched.runId,
        sessionKey: launched.sessionKey,
        workspaceDir: launched.workspaceDir,
      });
      let snapshotRead: Promise<Readiness1SourceRunFinalSnapshot> | undefined;
      return Object.freeze({
        kind: READINESS1_SOURCE_RUN_BINDING_V5_KIND,
        runId: expected.runId,
        sessionKey: expected.sessionKey,
        workspaceDir: expected.workspaceDir,
        readFinalSnapshot: async () => {
          if (snapshotRead) {
            return await snapshotRead;
          }
          const read = (async () => {
            try {
              params.assertCurrent();
              const wait = await launched.awaitTerminal();
              params.assertCurrent();
              if (
                wait.status !== "ok" ||
                wait.providerStarted !== true ||
                !Number.isFinite(wait.endedAt) ||
                wait.terminalReceipt?.runId !== expected.runId
              ) {
                throw new Error("Readiness #1 source terminal receipt is unavailable.");
              }
              const snapshot = await captureFinalSnapshot({ workspaceDir: expected.workspaceDir });
              params.assertCurrent();
              if (
                snapshot.workspaceDir !== expected.workspaceDir ||
                !SHA1.test(snapshot.head) ||
                !SHA256.test(snapshot.indexDigest) ||
                typeof snapshot.dirty !== "string"
              ) {
                throw new Error("Readiness #1 source final worktree snapshot is invalid.");
              }
              return Object.freeze({ ...snapshot });
            } catch (error) {
              snapshotRead = undefined;
              throw error;
            }
          })();
          snapshotRead = read;
          return await read;
        },
      });
    },
  });
}

/**
 * V6 consumes the held V5 run through two host closures: one records the
 * bounded final event durably, the other reads that exact run record. Missing,
 * malformed, or stale records deliberately remain UNKNOWN instead of being
 * reconstructed from session history or terminal transcript metadata.
 */
export function createReadiness1SourceRunBindingV6(params: {
  v5?: Readiness1SourceRunBindingV5;
  assertCurrent: () => void;
  waitForRun?: PluginRuntime["subagent"]["waitForRun"];
  persistFinalObservation?: Readiness1SourceRunFinalObservationWriter;
  readFinalObservation?: Readiness1SourceRunFinalObservationReader;
}): Readiness1SourceRunBindingV6 | undefined {
  const v5 = params.v5;
  const waitForRun = params.waitForRun;
  const persistFinalObservation = params.persistFinalObservation;
  const readFinalObservation = params.readFinalObservation;
  if (!v5 || !waitForRun || !persistFinalObservation || !readFinalObservation) {
    return undefined;
  }
  return Object.freeze({
    kind: READINESS1_SOURCE_RUN_BINDING_V6_KIND,
    launch: async (request) => {
      const launched = await v5.launch({
        ...request,
        onObservation: async (event) => {
          if (event.observation.kind === "final") {
            await persistFinalObservation(event);
          }
          await request.onObservation?.(event);
        },
      });
      const expected = Object.freeze({
        runId: launched.runId,
        sessionKey: launched.sessionKey,
        workspaceDir: launched.workspaceDir,
      });
      let evidenceRead: Promise<Readiness1SourceRunFinalEvidence> | undefined;
      return Object.freeze({
        kind: READINESS1_SOURCE_RUN_BINDING_V6_KIND,
        runId: expected.runId,
        sessionKey: expected.sessionKey,
        workspaceDir: expected.workspaceDir,
        readFinalEvidence: async () => {
          if (evidenceRead) {
            return await evidenceRead;
          }
          const read = (async () => {
            try {
              params.assertCurrent();
              const wait = await waitForRun({
                runId: expected.runId,
                timeoutMs: SOURCE_TERMINAL_WAIT_TIMEOUT_MS,
              });
              const [snapshot, finalObservation] = await Promise.all([
                launched.readFinalSnapshot(),
                readFinalObservation({ runId: expected.runId, sessionKey: expected.sessionKey }),
              ]);
              params.assertCurrent();
              const evidence = assessReadiness1SourceRunFinalEvidence({
                expected,
                observed: {
                  runId: expected.runId,
                  sessionKey: expected.sessionKey,
                  wait,
                  ...(finalObservation
                    ? { usage: finalObservation.usage, result: finalObservation.result }
                    : {}),
                  snapshot,
                },
              });
              if (evidence.state !== "CONFIRMED") {
                evidenceRead = undefined;
              }
              return evidence;
            } catch (error) {
              evidenceRead = undefined;
              throw error;
            }
          })();
          evidenceRead = read;
          return await read;
        },
      });
    },
  });
}

function unknownCleanupEvidence(
  expected: Readiness1SourceRunIdentity,
): Readiness1SourceRunCleanupEvidence {
  return Object.freeze({
    kind: READINESS1_SOURCE_RUN_CLEANUP_EVIDENCE_KIND,
    state: "UNKNOWN",
    runId: expected.runId,
    sessionKey: expected.sessionKey,
    workspaceDir: expected.workspaceDir,
  });
}

/**
 * V7 deliberately cannot manufacture cleanup facts from V6, `agent.wait`, or
 * a successful worktree removal. A native, run-bound finalizer must attest all
 * resources before this capability is made available by the host resolver.
 */
export function createReadiness1SourceRunBindingV7(params: {
  v6?: Readiness1SourceRunBindingV6;
  assertCurrent: () => void;
  finalizeCleanup?: Readiness1SourceRunCleanupFinalizer;
}): Readiness1SourceRunBindingV7 | undefined {
  const v6 = params.v6;
  const finalizeCleanup = params.finalizeCleanup;
  if (!v6 || !finalizeCleanup) {
    return undefined;
  }
  return Object.freeze({
    kind: READINESS1_SOURCE_RUN_BINDING_V7_KIND,
    launch: async (request) => {
      const launched = await v6.launch(request);
      const expected = Object.freeze({
        runId: launched.runId,
        sessionKey: launched.sessionKey,
        workspaceDir: launched.workspaceDir,
      });
      let finalization: Promise<Readiness1SourceRunCleanupEvidence> | undefined;
      return Object.freeze({
        kind: READINESS1_SOURCE_RUN_BINDING_V7_KIND,
        runId: expected.runId,
        sessionKey: expected.sessionKey,
        workspaceDir: expected.workspaceDir,
        readCleanupEvidence: async () => {
          let terminal: Readiness1SourceRunFinalEvidence;
          try {
            terminal = await launched.readFinalEvidence();
          } catch {
            return unknownCleanupEvidence(expected);
          }
          if (
            terminal.kind !== READINESS1_SOURCE_RUN_FINAL_EVIDENCE_KIND ||
            terminal.state !== "CONFIRMED" ||
            terminal.runId !== expected.runId ||
            terminal.sessionKey !== expected.sessionKey ||
            terminal.workspaceDir !== expected.workspaceDir
          ) {
            return unknownCleanupEvidence(expected);
          }
          if (!finalization) {
            finalization = (async () => {
              try {
                params.assertCurrent();
                const observed = await finalizeCleanup(expected);
                params.assertCurrent();
                if (observed.workspaceDir !== expected.workspaceDir) {
                  return unknownCleanupEvidence(expected);
                }
                return assessReadiness1SourceRunCleanupEvidence({ expected, terminal, observed });
              } catch {
                return unknownCleanupEvidence(expected);
              }
            })();
          }
          return await finalization;
        },
      });
    },
  });
}

export {
  READINESS1_HOST_BINDING_KIND,
  READINESS1_PLUGIN_ID,
  READINESS1_SOURCE_RUN_BINDING_V2_KIND,
  READINESS1_SOURCE_RUN_BINDING_V3_KIND,
  READINESS1_SOURCE_RUN_BINDING_V4_KIND,
  READINESS1_SOURCE_RUN_BINDING_V5_KIND,
  READINESS1_SOURCE_RUN_BINDING_V6_KIND,
  READINESS1_SOURCE_RUN_BINDING_V7_KIND,
};

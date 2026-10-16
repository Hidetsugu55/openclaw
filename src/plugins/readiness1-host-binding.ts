import { createHash } from "node:crypto";
import type {
  AgentRuntimeExecutionEvent,
  AgentRuntimeExecutionIdentity,
} from "../agents/command/types.js";
import type { AgentWaitResult } from "../agents/run-wait.types.js";
import type { PluginStateKeyedStore } from "../plugin-state/plugin-state-store.types.js";
import type { PluginRecord } from "./registry-types.js";
import type { PluginRuntime, PluginSubagentExecutionResult } from "./runtime/types.js";

const READINESS1_PLUGIN_ID = "readiness1-native-controller";
const READINESS1_HOST_BINDING_KIND = "openclaw.readiness1.host-binding.v1";
const READINESS1_SOURCE_RUN_BINDING_V2_KIND = "openclaw.readiness1.source-run-binding.v2";
const READINESS1_SOURCE_RUN_BINDING_V3_KIND = "openclaw.readiness1.source-run-binding.v3";
const READINESS1_SOURCE_RUN_BINDING_V4_KIND = "openclaw.readiness1.source-run-binding.v4";
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
}): Readiness1SourceRunBindingV4 | undefined {
  const v3 = createReadiness1SourceRunBindingV3(params);
  const assertSourceSession = params.assertSourceSession;
  const waitForRun = params.waitForRun;
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
              ...(request.onObservation
                ? {
                    onObservation: async (event) => {
                      params.assertCurrent();
                      requireExpectedIdentity(event.identity, context.sessionKey);
                      await request.onObservation?.(event);
                    },
                  }
                : {}),
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

export {
  READINESS1_HOST_BINDING_KIND,
  READINESS1_PLUGIN_ID,
  READINESS1_SOURCE_RUN_BINDING_V2_KIND,
  READINESS1_SOURCE_RUN_BINDING_V3_KIND,
  READINESS1_SOURCE_RUN_BINDING_V4_KIND,
};

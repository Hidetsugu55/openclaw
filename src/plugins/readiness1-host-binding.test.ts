import { describe, expect, it, vi } from "vitest";
import type { AgentRuntimeExecutionEvent } from "../agents/command/types.js";
import {
  closePluginStateDatabaseAsync,
  resetPluginStateStoreForTests,
} from "../plugin-state/plugin-state-store.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { createPluginRecord } from "./loader-records.js";
import {
  createReadiness1HostBinding,
  createReadiness1SourceRunBindingV2,
  createReadiness1SourceRunBindingV3,
  createReadiness1SourceRunBindingV4,
  createReadiness1SourceRunBindingV5,
  createReadiness1SourceRunBindingV6,
  createReadiness1SourceRunBindingV7,
  READINESS1_HOST_BINDING_KIND,
  READINESS1_SOURCE_RUN_BINDING_V2_KIND,
  READINESS1_SOURCE_RUN_BINDING_V3_KIND,
  READINESS1_SOURCE_RUN_BINDING_V4_KIND,
  READINESS1_SOURCE_RUN_BINDING_V5_KIND,
  READINESS1_SOURCE_RUN_BINDING_V6_KIND,
  READINESS1_SOURCE_RUN_BINDING_V7_KIND,
  type Readiness1SourceRunBindingV5,
  type Readiness1SourceRunBindingV6,
} from "./readiness1-host-binding.js";
import { finalizeReadiness1SourceRunCustody } from "./readiness1-source-run-custody.js";
import type { Readiness1SourceRunFinalEvidence } from "./readiness1-source-run-evidence.js";
import { revokePluginRecord } from "./registry-lifecycle.js";
import { createRuntimeTestRegistry } from "./registry-runtime.test-helpers.js";
import { createPluginRuntime } from "./runtime/index.js";
import type { PluginRuntime } from "./runtime/types.js";

describe("createReadiness1HostBinding", () => {
  it("refuses every plugin except the bundled controller", () => {
    const assertCurrent = vi.fn();
    const openLedgerStore = vi.fn();
    const openCanonicalTaskStore = vi.fn();
    const runWithExecutionControl = vi.fn();

    expect(
      createReadiness1HostBinding({
        record: { id: "readiness1-native-controller", origin: "workspace" },
        assertCurrent,
        openLedgerStore,
        openCanonicalTaskStore,
        runWithExecutionControl,
      }),
    ).toBeUndefined();
    expect(
      createReadiness1HostBinding({
        record: { id: "other", origin: "bundled" },
        assertCurrent,
        openLedgerStore,
        openCanonicalTaskStore,
        runWithExecutionControl,
      }),
    ).toBeUndefined();
    expect(assertCurrent).not.toHaveBeenCalled();
    expect(openLedgerStore).not.toHaveBeenCalled();
    expect(openCanonicalTaskStore).not.toHaveBeenCalled();
  });

  it("opens only the fixed retained ledger after rechecking lifecycle authority", async () => {
    const assertCurrent = vi.fn();
    const store = {};
    const openLedgerStore = vi.fn(() => store);
    const taskStore = { lookup: vi.fn() };
    const openCanonicalTaskStore = vi.fn(() => taskStore);
    const runWithExecutionControl = vi.fn();
    const binding = createReadiness1HostBinding({
      record: { id: "readiness1-native-controller", origin: "bundled" },
      assertCurrent,
      openLedgerStore: openLedgerStore as never,
      openCanonicalTaskStore: openCanonicalTaskStore as never,
      runWithExecutionControl: runWithExecutionControl as never,
    });

    expect(binding).toBeDefined();
    expect(Object.isFrozen(binding)).toBe(true);
    expect(binding?.kind).toBe(READINESS1_HOST_BINDING_KIND);
    expect(binding?.openLedgerStore()).toBe(store);
    expect(assertCurrent).toHaveBeenCalledTimes(1);
    expect(openLedgerStore).toHaveBeenCalledTimes(1);
    await expect(binding?.readCanonicalDescriptor("status:task")).rejects.toThrow(
      "canonical Task is unavailable",
    );
    expect(openCanonicalTaskStore).toHaveBeenCalledTimes(1);
    expect(taskStore.lookup).toHaveBeenCalledWith("status:task");
    await expect(binding?.readCanonicalDescriptor("invalid task id")).rejects.toThrow(
      "canonical Task id is invalid",
    );
  });

  it("starts only a host-stored read-only Task with a native pre-provider admission", async () => {
    const taskNodeId = "TASK_read_123";
    const descriptor = {
      contract: {
        taskNodeId,
        role: "researcher",
        actionClass: "read",
        caps: { provider: "codex" },
      },
      instructions: "Read the fixed source and return a concise summary.",
    };
    const assertCurrent = vi.fn();
    const beforeProvider = vi.fn(async () => {});
    const runWithExecutionControl = vi.fn(
      async (
        params: Parameters<PluginRuntime["subagent"]["runWithExecutionControl"]>[0],
        control: Parameters<PluginRuntime["subagent"]["runWithExecutionControl"]>[1],
      ) => {
        const identity = Object.freeze({
          runId: "native-read-run",
          sessionKey: params.sessionKey,
          sessionId: "native-read-session",
          lifecycleGeneration: "generation-1",
          resourceOwnership: Object.freeze({
            run: "gateway",
            session: "gateway",
            cleanup: "gateway",
          }),
        });
        await control.beforeProvider(identity);
        return Object.freeze({
          runId: identity.runId,
          sessionKey: identity.sessionKey,
          execution: identity,
        });
      },
    );
    const binding = createReadiness1HostBinding({
      record: { id: "readiness1-native-controller", origin: "bundled" },
      assertCurrent,
      openLedgerStore: vi.fn() as never,
      openCanonicalTaskStore: vi.fn(() => ({ lookup: vi.fn(async () => descriptor) })) as never,
      runWithExecutionControl,
    });
    if (!binding) throw new Error("Readiness #1 host binding was not created");

    await expect(
      binding.runCanonicalReadOnly({
        taskNodeId,
        ticketId: "ticket-read-123",
        beforeProvider,
      }),
    ).resolves.toMatchObject({ runId: "native-read-run" });
    expect(beforeProvider).toHaveBeenCalledTimes(1);
    expect(runWithExecutionControl).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionKey: expect.stringMatching(
          /^agent:researcher:subagent:workboard-readiness1-[a-f0-9]{24}$/,
        ),
        message: descriptor.instructions,
        provider: "codex",
        disableTools: true,
        promptMode: "minimal",
        lightContext: true,
        deliver: false,
        idempotencyKey: "ticket-read-123",
      }),
      expect.objectContaining({ beforeProvider: expect.any(Function) }),
    );

    const sourceBinding = createReadiness1HostBinding({
      record: { id: "readiness1-native-controller", origin: "bundled" },
      assertCurrent,
      openLedgerStore: vi.fn() as never,
      openCanonicalTaskStore: vi.fn(() => ({
        lookup: vi.fn(async () => ({
          ...descriptor,
          contract: { ...descriptor.contract, actionClass: "source" },
        })),
      })) as never,
      runWithExecutionControl,
    });
    await expect(
      sourceBinding?.runCanonicalReadOnly({
        taskNodeId,
        ticketId: "ticket-source-123",
        beforeProvider,
      }),
    ).rejects.toThrow("canonical read-only Task is invalid");
    expect(runWithExecutionControl).toHaveBeenCalledTimes(1);
  });

  it("prepares only the host-stored source Task through managed worktree and sandbox APIs", async () => {
    const taskNodeId = "TASK_source_123";
    const claimId = "ticket-source-123";
    const descriptor = {
      contract: {
        taskNodeId,
        role: "dev-host",
        actionClass: "source",
        caps: { provider: "codex" },
        ref: "refs/heads/main",
        head: "a".repeat(40),
        root: "/state/worktrees/wt-1",
      },
      indexDigest: "b".repeat(64),
      sourceRoot: "/repo",
      worktreeName: "readiness1-task-source-123",
      worktreeBranch: "openclaw/readiness1-task-source-123",
    };
    const assertCurrent = vi.fn();
    const resolveCheckoutRoot = vi.fn(async ({ path }: { path: string }) =>
      path === descriptor.contract.root ? descriptor.contract.root : descriptor.sourceRoot,
    );
    const create = vi.fn(async () => ({
      id: "wt-1",
      path: descriptor.contract.root,
      branch: descriptor.worktreeBranch,
    }));
    const release = vi.fn(async () => {});
    const removeIfLossless = vi.fn(async () => true);
    const prepareWorkspaceAuthority = vi.fn(async () => ({
      sandboxed: true as const,
      workspaceAccess: "rw" as const,
    }));
    const binding = createReadiness1HostBinding({
      record: { id: "readiness1-native-controller", origin: "bundled" },
      assertCurrent,
      openLedgerStore: vi.fn() as never,
      openCanonicalTaskStore: vi.fn(() => ({ lookup: vi.fn(async () => descriptor) })) as never,
      runWithExecutionControl: vi.fn() as never,
      workspace: {
        config: { current: vi.fn(() => ({})) } as never,
        worktrees: { resolveCheckoutRoot, create, release, removeIfLossless } as never,
        sandbox: { prepareWorkspaceAuthority } as never,
      },
    });
    if (!binding) throw new Error("Readiness #1 host binding was not created");

    await expect(binding.prepareCanonicalWorkspace({ taskNodeId, claimId })).resolves.toEqual({
      id: "wt-1",
      path: descriptor.contract.root,
      branch: descriptor.worktreeBranch,
      sandboxed: true,
      workspaceAccess: "rw",
    });
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        repoRoot: descriptor.sourceRoot,
        name: descriptor.worktreeName,
        baseRef: descriptor.contract.head,
        ownerKind: "workboard",
        ownerId: `readiness1:${taskNodeId}:${claimId}`,
        commitGuard: assertCurrent,
      }),
    );
    expect(prepareWorkspaceAuthority).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: descriptor.contract.role,
        workspaceDir: descriptor.contract.root,
        requiredToolNames: ["read", "exec", "apply_patch"],
        modelProvider: "codex",
      }),
    );
    expect(release).not.toHaveBeenCalled();
    expect(removeIfLossless).not.toHaveBeenCalled();
  });

  it("creates an opaque v2 source-run lease with one fixed workspace identity", async () => {
    const taskNodeId = "TASK_source_v2_123";
    const claimId = "ticket-source-v2-123";
    const descriptor = {
      contract: {
        taskNodeId,
        role: "dev-host",
        actionClass: "source",
        caps: { provider: "codex" },
        ref: "refs/heads/main",
        head: "a".repeat(40),
        root: "/state/worktrees/wt-v2",
      },
      indexDigest: "b".repeat(64),
      sourceRoot: "/repo",
      worktreeName: "readiness1-task-source-v2-123",
      worktreeBranch: "openclaw/readiness1-task-source-v2-123",
    };
    const releaseRunLease = vi.fn(async () => true);
    const releaseWorkspace = vi.fn(async () => {});
    const acquireRunLease = vi.fn(async () => ({ release: releaseRunLease }));
    const binding = createReadiness1SourceRunBindingV2({
      acquireSourceRunLease: acquireRunLease,
      record: { id: "readiness1-native-controller", origin: "bundled" },
      assertCurrent: vi.fn(),
      openLedgerStore: vi.fn() as never,
      openCanonicalTaskStore: vi.fn(() => ({ lookup: vi.fn(async () => descriptor) })) as never,
      runWithExecutionControl: vi.fn() as never,
      workspace: {
        config: { current: vi.fn(() => ({})) } as never,
        worktrees: {
          resolveCheckoutRoot: vi.fn(async ({ path }: { path: string }) =>
            path === descriptor.contract.root ? descriptor.contract.root : descriptor.sourceRoot,
          ),
          create: vi.fn(async () => ({
            id: "wt-v2",
            path: descriptor.contract.root,
            branch: descriptor.worktreeBranch,
          })),
          release: releaseWorkspace,
          removeIfLossless: vi.fn(async () => true),
        } as never,
        sandbox: {
          prepareWorkspaceAuthority: vi.fn(async () => ({
            sandboxed: true as const,
            workspaceAccess: "rw" as const,
          })),
        } as never,
      },
    });
    if (!binding) throw new Error("Readiness #1 source run binding was not created");

    expect(binding.kind).toBe(READINESS1_SOURCE_RUN_BINDING_V2_KIND);
    const lease = await binding.prepare({ taskNodeId, claimId });
    expect(Object.keys(lease)).toEqual(["kind", "withContext", "release"]);
    await expect(
      lease.withContext((context) => {
        expect(context.sessionRoot).toBe(descriptor.contract.root);
        expect(context.workspaceDir).toBe(context.sessionRoot);
        expect(context.cwd).toBe(context.sessionRoot);
        expect(context.agentId).toBe(descriptor.contract.role);
        expect(context.provider).toBe("codex");
        expect(context.sandboxed).toBe(true);
        expect(context.workspaceAccess).toBe("rw");
        expect(context.requiredToolNames).toEqual(["read", "exec", "apply_patch"]);
        return "bound";
      }),
    ).resolves.toBe("bound");
    expect(acquireRunLease).toHaveBeenCalledWith("wt-v2");
    await expect(lease.release()).resolves.toBeUndefined();
    expect(releaseRunLease).toHaveBeenCalledTimes(1);
    expect(releaseWorkspace).toHaveBeenCalledWith({ path: descriptor.contract.root });
    await expect(lease.withContext(async () => "later")).rejects.toThrow("lease is unavailable");
  });

  it("does not treat an uncertain v2 run-lease release as success", async () => {
    const taskNodeId = "TASK_source_v2_unknown";
    const descriptor = {
      contract: {
        taskNodeId,
        role: "dev-host",
        actionClass: "source",
        caps: { provider: "codex" },
        ref: "refs/heads/main",
        head: "a".repeat(40),
        root: "/state/worktrees/wt-v2-unknown",
      },
      indexDigest: "b".repeat(64),
      sourceRoot: "/repo",
      worktreeName: "readiness1-task-source-v2-unknown",
      worktreeBranch: "openclaw/readiness1-task-source-v2-unknown",
    };
    const releaseWorkspace = vi.fn(async () => {});
    const binding = createReadiness1SourceRunBindingV2({
      acquireSourceRunLease: vi.fn(async () => ({ release: vi.fn(async () => false) })),
      record: { id: "readiness1-native-controller", origin: "bundled" },
      assertCurrent: vi.fn(),
      openLedgerStore: vi.fn() as never,
      openCanonicalTaskStore: vi.fn(() => ({ lookup: vi.fn(async () => descriptor) })) as never,
      runWithExecutionControl: vi.fn() as never,
      workspace: {
        config: { current: vi.fn(() => ({})) } as never,
        worktrees: {
          resolveCheckoutRoot: vi.fn(async ({ path }: { path: string }) =>
            path === descriptor.contract.root ? descriptor.contract.root : descriptor.sourceRoot,
          ),
          create: vi.fn(async () => ({
            id: "wt-v2-unknown",
            path: descriptor.contract.root,
            branch: descriptor.worktreeBranch,
          })),
          release: releaseWorkspace,
          removeIfLossless: vi.fn(async () => true),
        } as never,
        sandbox: {
          prepareWorkspaceAuthority: vi.fn(async () => ({
            sandboxed: true as const,
            workspaceAccess: "rw" as const,
          })),
        } as never,
      },
    });
    if (!binding) throw new Error("Readiness #1 source run binding was not created");

    const lease = await binding.prepare({ taskNodeId, claimId: "ticket-source-v2-unknown" });
    await expect(lease.release()).rejects.toThrow("lease release is UNKNOWN");
    expect(releaseWorkspace).not.toHaveBeenCalled();
  });

  it("binds one exact source session root and releases on binding failure", async () => {
    const taskNodeId = "TASK_source_v3_123";
    const descriptor = {
      contract: {
        taskNodeId,
        role: "dev-host",
        actionClass: "source",
        caps: { provider: "codex" },
        ref: "refs/heads/main",
        head: "a".repeat(40),
        root: "/state/worktrees/wt-v3",
      },
      indexDigest: "b".repeat(64),
      sourceRoot: "/repo",
      worktreeName: "readiness1-task-source-v3-123",
      worktreeBranch: "openclaw/readiness1-task-source-v3-123",
    };
    const releaseRunLease = vi.fn(async () => true);
    const releaseWorkspace = vi.fn(async () => {});
    const runWithExecutionControl = vi.fn();
    let bindAttempt = 0;
    const bindSourceSession = vi.fn(async (context) => {
      expect(context.sessionRoot).toBe(descriptor.contract.root);
      expect(context.workspaceDir).toBe(context.sessionRoot);
      expect(context.cwd).toBe(context.sessionRoot);
      expect(context.requiredToolNames).toEqual(["read", "exec", "apply_patch"]);
      if (bindAttempt++ > 0) {
        throw new Error("session workspace drift");
      }
    });
    const binding = createReadiness1SourceRunBindingV3({
      acquireSourceRunLease: vi.fn(async () => ({ release: releaseRunLease })),
      bindSourceSession,
      record: { id: "readiness1-native-controller", origin: "bundled" },
      assertCurrent: vi.fn(),
      openLedgerStore: vi.fn() as never,
      openCanonicalTaskStore: vi.fn(() => ({ lookup: vi.fn(async () => descriptor) })) as never,
      runWithExecutionControl: runWithExecutionControl as never,
      workspace: {
        config: { current: vi.fn(() => ({})) } as never,
        worktrees: {
          resolveCheckoutRoot: vi.fn(async ({ path }: { path: string }) =>
            path === descriptor.contract.root ? descriptor.contract.root : descriptor.sourceRoot,
          ),
          create: vi.fn(async () => ({
            id: "wt-v3",
            path: descriptor.contract.root,
            branch: descriptor.worktreeBranch,
          })),
          release: releaseWorkspace,
          removeIfLossless: vi.fn(async () => true),
        } as never,
        sandbox: {
          prepareWorkspaceAuthority: vi.fn(async () => ({
            sandboxed: true as const,
            workspaceAccess: "rw" as const,
          })),
        } as never,
      },
    });
    if (!binding) throw new Error("Readiness #1 source run v3 binding was not created");

    expect(binding.kind).toBe(READINESS1_SOURCE_RUN_BINDING_V3_KIND);
    const lease = await binding.prepare({ taskNodeId, claimId: "ticket-source-v3-123" });
    await expect(lease.release()).resolves.toBeUndefined();
    await expect(binding.prepare({ taskNodeId, claimId: "ticket-source-v3-123" })).rejects.toThrow(
      "session workspace drift",
    );
    expect(bindSourceSession).toHaveBeenCalledTimes(2);
    expect(releaseRunLease).toHaveBeenCalledTimes(2);
    expect(releaseWorkspace).toHaveBeenCalledTimes(2);
    expect(releaseWorkspace).toHaveBeenLastCalledWith({ path: descriptor.contract.root });
    expect(runWithExecutionControl).not.toHaveBeenCalled();
  });

  it("retains one fixed source context after native admission until a later evidence binding exists", async () => {
    const taskNodeId = "TASK_source_v4_123";
    const ticketId = "ticket-source-v4-123";
    const descriptor = {
      contract: {
        taskNodeId,
        role: "dev-host",
        actionClass: "source",
        caps: { provider: "codex" },
        ref: "refs/heads/main",
        head: "a".repeat(40),
        root: "/state/worktrees/wt-v4",
      },
      instructions: "Edit only the canonical source worktree and run the fixed tests.",
      indexDigest: "b".repeat(64),
      sourceRoot: "/repo",
      worktreeName: "readiness1-task-source-v4-123",
      worktreeBranch: "openclaw/readiness1-task-source-v4-123",
    };
    const releaseRunLease = vi.fn(async () => true);
    const releaseWorkspace = vi.fn(async () => {});
    const assertSourceSession = vi.fn(async (context) => {
      expect(context.sessionRoot).toBe(descriptor.contract.root);
      expect(context.workspaceDir).toBe(context.sessionRoot);
      expect(context.cwd).toBe(context.sessionRoot);
      expect(context.requiredToolNames).toEqual(["read", "exec", "apply_patch"]);
    });
    const beforeProvider = vi.fn(async () => {});
    const runWithExecutionControl = vi.fn(
      async (
        params: Parameters<PluginRuntime["subagent"]["runWithExecutionControl"]>[0],
        control: Parameters<PluginRuntime["subagent"]["runWithExecutionControl"]>[1],
      ) => {
        const identity = Object.freeze({
          runId: "native-source-run",
          sessionKey: params.sessionKey,
          sessionId: "native-source-session",
          lifecycleGeneration: "generation-1",
          resourceOwnership: Object.freeze({
            run: "gateway" as const,
            session: "gateway" as const,
            cleanup: "gateway" as const,
          }),
        });
        await control.beforeProvider(identity);
        return Object.freeze({
          runId: identity.runId,
          sessionKey: identity.sessionKey,
          execution: identity,
        });
      },
    );
    const waitForRun = vi.fn(async () => ({ status: "timeout" as const }));
    const binding = createReadiness1SourceRunBindingV4({
      acquireSourceRunLease: vi.fn(async () => ({ release: releaseRunLease })),
      bindSourceSession: vi.fn(async () => {}),
      assertSourceSession,
      record: { id: "readiness1-native-controller", origin: "bundled" },
      assertCurrent: vi.fn(),
      openLedgerStore: vi.fn() as never,
      openCanonicalTaskStore: vi.fn(() => ({ lookup: vi.fn(async () => descriptor) })) as never,
      runWithExecutionControl,
      waitForRun,
      workspace: {
        config: { current: vi.fn(() => ({})) } as never,
        worktrees: {
          resolveCheckoutRoot: vi.fn(async ({ path }: { path: string }) =>
            path === descriptor.contract.root ? descriptor.contract.root : descriptor.sourceRoot,
          ),
          create: vi.fn(async () => ({
            id: "wt-v4",
            path: descriptor.contract.root,
            branch: descriptor.worktreeBranch,
          })),
          release: releaseWorkspace,
          removeIfLossless: vi.fn(async () => true),
        } as never,
        sandbox: {
          prepareWorkspaceAuthority: vi.fn(async () => ({
            sandboxed: true as const,
            workspaceAccess: "rw" as const,
          })),
        } as never,
      },
    });
    if (!binding) throw new Error("Readiness #1 source run v4 binding was not created");

    const launched = await binding.launch({ taskNodeId, ticketId, beforeProvider });

    expect(launched).toMatchObject({
      kind: READINESS1_SOURCE_RUN_BINDING_V4_KIND,
      runId: "native-source-run",
      workspaceDir: descriptor.contract.root,
    });
    expect(runWithExecutionControl).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionKey: expect.stringMatching(
          /^agent:dev-host:subagent:workboard-readiness1-[a-f0-9]{24}$/,
        ),
        message: descriptor.instructions,
        provider: "codex",
        cwd: descriptor.contract.root,
        promptMode: "minimal",
        lightContext: true,
        deliver: false,
        idempotencyKey: ticketId,
      }),
      expect.objectContaining({ beforeProvider: expect.any(Function) }),
    );
    expect(runWithExecutionControl.mock.calls[0]?.[0]).not.toHaveProperty("disableTools");
    expect(runWithExecutionControl.mock.calls[0]?.[0]).not.toHaveProperty("toolsAlsoAllow");
    expect(assertSourceSession).toHaveBeenCalledTimes(2);
    expect(beforeProvider).toHaveBeenCalledTimes(1);
    expect(Object.keys(launched).sort()).toEqual(
      ["awaitTerminal", "kind", "runId", "sessionKey", "workspaceDir"].sort(),
    );
    expect(launched).not.toHaveProperty("release");
    await expect(launched.awaitTerminal()).resolves.toEqual({ status: "timeout" });
    expect(waitForRun).toHaveBeenCalledWith({ runId: "native-source-run", timeoutMs: 30_000 });
    await expect(launched.awaitTerminal()).resolves.toEqual({ status: "timeout" });
    expect(releaseRunLease).not.toHaveBeenCalled();
    expect(releaseWorkspace).not.toHaveBeenCalled();
  });

  it("finalizes one admitted direct-local custody receipt before releasing its exact workspace", async () => {
    const taskNodeId = "TASK_source_v4_custody_123";
    const ticketId = "ticket-source-v4-custody-123";
    const descriptor = {
      contract: {
        taskNodeId,
        role: "dev-host",
        actionClass: "source",
        caps: { provider: "codex" },
        ref: "refs/heads/main",
        head: "a".repeat(40),
        root: "/state/worktrees/wt-v4-custody",
      },
      instructions: "Edit only the canonical source worktree and run the fixed tests.",
      indexDigest: "b".repeat(64),
      sourceRoot: "/repo",
      worktreeName: "readiness1-task-source-v4-custody-123",
      worktreeBranch: "openclaw/readiness1-task-source-v4-custody-123",
    };
    const cleanupAndObserve = vi.fn(async () => ({
      processStopped: true,
      groupStopped: true,
      containerAbsent: true as const,
      lsofClear: true,
    }));
    const releaseRunLease = vi.fn().mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    const removeIfLossless = vi.fn(async () => true);
    const isWorkspaceAbsent = vi.fn(async () => true);
    const runWithExecutionControl = vi.fn(
      async (
        params: Parameters<PluginRuntime["subagent"]["runWithExecutionControl"]>[0],
        control: Parameters<PluginRuntime["subagent"]["runWithExecutionControl"]>[1],
      ) => {
        const identity = Object.freeze({
          runId: "native-source-v4-custody",
          sessionKey: params.sessionKey,
          sessionId: "native-source-session",
          lifecycleGeneration: "generation-1",
          resourceOwnership: Object.freeze({
            run: "gateway" as const,
            session: "gateway" as const,
            cleanup: "gateway" as const,
          }),
        });
        await control.beforeProvider(identity);
        await control.onObservation?.({
          identity,
          sequence: 1,
          observation: Object.freeze({
            kind: "direct_local_process_custody" as const,
            custody: Object.freeze({
              kind: "direct-local-process-group" as const,
              cleanupAndObserve,
            }),
          }),
        });
        return Object.freeze({
          runId: identity.runId,
          sessionKey: identity.sessionKey,
          execution: identity,
        });
      },
    );
    const binding = createReadiness1SourceRunBindingV4({
      acquireSourceRunLease: vi.fn(async () => ({ release: releaseRunLease })),
      bindSourceSession: vi.fn(async () => {}),
      assertSourceSession: vi.fn(async () => {}),
      isWorkspaceAbsent,
      record: { id: "readiness1-native-controller", origin: "bundled" },
      assertCurrent: vi.fn(),
      openLedgerStore: vi.fn() as never,
      openCanonicalTaskStore: vi.fn(() => ({ lookup: vi.fn(async () => descriptor) })) as never,
      runWithExecutionControl,
      waitForRun: vi.fn(async () => ({ status: "timeout" as const })),
      workspace: {
        config: { current: vi.fn(() => ({})) } as never,
        worktrees: {
          resolveCheckoutRoot: vi.fn(async ({ path }: { path: string }) =>
            path === descriptor.contract.root ? descriptor.contract.root : descriptor.sourceRoot,
          ),
          create: vi.fn(async () => ({
            id: "wt-v4-custody",
            path: descriptor.contract.root,
            branch: descriptor.worktreeBranch,
          })),
          release: vi.fn(async () => {}),
          removeIfLossless,
        } as never,
        sandbox: {
          prepareWorkspaceAuthority: vi.fn(async () => ({
            sandboxed: true as const,
            workspaceAccess: "rw" as const,
          })),
        } as never,
      },
    });
    if (!binding) throw new Error("Readiness #1 source run v4 binding was not created");

    const launched = await binding.launch({
      taskNodeId,
      ticketId,
      beforeProvider: vi.fn(async () => {}),
    });
    const receipt = await finalizeReadiness1SourceRunCustody({
      runId: launched.runId,
      sessionKey: launched.sessionKey,
      workspaceDir: launched.workspaceDir,
    });

    expect(receipt).toEqual({
      runId: "native-source-v4-custody",
      sessionKey: launched.sessionKey,
      workspaceDir: descriptor.contract.root,
      processStopped: true,
      groupStopped: true,
      containerRemoved: true,
      lsofClear: true,
      runLeaseReleased: true,
      workspaceReleased: true,
      workspaceRemoved: true,
    });
    expect(runWithExecutionControl.mock.calls[0]?.[1]).toEqual(
      expect.objectContaining({ requireDirectLocalProcessCustody: true }),
    );
    expect(cleanupAndObserve).toHaveBeenCalledTimes(1);
    expect(releaseRunLease).toHaveBeenCalledTimes(1);
    expect(removeIfLossless).toHaveBeenCalledWith({
      path: descriptor.contract.root,
      ownerKind: "workboard",
      ownerId: `readiness1:${taskNodeId}:${ticketId}`,
    });
    expect(isWorkspaceAbsent).toHaveBeenCalledWith({ workspaceDir: descriptor.contract.root });
    expect(cleanupAndObserve.mock.invocationCallOrder[0]).toBeLessThan(
      releaseRunLease.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
    );
    expect(releaseRunLease.mock.invocationCallOrder[0]).toBeLessThan(
      removeIfLossless.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
    );
    await expect(
      finalizeReadiness1SourceRunCustody({
        runId: launched.runId,
        sessionKey: launched.sessionKey,
        workspaceDir: launched.workspaceDir,
      }),
    ).rejects.toThrow("source run custody is unavailable");

    const retained = await binding.launch({
      taskNodeId,
      ticketId: `${ticketId}-lease-false`,
      beforeProvider: vi.fn(async () => {}),
    });
    await expect(
      finalizeReadiness1SourceRunCustody({
        runId: retained.runId,
        sessionKey: retained.sessionKey,
        workspaceDir: retained.workspaceDir,
      }),
    ).resolves.toMatchObject({
      processStopped: true,
      groupStopped: true,
      containerRemoved: true,
      lsofClear: true,
      runLeaseReleased: false,
      workspaceReleased: false,
      workspaceRemoved: false,
    });
    expect(removeIfLossless).toHaveBeenCalledTimes(1);
  });

  it("reads a fixed final snapshot only after one exact terminal receipt", async () => {
    const taskNodeId = "TASK_source_v5_123";
    const ticketId = "ticket-source-v5-123";
    const descriptor = {
      contract: {
        taskNodeId,
        role: "dev-host",
        actionClass: "source",
        caps: { provider: "codex" },
        ref: "refs/heads/main",
        head: "a".repeat(40),
        root: "/state/worktrees/wt-v5",
      },
      instructions: "Edit only the canonical source worktree and run the fixed tests.",
      indexDigest: "b".repeat(64),
      sourceRoot: "/repo",
      worktreeName: "readiness1-task-source-v5-123",
      worktreeBranch: "openclaw/readiness1-task-source-v5-123",
    };
    const releaseRunLease = vi.fn(async () => true);
    const releaseWorkspace = vi.fn(async () => {});
    const runWithExecutionControl = vi.fn(
      async (
        params: Parameters<PluginRuntime["subagent"]["runWithExecutionControl"]>[0],
        control: Parameters<PluginRuntime["subagent"]["runWithExecutionControl"]>[1],
      ) => {
        const identity = Object.freeze({
          runId: "native-source-v5",
          sessionKey: params.sessionKey,
          sessionId: "native-source-session",
          lifecycleGeneration: "generation-1",
          resourceOwnership: Object.freeze({
            run: "gateway" as const,
            session: "gateway" as const,
            cleanup: "gateway" as const,
          }),
        });
        await control.beforeProvider(identity);
        return Object.freeze({
          runId: identity.runId,
          sessionKey: identity.sessionKey,
          execution: identity,
        });
      },
    );
    let terminalReady = false;
    let terminalRunId = "native-source-v5";
    let snapshotValid = false;
    const waitForRun = vi.fn(async () =>
      terminalReady
        ? {
            status: "ok" as const,
            providerStarted: true,
            endedAt: 1_700_000_000_000,
            terminalReceipt: {
              runId: terminalRunId,
              sessionId: "native-source-session",
              turnId: "native-turn-v5",
              requested: { provider: "codex", model: "gpt-5" },
              effective: { provider: "codex", model: "gpt-5", responseModel: "gpt-5" },
              successfulToolNames: [],
              rerouted: false,
              terminalDisposition: "silent" as const,
            },
          }
        : { status: "timeout" as const },
    );
    const captureFinalSnapshot = vi.fn(async (expected: { workspaceDir: string }) =>
      Object.freeze({
        workspaceDir: expected.workspaceDir,
        head: snapshotValid ? "d".repeat(40) : "invalid-head",
        indexDigest: "e".repeat(64),
        dirty: "",
      }),
    );
    const binding = createReadiness1SourceRunBindingV5({
      acquireSourceRunLease: vi.fn(async () => ({ release: releaseRunLease })),
      bindSourceSession: vi.fn(async () => {}),
      assertSourceSession: vi.fn(async () => {}),
      captureFinalSnapshot,
      record: { id: "readiness1-native-controller", origin: "bundled" },
      assertCurrent: vi.fn(),
      openLedgerStore: vi.fn() as never,
      openCanonicalTaskStore: vi.fn(() => ({ lookup: vi.fn(async () => descriptor) })) as never,
      runWithExecutionControl,
      waitForRun,
      workspace: {
        config: { current: vi.fn(() => ({})) } as never,
        worktrees: {
          resolveCheckoutRoot: vi.fn(async ({ path }: { path: string }) =>
            path === descriptor.contract.root ? descriptor.contract.root : descriptor.sourceRoot,
          ),
          create: vi.fn(async () => ({
            id: "wt-v5",
            path: descriptor.contract.root,
            branch: descriptor.worktreeBranch,
          })),
          release: releaseWorkspace,
          removeIfLossless: vi.fn(async () => true),
        } as never,
        sandbox: {
          prepareWorkspaceAuthority: vi.fn(async () => ({
            sandboxed: true as const,
            workspaceAccess: "rw" as const,
          })),
        } as never,
      },
    });
    if (!binding) throw new Error("Readiness #1 source run v5 binding was not created");

    const launched = await binding.launch({ taskNodeId, ticketId, beforeProvider: async () => {} });
    expect(launched).toMatchObject({
      kind: READINESS1_SOURCE_RUN_BINDING_V5_KIND,
      runId: "native-source-v5",
      workspaceDir: descriptor.contract.root,
    });
    expect(Object.keys(launched).sort()).toEqual(
      ["kind", "readFinalSnapshot", "runId", "sessionKey", "workspaceDir"].sort(),
    );
    await expect(launched.readFinalSnapshot()).rejects.toThrow(/terminal receipt is unavailable/);
    expect(captureFinalSnapshot).not.toHaveBeenCalled();
    terminalReady = true;
    terminalRunId = "other-source-v5";
    await expect(launched.readFinalSnapshot()).rejects.toThrow(/terminal receipt is unavailable/);
    expect(captureFinalSnapshot).not.toHaveBeenCalled();
    terminalRunId = "native-source-v5";
    await expect(launched.readFinalSnapshot()).rejects.toThrow(/snapshot is invalid/);
    expect(captureFinalSnapshot).toHaveBeenCalledWith({ workspaceDir: descriptor.contract.root });
    snapshotValid = true;
    const [first, second] = await Promise.all([
      launched.readFinalSnapshot(),
      launched.readFinalSnapshot(),
    ]);
    expect(first).toEqual({
      workspaceDir: descriptor.contract.root,
      head: "d".repeat(40),
      indexDigest: "e".repeat(64),
      dirty: "",
    });
    expect(second).toBe(first);
    expect(waitForRun).toHaveBeenCalledTimes(4);
    expect(captureFinalSnapshot).toHaveBeenCalledTimes(2);
    expect(releaseRunLease).not.toHaveBeenCalled();
    expect(releaseWorkspace).not.toHaveBeenCalled();
  });

  it("binds one durable final result and measured usage to the exact held run", async () => {
    const identity = Object.freeze({
      runId: "native-source-v6",
      sessionKey: "agent:dev-host:subagent:workboard-readiness1-v6",
      sessionId: "native-source-session-v6",
      lifecycleGeneration: "generation-v6",
      resourceOwnership: Object.freeze({
        run: "gateway" as const,
        session: "gateway" as const,
        cleanup: "gateway" as const,
      }),
    });
    const terminalReceipt = {
      runId: identity.runId,
      sessionId: identity.sessionId,
      turnId: "native-turn-v6",
      requested: { provider: "codex", model: "gpt-5" },
      effective: { provider: "codex", model: "gpt-5", responseModel: "gpt-5" },
      successfulToolNames: [],
      rerouted: false,
      terminalDisposition: "silent" as const,
    };
    const finalEvent = Object.freeze({
      identity,
      sequence: 4,
      observation: Object.freeze({
        kind: "final" as const,
        result: Object.freeze({ digest: "f".repeat(64), byteLength: 128 }),
        usage: 42,
      }),
    });
    const persisted = new Map<
      string,
      Extract<AgentRuntimeExecutionEvent["observation"], { kind: "final" }>
    >();
    const persistFinalObservation = vi.fn(async (event: AgentRuntimeExecutionEvent) => {
      if (event.observation.kind === "final") {
        persisted.set(event.identity.runId, event.observation);
      }
    });
    const callerObservation = vi.fn(async () => {});
    const v5: Readiness1SourceRunBindingV5 = Object.freeze({
      kind: READINESS1_SOURCE_RUN_BINDING_V5_KIND,
      launch: async (request) => {
        await request.onObservation?.(finalEvent);
        return Object.freeze({
          kind: READINESS1_SOURCE_RUN_BINDING_V5_KIND,
          runId: identity.runId,
          sessionKey: identity.sessionKey,
          workspaceDir: "/state/worktrees/wt-v6",
          readFinalSnapshot: async () =>
            Object.freeze({
              workspaceDir: "/state/worktrees/wt-v6",
              head: "a".repeat(40),
              indexDigest: "b".repeat(64),
              dirty: "",
            }),
        });
      },
    });
    const binding = createReadiness1SourceRunBindingV6({
      v5,
      assertCurrent: vi.fn(),
      waitForRun: vi.fn(async () =>
        Object.freeze({
          status: "ok" as const,
          providerStarted: true,
          endedAt: 1_700_000_000_000,
          terminalReceipt,
          terminalReply: { disposition: "silent" as const },
        }),
      ),
      persistFinalObservation,
      readFinalObservation: vi.fn(async (expected) => {
        const observation = persisted.get(expected.runId);
        return observation
          ? Object.freeze({
              runId: expected.runId,
              sessionKey: expected.sessionKey,
              usage: observation.usage,
              result: Object.freeze({
                runId: expected.runId,
                sessionKey: expected.sessionKey,
                digest: observation.result.digest,
                byteLength: observation.result.byteLength,
              }),
            })
          : undefined;
      }),
    });
    if (!binding) throw new Error("Readiness #1 source run v6 binding was not created");

    const launched = await binding.launch({
      taskNodeId: "TASK_source_v6_123",
      ticketId: "ticket-source-v6-123",
      beforeProvider: async () => {},
      onObservation: callerObservation,
    });

    expect(launched).toMatchObject({
      kind: READINESS1_SOURCE_RUN_BINDING_V6_KIND,
      runId: identity.runId,
      workspaceDir: "/state/worktrees/wt-v6",
    });
    expect(Object.keys(launched).sort()).toEqual(
      ["kind", "readFinalEvidence", "runId", "sessionKey", "workspaceDir"].sort(),
    );
    await expect(launched.readFinalEvidence()).resolves.toMatchObject({
      state: "CONFIRMED",
      runId: identity.runId,
      usage: 42,
      result: { digest: "f".repeat(64), byteLength: 128 },
    });
    expect(persistFinalObservation).toHaveBeenCalledWith(finalEvent);
    expect(callerObservation).toHaveBeenCalledWith(finalEvent);
    expect(launched).not.toHaveProperty("release");
    expect(launched).not.toHaveProperty("cleanup");
  });

  it("runs one host cleanup finalizer only after exact final evidence", async () => {
    const expected = Object.freeze({
      runId: "native-source-v7",
      sessionKey: "agent:dev-host:subagent:workboard-readiness1-v7",
      workspaceDir: "/state/worktrees/wt-v7",
    });
    const terminal: Readiness1SourceRunFinalEvidence = Object.freeze({
      kind: "openclaw.readiness1.source-run-final-evidence.v1",
      state: "CONFIRMED",
      ...expected,
      providerStarted: true,
      endedAt: 1_700_000_000_000,
      usage: 42,
      result: Object.freeze({
        runId: expected.runId,
        sessionKey: expected.sessionKey,
        digest: "f".repeat(64),
        byteLength: 128,
      }),
      snapshot: Object.freeze({
        workspaceDir: expected.workspaceDir,
        head: "a".repeat(40),
        indexDigest: "b".repeat(64),
        dirty: "",
      }),
    });
    const readFinalEvidence = vi.fn(async () => terminal);
    const v6: Readiness1SourceRunBindingV6 = Object.freeze({
      kind: READINESS1_SOURCE_RUN_BINDING_V6_KIND,
      launch: async () =>
        Object.freeze({
          kind: READINESS1_SOURCE_RUN_BINDING_V6_KIND,
          ...expected,
          readFinalEvidence,
        }),
    });
    const finalizeCleanup = vi.fn(
      async (received: { runId: string; sessionKey: string; workspaceDir: string }) =>
        Object.freeze({
          runId: received.runId,
          sessionKey: received.sessionKey,
          workspaceDir: received.workspaceDir,
          processStopped: true,
          groupStopped: true,
          containerRemoved: true,
          lsofClear: true,
          runLeaseReleased: true,
          workspaceReleased: true,
          workspaceRemoved: true,
        }),
    );
    const binding = createReadiness1SourceRunBindingV7({
      v6,
      assertCurrent: vi.fn(),
      finalizeCleanup,
    });
    if (!binding) throw new Error("Readiness #1 source run v7 binding was not created");

    const launched = await binding.launch({
      taskNodeId: "TASK_source_v7_123",
      ticketId: "ticket-source-v7-123",
      beforeProvider: async () => {},
    });
    expect(launched).toMatchObject({ kind: READINESS1_SOURCE_RUN_BINDING_V7_KIND, ...expected });
    expect(Object.keys(launched).sort()).toEqual(
      [
        "kind",
        "readCleanupEvidence",
        "readFinalEvidence",
        "runId",
        "sessionKey",
        "workspaceDir",
      ].sort(),
    );
    await expect(launched.readFinalEvidence()).resolves.toBe(terminal);

    const [first, second] = await Promise.all([
      launched.readCleanupEvidence(),
      launched.readCleanupEvidence(),
    ]);

    expect(first).toMatchObject({ state: "CONFIRMED", ...expected });
    expect(second).toBe(first);
    expect(readFinalEvidence).toHaveBeenCalledTimes(3);
    expect(finalizeCleanup).toHaveBeenCalledTimes(1);
    expect(finalizeCleanup).toHaveBeenCalledWith(expected);
  });

  it("keeps cleanup UNKNOWN without confirmed final evidence or a complete exact receipt", async () => {
    const expected = Object.freeze({
      runId: "native-source-v7-unknown",
      sessionKey: "agent:dev-host:subagent:workboard-readiness1-v7-unknown",
      workspaceDir: "/state/worktrees/wt-v7-unknown",
    });
    let terminal: Readiness1SourceRunFinalEvidence = Object.freeze({
      kind: "openclaw.readiness1.source-run-final-evidence.v1",
      state: "UNKNOWN",
      ...expected,
      providerStarted: false,
    });
    const v6: Readiness1SourceRunBindingV6 = Object.freeze({
      kind: READINESS1_SOURCE_RUN_BINDING_V6_KIND,
      launch: async () =>
        Object.freeze({
          kind: READINESS1_SOURCE_RUN_BINDING_V6_KIND,
          ...expected,
          readFinalEvidence: async () => terminal,
        }),
    });
    const finalizeCleanup = vi.fn(async () =>
      Object.freeze({
        runId: expected.runId,
        sessionKey: expected.sessionKey,
        workspaceDir: "/state/worktrees/other-v7-unknown",
        processStopped: true,
        groupStopped: true,
        containerRemoved: true,
        lsofClear: true,
        runLeaseReleased: true,
        workspaceReleased: true,
        workspaceRemoved: true,
      }),
    );
    const binding = createReadiness1SourceRunBindingV7({
      v6,
      assertCurrent: vi.fn(),
      finalizeCleanup,
    });
    if (!binding) throw new Error("Readiness #1 source run v7 binding was not created");
    const launched = await binding.launch({
      taskNodeId: "TASK_source_v7_unknown",
      ticketId: "ticket-source-v7-unknown",
      beforeProvider: async () => {},
    });

    await expect(launched.readCleanupEvidence()).resolves.toMatchObject({ state: "UNKNOWN" });
    expect(finalizeCleanup).not.toHaveBeenCalled();

    terminal = Object.freeze({
      kind: "openclaw.readiness1.source-run-final-evidence.v1",
      state: "CONFIRMED",
      ...expected,
      providerStarted: true,
      endedAt: 1_700_000_000_000,
      usage: 42,
      result: Object.freeze({
        runId: expected.runId,
        sessionKey: expected.sessionKey,
        digest: "f".repeat(64),
        byteLength: 128,
      }),
      snapshot: Object.freeze({
        workspaceDir: expected.workspaceDir,
        head: "a".repeat(40),
        indexDigest: "b".repeat(64),
        dirty: "",
      }),
    });
    await expect(launched.readCleanupEvidence()).resolves.toMatchObject({ state: "UNKNOWN" });
    await expect(launched.readCleanupEvidence()).resolves.toMatchObject({ state: "UNKNOWN" });
    expect(finalizeCleanup).toHaveBeenCalledTimes(1);
    expect(createReadiness1SourceRunBindingV7({ v6, assertCurrent: vi.fn() })).toBeUndefined();
  });

  it("retains the exclusive workspace when a failure follows native provider admission", async () => {
    const taskNodeId = "TASK_source_v4_unknown";
    const descriptor = {
      contract: {
        taskNodeId,
        role: "dev-host",
        actionClass: "source",
        caps: { provider: "codex" },
        ref: "refs/heads/main",
        head: "a".repeat(40),
        root: "/state/worktrees/wt-v4-unknown",
      },
      instructions: "Use only the fixed source worktree.",
      indexDigest: "b".repeat(64),
      sourceRoot: "/repo",
      worktreeName: "readiness1-task-source-v4-unknown",
      worktreeBranch: "openclaw/readiness1-task-source-v4-unknown",
    };
    const releaseRunLease = vi.fn(async () => true);
    const releaseWorkspace = vi.fn(async () => {});
    const runWithExecutionControl = vi.fn(
      async (
        params: Parameters<PluginRuntime["subagent"]["runWithExecutionControl"]>[0],
        control: Parameters<PluginRuntime["subagent"]["runWithExecutionControl"]>[1],
      ) => {
        const identity = Object.freeze({
          runId: "native-source-unknown",
          sessionKey: params.sessionKey,
          sessionId: "native-source-session",
          lifecycleGeneration: "generation-1",
          resourceOwnership: Object.freeze({
            run: "gateway" as const,
            session: "gateway" as const,
            cleanup: "gateway" as const,
          }),
        });
        await control.beforeProvider(identity);
        throw new Error("simulated post-admission runtime failure");
      },
    );
    const binding = createReadiness1SourceRunBindingV4({
      acquireSourceRunLease: vi.fn(async () => ({ release: releaseRunLease })),
      bindSourceSession: vi.fn(async () => {}),
      assertSourceSession: vi.fn(async () => {}),
      record: { id: "readiness1-native-controller", origin: "bundled" },
      assertCurrent: vi.fn(),
      openLedgerStore: vi.fn() as never,
      openCanonicalTaskStore: vi.fn(() => ({ lookup: vi.fn(async () => descriptor) })) as never,
      runWithExecutionControl,
      waitForRun: vi.fn() as never,
      workspace: {
        config: { current: vi.fn(() => ({})) } as never,
        worktrees: {
          resolveCheckoutRoot: vi.fn(async ({ path }: { path: string }) =>
            path === descriptor.contract.root ? descriptor.contract.root : descriptor.sourceRoot,
          ),
          create: vi.fn(async () => ({
            id: "wt-v4-unknown",
            path: descriptor.contract.root,
            branch: descriptor.worktreeBranch,
          })),
          release: releaseWorkspace,
          removeIfLossless: vi.fn(async () => true),
        } as never,
        sandbox: {
          prepareWorkspaceAuthority: vi.fn(async () => ({
            sandboxed: true as const,
            workspaceAccess: "rw" as const,
          })),
        } as never,
      },
    });
    if (!binding) throw new Error("Readiness #1 source run v4 binding was not created");

    await expect(
      binding.launch({
        taskNodeId,
        ticketId: "ticket-source-v4-unknown",
        beforeProvider: async () => {},
      }),
    ).rejects.toThrow("workspace remains retained");
    expect(releaseRunLease).not.toHaveBeenCalled();
    expect(releaseWorkspace).not.toHaveBeenCalled();
  });

  it("rejects source index digest drift before provider admission and releases the workspace", async () => {
    const taskNodeId = "TASK_source_v4_index_drift";
    const ticketId = "ticket-source-v4-index-drift";
    const descriptor = {
      contract: {
        taskNodeId,
        role: "dev-host",
        actionClass: "source",
        caps: { provider: "codex" },
        ref: "refs/heads/main",
        head: "a".repeat(40),
        root: "/state/worktrees/wt-v4-index-drift",
      },
      instructions: "Use only the canonical source worktree.",
      indexDigest: "b".repeat(64),
      sourceRoot: "/repo",
      worktreeName: "readiness1-task-source-v4-index-drift",
      worktreeBranch: "openclaw/readiness1-task-source-v4-index-drift",
    };
    const lookup = vi
      .fn()
      .mockResolvedValueOnce(descriptor)
      .mockResolvedValueOnce(descriptor)
      .mockResolvedValueOnce(descriptor)
      .mockResolvedValueOnce({ ...descriptor, indexDigest: "c".repeat(64) });
    const releaseRunLease = vi.fn(async () => true);
    const releaseWorkspace = vi.fn(async () => {});
    const beforeProvider = vi.fn(async () => {});
    const runWithExecutionControl = vi.fn(
      async (
        params: Parameters<PluginRuntime["subagent"]["runWithExecutionControl"]>[0],
        control: Parameters<PluginRuntime["subagent"]["runWithExecutionControl"]>[1],
      ) => {
        await control.beforeProvider(
          Object.freeze({
            runId: "native-source-index-drift",
            sessionKey: params.sessionKey,
            sessionId: "native-source-session",
            lifecycleGeneration: "generation-1",
            resourceOwnership: Object.freeze({
              run: "gateway" as const,
              session: "gateway" as const,
              cleanup: "gateway" as const,
            }),
          }),
        );
        throw new Error("provider should not start after index digest drift");
      },
    );
    const binding = createReadiness1SourceRunBindingV4({
      acquireSourceRunLease: vi.fn(async () => ({ release: releaseRunLease })),
      bindSourceSession: vi.fn(async () => {}),
      assertSourceSession: vi.fn(async () => {}),
      record: { id: "readiness1-native-controller", origin: "bundled" },
      assertCurrent: vi.fn(),
      openLedgerStore: vi.fn() as never,
      openCanonicalTaskStore: vi.fn(() => ({ lookup })) as never,
      runWithExecutionControl,
      waitForRun: vi.fn() as never,
      workspace: {
        config: { current: vi.fn(() => ({})) } as never,
        worktrees: {
          resolveCheckoutRoot: vi.fn(async ({ path }: { path: string }) =>
            path === descriptor.contract.root ? descriptor.contract.root : descriptor.sourceRoot,
          ),
          create: vi.fn(async () => ({
            id: "wt-v4-index-drift",
            path: descriptor.contract.root,
            branch: descriptor.worktreeBranch,
          })),
          release: releaseWorkspace,
          removeIfLossless: vi.fn(async () => true),
        } as never,
        sandbox: {
          prepareWorkspaceAuthority: vi.fn(async () => ({
            sandboxed: true as const,
            workspaceAccess: "rw" as const,
          })),
        } as never,
      },
    });
    if (!binding) throw new Error("Readiness #1 source run v4 binding was not created");

    await expect(binding.launch({ taskNodeId, ticketId, beforeProvider })).rejects.toThrow(
      "canonical source Task drift before provider",
    );
    expect(beforeProvider).not.toHaveBeenCalled();
    expect(releaseRunLease).toHaveBeenCalledTimes(1);
    expect(releaseWorkspace).toHaveBeenCalledWith({ path: descriptor.contract.root });
  });

  it("removes a mismatched host worktree and refuses the source Task", async () => {
    const taskNodeId = "TASK_source_456";
    const claimId = "ticket-source-456";
    const descriptor = {
      contract: {
        taskNodeId,
        role: "dev-host",
        actionClass: "source",
        caps: { provider: "codex" },
        ref: "refs/heads/main",
        head: "a".repeat(40),
        root: "/state/worktrees/wt-2",
      },
      indexDigest: "b".repeat(64),
      sourceRoot: "/repo",
      worktreeName: "readiness1-task-source-456",
      worktreeBranch: "openclaw/readiness1-task-source-456",
    };
    const release = vi.fn(async () => {});
    const removeIfLossless = vi.fn(async () => true);
    const binding = createReadiness1HostBinding({
      record: { id: "readiness1-native-controller", origin: "bundled" },
      assertCurrent: vi.fn(),
      openLedgerStore: vi.fn() as never,
      openCanonicalTaskStore: vi.fn(() => ({ lookup: vi.fn(async () => descriptor) })) as never,
      runWithExecutionControl: vi.fn() as never,
      workspace: {
        config: { current: vi.fn(() => ({})) } as never,
        worktrees: {
          resolveCheckoutRoot: vi.fn(async ({ path }: { path: string }) =>
            path === descriptor.contract.root ? descriptor.contract.root : descriptor.sourceRoot,
          ),
          create: vi.fn(async () => ({
            id: "wt-2",
            path: "/wrong",
            branch: descriptor.worktreeBranch,
          })),
          release,
          removeIfLossless,
        } as never,
        sandbox: { prepareWorkspaceAuthority: vi.fn() } as never,
      },
    });
    if (!binding) throw new Error("Readiness #1 host binding was not created");

    await expect(binding.prepareCanonicalWorkspace({ taskNodeId, claimId })).rejects.toThrow(
      "managed worktree identity mismatch",
    );
    expect(release).toHaveBeenCalledWith({ path: "/wrong" });
    expect(removeIfLossless).toHaveBeenCalledWith({
      path: "/wrong",
      ownerKind: "workboard",
      ownerId: `readiness1:${taskNodeId}:${claimId}`,
    });
  });

  it("injects the binding only for the exact bundled controller runtime", () => {
    const resolveBinding = (
      id: string,
      origin: "bundled" | "global",
      property:
        | "readiness1HostBinding"
        | "readiness1SourceRunBindingV2"
        | "readiness1SourceRunBindingV3"
        | "readiness1SourceRunBindingV4"
        | "readiness1SourceRunBindingV5"
        | "readiness1SourceRunBindingV6"
        | "readiness1SourceRunBindingV7" = "readiness1HostBinding",
    ) => {
      const builder = createRuntimeTestRegistry(createPluginRuntime());
      const record = createPluginRecord({
        id,
        source: `/plugins/${id}/index.js`,
        origin,
        enabled: true,
        configSchema: false,
      });
      const api = builder.createApi(record, { config: {} });
      return (api.runtime as unknown as Record<string, unknown>)[property];
    };

    const binding = resolveBinding("readiness1-native-controller", "bundled");
    expect(binding).toMatchObject({ kind: READINESS1_HOST_BINDING_KIND });
    expect(Object.keys(binding as object).sort()).toEqual([
      "kind",
      "openLedgerStore",
      "prepareCanonicalWorkspace",
      "readCanonicalDescriptor",
      "runCanonicalReadOnly",
    ]);
    expect(
      resolveBinding("readiness1-native-controller", "bundled", "readiness1SourceRunBindingV2"),
    ).toMatchObject({ kind: READINESS1_SOURCE_RUN_BINDING_V2_KIND });
    expect(
      resolveBinding("readiness1-native-controller", "bundled", "readiness1SourceRunBindingV3"),
    ).toMatchObject({ kind: READINESS1_SOURCE_RUN_BINDING_V3_KIND });
    expect(
      resolveBinding("readiness1-native-controller", "bundled", "readiness1SourceRunBindingV4"),
    ).toMatchObject({ kind: READINESS1_SOURCE_RUN_BINDING_V4_KIND });
    expect(
      resolveBinding("readiness1-native-controller", "bundled", "readiness1SourceRunBindingV5"),
    ).toMatchObject({ kind: READINESS1_SOURCE_RUN_BINDING_V5_KIND });
    expect(
      resolveBinding("readiness1-native-controller", "bundled", "readiness1SourceRunBindingV6"),
    ).toMatchObject({ kind: READINESS1_SOURCE_RUN_BINDING_V6_KIND });
    expect(
      resolveBinding("readiness1-native-controller", "bundled", "readiness1SourceRunBindingV7"),
    ).toMatchObject({ kind: READINESS1_SOURCE_RUN_BINDING_V7_KIND });
    expect(resolveBinding("readiness1-native-controller", "global")).toBeUndefined();
    expect(resolveBinding("other", "bundled")).toBeUndefined();
    expect(resolveBinding("other", "bundled", "readiness1SourceRunBindingV2")).toBeUndefined();
    expect(resolveBinding("other", "bundled", "readiness1SourceRunBindingV3")).toBeUndefined();
    expect(resolveBinding("other", "bundled", "readiness1SourceRunBindingV4")).toBeUndefined();
    expect(resolveBinding("other", "bundled", "readiness1SourceRunBindingV5")).toBeUndefined();
    expect(resolveBinding("other", "bundled", "readiness1SourceRunBindingV6")).toBeUndefined();
    expect(resolveBinding("other", "bundled", "readiness1SourceRunBindingV7")).toBeUndefined();
  });

  it("refuses source-session sandbox creation from every other plugin", async () => {
    const builder = createRuntimeTestRegistry(createPluginRuntime());
    const record = createPluginRecord({
      id: "other",
      source: "/plugins/other/index.js",
      origin: "bundled",
      enabled: true,
      configSchema: false,
    });
    const api = builder.createApi(record, { config: {} });
    const runtime = api.runtime as PluginRuntime;

    await expect(
      runtime.agent.session.createSessionEntry({
        cfg: {},
        key: "agent:main:harness:openclaw:forbidden-source-worktree",
        sandbox: "required",
        initialEntry: { agentHarnessId: "openclaw" },
      }),
    ).rejects.toThrow('Plugin "other" is not authorized to require a source session sandbox.');
  });

  it("refuses source-session tool policy creation from every other plugin", async () => {
    const builder = createRuntimeTestRegistry(createPluginRuntime());
    const record = createPluginRecord({
      id: "other",
      source: "/plugins/other/index.js",
      origin: "bundled",
      enabled: true,
      configSchema: false,
    });
    const api = builder.createApi(record, { config: {} });
    const runtime = api.runtime as PluginRuntime;

    await expect(
      runtime.agent.session.createSessionEntry({
        cfg: {},
        key: "agent:main:harness:openclaw:forbidden-source-tools",
        sourceToolPolicy: "readiness1-source-v1",
        initialEntry: { agentHarnessId: "openclaw" },
      }),
    ).rejects.toThrow('Plugin "other" is not authorized to require a source session tool policy.');
  });

  it("opens the real retained ledger and rejects a retired runtime", async () => {
    await withOpenClawTestState({ label: "readiness1-retained-ledger" }, async () => {
      try {
        const builder = createRuntimeTestRegistry(createPluginRuntime());
        const record = createPluginRecord({
          id: "readiness1-native-controller",
          source: "/plugins/readiness1-native-controller/index.js",
          origin: "bundled",
          enabled: true,
          configSchema: false,
        });
        const api = builder.createApi(record, { config: {} });
        const binding = (
          api.runtime as unknown as {
            readiness1HostBinding?: ReturnType<typeof createReadiness1HostBinding>;
          }
        ).readiness1HostBinding;
        expect(binding).toBeDefined();
        if (!binding) throw new Error("Readiness #1 host binding was not injected");

        const ledger = binding.openLedgerStore();
        await ledger.register("status:task", { state: "UNACTIVATED" });
        await expect(ledger.lookup("status:task")).resolves.toEqual({ state: "UNACTIVATED" });

        const canonicalTasks = api.runtime.state.openKeyedStore<unknown>({
          namespace: "readiness1-canonical-tasks",
          retention: "retained",
        });
        const task = { taskNodeId: "status:task", source: "host-admin-apply" };
        await canonicalTasks.register("status:task", task);
        await expect(binding.readCanonicalDescriptor("status:task")).resolves.toEqual(task);

        revokePluginRecord(builder.registry, record);
        expect(() => binding.openLedgerStore()).toThrow("runtime is no longer active");
        await expect(ledger.lookup("status:task")).rejects.toThrow("runtime is no longer active");
        await expect(binding.readCanonicalDescriptor("status:task")).rejects.toThrow(
          "runtime is no longer active",
        );
      } finally {
        await closePluginStateDatabaseAsync();
        resetPluginStateStoreForTests();
      }
    });
  });
});

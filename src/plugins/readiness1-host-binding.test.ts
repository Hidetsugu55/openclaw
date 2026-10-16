import { describe, expect, it, vi } from "vitest";
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
  READINESS1_HOST_BINDING_KIND,
  READINESS1_SOURCE_RUN_BINDING_V2_KIND,
  READINESS1_SOURCE_RUN_BINDING_V3_KIND,
  READINESS1_SOURCE_RUN_BINDING_V4_KIND,
} from "./readiness1-host-binding.js";
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

  it("launches only one fixed source context and rechecks the source session at native admission", async () => {
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
    const binding = createReadiness1SourceRunBindingV4({
      acquireSourceRunLease: vi.fn(async () => ({ release: releaseRunLease })),
      bindSourceSession: vi.fn(async () => {}),
      assertSourceSession,
      record: { id: "readiness1-native-controller", origin: "bundled" },
      assertCurrent: vi.fn(),
      openLedgerStore: vi.fn() as never,
      openCanonicalTaskStore: vi.fn(() => ({ lookup: vi.fn(async () => descriptor) })) as never,
      runWithExecutionControl,
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
    await expect(launched.release()).resolves.toBeUndefined();
    expect(releaseRunLease).toHaveBeenCalledTimes(1);
    expect(releaseWorkspace).toHaveBeenCalledWith({ path: descriptor.contract.root });
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
        | "readiness1SourceRunBindingV4" = "readiness1HostBinding",
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
    expect(resolveBinding("readiness1-native-controller", "global")).toBeUndefined();
    expect(resolveBinding("other", "bundled")).toBeUndefined();
    expect(resolveBinding("other", "bundled", "readiness1SourceRunBindingV2")).toBeUndefined();
    expect(resolveBinding("other", "bundled", "readiness1SourceRunBindingV3")).toBeUndefined();
    expect(resolveBinding("other", "bundled", "readiness1SourceRunBindingV4")).toBeUndefined();
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

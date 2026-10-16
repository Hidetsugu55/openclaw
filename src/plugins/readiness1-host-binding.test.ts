import { describe, expect, it, vi } from "vitest";
import {
  closePluginStateDatabaseAsync,
  resetPluginStateStoreForTests,
} from "../plugin-state/plugin-state-store.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { createPluginRecord } from "./loader-records.js";
import {
  createReadiness1HostBinding,
  READINESS1_HOST_BINDING_KIND,
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
          resourceOwnership: Object.freeze({ run: "gateway", session: "gateway", cleanup: "gateway" }),
        });
        await control.beforeProvider(identity);
        return Object.freeze({ runId: identity.runId, sessionKey: identity.sessionKey, execution: identity });
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
        sessionKey: expect.stringMatching(/^agent:researcher:subagent:workboard-readiness1-[a-f0-9]{24}$/),
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
        lookup: vi.fn(async () => ({ ...descriptor, contract: { ...descriptor.contract, actionClass: "source" } })),
      })) as never,
      runWithExecutionControl,
    });
    await expect(
      sourceBinding?.runCanonicalReadOnly({ taskNodeId, ticketId: "ticket-source-123", beforeProvider }),
    ).rejects.toThrow("canonical read-only Task is invalid");
    expect(runWithExecutionControl).toHaveBeenCalledTimes(1);
  });

  it("injects the binding only for the exact bundled controller runtime", () => {
    const resolveBinding = (id: string, origin: "bundled" | "global") => {
      const builder = createRuntimeTestRegistry(createPluginRuntime());
      const record = createPluginRecord({
        id,
        source: `/plugins/${id}/index.js`,
        origin,
        enabled: true,
        configSchema: false,
      });
      const api = builder.createApi(record, { config: {} });
      return (api.runtime as unknown as { readiness1HostBinding?: unknown }).readiness1HostBinding;
    };

    const binding = resolveBinding("readiness1-native-controller", "bundled");
    expect(binding).toMatchObject({ kind: READINESS1_HOST_BINDING_KIND });
    expect(resolveBinding("readiness1-native-controller", "global")).toBeUndefined();
    expect(resolveBinding("other", "bundled")).toBeUndefined();
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
        const binding = (api.runtime as unknown as {
          readiness1HostBinding?: ReturnType<typeof createReadiness1HostBinding>;
        }).readiness1HostBinding;
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

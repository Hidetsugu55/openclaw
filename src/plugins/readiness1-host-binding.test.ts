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

describe("createReadiness1HostBinding", () => {
  it("refuses every plugin except the bundled controller", () => {
    const assertCurrent = vi.fn();
    const openLedgerStore = vi.fn();

    expect(
      createReadiness1HostBinding({
        record: { id: "readiness1-native-controller", origin: "workspace" },
        assertCurrent,
        openLedgerStore,
      }),
    ).toBeUndefined();
    expect(
      createReadiness1HostBinding({
        record: { id: "other", origin: "bundled" },
        assertCurrent,
        openLedgerStore,
      }),
    ).toBeUndefined();
    expect(assertCurrent).not.toHaveBeenCalled();
    expect(openLedgerStore).not.toHaveBeenCalled();
  });

  it("opens only the fixed retained ledger after rechecking lifecycle authority", () => {
    const assertCurrent = vi.fn();
    const store = {};
    const openLedgerStore = vi.fn(() => store);
    const binding = createReadiness1HostBinding({
      record: { id: "readiness1-native-controller", origin: "bundled" },
      assertCurrent,
      openLedgerStore: openLedgerStore as never,
    });

    expect(binding).toBeDefined();
    expect(Object.isFrozen(binding)).toBe(true);
    expect(binding?.kind).toBe(READINESS1_HOST_BINDING_KIND);
    expect(binding?.openLedgerStore()).toBe(store);
    expect(assertCurrent).toHaveBeenCalledTimes(1);
    expect(openLedgerStore).toHaveBeenCalledTimes(1);
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

        revokePluginRecord(builder.registry, record);
        expect(() => binding.openLedgerStore()).toThrow("runtime is no longer active");
        await expect(ledger.lookup("status:task")).rejects.toThrow("runtime is no longer active");
      } finally {
        await closePluginStateDatabaseAsync();
        resetPluginStateStoreForTests();
      }
    });
  });
});

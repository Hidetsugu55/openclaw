import { describe, expect, it, vi } from "vitest";
import { createPluginRecord } from "./loader-records.js";
import {
  createReadiness1HostBinding,
  READINESS1_HOST_BINDING_KIND,
} from "./readiness1-host-binding.js";
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
});

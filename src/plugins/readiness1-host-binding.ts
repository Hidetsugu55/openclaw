import type { PluginStateKeyedStore } from "../plugin-state/plugin-state-store.types.js";
import type { PluginRecord } from "./registry-types.js";

const READINESS1_PLUGIN_ID = "readiness1-native-controller";
const READINESS1_HOST_BINDING_KIND = "openclaw.readiness1.host-binding.v1";

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
}>;

export function createReadiness1HostBinding(params: {
  record: Pick<PluginRecord, "id" | "origin">;
  assertCurrent: () => void;
  openLedgerStore: () => PluginStateKeyedStore<unknown>;
  openCanonicalTaskStore: () => PluginStateKeyedStore<unknown>;
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
      params.assertCurrent();
      if (!/^[A-Za-z0-9_:-]{3,512}$/.test(taskNodeId)) {
        throw new Error("Readiness #1 canonical Task id is invalid.");
      }
      const task = await params.openCanonicalTaskStore().lookup(taskNodeId);
      if (task == null) {
        throw new Error("Readiness #1 canonical Task is unavailable.");
      }
      return structuredClone(task);
    },
  });
}

export { READINESS1_HOST_BINDING_KIND, READINESS1_PLUGIN_ID };

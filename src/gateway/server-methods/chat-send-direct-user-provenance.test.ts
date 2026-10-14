import { describe, expect, it, vi } from "vitest";
import {
  GATEWAY_CLIENT_IDS,
  GATEWAY_CLIENT_MODES,
} from "../../../packages/gateway-protocol/src/client-info.js";
import { PROTOCOL_VERSION } from "../../../packages/gateway-protocol/src/version.js";
import { buildEmbeddedAttemptToolRunContext } from "../../agents/embedded-agent-runner/run/attempt-tool-run-context.js";
import { enqueueFollowupRun } from "../../auto-reply/reply/queue/enqueue.js";
import { clearFollowupQueue } from "../../auto-reply/reply/queue/state.js";
import type { FollowupRun } from "../../auto-reply/reply/queue/types.js";
import type { PairedDevice } from "../../infra/device-pairing.js";
import { createPluginRuntimeMock } from "../../plugin-sdk/test-helpers/plugin-runtime-mock.js";
import { createPluginRegistry } from "../../plugins/registry.js";
import { createPluginRecord } from "../../plugins/status.test-helpers.js";
import { createPluginToolFactoryContext } from "../../plugins/tool-factory-context.js";
import { bindPluginToolCallbacks } from "../../plugins/tool-factory-runtime.js";
import type { OpenClawPluginToolContext } from "../../plugins/tool-types.js";
import { resolveChatSendDirectUserPluginToolProvenance } from "./chat-send-direct-user-provenance.js";
import type { ChatSendExternalAdmissionParams } from "./chat-send-external-authority-contract.js";
import type { GatewayClient } from "./client-types.js";

const DEVICE_ID = "paired-owner-device";
const DEVICE_PUBLIC_KEY = "paired-owner-public-key";

type DirectAdmission = ChatSendExternalAdmissionParams & { isDirectExternalUser: true };

function createDirectAdmissionFixture(): {
  client: GatewayClient;
  paired: PairedDevice;
  params: DirectAdmission;
  setCurrent: (value: boolean) => void;
} {
  let current = true;
  const client: GatewayClient = {
    connect: {
      minProtocol: PROTOCOL_VERSION,
      maxProtocol: PROTOCOL_VERSION,
      client: {
        id: GATEWAY_CLIENT_IDS.CONTROL_UI,
        version: "test",
        platform: "test",
        mode: GATEWAY_CLIENT_MODES.UI,
      },
      role: "operator",
      scopes: ["operator.admin"],
      device: {
        id: DEVICE_ID,
        publicKey: DEVICE_PUBLIC_KEY,
        signature: "synthetic-signature",
        signedAt: 1,
        nonce: "synthetic-nonce",
      },
    },
    connId: "direct-owner-connection",
    internal: {
      authenticatedOperator: true,
      authenticatedControlUi: true,
      controlUiAdmin: true,
    },
  };
  const paired: PairedDevice = {
    deviceId: DEVICE_ID,
    publicKey: DEVICE_PUBLIC_KEY,
    clientId: GATEWAY_CLIENT_IDS.CONTROL_UI,
    role: "operator",
    roles: ["operator"],
    tokens: {
      operator: {
        token: "synthetic-active-token",
        role: "operator",
        scopes: ["operator.admin"],
        createdAtMs: 1,
      },
    },
    createdAtMs: 1,
    approvedAtMs: 1,
  };
  return {
    client,
    paired,
    params: {
      runId: "direct-owner-run",
      sessionKey: "agent:main:main",
      client,
      isCurrent: () => current,
      hasExplicitOrigin: false,
      hasRestoredCronContinuation: false,
      isIncognitoEntry: false,
      isReconnectResume: false,
      isSystemGenerated: false,
      turnKind: "main",
      isDirectExternalUser: true,
    },
    setCurrent(value) {
      current = value;
    },
  };
}

function registerReadinessTool(effect: () => void) {
  const builder = createPluginRegistry({
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    runtime: createPluginRuntimeMock(),
    activateGlobalSideEffects: false,
  });
  const record = createPluginRecord({
    id: "readiness-probe",
    contracts: { tools: ["readiness_probe"] },
  });
  let observedContext: OpenClawPluginToolContext<2> | undefined;
  builder.registry.plugins.push(record);
  builder.createApi(record, { config: {}, registrationMode: "full" }).registerTool(
    {
      contextVersion: 2,
      create(context) {
        observedContext = context;
        if (context.originTrigger !== "direct-user" || context.deviceId !== DEVICE_ID) {
          return null;
        }
        return {
          name: "readiness_probe",
          label: "Readiness probe",
          description: "Synthetic provider-free readiness probe",
          parameters: { type: "object", properties: {} },
          async execute() {
            context.assertInvocationCurrent();
            effect();
            return { content: [{ type: "text", text: "ready" }], details: {} };
          },
        };
      },
    },
    { name: "readiness_probe" },
  );
  const entry = builder.registry.tools[0];
  if (!entry) {
    throw new Error("expected readiness tool registration");
  }
  return { entry, registry: builder.registry, readObservedContext: () => observedContext };
}

describe("Gateway direct-user plugin tool provenance", () => {
  it("creates and retains an immutable V2 readiness tool only for the live paired owner", async () => {
    const fixture = createDirectAdmissionFixture();
    const readPairedDevice = vi.fn(async () => fixture.paired);
    const providerCalls = vi.fn();
    const subagentRuns = vi.fn();
    const ledgerMutations = vi.fn();
    const deliveriesOrNotifications = vi.fn();
    const githubOperations = vi.fn();
    const readinessUse = vi.fn();

    const provenance = await resolveChatSendDirectUserPluginToolProvenance(fixture.params, {
      getPairedDevice: readPairedDevice,
    });
    expect(provenance).toMatchObject({
      originTrigger: "direct-user",
      deviceId: DEVICE_ID,
    });
    expect(Object.isFrozen(provenance)).toBe(true);
    expect(readPairedDevice).toHaveBeenCalledExactlyOnceWith(DEVICE_ID);
    if (!provenance) {
      throw new Error("expected direct-user provenance");
    }

    const projectedToolRun = buildEmbeddedAttemptToolRunContext({
      directUserPluginToolProvenance: provenance,
    });
    expect(projectedToolRun.directUserPluginToolProvenance).toBe(provenance);

    const readiness = registerReadinessTool(readinessUse);
    const factoryContext = createPluginToolFactoryContext({
      entry: readiness.entry,
      registry: readiness.registry,
      context: {},
      assertInvocationCurrent: () => {},
      directUserPluginToolProvenance: projectedToolRun.directUserPluginToolProvenance,
    });
    const rawTool = readiness.entry.factory(factoryContext);
    if (!rawTool || Array.isArray(rawTool)) {
      throw new Error("expected direct-user readiness tool");
    }
    const observedContext = readiness.readObservedContext();
    expect(observedContext).toBeDefined();
    expect(Object.getOwnPropertyDescriptor(observedContext, "originTrigger")).toMatchObject({
      configurable: false,
      enumerable: true,
      value: "direct-user",
      writable: false,
    });
    expect(Object.getOwnPropertyDescriptor(observedContext, "deviceId")).toMatchObject({
      configurable: false,
      enumerable: true,
      value: DEVICE_ID,
      writable: false,
    });
    expect(Reflect.set(observedContext ?? {}, "deviceId", "forged-device")).toBe(false);

    const tool = bindPluginToolCallbacks(
      readiness.entry,
      readiness.registry,
      rawTool,
      factoryContext.assertInvocationCurrent,
    );
    await expect(tool.execute("readiness-1", {})).resolves.toMatchObject({
      content: [{ text: "ready" }],
    });
    expect(readinessUse).toHaveBeenCalledOnce();

    fixture.setCurrent(false);
    await expect(tool.execute("readiness-stale", {})).rejects.toThrow("no longer current");
    expect(readinessUse).toHaveBeenCalledOnce();

    const queueKey = "agent:main:queued-provenance-test";
    const queued: FollowupRun = {
      prompt: "queued prompt",
      enqueuedAt: 1,
      run: {
        agentId: "main",
        agentDir: "/tmp/agent",
        sessionId: "queued-session",
        sessionKey: queueKey,
        sessionFile: "/tmp/queued-session.jsonl",
        workspaceDir: "/tmp/workspace",
        config: {},
        provider: "synthetic",
        model: "provider-free",
        requestedRouteResolution: "resolved",
        timeoutMs: 1,
        blockReplyBreak: "message_end",
        directUserPluginToolProvenance: provenance,
      },
    };
    expect(
      enqueueFollowupRun(queueKey, queued, { mode: "followup" }, "none", undefined, false),
    ).toBe(true);
    expect(queued.run.directUserPluginToolProvenance).toBeUndefined();
    clearFollowupQueue(queueKey);

    for (const prohibitedEffect of [
      providerCalls,
      subagentRuns,
      ledgerMutations,
      deliveriesOrNotifications,
      githubOperations,
    ]) {
      expect(prohibitedEffect).not.toHaveBeenCalled();
    }
  });

  it.each([
    [
      "missing device",
      (fixture: ReturnType<typeof createDirectAdmissionFixture>) => {
        fixture.client.connect.device = undefined;
      },
    ],
    [
      "channel",
      (fixture: ReturnType<typeof createDirectAdmissionFixture>) => {
        fixture.params.hasExplicitOrigin = true;
      },
    ],
    [
      "cron",
      (fixture: ReturnType<typeof createDirectAdmissionFixture>) => {
        fixture.params.hasRestoredCronContinuation = true;
      },
    ],
    [
      "internal",
      (fixture: ReturnType<typeof createDirectAdmissionFixture>) => {
        fixture.params.inputProvenance = { kind: "internal_system", sourceTool: "test" };
      },
    ],
    [
      "subagent",
      (fixture: ReturnType<typeof createDirectAdmissionFixture>) => {
        fixture.params.spawnedBy = "agent:main:subagent:child";
      },
    ],
    [
      "synthetic client",
      (fixture: ReturnType<typeof createDirectAdmissionFixture>) => {
        fixture.client.internal = { syntheticClient: true };
      },
    ],
    [
      "unauthenticated operator",
      (fixture: ReturnType<typeof createDirectAdmissionFixture>) => {
        fixture.client.internal = { authenticatedControlUi: true };
      },
    ],
    [
      "system-generated",
      (fixture: ReturnType<typeof createDirectAdmissionFixture>) => {
        fixture.params.isSystemGenerated = true;
      },
    ],
    [
      "queued/reconnect",
      (fixture: ReturnType<typeof createDirectAdmissionFixture>) => {
        fixture.params.isReconnectResume = true;
      },
    ],
    [
      "incognito",
      (fixture: ReturnType<typeof createDirectAdmissionFixture>) => {
        fixture.params.isIncognitoEntry = true;
      },
    ],
    [
      "btw",
      (fixture: ReturnType<typeof createDirectAdmissionFixture>) => {
        fixture.params.turnKind = "btw";
      },
    ],
    [
      "stale request",
      (fixture: ReturnType<typeof createDirectAdmissionFixture>) => {
        fixture.setCurrent(false);
      },
    ],
    [
      "invalidated client",
      (fixture: ReturnType<typeof createDirectAdmissionFixture>) => {
        fixture.client.invalidated = true;
      },
    ],
  ])("omits provenance and cannot create or use readiness for %s", async (_label, reject) => {
    const fixture = createDirectAdmissionFixture();
    reject(fixture);
    const readinessUse = vi.fn();
    const provenance = await resolveChatSendDirectUserPluginToolProvenance(fixture.params, {
      getPairedDevice: vi.fn(async () => fixture.paired),
    });
    expect(provenance).toBeUndefined();

    const readiness = registerReadinessTool(readinessUse);
    const context = createPluginToolFactoryContext({
      entry: readiness.entry,
      registry: readiness.registry,
      context: {
        originTrigger: "direct-user",
        deviceId: DEVICE_ID,
      } as OpenClawPluginToolContext,
      assertInvocationCurrent: () => {},
      directUserPluginToolProvenance: provenance,
    });
    expect(readiness.entry.factory(context)).toBeNull();
    expect(readinessUse).not.toHaveBeenCalled();
  });

  it.each([
    ["missing pairing", (_fixture: ReturnType<typeof createDirectAdmissionFixture>) => null],
    [
      "foreign public key",
      (fixture: ReturnType<typeof createDirectAdmissionFixture>) => ({
        ...fixture.paired,
        publicKey: "foreign-public-key",
      }),
    ],
    [
      "replaced client",
      (fixture: ReturnType<typeof createDirectAdmissionFixture>) => ({
        ...fixture.paired,
        clientId: GATEWAY_CLIENT_IDS.CLI,
      }),
    ],
    [
      "ambiguous client",
      (fixture: ReturnType<typeof createDirectAdmissionFixture>) => ({
        ...fixture.paired,
        clientId: undefined,
      }),
    ],
    [
      "revoked operator token",
      (fixture: ReturnType<typeof createDirectAdmissionFixture>) => ({
        ...fixture.paired,
        tokens: {
          operator: {
            ...fixture.paired.tokens?.operator,
            token: "revoked-token",
            role: "operator",
            scopes: ["operator.admin"],
            createdAtMs: 1,
            revokedAtMs: 2,
          },
        },
      }),
    ],
  ])("rejects %s pairing lifecycle state", async (_label, pairedResult) => {
    const fixture = createDirectAdmissionFixture();
    const readinessUse = vi.fn();
    const provenance = await resolveChatSendDirectUserPluginToolProvenance(fixture.params, {
      getPairedDevice: vi.fn(async () => pairedResult(fixture)),
    });
    expect(provenance).toBeUndefined();

    const readiness = registerReadinessTool(readinessUse);
    const context = createPluginToolFactoryContext({
      entry: readiness.entry,
      registry: readiness.registry,
      context: {},
      assertInvocationCurrent: () => {},
      directUserPluginToolProvenance: provenance,
    });
    expect(readiness.entry.factory(context)).toBeNull();
    expect(readinessUse).not.toHaveBeenCalled();
  });

  it("fails closed without creating readiness when the pairing read fails", async () => {
    const fixture = createDirectAdmissionFixture();
    const readinessUse = vi.fn();
    const provenance = await resolveChatSendDirectUserPluginToolProvenance(fixture.params, {
      getPairedDevice: vi.fn(async () => {
        throw new Error("pairing store unavailable");
      }),
    });
    expect(provenance).toBeUndefined();

    const readiness = registerReadinessTool(readinessUse);
    const context = createPluginToolFactoryContext({
      entry: readiness.entry,
      registry: readiness.registry,
      context: {},
      assertInvocationCurrent: () => {},
    });
    expect(readiness.entry.factory(context)).toBeNull();
    expect(readinessUse).not.toHaveBeenCalled();
  });

  it("never projects the direct-user fields into a legacy V1 plugin context", async () => {
    const fixture = createDirectAdmissionFixture();
    const provenance = await resolveChatSendDirectUserPluginToolProvenance(fixture.params, {
      getPairedDevice: vi.fn(async () => fixture.paired),
    });
    expect(provenance).toBeDefined();

    const builder = createPluginRegistry({
      logger: { info() {}, warn() {}, error() {}, debug() {} },
      runtime: createPluginRuntimeMock(),
      activateGlobalSideEffects: false,
    });
    const record = createPluginRecord({ id: "legacy", contracts: { tools: ["legacy"] } });
    const observed = vi.fn((_context: OpenClawPluginToolContext) => null);
    builder.registry.plugins.push(record);
    builder
      .createApi(record, { config: {}, registrationMode: "full" })
      .registerTool(observed, { name: "legacy" });
    const entry = builder.registry.tools[0];
    if (!entry) {
      throw new Error("expected legacy registration");
    }
    const context = createPluginToolFactoryContext({
      entry,
      registry: builder.registry,
      context: {},
      assertInvocationCurrent: () => {},
      directUserPluginToolProvenance: provenance,
    });
    entry.factory(context);
    expect(observed).toHaveBeenCalledOnce();
    const legacyContext = observed.mock.calls[0]?.[0] as Record<string, unknown> | undefined;
    expect(legacyContext).not.toHaveProperty("originTrigger");
    expect(legacyContext).not.toHaveProperty("deviceId");
  });
});

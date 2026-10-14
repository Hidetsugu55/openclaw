import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createOpenClawTestInstance } from "../../test/helpers/openclaw-test-instance.js";
import { runQaGatewayFixture } from "../../test/helpers/qa-gateway-cleanup.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { generateStoredDeviceIdentity } from "../infra/device-identity-store.js";
import {
  createExecutionOwnershipProbe,
  EXECUTION_OWNERSHIP_PROBE_ID,
} from "./gateway-execution-ownership.live.test-support.js";
import { connectGatewayClient, disconnectGatewayClient } from "./test-helpers.e2e.js";

const MODEL_REF = "execution-proof/execution-proof";

type CanaryStats = {
  id: string;
  guardCalls: number;
  markExecutionStartedCalls: number;
  providerStartHooks: number;
  identityPublications: number;
  identity?: { runId: string; sessionKey: string; sessionId: string };
  replacement?: { before: string; after: string; identity: string };
  error?: string;
  terminal?: { status: string; error?: string };
  ownerPresentAfterSettlement?: boolean;
};

describe("Gateway execution ownership loopback canary", () => {
  it(
    "fails closed on exact session replacement during awaited admission and admits the safe path once",
    { timeout: 240_000 },
    async () => {
      const instance = await createOpenClawTestInstance({
        name: "execution-ownership",
        entrypoint: ["src/entry.ts"],
        gatewayCommandPrefix: [process.execPath, "--import", "./scripts/tsx.mjs"],
        env: {
          OPENCLAW_AGENT_RUNTIME: undefined,
          OPENCLAW_SKIP_PROVIDERS: undefined,
          OPENCLAW_TEST_MINIMAL_GATEWAY: undefined,
        },
      });
      const probe = await createExecutionOwnershipProbe(instance.state);
      let client: Awaited<ReturnType<typeof connectGatewayClient>> | undefined;
      await runQaGatewayFixture(
        async () => {
          const config: OpenClawConfig = {
            gateway: {
              mode: "local",
              port: instance.port,
              auth: { mode: "token", token: instance.gatewayToken },
              controlUi: { enabled: false },
            },
            agents: {
              defaults: {
                workspace: instance.state.workspaceDir,
                skipBootstrap: true,
                heartbeat: { every: "0m" },
                model: { primary: MODEL_REF },
                models: {
                  [MODEL_REF]: { agentRuntime: { id: EXECUTION_OWNERSHIP_PROBE_ID } },
                },
                sandbox: { mode: "off" },
              },
            },
            plugins: {
              load: { paths: [probe.pluginPath] },
              allow: [EXECUTION_OWNERSHIP_PROBE_ID],
              entries: { [EXECUTION_OWNERSHIP_PROBE_ID]: { enabled: true } },
            },
            tools: { allow: [] },
            models: {
              mode: "replace",
              providers: {
                "execution-proof": {
                  baseUrl: `${probe.baseUrl}/v1`,
                  apiKey: "test-only",
                  api: "openai-responses",
                  request: { allowPrivateNetwork: true },
                  models: [
                    {
                      id: "execution-proof",
                      name: "execution-proof",
                      api: "openai-responses",
                      reasoning: false,
                      input: ["text"],
                      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                      contextWindow: 32_000,
                      maxTokens: 512,
                    },
                  ],
                },
              },
            },
          };
          await instance.state.writeConfig(config);
          await instance.startGateway();
          client = await connectGatewayClient({
            url: instance.url,
            token: instance.gatewayToken,
            role: "operator",
            scopes: ["operator.admin", "operator.read", "operator.write"],
            deviceIdentity: generateStoredDeviceIdentity(),
            deviceAuthScope: "test://execution-ownership",
            sharedStateMode: "read-only",
          });

          const staleId = `stale-${randomUUID()}`;
          const staleSessionKey = `agent:main:execution-ownership-stale-${randomUUID()}`;
          await client.request("executionOwnership.start", {
            id: staleId,
            sessionKey: staleSessionKey,
            message: "STALE_EXECUTION_OWNERSHIP_CANARY",
          });
          const entered = await client.request<CanaryStats>("executionOwnership.entered", {
            id: staleId,
          });
          expect(entered, JSON.stringify(entered)).toMatchObject({
            guardCalls: 1,
            markExecutionStartedCalls: 0,
            providerStartHooks: 0,
            identityPublications: 0,
            identity: { sessionKey: staleSessionKey },
          });
          const replacementSessionId = `replacement-${randomUUID()}`;
          const released = await client.request<CanaryStats>("executionOwnership.release", {
            id: staleId,
            replacementSessionId,
          });
          expect(released.replacement).toEqual({
            before: entered.identity?.sessionId,
            after: replacementSessionId,
            identity: entered.identity?.sessionId,
          });
          const stale = await client.request<CanaryStats>("executionOwnership.settled", {
            id: staleId,
          });
          expect(stale).toMatchObject({
            guardCalls: 1,
            markExecutionStartedCalls: 0,
            providerStartHooks: 0,
            identityPublications: 0,
            ownerPresentAfterSettlement: false,
            replacement: { after: replacementSessionId },
            error: expect.stringMatching(
              /ownership is UNKNOWN|ended before native identity admission/u,
            ),
          });
          expect(probe.requests).toEqual([]);

          const safeId = `safe-${randomUUID()}`;
          const safeSessionKey = `agent:main:execution-ownership-safe-${randomUUID()}`;
          await client.request("executionOwnership.start", {
            id: safeId,
            sessionKey: safeSessionKey,
            message: "SAFE_EXECUTION_OWNERSHIP_CANARY",
          });
          await client.request("executionOwnership.entered", { id: safeId });
          await client.request("executionOwnership.release", { id: safeId });
          const safe = await client.request<CanaryStats>("executionOwnership.settled", {
            id: safeId,
          });
          expect(safe).toMatchObject({
            guardCalls: 1,
            markExecutionStartedCalls: 1,
            providerStartHooks: 1,
            identityPublications: 1,
            terminal: { status: "ok" },
            ownerPresentAfterSettlement: false,
          });
          expect(safe.error).toBeUndefined();
          expect(probe.requests).toHaveLength(1);
          expect(probe.requests[0]).toContain("SAFE_EXECUTION_OWNERSHIP_CANARY");
          expect(probe.failures).toEqual([]);
        },
        () => client && disconnectGatewayClient(client),
        () => instance.cleanup(),
        () => probe.close(),
      );
      expect(instance.child).toBeUndefined();
      expect(probe.listening).toBe(false);
    },
  );
});

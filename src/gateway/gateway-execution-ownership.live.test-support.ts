import fs from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { json } from "node:stream/consumers";
import { writeOpenAiResponsesText } from "../../test/helpers/openai-responses-sse.js";
import type { OpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { reserveTestPortListener } from "../test-utils/port-claims.js";

export const EXECUTION_OWNERSHIP_PROBE_ID = "execution-ownership-proof";

type ProviderBody = {
  input?: unknown;
};

export async function createExecutionOwnershipProbe(state: OpenClawTestState) {
  const requests: string[] = [];
  const failures: string[] = [];
  const reserved = await reserveTestPortListener({
    offsets: [0],
    createListener: () =>
      createServer((request, response) => {
        void (async () => {
          if (request.method !== "POST" || request.url !== "/v1/responses") {
            response.writeHead(404).end();
            return;
          }
          const body = (await json(request)) as ProviderBody;
          const serialized = JSON.stringify(body.input ?? null);
          requests.push(serialized);
          writeOpenAiResponsesText(response, {
            text: "Gateway execution ownership canary completed.",
            messageId: `msg_${requests.length}`,
            responseId: `resp_${requests.length}`,
          });
        })().catch((error: unknown) => {
          failures.push(String(error));
          response.writeHead(500, { "content-type": "application/json" });
          response.end(JSON.stringify({ error: { message: "local canary provider failed" } }));
        });
      }),
  });
  const baseUrl = `http://127.0.0.1:${reserved.claim.port}`;
  const pluginPath = state.path(EXECUTION_OWNERSHIP_PROBE_ID);
  await fs.mkdir(pluginPath, { recursive: true });
  await Promise.all([
    fs.writeFile(
      path.join(pluginPath, "package.json"),
      JSON.stringify({
        name: EXECUTION_OWNERSHIP_PROBE_ID,
        type: "commonjs",
        openclaw: { extensions: ["./index.cjs"] },
      }),
    ),
    fs.writeFile(
      path.join(pluginPath, "openclaw.plugin.json"),
      JSON.stringify({
        id: EXECUTION_OWNERSHIP_PROBE_ID,
        activation: { onStartup: true },
        configSchema: { type: "object", additionalProperties: false, properties: {} },
      }),
    ),
    fs.writeFile(
      path.join(pluginPath, "index.cjs"),
      `const http = require("node:http");
const OBSERVER = Symbol.for("openclaw.test.agentRunExecutionCanaryObserver");
const state = globalThis[Symbol.for("openclaw.test.executionOwnershipProof")] ??= { runs: new Map() };
const providerUrl = new URL(${JSON.stringify(`${baseUrl}/v1/responses`)});
function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}
function project(record) {
  return {
    id: record.id,
    guardCalls: record.guardCalls,
    markExecutionStartedCalls: record.markExecutionStartedCalls,
    providerStartHooks: record.providerStartHooks,
    identityPublications: record.identityPublications,
    identity: record.identity,
    replacement: record.replacement,
    error: record.error,
    terminal: record.terminal,
    ownerPresentAfterSettlement: record.ownerPresentAfterSettlement,
  };
}
Reflect.set(globalThis, OBSERVER, (event) => {
  for (const record of state.runs.values()) {
    if (record.identity?.runId !== event.runId) continue;
    if (event.kind === "mark-execution-started") record.markExecutionStartedCalls++;
    if (event.kind === "provider-start-hook") record.providerStartHooks++;
  }
});
function requestProvider(input) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ input });
    const request = http.request(providerUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "content-length": Buffer.byteLength(body),
      },
    }, (response) => {
      response.resume();
      response.once("end", () => {
        if (response.statusCode >= 200 && response.statusCode < 300) resolve();
        else reject(new Error(\`local provider returned \${response.statusCode}\`));
      });
    });
    request.once("error", reject);
    request.end(body);
  });
}
module.exports = {
  id: "${EXECUTION_OWNERSHIP_PROBE_ID}",
  register(api) {
    api.registerAgentHarness({
      id: "${EXECUTION_OWNERSHIP_PROBE_ID}",
      label: "Gateway execution ownership proof",
      authBootstrap: "harness",
      supports: () => ({ supported: true, priority: 100 }),
      async runAttempt(params) {
        await params.onExecutionStarted?.();
        await requestProvider(params.prompt);
        const text = "Gateway execution ownership canary completed.";
        const assistant = {
          role: "assistant",
          content: [{ type: "text", text }],
          api: "openai-responses",
          provider: "execution-proof",
          model: "execution-proof",
          usage: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 0,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
          stopReason: "stop",
          timestamp: Date.now(),
        };
        return {
          terminal: { kind: "ok" },
          sessionIdUsed: "execution-ownership-proof",
          messagesSnapshot: [assistant],
          assistantTexts: [text],
          toolMetas: [],
          lastAssistant: assistant,
          didSendViaMessagingTool: false,
          messagingToolSentTexts: [],
          messagingToolSentMediaUrls: [],
          messagingToolSentTargets: [],
          cloudCodeAssistFormatError: false,
          replayMetadata: { hadPotentialSideEffects: false, replaySafe: true },
          itemLifecycle: { startedCount: 0, completedCount: 0, activeCount: 0 },
        };
      },
    });
    const pending = [];
    const launch = (record) => {
      void api.runtime.subagent.runWithExecutionControl(
        {
          sessionKey: record.sessionKey,
          message: record.message,
          deliver: false,
          idempotencyKey: record.id,
        },
        {
          beforeProvider: async (identity) => {
            record.guardCalls++;
            record.identity = identity;
            record.entered.resolve();
            await record.release.promise;
          },
        },
      ).then(async (result) => {
        record.identityPublications++;
        record.result = result;
        record.terminal = await api.runtime.subagent.waitForRun({
          runId: result.runId,
          timeoutMs: 60_000,
        });
      }).catch((error) => {
        record.error = error instanceof Error ? (error.stack ?? error.message) : String(error);
      }).finally(() => {
        record.ownerPresentAfterSettlement = record.identity
          ? record.context.chatAbortControllers.has(record.identity.runId)
          : undefined;
        record.settled.resolve();
      });
    };
    const launcher = setInterval(() => {
      for (const record of pending.splice(0)) launch(record);
    }, 1);
    launcher.unref();
    api.registerGatewayMethod("executionOwnership.start", ({ params, context, respond }) => {
      const entered = deferred();
      const release = deferred();
      const settled = deferred();
      const record = {
        id: params.id,
        entered,
        release,
        settled,
        context,
        sessionKey: params.sessionKey,
        message: params.message,
        guardCalls: 0,
        markExecutionStartedCalls: 0,
        providerStartHooks: 0,
        identityPublications: 0,
      };
      state.runs.set(record.id, record);
      pending.push(record);
      respond(true, { started: true });
    }, { scope: "operator.admin" });
    api.registerGatewayMethod("executionOwnership.entered", async ({ params, respond }) => {
      const record = state.runs.get(params.id);
      if (!record) return respond(false, undefined, { code: "NOT_FOUND", message: "run missing" });
      await Promise.race([record.entered.promise, record.settled.promise]);
      respond(true, project(record));
    }, { scope: "operator.admin" });
    api.registerGatewayMethod("executionOwnership.release", ({ params, respond }) => {
      const record = state.runs.get(params.id);
      if (!record?.identity) return respond(false, undefined, { code: "NOT_READY", message: "identity missing" });
      const owner = record.context.chatAbortControllers.get(record.identity.runId);
      if (!owner) return respond(false, undefined, { code: "OWNER_MISSING", message: "owner missing" });
      if (typeof params.replacementSessionId === "string") {
        record.replacement = {
          before: owner.sessionId,
          after: params.replacementSessionId,
          identity: record.identity.sessionId,
        };
        owner.sessionId = params.replacementSessionId;
      }
      record.release.resolve();
      respond(true, project(record));
    }, { scope: "operator.admin" });
    api.registerGatewayMethod("executionOwnership.settled", async ({ params, respond }) => {
      const record = state.runs.get(params.id);
      if (!record) return respond(false, undefined, { code: "NOT_FOUND", message: "run missing" });
      await record.settled.promise;
      respond(true, project(record));
    }, { scope: "operator.admin" });
  },
};
`,
    ),
  ]);

  return {
    baseUrl,
    pluginPath,
    requests,
    failures,
    get listening() {
      return reserved.listener.listening;
    },
    async close() {
      reserved.listener.closeAllConnections();
      await reserved.releaseListener();
      await reserved.claim.release();
    },
  };
}

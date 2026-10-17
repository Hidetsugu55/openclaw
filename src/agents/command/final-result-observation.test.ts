import { createHash } from "node:crypto";
import { stableStringify } from "@openclaw/normalization-core";
import { describe, expect, it } from "vitest";
import { buildAgentRuntimeFinalObservation } from "./final-result-observation.js";

describe("agent runtime final result observation", () => {
  it("hashes only a bounded terminal result after measured cumulative usage", () => {
    const result = {
      meta: { agentMeta: { diagnosticUsage: { total: 42 } } },
      payloads: [
        {
          text: "completed source work",
          mediaUrls: ["https://example.test/result"],
          channelData: { private: "must-not-affect-digest" },
        },
      ],
      sourceReplyDelivered: true,
    } as never;

    const observation = buildAgentRuntimeFinalObservation(result);
    const serialized = stableStringify({
      kind: "openclaw.agent.runtime-final-result.v1",
      payloads: [
        {
          text: "completed source work",
          mediaUrl: null,
          mediaUrls: ["https://example.test/result"],
          replyToId: null,
          isError: false,
          isReasoning: false,
          isCommentary: false,
          audioAsVoice: false,
          trustedLocalMedia: false,
        },
      ],
      didSendViaMessagingTool: false,
      sourceReplyDelivered: true,
    });

    expect(observation).toEqual({
      kind: "final",
      result: {
        digest: createHash("sha256").update(serialized).digest("hex"),
        byteLength: Buffer.byteLength(serialized, "utf8"),
      },
      usage: 42,
    });
    expect(Object.isFrozen(observation)).toBe(true);
    expect(Object.isFrozen(observation?.result)).toBe(true);
  });

  it("leaves usage UNKNOWN when the terminal run did not report a safe total", () => {
    expect(
      buildAgentRuntimeFinalObservation({
        meta: { agentMeta: { diagnosticUsage: { total: -1 } } },
      } as never),
    ).toBeUndefined();
    expect(buildAgentRuntimeFinalObservation({ meta: {} } as never)).toBeUndefined();
  });
});

import { createHash } from "node:crypto";
import { stableStringify } from "@openclaw/normalization-core";
import type { EmbeddedAgentRunResult } from "../embedded-agent-runner/types.js";
import type { AgentRuntimeExecutionObservation } from "./types.js";

type FinalObservation = Extract<AgentRuntimeExecutionObservation, { kind: "final" }>;

function normalizeStringList(value: unknown): string[] | undefined {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    return undefined;
  }
  return [...value];
}

/**
 * Produces a bounded digest of the terminal result after persistence has
 * completed. It deliberately excludes channelData and all provider-native
 * fields so the in-process observer never receives model text or raw payloads.
 */
export function buildAgentRuntimeFinalObservation(
  result: EmbeddedAgentRunResult,
): FinalObservation | undefined {
  const usage = result.meta.agentMeta?.diagnosticUsage?.total;
  if (typeof usage !== "number" || !Number.isSafeInteger(usage) || usage < 0) {
    return undefined;
  }
  const serialized = stableStringify({
    kind: "openclaw.agent.runtime-final-result.v1",
    payloads: (result.payloads ?? []).map((payload) => ({
      text: typeof payload.text === "string" ? payload.text : null,
      mediaUrl: typeof payload.mediaUrl === "string" ? payload.mediaUrl : null,
      mediaUrls: normalizeStringList(payload.mediaUrls) ?? null,
      replyToId: typeof payload.replyToId === "string" ? payload.replyToId : null,
      isError: payload.isError === true,
      isReasoning: payload.isReasoning === true,
      isCommentary: payload.isCommentary === true,
      audioAsVoice: payload.audioAsVoice === true,
      trustedLocalMedia: payload.trustedLocalMedia === true,
    })),
    didSendViaMessagingTool: result.didSendViaMessagingTool === true,
    sourceReplyDelivered: result.sourceReplyDelivered === true,
  });
  return Object.freeze({
    kind: "final",
    result: Object.freeze({
      digest: createHash("sha256").update(serialized).digest("hex"),
      byteLength: Buffer.byteLength(serialized, "utf8"),
    }),
    usage,
  });
}

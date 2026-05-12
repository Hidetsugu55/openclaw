import type { EmbeddedRunAttemptParams } from "./types.js";

export function resolveEffectiveForceMessageTool(params: EmbeddedRunAttemptParams): boolean {
  return (
    params.forceMessageTool === true ||
    params.sourceReplyDeliveryMode === "message_tool_only" ||
    (params.config?.messages?.groupChat?.visibleReplies === "message_tool" &&
      isGroupOrChannelSource(params))
  );
}

export function isGroupOrChannelSource(params: EmbeddedRunAttemptParams): boolean {
  return (
    hasNonEmptyString(params.groupId) ||
    hasNonEmptyString(params.groupChannel) ||
    hasNonEmptyString(params.groupSpace) ||
    hasGroupOrChannelSegment(params.sessionKey) ||
    hasGroupOrChannelSegment(params.messageTo)
  );
}

function hasNonEmptyString(value: string | null | undefined): boolean {
  return typeof value === "string" && value.trim().length > 0;
}

function hasGroupOrChannelSegment(value: string | null | undefined): boolean {
  if (!value) {
    return false;
  }
  const segments = value
    .split(":")
    .map((segment) => segment.trim().toLowerCase())
    .filter(Boolean);
  return segments.includes("group") || segments.includes("channel");
}

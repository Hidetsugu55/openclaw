import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalLowercaseString,
  normalizeOptionalString,
} from "../shared/string-coerce.js";
import {
  INTERNAL_MESSAGE_CHANNEL,
  isDeliverableMessageChannel,
  normalizeMessageChannel,
} from "../utils/message-channel.js";

export type ParsedAgentSessionKey = {
  agentId: string;
  rest: string;
};

export type ParsedThreadSessionSuffix = {
  baseSessionKey: string | undefined;
  threadId: string | undefined;
};

export type RawSessionConversationRef = {
  channel: string;
  kind: "group" | "channel";
  rawId: string;
  prefix: string;
};

/**
 * Parse agent-scoped session keys in a canonical, case-insensitive way.
 * Returned values are normalized to lowercase for stable comparisons/routing.
 */
export function parseAgentSessionKey(
  sessionKey: string | undefined | null,
): ParsedAgentSessionKey | null {
  const raw = normalizeOptionalLowercaseString(sessionKey);
  if (!raw) {
    return null;
  }
  const parts = raw.split(":").filter(Boolean);
  if (parts.length < 3) {
    return null;
  }
  if (parts[0] !== "agent") {
    return null;
  }
  const agentId = normalizeOptionalString(parts[1]);
  const rest = parts.slice(2).join(":");
  if (!agentId || !rest) {
    return null;
  }
  return { agentId, rest };
}

export function isCronRunSessionKey(sessionKey: string | undefined | null): boolean {
  const parsed = parseAgentSessionKey(sessionKey);
  if (!parsed) {
    return false;
  }
  return /^cron:[^:]+:run:[^:]+(?::|$)/.test(parsed.rest);
}

export function isCronSessionKey(sessionKey: string | undefined | null): boolean {
  const parsed = parseAgentSessionKey(sessionKey);
  if (!parsed) {
    return false;
  }
  return normalizeOptionalLowercaseString(parsed.rest)?.startsWith("cron:") === true;
}

export function isSubagentSessionKey(sessionKey: string | undefined | null): boolean {
  const raw = normalizeOptionalString(sessionKey);
  if (!raw) {
    return false;
  }
  if (normalizeOptionalLowercaseString(raw)?.startsWith("subagent:")) {
    return true;
  }
  const parsed = parseAgentSessionKey(raw);
  return normalizeOptionalLowercaseString(parsed?.rest)?.startsWith("subagent:") === true;
}

export function getSubagentDepth(sessionKey: string | undefined | null): number {
  const raw = normalizeOptionalLowercaseString(sessionKey);
  if (!raw) {
    return 0;
  }
  return raw.split(":subagent:").length - 1;
}

export function isAcpSessionKey(sessionKey: string | undefined | null): boolean {
  const raw = normalizeOptionalString(sessionKey);
  if (!raw) {
    return false;
  }
  const normalized = normalizeLowercaseStringOrEmpty(raw);
  if (normalized.startsWith("acp:")) {
    return true;
  }
  const parsed = parseAgentSessionKey(raw);
  return normalizeOptionalLowercaseString(parsed?.rest)?.startsWith("acp:") === true;
}

export function parseThreadSessionSuffix(
  sessionKey: string | undefined | null,
): ParsedThreadSessionSuffix {
  const raw = normalizeOptionalString(sessionKey);
  if (!raw) {
    return { baseSessionKey: undefined, threadId: undefined };
  }

  const lowerRaw = normalizeLowercaseStringOrEmpty(raw);
  const threadMarker = ":thread:";
  const threadIndex = lowerRaw.lastIndexOf(threadMarker);
  const markerIndex = threadIndex;
  const marker = threadMarker;

  const baseSessionKey = markerIndex === -1 ? raw : raw.slice(0, markerIndex);
  const threadIdRaw = markerIndex === -1 ? undefined : raw.slice(markerIndex + marker.length);
  const threadId = normalizeOptionalString(threadIdRaw);

  return { baseSessionKey, threadId };
}

export function parseRawSessionConversationRef(
  sessionKey: string | undefined | null,
): RawSessionConversationRef | null {
  const raw = normalizeOptionalString(sessionKey);
  if (!raw) {
    return null;
  }

  const rawParts = raw.split(":").filter(Boolean);
  const bodyStartIndex =
    rawParts.length >= 3 && normalizeOptionalLowercaseString(rawParts[0]) === "agent" ? 2 : 0;
  const parts = rawParts.slice(bodyStartIndex);
  if (parts.length < 3) {
    return null;
  }

  const channel = normalizeOptionalLowercaseString(parts[0]);
  const kind = normalizeOptionalLowercaseString(parts[1]);
  if (!channel || (kind !== "group" && kind !== "channel")) {
    return null;
  }

  const rawId = normalizeOptionalString(parts.slice(2).join(":"));
  const prefix = normalizeOptionalString(rawParts.slice(0, bodyStartIndex + 2).join(":"));
  if (!rawId || !prefix) {
    return null;
  }

  return { channel, kind, rawId, prefix };
}

export function resolveThreadParentSessionKey(
  sessionKey: string | undefined | null,
): string | null {
  const { baseSessionKey, threadId } = parseThreadSessionSuffix(sessionKey);
  if (!threadId) {
    return null;
  }
  const parent = normalizeOptionalString(baseSessionKey);
  if (!parent) {
    return null;
  }
  return parent;
}

export const DIRECT_SESSION_MARKERS: ReadonlySet<string> = new Set(["direct", "dm"]);
const THREAD_SESSION_MARKERS: ReadonlySet<string> = new Set(["thread", "topic"]);
// Tokens that may appear after a channel name but must never be accepted as an
// accountId in the `<channel>:<accountId>:<direct|dm>:<peerId>` shape — they
// would silently let group/channel/thread keys masquerade as direct keys.
const RESERVED_SESSION_KEY_TOKENS: ReadonlySet<string> = new Set([
  "channel",
  "group",
  "thread",
  "topic",
  "direct",
  "dm",
]);

function hasStrictDirectSessionTail(parts: string[], markerIndex: number): boolean {
  const peerId = normalizeOptionalString(parts[markerIndex + 1]);
  if (!peerId) {
    return false;
  }
  const tail = parts.slice(markerIndex + 2);
  if (tail.length === 0) {
    return true;
  }
  return (
    tail.length === 2 &&
    THREAD_SESSION_MARKERS.has(tail[0] ?? "") &&
    Boolean(normalizeOptionalString(tail[1]))
  );
}

export function isDirectSessionKey(sessionKey: string | undefined | null): boolean {
  const raw = normalizeLowercaseStringOrEmpty(sessionKey);
  if (!raw) {
    return false;
  }
  const scoped = parseAgentSessionKey(raw)?.rest ?? raw;
  const parts = scoped.split(":").filter(Boolean);
  if (parts.length < 2) {
    return false;
  }
  if (DIRECT_SESSION_MARKERS.has(parts[0] ?? "")) {
    return hasStrictDirectSessionTail(parts, 0);
  }
  const channel = normalizeMessageChannel(parts[0]);
  if (!channel || !isDeliverableMessageChannel(channel)) {
    return false;
  }
  if (DIRECT_SESSION_MARKERS.has(parts[1] ?? "")) {
    return hasStrictDirectSessionTail(parts, 1);
  }
  return Boolean(normalizeOptionalString(parts[1])) &&
    !RESERVED_SESSION_KEY_TOKENS.has(parts[1] ?? "") &&
    DIRECT_SESSION_MARKERS.has(parts[2] ?? "")
    ? hasStrictDirectSessionTail(parts, 2)
    : false;
}

/**
 * Derive a routable destination from a channel-scoped direct session key when
 * the persisted delivery context is missing `to`. Returns the channel and the
 * peer-id encoded inside the session key.
 *
 * Accepts keys of the shape:
 *   agent:<agentId>:<channel>:direct:<peerId>[:thread:<id>]
 *   agent:<agentId>:<channel>:<accountId>:direct:<peerId>[:thread:<id>]
 * (and the `dm`/`topic` synonyms).
 *
 * `accountId` and `threadId` are intentionally NOT derived from the key:
 *  - accountId is not encoded in the canonical key shape; deriving it would
 *    risk cross-account collisions when two accounts share a peer-id.
 *  - threadId would risk replying in the wrong thread for channels that
 *    encode thread IDs separately (Slack `thread_ts`, Telegram
 *    `message_thread_id`).
 *
 * Returns `undefined` when the channel is non-deliverable (webchat/internal),
 * when the marker is not `direct`/`dm`, when the peer-id is empty, or when
 * the tail beyond the peer-id is anything other than an optional
 * `:thread:<id>` / `:topic:<id>` pair.
 */
export function tryDeriveDirectRouteFromSessionKey(
  sessionKey: string | undefined | null,
): { channel: string; to: string } | undefined {
  const raw = normalizeLowercaseStringOrEmpty(sessionKey);
  if (!raw) {
    return undefined;
  }
  const scoped = parseAgentSessionKey(raw)?.rest ?? raw;
  const parts = scoped.split(":").filter(Boolean);
  if (parts.length < 3) {
    return undefined;
  }
  const channel = normalizeMessageChannel(parts[0]);
  if (!channel || channel === INTERNAL_MESSAGE_CHANNEL || !isDeliverableMessageChannel(channel)) {
    return undefined;
  }
  let markerIndex: number | undefined;
  if (DIRECT_SESSION_MARKERS.has(parts[1] ?? "")) {
    markerIndex = 1;
  } else if (
    parts[2] != null &&
    DIRECT_SESSION_MARKERS.has(parts[2] ?? "") &&
    Boolean(normalizeOptionalString(parts[1])) &&
    !RESERVED_SESSION_KEY_TOKENS.has(parts[1] ?? "")
  ) {
    markerIndex = 2;
  } else {
    return undefined;
  }
  if (!hasStrictDirectSessionTail(parts, markerIndex)) {
    return undefined;
  }
  const peerId = normalizeOptionalString(parts[markerIndex + 1]);
  if (!peerId) {
    return undefined;
  }
  return { channel, to: peerId };
}

import {
  channelRouteCompactKey,
  channelRouteThreadId,
  channelRouteTarget,
  normalizeChannelRouteTarget,
} from "../plugin-sdk/channel-route.js";
import { tryDeriveDirectRouteFromSessionKey } from "../sessions/session-key-utils.js";
import { normalizeAccountId } from "./account-id.js";
import type { DeliveryContext, DeliveryContextSessionSource } from "./delivery-context.types.js";
import { normalizeMessageChannel } from "./message-channel-core.js";
export type { DeliveryContext, DeliveryContextSessionSource } from "./delivery-context.types.js";

export function normalizeDeliveryContext(context?: DeliveryContext): DeliveryContext | undefined {
  if (!context) {
    return undefined;
  }
  const route = normalizeChannelRouteTarget({
    channel:
      typeof context.channel === "string"
        ? (normalizeMessageChannel(context.channel) ?? context.channel.trim())
        : undefined,
    to: context.to,
    accountId: context.accountId,
    threadId: context.threadId,
  });
  if (!route) {
    return undefined;
  }
  const normalized: DeliveryContext = {
    channel: route.channel,
    to: channelRouteTarget(route),
    accountId: normalizeAccountId(route.accountId),
  };
  const threadId = channelRouteThreadId(route);
  if (threadId != null) {
    normalized.threadId = threadId;
  }
  return normalized;
}

export function normalizeSessionDeliveryFields(source?: DeliveryContextSessionSource): {
  deliveryContext?: DeliveryContext;
  lastChannel?: string;
  lastTo?: string;
  lastAccountId?: string;
  lastThreadId?: string | number;
} {
  if (!source) {
    return {
      deliveryContext: undefined,
      lastChannel: undefined,
      lastTo: undefined,
      lastAccountId: undefined,
      lastThreadId: undefined,
    };
  }

  const merged = mergeDeliveryContext(
    normalizeDeliveryContext({
      channel: source.lastChannel ?? source.channel,
      to: source.lastTo,
      accountId: source.lastAccountId,
      threadId: source.lastThreadId,
    }),
    normalizeDeliveryContext(source.deliveryContext),
  );

  if (!merged) {
    return {
      deliveryContext: undefined,
      lastChannel: undefined,
      lastTo: undefined,
      lastAccountId: undefined,
      lastThreadId: undefined,
    };
  }

  return {
    deliveryContext: merged,
    lastChannel: merged.channel,
    lastTo: merged.to,
    lastAccountId: merged.accountId,
    lastThreadId: merged.threadId,
  };
}

export function deliveryContextFromSession(
  entry?: DeliveryContextSessionSource,
): DeliveryContext | undefined {
  if (!entry) {
    return undefined;
  }
  const source: DeliveryContextSessionSource = {
    channel: entry.channel ?? entry.origin?.provider,
    lastChannel: entry.lastChannel,
    lastTo: entry.lastTo,
    lastAccountId: entry.lastAccountId ?? entry.origin?.accountId,
    lastThreadId: entry.lastThreadId ?? entry.deliveryContext?.threadId ?? entry.origin?.threadId,
    origin: entry.origin,
    deliveryContext: entry.deliveryContext,
  };
  return normalizeSessionDeliveryFields(source).deliveryContext;
}

/**
 * Same as `deliveryContextFromSession`, but when the resulting context is
 * missing `to` and the session key encodes a direct external peer-id (e.g.
 * `agent:main:discord:direct:1490529714870157373`), recover the route from
 * the session key. Channel/account/thread bits stay intact as they would
 * from the standard helper — only `to` is filled in, and only when the
 * derived channel matches the resolved context channel.
 *
 * Use this from call-sites that know the session key (e.g. continuation
 * paths in `chat.ts`, outbound resolution where the entry is paired with
 * its key). Other call-sites keep using `deliveryContextFromSession`.
 */
export function deliveryContextFromSessionWithKey(
  entry: DeliveryContextSessionSource | undefined,
  sessionKey: string | undefined,
): DeliveryContext | undefined {
  const base = deliveryContextFromSession(entry);
  if (!sessionKey) {
    return base;
  }
  if (base?.to) {
    return base;
  }
  const derived = tryDeriveDirectRouteFromSessionKey(sessionKey);
  if (!derived) {
    return base;
  }
  // If we already have a context with a channel that disagrees with the
  // session-key channel, do not cross-route — return the original
  // (under-specified) context untouched.
  if (base?.channel && base.channel !== derived.channel) {
    return base;
  }
  return normalizeDeliveryContext({
    channel: base?.channel ?? derived.channel,
    to: derived.to,
    accountId: base?.accountId,
    threadId: base?.threadId,
  });
}

export function mergeDeliveryContext(
  primary?: DeliveryContext,
  fallback?: DeliveryContext,
): DeliveryContext | undefined {
  const normalizedPrimary = normalizeDeliveryContext(primary);
  const normalizedFallback = normalizeDeliveryContext(fallback);
  if (!normalizedPrimary && !normalizedFallback) {
    return undefined;
  }
  const channelsConflict =
    normalizedPrimary?.channel &&
    normalizedFallback?.channel &&
    normalizedPrimary.channel !== normalizedFallback.channel;
  return normalizeDeliveryContext({
    channel: normalizedPrimary?.channel ?? normalizedFallback?.channel,
    // Keep route fields paired to their channel; avoid crossing fields between
    // unrelated channels during session context merges.
    to: channelsConflict
      ? normalizedPrimary?.to
      : (normalizedPrimary?.to ?? normalizedFallback?.to),
    accountId: channelsConflict
      ? normalizedPrimary?.accountId
      : (normalizedPrimary?.accountId ?? normalizedFallback?.accountId),
    threadId: channelsConflict
      ? normalizedPrimary?.threadId
      : (normalizedPrimary?.threadId ?? normalizedFallback?.threadId),
  });
}

export function deliveryContextKey(context?: DeliveryContext): string | undefined {
  return channelRouteCompactKey(normalizeDeliveryContext(context));
}

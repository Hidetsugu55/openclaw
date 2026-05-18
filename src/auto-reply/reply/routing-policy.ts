import { tryDeriveDirectRouteFromSessionKey } from "../../sessions/session-key-utils.js";
import { INTERNAL_MESSAGE_CHANNEL, normalizeMessageChannel } from "../../utils/message-channel.js";

export function resolveReplyRoutingDecision(params: {
  provider?: string;
  surface?: string;
  explicitDeliverRoute?: boolean;
  originatingChannel?: string;
  originatingTo?: string;
  /**
   * Optional agent-scoped session key. When the resolved `originatingTo` is
   * missing but the session key encodes a direct external peer-id (and the
   * derived channel agrees with `originatingChannel`), the routing decision
   * falls back to that peer-id as the reply destination. `accountId` and
   * `threadId` are never derived from the session key — see
   * `tryDeriveDirectRouteFromSessionKey` for the exact rules.
   */
  sessionKey?: string;
  suppressDirectUserDelivery?: boolean;
  isRoutableChannel: (channel: string | undefined) => boolean;
}) {
  const originatingChannel = normalizeMessageChannel(params.originatingChannel);
  const providerChannel = normalizeMessageChannel(params.provider);
  const surfaceChannel = normalizeMessageChannel(params.surface);
  const currentSurface = providerChannel ?? surfaceChannel;
  const isInternalWebchatTurn =
    currentSurface === INTERNAL_MESSAGE_CHANNEL &&
    (surfaceChannel === INTERNAL_MESSAGE_CHANNEL || !surfaceChannel) &&
    params.explicitDeliverRoute !== true;

  // Resolve the reply destination, falling back to the session key only when
  // (a) we have no persisted `originatingTo`, and (b) the session key derives
  // a route whose channel agrees with the originating channel. This protects
  // against webchat session keys (which would never derive a deliverable
  // channel) and against cross-channel routing.
  let resolvedOriginatingTo = params.originatingTo;
  if (!resolvedOriginatingTo && params.sessionKey) {
    const derived = tryDeriveDirectRouteFromSessionKey(params.sessionKey);
    if (derived && (!originatingChannel || derived.channel === originatingChannel)) {
      resolvedOriginatingTo = derived.to;
    }
  }

  const shouldRouteToOriginating = Boolean(
    !params.suppressDirectUserDelivery &&
    !isInternalWebchatTurn &&
    params.isRoutableChannel(originatingChannel) &&
    resolvedOriginatingTo &&
    originatingChannel !== currentSurface,
  );
  return {
    originatingChannel,
    originatingTo: resolvedOriginatingTo,
    currentSurface,
    isInternalWebchatTurn,
    shouldRouteToOriginating,
    shouldSuppressTyping:
      params.suppressDirectUserDelivery === true ||
      shouldRouteToOriginating ||
      originatingChannel === INTERNAL_MESSAGE_CHANNEL,
  };
}

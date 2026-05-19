import type { ChannelRouteTargetInput } from "../plugin-sdk/channel-route.js";

export type DeliveryIntentRef = {
  id: string;
  kind: "outbound_queue";
  queuePolicy?: "required" | "best_effort";
};

export type DeliveryContext = Pick<
  ChannelRouteTargetInput,
  "accountId" | "channel" | "threadId" | "to"
> & {
  channel?: string;
  to?: string;
  accountId?: string;
  threadId?: string | number;
  deliveryIntent?: DeliveryIntentRef;
};

export type DeliveryContextSessionSource = {
  channel?: string;
  lastChannel?: string;
  lastTo?: string;
  lastAccountId?: string;
  lastThreadId?: string | number;
  origin?: {
    provider?: string;
    accountId?: string;
    threadId?: string | number;
  };
  deliveryContext?: DeliveryContext;
  /**
   * Optional agent-scoped session key. When provided, downstream helpers
   * (e.g. `deliveryContextFromSessionWithKey`) may derive a routable
   * destination from the key itself for direct external sessions whose
   * stored `deliveryContext` is missing `to`. The session key never
   * supplies `accountId` or `threadId` — see
   * `tryDeriveDirectRouteFromSessionKey` for the exact rules.
   */
  sessionKey?: string;
};

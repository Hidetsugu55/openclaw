import { describe, expect, it } from "vitest";
import { resolveReplyRoutingDecision } from "./routing-policy.js";

function isRoutableChannel(channel: string | undefined) {
  return Boolean(
    channel &&
    ["telegram", "slack", "discord", "signal", "imessage", "whatsapp", "feishu"].includes(channel),
  );
}

describe("resolveReplyRoutingDecision", () => {
  it("routes replies to the originating channel when the current provider differs", () => {
    expect(
      resolveReplyRoutingDecision({
        provider: "slack",
        surface: "slack",
        originatingChannel: "telegram",
        originatingTo: "telegram:123",
        isRoutableChannel,
      }),
    ).toEqual({
      originatingChannel: "telegram",
      originatingTo: "telegram:123",
      currentSurface: "slack",
      isInternalWebchatTurn: false,
      shouldRouteToOriginating: true,
      shouldSuppressTyping: true,
    });
  });

  it("does not route external replies from internal webchat without explicit delivery", () => {
    expect(
      resolveReplyRoutingDecision({
        provider: "webchat",
        surface: "webchat",
        explicitDeliverRoute: false,
        originatingChannel: "telegram",
        originatingTo: "telegram:123",
        isRoutableChannel,
      }),
    ).toEqual({
      originatingChannel: "telegram",
      originatingTo: "telegram:123",
      currentSurface: "webchat",
      isInternalWebchatTurn: true,
      shouldRouteToOriginating: false,
      shouldSuppressTyping: false,
    });
  });

  it("suppresses direct user delivery for parent-owned background ACP children", () => {
    expect(
      resolveReplyRoutingDecision({
        provider: "discord",
        surface: "discord",
        originatingChannel: "telegram",
        originatingTo: "telegram:123",
        suppressDirectUserDelivery: true,
        isRoutableChannel,
      }),
    ).toEqual({
      originatingChannel: "telegram",
      originatingTo: "telegram:123",
      currentSurface: "discord",
      isInternalWebchatTurn: false,
      shouldRouteToOriginating: false,
      shouldSuppressTyping: true,
    });
  });

  it("recovers originatingTo from a discord direct session key when none was supplied", () => {
    const decision = resolveReplyRoutingDecision({
      provider: "webchat",
      surface: "webchat",
      explicitDeliverRoute: true,
      originatingChannel: "discord",
      // originatingTo intentionally omitted — the persisted entry lost it.
      sessionKey: "agent:main:discord:direct:1490529714870157373",
      isRoutableChannel,
    });
    expect(decision.originatingChannel).toBe("discord");
    expect(decision.originatingTo).toBe("1490529714870157373");
    expect(decision.shouldRouteToOriginating).toBe(true);
  });

  it("does not derive originatingTo from webchat-scoped session keys", () => {
    const decision = resolveReplyRoutingDecision({
      provider: "webchat",
      surface: "webchat",
      explicitDeliverRoute: true,
      originatingChannel: "webchat",
      sessionKey: "agent:main:webchat:direct:user-1",
      isRoutableChannel,
    });
    expect(decision.originatingTo).toBeUndefined();
    expect(decision.shouldRouteToOriginating).toBe(false);
  });

  it("does not adopt a derived `to` when the derived channel disagrees with the originating channel", () => {
    const decision = resolveReplyRoutingDecision({
      provider: "webchat",
      surface: "webchat",
      explicitDeliverRoute: true,
      originatingChannel: "telegram",
      sessionKey: "agent:main:discord:direct:1490529714870157373",
      isRoutableChannel,
    });
    // The session key derives a discord peer-id, but the originating channel
    // is telegram — never bleed the peer-id across channels.
    expect(decision.originatingTo).toBeUndefined();
    expect(decision.shouldRouteToOriginating).toBe(false);
  });
});

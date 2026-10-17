import type { AgentRunTimeoutPhase } from "@openclaw/normalization-core/agent-run-terminal-outcome";
import type { AgentRunTerminalReceipt } from "./agent-run-terminal-receipt.js";
import type { AgentRunTerminalReplySnapshot } from "./agent-run-terminal-reply.types.js";

/** Immutable copy of a Gateway terminal receipt returned from `agent.wait`. */
export type AgentWaitTerminalReceipt = Readonly<
  Omit<AgentRunTerminalReceipt, "requested" | "effective" | "successfulToolNames">
> & {
  readonly requested: Readonly<AgentRunTerminalReceipt["requested"]>;
  readonly effective: Readonly<AgentRunTerminalReceipt["effective"]>;
  readonly successfulToolNames: readonly string[];
};

/** Normalized terminal or pending state returned by `agent.wait`. */
export type AgentWaitResult = {
  status: "ok" | "timeout" | "error" | "pending";
  error?: string;
  /** Set locally when the wait RPC fails; terminal run text is never retry evidence. */
  retryableTransportError?: true;
  startedAt?: number;
  endedAt?: number;
  stopReason?: string;
  livenessState?: string;
  yielded?: boolean;
  pendingError?: boolean;
  timeoutPhase?: AgentRunTimeoutPhase;
  providerStarted?: boolean;
  /** Gateway-produced terminal fact, retained only when it belongs to the waited run. */
  terminalReceipt?: AgentWaitTerminalReceipt;
  terminalReply?: AgentRunTerminalReplySnapshot;
  sourceReplyDelivered?: true;
};

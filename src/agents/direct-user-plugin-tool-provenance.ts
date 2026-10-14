/**
 * Gateway-minted provenance for one live, paired direct-user turn.
 *
 * This object is host-only. Plugin factories receive only the two immutable
 * public fields; the lifetime callbacks stay in the command/tool pipeline.
 */
export type DirectUserPluginToolProvenance = Readonly<{
  originTrigger: "direct-user";
  deviceId: string;
  isCurrent: () => boolean;
  assertCurrent: () => void;
}>;

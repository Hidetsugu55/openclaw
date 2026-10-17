import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { DirectUserPluginToolProvenance } from "../../agents/direct-user-plugin-tool-provenance.js";
import {
  getPairedDevice,
  hasEffectivePairedDeviceRole,
  type PairedDevice,
} from "../../infra/device-pairing.js";
import { isIncognitoSessionKey } from "../../routing/session-key.js";
import { hasGatewayAdminScope } from "../operator-scopes.js";
import type { ChatSendExternalAdmissionParams } from "./chat-send-external-authority-contract.js";
import { isDirectGatewayChatUserTurn } from "./cron-creator-authority-admission.js";

type DirectUserProvenanceDependencies = {
  getPairedDevice: (deviceId: string) => Promise<PairedDevice | null>;
};

const defaultDependencies: DirectUserProvenanceDependencies = { getPairedDevice };

/**
 * Resolve paired direct-owner provenance at the authenticated Gateway ingress.
 * Missing or changing route, device, pairing, or request authority fails closed.
 */
export async function resolveChatSendDirectUserPluginToolProvenance(
  params: ChatSendExternalAdmissionParams & { isDirectExternalUser: true },
  dependencies: DirectUserProvenanceDependencies = defaultDependencies,
): Promise<DirectUserPluginToolProvenance | undefined> {
  const client = params.client;
  const deviceId = normalizeOptionalString(client?.connect.device?.id);
  const devicePublicKey = normalizeOptionalString(client?.connect.device?.publicKey);
  const role = normalizeOptionalString(client?.connect.role);
  const isCurrent = () => {
    try {
      return (
        params.isCurrent !== undefined &&
        params.isCurrent() &&
        client != null &&
        client.invalidated !== true &&
        normalizeOptionalString(client.connect.device?.id) === deviceId &&
        normalizeOptionalString(client.connect.device?.publicKey) === devicePublicKey &&
        normalizeOptionalString(client.connect.role) === role &&
        client.internal?.authenticatedOperator === true &&
        hasGatewayAdminScope(client)
      );
    } catch {
      return false;
    }
  };
  if (
    !deviceId ||
    !devicePublicKey ||
    role !== "operator" ||
    client?.internal?.authenticatedOperator !== true ||
    !hasGatewayAdminScope(client) ||
    params.isIncognitoEntry ||
    isIncognitoSessionKey(params.sessionKey) ||
    params.isReconnectResume ||
    !isDirectGatewayChatUserTurn({
      ...params,
      resolvedSessionKey: params.sessionKey,
      isIncognito: params.isIncognitoEntry,
      isDirectExternalUser: true,
    }) ||
    !isCurrent()
  ) {
    return undefined;
  }
  let paired: PairedDevice | null;
  try {
    paired = await dependencies.getPairedDevice(deviceId);
  } catch {
    return undefined;
  }
  if (
    !isCurrent() ||
    !paired ||
    paired.deviceId !== deviceId ||
    paired.publicKey !== devicePublicKey ||
    !hasEffectivePairedDeviceRole(paired, "operator") ||
    normalizeOptionalString(paired.clientId) !== client?.connect.client.id
  ) {
    return undefined;
  }
  const assertCurrent = () => {
    if (!isCurrent()) {
      throw new Error("Direct-user plugin tool provenance is no longer current.");
    }
  };
  return Object.freeze({
    originTrigger: "direct-user" as const,
    deviceId,
    isCurrent,
    assertCurrent,
  });
}

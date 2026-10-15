import net from 'node:net';
import { requireThat } from './contract.js';

// Source policy candidates; these do not mutate live configuration or claim
// effective sandbox/network enforcement. Production bind needs route evidence.
export const ROLE_CANDIDATES = Object.freeze({
  main: { hostExec: false, genericMessage: false, peerTranscript: false, mutation: ['ready.consume', 'comment.append', 'task.status', 'notify.owner'], read: ['repo.read', 'file.read', 'issue.read', 'pr.read', 'diff.read', 'checks.read'], merge: false },
  researcher: { hostExec: false, codeWrite: false, localOnlyPII: true },
  'dev-host': { sandboxRequired: true, independentRoot: true, taskOnlyRW: true, hostGateway: false },
  reviewer: { sourceWrite: false, peerTranscript: false },
  auditor: { fresh: true, sourceWrite: false, noPersistence: true, tools: ['Read', 'Glob', 'Grep'] },
  ops: { hostExec: false, genericInterpreter: false, actionsRequireNativeActivation: true, codingRootForRepair: false },
});
export function publicAddressAllowed(address, localInference = []) {
  // Only a controller-approved literal local inference address is an exception.
  if (localInference.includes(address)) return true;
  const kind = net.isIP(address); if (!kind) return false;
  if (kind === 4) {
    const [a, b] = address.split('.').map(Number);
    return !(a === 0 || a === 10 || a === 127 || a >= 224 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 198 && (b === 18 || b === 19)));
  }
  const host = new URL(`http://[${address}]/`).hostname.slice(1, -1).toLowerCase();
  // Conservative IPv6: global unicast 2000::/3 only. Reject transition/mapped
  // mechanisms that can tunnel to a private IPv4 destination, plus documentation.
  return /^[23][0-9a-f]{0,3}:/.test(host) && !/^(?:2001:(?:[01]?[0-9a-f]{1,2}:|db8:)|2002:|3fff:)/.test(host);
}
export function builderBoundary(proof, { piiSensitive, safeView }) {
  requireThat(typeof piiSensitive === 'boolean', 'PII classification UNKNOWN');
  requireThat(proof.noStateReach === true && proof.noConfigReach === true && proof.noDeviceReach === true && proof.noProcessCredentialReach === true && proof.noBootstrapMaterialReach === true && proof.noGatewayReach === true && proof.noRuntimeWrite === true && proof.publicEgressOnly === true, 'I-0 / egress UNKNOWN');
  requireThat(!piiSensitive || proof.localOnly === true || safeView?.approvedBoundary === true, 'raw PII cloud route forbidden');
  return true;
}

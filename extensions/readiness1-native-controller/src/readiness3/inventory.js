import { digest } from '../contract.js';

const STATES = new Set(['YES', 'NO', 'UNKNOWN']);
const MODES = new Set(['AUTONOMOUS', 'OWNER_ATTENDED_EXCEPTION', 'HUMAN_ONLY', 'READ_ONLY']);
const DANGEROUS = ['admin', 'bypass', 'mergeOutsideController', 'ownerCredentialReachable', 'credentialMaterialReachable', 'untrustedRunnerCoResident'];
const KNOWN_EVENTS = new Set([
  'APP_INSTALLED', 'APP_PERMISSION_CHANGED', 'REPO_SELECTION_EXPANDED',
  'CREDENTIAL_CHANGED', 'ATTENDED_TO_UNATTENDED', 'OWNER_BROWSER_APPROVED',
  'CONTROLLER_CHANGED', 'SCHEDULER_REGISTERED', 'RUNNER_REGISTERED',
]);
const SHA64 = /^[a-f0-9]{64}$/;

function add(routeReasons, route, reason) {
  if (!routeReasons.has(route)) routeReasons.set(route, []);
  routeReasons.get(route).push(reason);
}

function completeState(principal, routeReasons, route) {
  for (const field of [...DANGEROUS, 'unattendedSurface']) {
    if (!STATES.has(principal[field]) || principal[field] === 'UNKNOWN') add(routeReasons, route, `${field}_unknown`);
  }
}

export function evaluatePrincipalInventory({ requiredRoutes, principals, now = Date.now(), maxAgeMs }) {
  const routeReasons = new Map();
  const lanes = {};
  if (!Array.isArray(requiredRoutes) || requiredRoutes.length === 0 || !Array.isArray(principals)
      || principals.length === 0 || !Number.isSafeInteger(now) || !Number.isSafeInteger(maxAgeMs) || maxAgeMs <= 0) {
    return Object.freeze({ decision: 'UNKNOWN_UNSAFE', reasons: ['inventory_invalid'], lanes });
  }
  const required = new Set(requiredRoutes);
  if (required.size !== requiredRoutes.length || [...required].some(route => typeof route !== 'string' || !route)) {
    return Object.freeze({ decision: 'UNKNOWN_UNSAFE', reasons: ['required_routes_invalid'], lanes });
  }

  const grouped = new Map();
  const verificationTimes = [];
  for (const principal of principals) {
    const route = typeof principal?.route === 'string' && principal.route ? principal.route : 'unknown-route';
    if (grouped.has(route)) { add(routeReasons, route, 'duplicate_route'); continue; }
    grouped.set(route, principal);
    lanes[route] = 'UNKNOWN_UNSAFE';
    if (!MODES.has(principal?.mode)) add(routeReasons, route, 'mode_unknown');
    if (principal?.observedBy !== 'trusted-controller' || !SHA64.test(principal?.evidenceDigest ?? '')) add(routeReasons, route, 'observation_evidence_unknown');
    if (typeof principal?.hostPrincipal !== 'string' || !principal.hostPrincipal || principal.hostPrincipal !== principal.hostPrincipal.trim().toLowerCase()) add(routeReasons, route, 'host_principal_invalid');
    const verifiedAt = Date.parse(principal?.lastVerified ?? '');
    if (Number.isFinite(verifiedAt)) verificationTimes.push(verifiedAt);
    if (!Number.isFinite(verifiedAt) || verifiedAt > now || now - verifiedAt > maxAgeMs) add(routeReasons, route, 'verification_stale_or_unknown');
    completeState(principal ?? {}, routeReasons, route);

    if (principal?.mode === 'AUTONOMOUS') {
      for (const field of DANGEROUS) if (principal[field] !== 'NO') add(routeReasons, route, `${field}_not_denied`);
      if (principal.unattendedSurface !== 'YES' || principal.credentialIsolationVerified !== true) add(routeReasons, route, 'autonomous_boundary_unverified');
    } else if (principal?.mode === 'OWNER_ATTENDED_EXCEPTION') {
      if (principal.origin !== 'owner-foreground' || principal.lifecycle !== 'FOREGROUND_BOUND'
          || principal.ownerPresent !== true || principal.unattendedSurface !== 'NO') add(routeReasons, route, 'attended_lifecycle_not_bound');
    } else if (principal?.mode === 'HUMAN_ONLY') {
      if (principal.unattendedSurface !== 'NO') add(routeReasons, route, 'human_only_has_unattended_surface');
    } else if (principal?.mode === 'READ_ONLY') {
      for (const field of DANGEROUS) if (principal[field] !== 'NO') add(routeReasons, route, `${field}_contradicts_read_only`);
      if (principal.unattendedSurface !== 'NO') add(routeReasons, route, 'read_only_has_unattended_surface');
    }
  }

  for (const route of required) if (!grouped.has(route)) add(routeReasons, route, 'required_route_missing');
  for (const autonomous of principals.filter(principal => principal?.mode === 'AUTONOMOUS')) {
    for (const other of principals) {
      if (other !== autonomous && other?.hostPrincipal === autonomous.hostPrincipal && other?.ownerCredentialReachable !== 'NO') add(routeReasons, autonomous.route, 'owner_principal_co_residency');
    }
  }

  for (const [route, principal] of grouped.entries()) {
    if ((routeReasons.get(route) ?? []).length > 0) lanes[route] = 'UNKNOWN_UNSAFE';
    else if (principal.mode === 'AUTONOMOUS') lanes[route] = 'NORMAL_VERIFIED';
    else lanes[route] = principal.mode;
  }
  const reasons = [...routeReasons.entries()].flatMap(([route, values]) => values.map(reason => `${route}:${reason}`));
  if (reasons.length > 0) return Object.freeze({ decision: 'UNKNOWN_UNSAFE', reasons: [...new Set(reasons)], lanes });
  const revision = digest({ requiredRoutes, principals, observedAt: now, maxAgeMs });
  return Object.freeze({ decision: 'INVENTORY_COMPLETE', reasons: [], lanes, revision, observedAt: now, expiresAt: Math.min(...verificationTimes) + maxAgeMs });
}

export function routeInventoryProof(inventory, route) {
  if (inventory?.decision !== 'INVENTORY_COMPLETE' || inventory?.lanes?.[route] !== 'NORMAL_VERIFIED') {
    return Object.freeze({ decision: 'UNKNOWN_UNSAFE', route, lanes: inventory?.lanes ?? {}, revision: inventory?.revision, expiresAt: inventory?.expiresAt });
  }
  return Object.freeze({ decision: 'NORMAL_VERIFIED', route, lanes: inventory.lanes, revision: inventory.revision, expiresAt: inventory.expiresAt });
}

export function invalidateInventoryProof(proof, events) {
  if (!Array.isArray(events) || events.length === 0 || events.some(event => !KNOWN_EVENTS.has(event))) {
    return Object.freeze({ decision: 'UNKNOWN_UNSAFE', previousRevision: proof?.revision, reasons: ['proof_invalidated:EVENTS_UNKNOWN'] });
  }
  return Object.freeze({ decision: 'UNKNOWN_UNSAFE', previousRevision: proof?.revision, reasons: [...new Set(events.map(event => `proof_invalidated:${event}`))] });
}

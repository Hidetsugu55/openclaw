import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluatePrincipalInventory, invalidateInventoryProof, routeInventoryProof } from '../src/readiness3/inventory.js';

const now = Date.parse('2026-10-10T15:00:00Z');
const maxAgeMs = 60 * 60 * 1000;
const safe = (patch = {}) => ({
  route: 'openclaw-controller', mode: 'AUTONOMOUS', origin: 'openclaw',
  hostPrincipal: 'studio:controller-user', lastVerified: '2026-10-10T14:40:00Z',
  observedBy: 'trusted-controller', evidenceDigest: 'b'.repeat(64),
  admin: 'NO', bypass: 'NO', mergeOutsideController: 'NO', ownerCredentialReachable: 'NO',
  credentialMaterialReachable: 'NO', untrustedRunnerCoResident: 'NO', unattendedSurface: 'YES',
  credentialIsolationVerified: true, ...patch,
});
const evaluate = (requiredRoutes, principals, patch = {}) => evaluatePrincipalInventory({ requiredRoutes, principals, now, maxAgeMs, ...patch });

test('G01 G10 G15 G27 G30 autonomous lane requires complete fresh negative coverage', () => {
  const result = evaluate(['openclaw-controller', 'snapshot-publisher'], [
    safe(), safe({ route: 'snapshot-publisher', hostPrincipal: 'studio:publisher-user', origin: 'schedule' }),
  ]);
  assert.equal(result.decision, 'INVENTORY_COMPLETE');
  assert.match(result.revision, /^[a-f0-9]{64}$/);
  assert.equal(result.expiresAt, Date.parse('2026-10-10T14:40:00Z') + maxAgeMs);
  assert.equal(routeInventoryProof(result, 'openclaw-controller').decision, 'NORMAL_VERIFIED');
  for (const patch of [
    { admin: 'YES' }, { bypass: 'UNKNOWN' }, { mergeOutsideController: 'YES' },
    { ownerCredentialReachable: 'YES' }, { credentialMaterialReachable: 'UNKNOWN' },
    { untrustedRunnerCoResident: 'YES' }, { hostPrincipal: undefined },
    { lastVerified: '2020-01-01T00:00:00Z' },
  ]) {
    const unsafe = evaluate(['route'], [safe({ route: 'route', ...patch })]);
    assert.equal(unsafe.decision, 'UNKNOWN_UNSAFE');
    assert.equal(unsafe.lanes.route, 'UNKNOWN_UNSAFE');
  }
  assert.equal(evaluatePrincipalInventory({ requiredRoutes: [], principals: [], now, maxAgeMs }).decision, 'UNKNOWN_UNSAFE');
});

test('G28 G29 attended mode is lifecycle-bound and never projected as Normal', () => {
  const attended = safe({
    route: 'attended', mode: 'OWNER_ATTENDED_EXCEPTION', origin: 'owner-foreground',
    hostPrincipal: 'macbook:owner', ownerCredentialReachable: 'YES', credentialMaterialReachable: 'YES',
    admin: 'YES', mergeOutsideController: 'YES', unattendedSurface: 'NO', credentialIsolationVerified: false,
    lifecycle: 'FOREGROUND_BOUND', ownerPresent: true,
  });
  const result = evaluate(['attended'], [attended]);
  assert.equal(result.decision, 'INVENTORY_COMPLETE');
  assert.equal(result.lanes.attended, 'OWNER_ATTENDED_EXCEPTION');
  assert.equal(routeInventoryProof(result, 'attended').decision, 'UNKNOWN_UNSAFE');
  for (const patch of [{ origin: 'schedule' }, { lifecycle: 'DETACHED' }, { ownerPresent: false }, { unattendedSurface: 'YES' }, { ownerCredentialReachable: 'UNKNOWN' }]) {
    assert.equal(evaluate(['attended'], [{ ...attended, ...patch }]).decision, 'UNKNOWN_UNSAFE');
  }
  const fakeReadOnly = safe({ route: 'read', mode: 'READ_ONLY', unattendedSurface: 'NO', admin: 'YES' });
  assert.equal(evaluate(['read'], [fakeReadOnly]).decision, 'UNKNOWN_UNSAFE');
});

test('G15 autonomous process cannot share any not-denied Owner credential principal', () => {
  const result = evaluate(['autonomous', 'attended'], [
    safe({ route: 'autonomous', hostPrincipal: 'macbook:owner' }),
    safe({ route: 'attended', mode: 'OWNER_ATTENDED_EXCEPTION', origin: 'owner-foreground', hostPrincipal: 'macbook:owner',
      ownerCredentialReachable: 'YES', credentialMaterialReachable: 'YES', admin: 'YES', mergeOutsideController: 'YES',
      unattendedSurface: 'NO', lifecycle: 'FOREGROUND_BOUND', ownerPresent: true }),
  ]);
  assert.equal(result.decision, 'UNKNOWN_UNSAFE');
  assert.ok(result.reasons.includes('autonomous:owner_principal_co_residency'));
});

test('G24 G31 every observed or unknown drift event invalidates the old proof', () => {
  const proof = { decision: 'NORMAL_VERIFIED', revision: 'a'.repeat(64) };
  for (const event of ['APP_INSTALLED', 'OWNER_BROWSER_APPROVED', 'CONTROLLER_CHANGED', 'RUNNER_REGISTERED']) {
    assert.equal(invalidateInventoryProof(proof, [event]).decision, 'UNKNOWN_UNSAFE');
  }
  assert.equal(invalidateInventoryProof(proof, []).decision, 'UNKNOWN_UNSAFE');
  assert.equal(invalidateInventoryProof(proof, ['NEW_UNKNOWN_EVENT']).decision, 'UNKNOWN_UNSAFE');
});

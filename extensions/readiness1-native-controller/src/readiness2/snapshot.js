import { digest, equal, requireThat } from '../contract.js';

export const SNAPSHOT_RESULTS = Object.freeze([
  'UPDATED',
  'UNCHANGED',
  'BUSY',
  'BLOCKED',
  'FAILED',
]);
export const SNAPSHOT_CLOSURE = Object.freeze([
  'scripts/update-consultation-snapshot.sh',
  'scripts/consultation_snapshot_checkout.py',
  'scripts/consultation_snapshot_deadline.py',
  'scripts/generate-consultation-snapshot.py',
  'scripts/consultation_snapshot_v3.py',
  'scripts/consultation_snapshot_safety.py',
  'tests/test_consultation_snapshot.py',
  'tests/test_consultation_snapshot_generator.py',
]);

// Deployment-owned fixed launcher. The fixture caller supplies captured
// immutable contents and native observations; no model-selected command, path,
// or base revision enters this surface.
export function createSnapshotRunner({
  scriptId,
  dependencies,
  approvedBase,
  launchFixed,
  readback,
}) {
  requireThat(
    scriptId
      && Array.isArray(dependencies)
      && /^[a-f0-9]{40}$/.test(approvedBase)
      && typeof launchFixed === 'function'
      && typeof readback === 'function',
    'snapshot native binding missing',
  );
  const manifest = [
    { relativePath: SNAPSHOT_CLOSURE[0], ...scriptId },
    ...dependencies,
  ];
  requireThat(
    equal(
      manifest.map((entry) => entry.relativePath).sort(),
      [...SNAPSHOT_CLOSURE].sort(),
    )
      && new Set(manifest.map((entry) => entry.path)).size === manifest.length,
    'snapshot closure incomplete',
  );
  const expectedIds = manifest.map(({ path, sha256 }) => ({ path, sha256 }));

  return async (input) => {
    requireThat(
      input.descriptor.operation === 'snapshot.update'
        && input.descriptor.route === 'snapshot-runner'
        && input.descriptor.snapshotBase === approvedBase,
      'not approved snapshot runner/base',
    );
    requireThat(
      equal(input.descriptor.immutableIds, expectedIds),
      'snapshot dependency manifest drift',
    );
    const closure = manifest.map((identity) => {
      const content = input.immutable.contents.find(
        (entry) => entry.path === identity.path
          && entry.sha256 === identity.sha256,
      );
      requireThat(
        content && digest(content.content) === identity.sha256,
        'snapshot captured dependency drift',
      );
      return { ...content, relativePath: identity.relativePath };
    });
    const before = await readback(input);
    requireThat(
      before?.source === 'native'
        && before.dedicated === true
        && before.snapshotPath === 'docs/consultation/current-runtime-snapshot.md',
      'snapshot checkout UNKNOWN',
    );
    requireThat(
      before.head === approvedBase && before.remoteHead === approvedBase,
      'unapproved snapshot sync base',
    );
    await input.authorizeFirstEffect();
    const native = await launchFixed({
      ...input,
      closure,
      approvedBase,
    });
    const after = await readback(input);
    if (
      !native
      || native.source !== 'native'
      || !Number.isInteger(native.exitCode)
      || !Array.isArray(native.loadedImmutableIds)
      || !equal(native.loadedImmutableIds, expectedIds)
      || !after
      || after.source !== 'native'
      || !equal(before.identity, after.identity)
    ) return { confirmed: false };
    if (
      native.syncBaseObserved !== null
      && native.syncBaseObserved !== approvedBase
    ) return { confirmed: false };

    const output = `${native.stdout ?? ''}\n${native.stderr ?? ''}`;
    let reportedStatus = null;
    try {
      const report = JSON.parse(String(native.stdout ?? '').trim());
      if (
        report
        && typeof report === 'object'
        && !Array.isArray(report)
        && SNAPSHOT_RESULTS.includes(report.status)
        && ['not_attempted', 'pending', 'published', 'unverified'].includes(
          report.publication,
        )
        && typeof report.reason === 'string'
        && /^[a-z][a-z0-9_]{0,79}$/.test(report.reason)
      ) reportedStatus = report.status;
    } catch {}

    const unchanged = before.head === after.head
      && before.snapshotDigest === after.snapshotDigest
      && before.remoteHead === after.remoteHead;
    let result;
    if (
      native.exitCode === 0
      && (
        reportedStatus === 'BUSY'
        || /snapshot update already running/.test(output)
      )
      && unchanged
    ) result = 'BUSY';
    else if (
      native.exitCode === 0
      && (
        reportedStatus === 'UNCHANGED'
        || /snapshot unchanged/.test(output)
      )
      && unchanged
    ) result = 'UNCHANGED';
    else if (
      native.exitCode === 0
      && after.head !== before.head
      && after.remoteHead === after.head
      && after.snapshotDigest !== before.snapshotDigest
      && equal(after.changedPaths, [before.snapshotPath])
    ) result = 'UPDATED';
    else if (
      native.exitCode !== 0
      && (
        (reportedStatus === 'BLOCKED' && after.remoteHead === before.remoteHead)
        || (
          /dedicated-checkout-|invalid-base-head|unexpected-publish-paths|origin-main-changed|unapproved-sync-base/.test(
            output,
          )
          && unchanged
        )
      )
    ) result = 'BLOCKED';
    else if (native.exitCode !== 0) result = 'FAILED';
    else return { confirmed: false };

    if (
      ['UPDATED', 'UNCHANGED'].includes(result)
      && native.syncBaseObserved !== approvedBase
    ) return { confirmed: false };
    return {
      confirmed: true,
      result,
      immutableIds: native.loadedImmutableIds,
      usage: 0,
    };
  };
}

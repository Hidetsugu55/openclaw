import { ACCEPTANCE_ROWS, UPSTREAM_COMMIT, UPSTREAM_VERSION, canonical, digest, requireThat } from './contract.js';

const LIVE_ONLY = 'LIVE_ROUTE_EVIDENCE_REQUIRED';

function measured(assertion, passed, source) {
  const evidence = { schema: 'readiness1.native-measurement.v1', assertion, passed, source };
  return { status: passed ? 'PASS' : 'BLOCKED', evidenceSha256: digest(evidence), blocker: passed ? null : LIVE_ONLY };
}

function fixedProbe(caseId, assertion, { config }) {
  if (caseId === 'A03' && assertion === 'authEnabled') {
    return measured(assertion, Boolean(config.gateway?.auth?.mode && config.gateway.auth.mode !== 'none'), 'effective-config');
  }
  if (caseId === 'A03' && assertion === 'autoApproveLocalDisabled') {
    return measured(assertion, config.gateway?.nodes?.pairing?.autoApproveLocal === false, 'effective-config');
  }
  // Version equality is not evidence of accepted artifact identity, an actual
  // lazy read/load, or a post-load digest. A17 stays blocked until a future
  // public route supplies all three bound observations.
  return measured(assertion, false, 'live-only-unimplemented');
}

export function createAcceptanceExecutor({ publicationStore, runtimeVersion, getConfig, now = Date.now }) {
  requireThat(publicationStore && typeof publicationStore.registerIfAbsent === 'function', 'native acceptance publisher unavailable');
  requireThat(typeof publicationStore.lookup === 'function', 'native acceptance publisher readback unavailable');
  requireThat(typeof publicationStore.withCurrent === 'function', 'action-bound native acceptance publisher unavailable');
  return Object.freeze({
    async execute({ runId, assertCurrent }) {
      requireThat(typeof runId === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{15,127}$/.test(runId), 'invalid acceptance run id');
      const config = getConfig();
      const observedAt = now();
      const cases = {};
      let passed = 0;
      for (const [caseId, assertions] of Object.entries(ACCEPTANCE_ROWS)) {
        const results = Object.fromEntries(assertions.map((assertion) => [assertion, fixedProbe(caseId, assertion, { config, runtimeVersion })]));
        const rowPassed = Object.values(results).every((result) => result.status === 'PASS');
        if (rowPassed) passed += 1;
        cases[caseId] = {
          status: rowPassed ? 'PASS' : 'BLOCKED',
          assertions: results,
          evidenceDigests: Object.values(results).map((result) => result.evidenceSha256),
          blocker: rowPassed ? null : LIVE_ONLY,
          observedAt,
        };
      }
      const blocked = Object.keys(ACCEPTANCE_ROWS).length - passed;
      const bundle = {
        schema: 'readiness1.native-acceptance-bundle.v3',
        fixture: true,
        route: 'fixture-only',
        upstream: { version: UPSTREAM_VERSION, commit: UPSTREAM_COMMIT },
        run: { id: runId, observedAt },
        cases,
      };
      const report = {
        schema: 'readiness1.native-acceptance-report.v3',
        status: 'BLOCKED',
        fixture: true,
        runId,
        passed,
        blocked,
        caseDigests: Object.fromEntries(Object.entries(cases).map(([caseId, row]) => [caseId, digest(row)])),
      };
      const envelope = {
        schema: 'readiness1.native-acceptance-publication.v1',
        bundle,
        report,
        bundleSha256: digest(bundle),
        reportSha256: digest(report),
      };
      envelope.publicationSha256 = digest(envelope);
      assertCurrent();
      const bound = publicationStore.withCurrent({ assertCurrent });
      const created = await bound.registerIfAbsent(runId, envelope);
      if (!created) {
        const existing = await bound.lookup(runId);
        requireThat(existing && canonical(existing) === canonical(envelope), 'acceptance run id already published with different evidence');
      }
      const readback = await bound.lookup(runId);
      requireThat(readback && digest(readback) === digest(envelope), 'acceptance publication readback mismatch');
      return {
        report,
        publication: {
          confirmed: true,
          store: `plugin-state:${'acceptance-runs-v1'}`,
          key: runId,
          bundleSha256: envelope.bundleSha256,
          reportSha256: envelope.reportSha256,
          publicationSha256: envelope.publicationSha256,
        },
      };
    },
  });
}

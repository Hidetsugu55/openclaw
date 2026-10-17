import { readFile } from "node:fs/promises";

import { ACCEPTANCE_ROWS, canonical, digest, requireThat } from "./contract.js";

const LIVE_ONLY = "LIVE_ROUTE_EVIDENCE_REQUIRED";
const TRUSTED_SOURCE_REQUIRED = "TRUSTED_SOURCE_DESCRIPTOR_REQUIRED";
// The setup repository fixes this path and verifies the descriptor against the
// integrated Git commit/tree before this source-only constructor is exercised.
const DESCRIPTOR_URL = new URL("../../../openclaw-2026.10.3.json", import.meta.url);
const FIXTURE_SOURCE = Object.freeze({
  status: "UNKNOWN",
  blocker: TRUSTED_SOURCE_REQUIRED,
});

async function readTrustedSourceIdentity() {
  let descriptor;
  try {
    descriptor = JSON.parse(await readFile(DESCRIPTOR_URL, "utf8"));
  } catch {
    throw new Error("trusted acceptance source descriptor unavailable");
  }
  const integrated = descriptor?.integratedSource;
  requireThat(
    descriptor?.schema === "openclaw.readiness.production-source.v2" &&
      descriptor.extensionSource === "pilot/pilot-1/plugins/readiness1-native-controller" &&
      descriptor.extensionTarget === "extensions/readiness1-native-controller" &&
      descriptor.packageComposition === "CORE_PACKAGE_INCLUDED_EXTENSION" &&
      typeof descriptor.version === "string" &&
      /^\d{4}\.\d{1,2}\.\d{1,2}$/.test(descriptor.version) &&
      typeof descriptor.commit === "string" &&
      /^[a-f0-9]{40}$/.test(descriptor.commit) &&
      integrated &&
      typeof integrated === "object" &&
      !Array.isArray(integrated) &&
      Object.keys(integrated).sort().join(",") ===
        [
          "commit",
          "controllerSourceCommit",
          "controllerSourceTreeSha256",
          "deltaContentSha256",
          "extensionTreeEntries",
          "extensionTreeSha256",
          "parentCommit",
          "tree",
        ]
          .sort()
          .join(",") &&
      integrated.commit === descriptor.commit &&
      /^[a-f0-9]{40}$/.test(integrated.tree) &&
      /^[a-f0-9]{40}$/.test(integrated.parentCommit) &&
      /^[a-f0-9]{40}$/.test(integrated.controllerSourceCommit) &&
      /^[a-f0-9]{64}$/.test(integrated.controllerSourceTreeSha256) &&
      /^[a-f0-9]{64}$/.test(integrated.extensionTreeSha256) &&
      integrated.controllerSourceTreeSha256 === integrated.extensionTreeSha256 &&
      Number.isSafeInteger(integrated.extensionTreeEntries) &&
      integrated.extensionTreeEntries > 0 &&
      /^[a-f0-9]{64}$/.test(integrated.deltaContentSha256),
    "invalid trusted acceptance source descriptor",
  );
  return Object.freeze({ version: descriptor.version, commit: integrated.commit });
}

function measured(assertion, passed, source) {
  const evidence = { schema: "readiness1.native-measurement.v1", assertion, passed, source };
  return {
    status: passed ? "PASS" : "BLOCKED",
    evidenceSha256: digest(evidence),
    blocker: passed ? null : LIVE_ONLY,
  };
}

function fixedProbe(caseId, assertion, { config }) {
  if (caseId === "A03" && assertion === "authEnabled") {
    return measured(
      assertion,
      Boolean(config.gateway?.auth?.mode && config.gateway.auth.mode !== "none"),
      "effective-config",
    );
  }
  if (caseId === "A03" && assertion === "autoApproveLocalDisabled") {
    return measured(
      assertion,
      config.gateway?.nodes?.pairing?.autoApproveLocal === false,
      "effective-config",
    );
  }
  // Version equality is not evidence of accepted artifact identity, an actual
  // lazy read/load, or a post-load digest. A17 stays blocked until a future
  // public route supplies all three bound observations.
  return measured(assertion, false, "live-only-unimplemented");
}

function buildAcceptanceExecutor(options, resolveSourceIdentity) {
  const { publicationStore, getConfig, now = Date.now } = options;
  requireThat(
    publicationStore && typeof publicationStore.registerIfAbsent === "function",
    "native acceptance publisher unavailable",
  );
  requireThat(
    typeof publicationStore.lookup === "function",
    "native acceptance publisher readback unavailable",
  );
  requireThat(
    typeof publicationStore.withCurrent === "function",
    "action-bound native acceptance publisher unavailable",
  );
  return Object.freeze({
    async execute({ runId, assertCurrent }) {
      requireThat(
        typeof runId === "string" && /^[A-Za-z0-9][A-Za-z0-9_.:-]{15,127}$/.test(runId),
        "invalid acceptance run id",
      );
      const source = await resolveSourceIdentity();
      const config = getConfig();
      const observedAt = now();
      const cases = {};
      let passed = 0;
      for (const [caseId, assertions] of Object.entries(ACCEPTANCE_ROWS)) {
        const results = Object.fromEntries(
          assertions.map((assertion) => [assertion, fixedProbe(caseId, assertion, { config })]),
        );
        const rowPassed = Object.values(results).every((result) => result.status === "PASS");
        if (rowPassed) passed += 1;
        cases[caseId] = {
          status: rowPassed ? "PASS" : "BLOCKED",
          assertions: results,
          evidenceDigests: Object.values(results).map((result) => result.evidenceSha256),
          blocker: rowPassed ? null : LIVE_ONLY,
          observedAt,
        };
      }
      const blocked = Object.keys(ACCEPTANCE_ROWS).length - passed;
      const bundle = {
        schema: "readiness1.native-acceptance-bundle.v3",
        fixture: true,
        route: "fixture-only",
        upstream: source,
        run: { id: runId, observedAt },
        cases,
      };
      const report = {
        schema: "readiness1.native-acceptance-report.v3",
        status: "BLOCKED",
        fixture: true,
        runId,
        passed,
        blocked,
        caseDigests: Object.fromEntries(
          Object.entries(cases).map(([caseId, row]) => [caseId, digest(row)]),
        ),
      };
      const envelope = {
        schema: "readiness1.native-acceptance-publication.v1",
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
        requireThat(
          existing && canonical(existing) === canonical(envelope),
          "acceptance run id already published with different evidence",
        );
      }
      const readback = await bound.lookup(runId);
      requireThat(
        readback && digest(readback) === digest(envelope),
        "acceptance publication readback mismatch",
      );
      return {
        report,
        publication: {
          confirmed: true,
          store: `plugin-state:${"acceptance-runs-v1"}`,
          key: runId,
          bundleSha256: envelope.bundleSha256,
          reportSha256: envelope.reportSha256,
          publicationSha256: envelope.publicationSha256,
        },
      };
    },
  });
}

export function createAcceptanceExecutor(options) {
  requireThat(
    options && !Object.hasOwn(options, "sourceIdentity"),
    "caller-supplied acceptance source identity forbidden",
  );
  return buildAcceptanceExecutor(options, readTrustedSourceIdentity);
}

export function createFixtureAcceptanceExecutor(options) {
  requireThat(
    options && !Object.hasOwn(options, "sourceIdentity"),
    "caller-supplied acceptance source identity forbidden",
  );
  return buildAcceptanceExecutor(options, async () => FIXTURE_SOURCE);
}

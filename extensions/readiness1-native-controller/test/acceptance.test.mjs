import assert from "node:assert/strict";
import test from "node:test";
import { createAcceptanceExecutor } from "../src/acceptance.js";
import { ACCEPTANCE_ROWS } from "../src/contract.js";
import { memoryStore } from "./helpers.mjs";

const sourceIdentity = Object.freeze({ version: "2026.10.3", commit: "f".repeat(40) });

test("A01-A19 executor publishes measured BLOCK and never synthetic PASS", async () => {
  const store = memoryStore();
  const executor = createAcceptanceExecutor({
    publicationStore: store,
    sourceIdentity,
    getConfig: () => ({
      gateway: { auth: { mode: "token" }, nodes: { pairing: { autoApproveLocal: false } } },
    }),
    now: () => 100,
  });
  const runId = "20261014T120000Z-native-run";
  const result = await executor.execute({ runId, assertCurrent() {} });
  assert.equal(result.report.status, "BLOCKED");
  assert.equal(result.report.passed, 0);
  assert.equal(result.report.blocked, 19);
  assert.deepEqual(
    Object.keys(result.report.caseDigests).sort(),
    Object.keys(ACCEPTANCE_ROWS).sort(),
  );
  assert.equal(result.publication.confirmed, true);
  const saved = await store.lookup(runId);
  assert.equal(saved.bundle.fixture, true);
  assert.equal(saved.bundle.route, "fixture-only");
  assert.deepEqual(saved.bundle.upstream, sourceIdentity);
  assert.equal(saved.report.status, "BLOCKED");
  assert.equal(saved.bundle.cases.A03.assertions.authEnabled.status, "PASS");
  assert.equal(saved.bundle.cases.A17.assertions.lazyRuntimeReadLoaded.status, "BLOCKED");
  assert.ok(Object.values(saved.bundle.cases).every((row) => row.status === "BLOCKED"));
});

test("acceptance publisher is idempotent only for exact evidence", async () => {
  const store = memoryStore();
  const executor = createAcceptanceExecutor({
    publicationStore: store,
    sourceIdentity,
    getConfig: () => ({}),
    now: () => 100,
  });
  const request = { runId: "20261014T120000Z-idempotent", assertCurrent() {} };
  await executor.execute(request);
  await executor.execute(request);
  const changed = createAcceptanceExecutor({
    publicationStore: store,
    sourceIdentity,
    getConfig: () => ({}),
    now: () => 101,
  });
  await assert.rejects(changed.execute(request), /different evidence/);
});

test("acceptance source identity is explicit and exact", () => {
  const publicationStore = memoryStore();
  const create = (identity) =>
    createAcceptanceExecutor({ publicationStore, sourceIdentity: identity, getConfig: () => ({}) });
  assert.throws(() => create(undefined), /invalid acceptance source identity/);
  assert.throws(
    () => create({ version: "2026.10.3", commit: "f".repeat(39) }),
    /invalid acceptance source identity/,
  );
  assert.throws(
    () => create({ version: "2026.10.3", commit: "f".repeat(40), extra: true }),
    /invalid acceptance source identity/,
  );
});

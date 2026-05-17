import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  CoreHarnessStartupIssues,
  CoreHarnessSummary,
} from "../commands/doctor-core-harness.js";
import type { OutputRuntimeEnv } from "../runtime.js";
import { runCoreHarnessJson } from "./doctor-health.js";

const mocks = vi.hoisted(() => ({
  readConfigFileSnapshot: vi.fn(),
  resolveOpenClawPackageRoot: vi.fn(),
  collectSourceInstallIssues: vi.fn(),
  buildCoreHarnessSummary: vi.fn(),
}));

vi.mock("../config/config.js", () => ({
  readConfigFileSnapshot: mocks.readConfigFileSnapshot,
}));

vi.mock("../infra/openclaw-root.js", () => ({
  resolveOpenClawPackageRoot: mocks.resolveOpenClawPackageRoot,
}));

vi.mock("../commands/doctor-install.js", () => ({
  collectSourceInstallIssues: mocks.collectSourceInstallIssues,
  noteSourceInstallIssues: vi.fn(),
}));

vi.mock("../commands/doctor-core-harness.js", async () => {
  const actual = await vi.importActual<typeof import("../commands/doctor-core-harness.js")>(
    "../commands/doctor-core-harness.js",
  );
  return {
    ...actual,
    buildCoreHarnessSummary: mocks.buildCoreHarnessSummary,
  };
});

function createRuntimeStub(): {
  runtime: OutputRuntimeEnv;
  payloads: unknown[];
  errors: string[];
  exitCodes: number[];
} {
  const payloads: unknown[] = [];
  const errors: string[] = [];
  const exitCodes: number[] = [];
  const runtime: OutputRuntimeEnv = {
    log: vi.fn(),
    error: vi.fn((...args: unknown[]) => {
      errors.push(args.map(String).join(" "));
    }),
    exit: vi.fn((code: number) => {
      exitCodes.push(code);
    }),
    writeStdout: vi.fn(),
    writeJson: vi.fn((value: unknown) => {
      payloads.push(value);
    }),
  };
  return { runtime, payloads, errors, exitCodes };
}

function makeSummary(warnings: CoreHarnessSummary["warnings"] = []): CoreHarnessSummary {
  return {
    effectiveHome: {
      path: "/tmp/test",
      source: "home",
      processHome: "/tmp/test",
      isolatedProcessHome: false,
    },
    config: { path: "/tmp/test/openclaw.json", readable: true, issues: [] },
    sandbox: { mode: "default", scope: "default", workspaceAccess: "default" },
    elevated: { enabled: true, wildcardAllowFrom: [] },
    approvals: {
      totalEntries: 0,
      allowAlwaysEntries: 0,
      opaqueCommandEntries: 0,
      staleOrUnknownLastUsedEntries: 0,
    },
    wrappers: { openclawSetupAlias: true, homeResolver: true },
    warnings,
  };
}

describe("runCoreHarnessJson", () => {
  const baseSnapshot = {
    runtimeConfig: { commands: { ownerAllowFrom: ["discord:123"] } },
    path: "/Users/hide_aibo/.openclaw/openclaw.json",
    valid: true,
    issues: [],
  };

  beforeEach(() => {
    mocks.readConfigFileSnapshot.mockReset();
    mocks.resolveOpenClawPackageRoot.mockReset();
    mocks.collectSourceInstallIssues.mockReset();
    mocks.buildCoreHarnessSummary.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("forwards resolved package root and install issues to buildCoreHarnessSummary", async () => {
    mocks.readConfigFileSnapshot.mockResolvedValue(baseSnapshot);
    mocks.resolveOpenClawPackageRoot.mockResolvedValue("/Users/hide_aibo/repos/openclaw-source");
    mocks.collectSourceInstallIssues.mockReturnValue(["- tsx binary is missing for source runs."]);
    mocks.buildCoreHarnessSummary.mockReturnValue(makeSummary());

    const { runtime } = createRuntimeStub();
    await runCoreHarnessJson(runtime);

    const callArgs = mocks.buildCoreHarnessSummary.mock.calls[0]?.[0] as {
      startupIssues?: CoreHarnessStartupIssues;
    };
    expect(callArgs?.startupIssues).toEqual({
      packageRootResolved: true,
      sourceInstallIssues: ["- tsx binary is missing for source runs."],
    });
  });

  it("reports packageRootResolved=false when resolveOpenClawPackageRoot returns null", async () => {
    mocks.readConfigFileSnapshot.mockResolvedValue(baseSnapshot);
    mocks.resolveOpenClawPackageRoot.mockResolvedValue(null);
    mocks.collectSourceInstallIssues.mockReturnValue([]);
    mocks.buildCoreHarnessSummary.mockReturnValue(makeSummary());

    const { runtime } = createRuntimeStub();
    await runCoreHarnessJson(runtime);

    const callArgs = mocks.buildCoreHarnessSummary.mock.calls[0]?.[0] as {
      startupIssues?: CoreHarnessStartupIssues;
    };
    expect(callArgs?.startupIssues).toEqual({
      packageRootResolved: false,
      sourceInstallIssues: [],
    });
  });

  it("returns exit code 3 when summary has an error-severity warning", async () => {
    mocks.readConfigFileSnapshot.mockResolvedValue(baseSnapshot);
    mocks.resolveOpenClawPackageRoot.mockResolvedValue(null);
    mocks.collectSourceInstallIssues.mockReturnValue([]);
    mocks.buildCoreHarnessSummary.mockReturnValue(
      makeSummary([
        {
          code: "core-harness.startup.broken-shim",
          severity: "error",
          category: "new",
          summary: "broken shim",
          what_to_do_now: "fix",
          safe_to_ignore_today: false,
        },
      ]),
    );

    const { runtime, exitCodes } = createRuntimeStub();
    await runCoreHarnessJson(runtime);

    expect(exitCodes).toEqual([3]);
  });

  it("returns exit code 1 when summary only has warn-severity warnings", async () => {
    mocks.readConfigFileSnapshot.mockResolvedValue(baseSnapshot);
    mocks.resolveOpenClawPackageRoot.mockResolvedValue("/repo");
    mocks.collectSourceInstallIssues.mockReturnValue(["something"]);
    mocks.buildCoreHarnessSummary.mockReturnValue(
      makeSummary([
        {
          code: "core-harness.startup.broken-root",
          severity: "warn",
          category: "new",
          summary: "broken root",
          what_to_do_now: "fix",
          safe_to_ignore_today: false,
        },
      ]),
    );

    const { runtime, exitCodes } = createRuntimeStub();
    await runCoreHarnessJson(runtime);

    expect(exitCodes).toEqual([1]);
  });

  it("returns exit code 0 when summary has no warnings", async () => {
    mocks.readConfigFileSnapshot.mockResolvedValue(baseSnapshot);
    mocks.resolveOpenClawPackageRoot.mockResolvedValue("/repo");
    mocks.collectSourceInstallIssues.mockReturnValue([]);
    mocks.buildCoreHarnessSummary.mockReturnValue(makeSummary());

    const { runtime, payloads, exitCodes } = createRuntimeStub();
    await runCoreHarnessJson(runtime);

    expect(payloads).toHaveLength(1);
    expect(exitCodes).toEqual([0]);
  });

  it("returns exit code 2 when config snapshot is invalid", async () => {
    mocks.readConfigFileSnapshot.mockResolvedValue({
      ...baseSnapshot,
      valid: false,
      issues: [{ path: "/tmp", message: "broken" }],
    });
    mocks.resolveOpenClawPackageRoot.mockResolvedValue("/repo");
    mocks.collectSourceInstallIssues.mockReturnValue([]);
    mocks.buildCoreHarnessSummary.mockReturnValue(makeSummary());

    const { runtime, exitCodes } = createRuntimeStub();
    await runCoreHarnessJson(runtime);

    expect(exitCodes).toEqual([2]);
  });

  it("exits 2 when snapshot read throws", async () => {
    mocks.readConfigFileSnapshot.mockRejectedValue(new Error("boom"));
    mocks.resolveOpenClawPackageRoot.mockResolvedValue(null);
    mocks.collectSourceInstallIssues.mockReturnValue([]);
    mocks.buildCoreHarnessSummary.mockReturnValue(makeSummary());

    const { runtime, exitCodes, errors } = createRuntimeStub();
    await runCoreHarnessJson(runtime);

    expect(exitCodes).toEqual([2]);
    expect(errors.join("\n")).toContain("boom");
  });
});

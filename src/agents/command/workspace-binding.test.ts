import { describe, expect, it } from "vitest";
import { resolveAgentCommandWorkspaceDir } from "./workspace-binding.js";

describe("resolveAgentCommandWorkspaceDir", () => {
  it("uses an explicit host-provided spawned workspace for the current run", () => {
    expect(
      resolveAgentCommandWorkspaceDir({
        spawnedWorkspaceDir: " /work/current-run ",
        sessionEntry: { spawnedWorkspaceDir: "/work/persisted-session" },
        agentWorkspaceDir: "/work/default-agent",
      }),
    ).toBe("/work/current-run");
  });

  it("reuses the host-persisted session workspace before the agent default", () => {
    expect(
      resolveAgentCommandWorkspaceDir({
        sessionEntry: { spawnedWorkspaceDir: "/work/persisted-session" },
        agentWorkspaceDir: "/work/default-agent",
      }),
    ).toBe("/work/persisted-session");
  });

  it("falls back to the configured agent workspace when no session workspace exists", () => {
    expect(resolveAgentCommandWorkspaceDir({ agentWorkspaceDir: "/work/default-agent" })).toBe(
      "/work/default-agent",
    );
  });
});

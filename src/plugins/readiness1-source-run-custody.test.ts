import { describe, expect, it, vi } from "vitest";
import { createDirectLocalProcessCustody } from "../agents/cli-runner/direct-process-custody.js";
import {
  finalizeReadiness1SourceRunCustody,
  registerReadiness1SourceRunCustody,
} from "./readiness1-source-run-custody.js";

describe("readiness1 source-run custody", () => {
  it("keeps direct process identity opaque while certifying its dedicated group", async () => {
    const wait = vi.fn(async () => ({ reason: "exit" }));
    const observeGroupGone = vi
      .fn()
      .mockReturnValueOnce(false)
      .mockReturnValueOnce(false)
      .mockReturnValueOnce(false)
      .mockReturnValueOnce(false)
      .mockReturnValueOnce(false)
      .mockReturnValueOnce(true);
    const signalGroup = vi.fn();
    const lsofGroupClear = vi.fn(() => true);
    const custody = createDirectLocalProcessCustody(
      { pid: 7101, processGroupId: 7101, wait },
      {
        observeGroupGone,
        signalGroup,
        lsofGroupClear,
        wait: vi.fn(async () => undefined),
      },
    );

    await expect(custody.cleanupAndObserve()).resolves.toEqual({
      processStopped: true,
      groupStopped: true,
      containerAbsent: true,
      lsofClear: true,
    });
    expect(Object.keys(custody).sort()).toEqual(["cleanupAndObserve", "kind"]);
    expect(signalGroup).toHaveBeenCalledExactlyOnceWith(7101);
    expect(lsofGroupClear).toHaveBeenCalledExactlyOnceWith(7101);
  });

  it("fails closed when the retained root cannot settle, or lacks a dedicated group", async () => {
    const lost = createDirectLocalProcessCustody(
      {
        pid: 7102,
        processGroupId: 7102,
        wait: vi.fn(async () => await Promise.reject(new Error("lost"))),
      },
      {
        observeGroupGone: vi.fn(() => true),
        signalGroup: vi.fn(),
        lsofGroupClear: vi.fn(() => true),
        wait: vi.fn(async () => undefined),
      },
    );

    await expect(lost.cleanupAndObserve()).resolves.toEqual({
      processStopped: false,
      groupStopped: false,
      containerAbsent: true,
      lsofClear: false,
    });
    expect(() =>
      createDirectLocalProcessCustody({
        pid: 7103,
        processGroupId: 7104,
        wait: vi.fn(async () => ({ reason: "exit" })),
      }),
    ).toThrow("dedicated process group");
  });

  it("serializes one exact finalizer and removes only a fully confirmed receipt", async () => {
    const expected = {
      runId: "run-custody-confirmed",
      sessionKey: "agent:dev:subagent:custody",
      workspaceDir: "/private/tmp/readiness-custody-confirmed",
    };
    const cleanupAndObserve = vi.fn(async () => ({
      processStopped: true,
      groupStopped: true,
      containerAbsent: true as const,
      lsofClear: true,
    }));
    const finalizeWorkspace = vi.fn(async () => ({
      processStopped: true,
      groupStopped: true,
      containerRemoved: true,
      lsofClear: true,
      runLeaseReleased: true,
      workspaceReleased: true,
      workspaceRemoved: true,
    }));

    registerReadiness1SourceRunCustody({
      expected,
      custody: { kind: "direct-local-process-group", cleanupAndObserve },
      finalizeWorkspace,
    });
    const [first, second] = await Promise.all([
      finalizeReadiness1SourceRunCustody(expected),
      finalizeReadiness1SourceRunCustody(expected),
    ]);

    expect(first).toEqual({
      ...expected,
      processStopped: true,
      groupStopped: true,
      containerRemoved: true,
      lsofClear: true,
      runLeaseReleased: true,
      workspaceReleased: true,
      workspaceRemoved: true,
    });
    expect(second).toBe(first);
    expect(cleanupAndObserve).toHaveBeenCalledOnce();
    expect(finalizeWorkspace).toHaveBeenCalledOnce();
    await expect(finalizeReadiness1SourceRunCustody(expected)).rejects.toThrow("unavailable");
  });

  it("rejects identity drift without running the retained cleanup closure", async () => {
    const expected = {
      runId: "run-custody-drift",
      sessionKey: "agent:dev:subagent:custody-drift",
      workspaceDir: "/private/tmp/readiness-custody-drift",
    };
    const cleanupAndObserve = vi.fn(async () => ({
      processStopped: true,
      groupStopped: true,
      containerAbsent: true as const,
      lsofClear: true,
    }));
    registerReadiness1SourceRunCustody({
      expected,
      custody: { kind: "direct-local-process-group", cleanupAndObserve },
      finalizeWorkspace: vi.fn(async () => ({
        processStopped: true,
        groupStopped: true,
        containerRemoved: true,
        lsofClear: true,
        runLeaseReleased: true,
        workspaceReleased: true,
        workspaceRemoved: true,
      })),
    });

    await expect(
      finalizeReadiness1SourceRunCustody({ ...expected, sessionKey: "agent:other:subagent:drift" }),
    ).rejects.toThrow("unavailable");
    expect(cleanupAndObserve).not.toHaveBeenCalled();
  });
});

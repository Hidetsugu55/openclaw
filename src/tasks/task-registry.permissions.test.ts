import type { Stats } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import type { SubsystemLogger } from "../logging/subsystem.js";
import {
  applyExpectedModeIfPossible,
  type FilesystemPermissionOps,
} from "./task-registry.permissions.js";

function createLog(): SubsystemLogger & {
  info: ReturnType<typeof vi.fn>;
  debug: ReturnType<typeof vi.fn>;
  warn: ReturnType<typeof vi.fn>;
  error: ReturnType<typeof vi.fn>;
} {
  return {
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  } as never;
}

function createOps(overrides: Partial<FilesystemPermissionOps> = {}): {
  ops: FilesystemPermissionOps;
  lstatSync: ReturnType<typeof vi.fn>;
  chmodSync: ReturnType<typeof vi.fn>;
} {
  const lstatSpy = (overrides.lstatSync ??
    vi.fn(() => ({ mode: 0o040755 }) as unknown as Stats)) as ReturnType<typeof vi.fn>;
  const chmodSpy = (overrides.chmodSync ?? vi.fn()) as ReturnType<typeof vi.fn>;
  const ops: FilesystemPermissionOps = {
    lstatSync: lstatSpy as unknown as FilesystemPermissionOps["lstatSync"],
    chmodSync: chmodSpy as unknown as FilesystemPermissionOps["chmodSync"],
  };
  return { ops, lstatSync: lstatSpy, chmodSync: chmodSpy };
}

function makeErrnoError(code: string, message = code): NodeJS.ErrnoException {
  const err = new Error(message) as NodeJS.ErrnoException;
  err.code = code;
  err.syscall = "chmod";
  return err;
}

describe("applyExpectedModeIfPossible", () => {
  it("does not call chmod when the current mode already matches", () => {
    const log = createLog();
    const { ops, lstatSync, chmodSync } = createOps({
      lstatSync: vi.fn(() => ({ mode: 0o040700 }) as unknown as Stats),
    });

    applyExpectedModeIfPossible("/fake/dir", 0o700, log, ops);

    expect(lstatSync).toHaveBeenCalledTimes(1);
    expect(chmodSync).not.toHaveBeenCalled();
    expect(log.debug).not.toHaveBeenCalled();
  });

  it("calls chmod when the current mode does not match", () => {
    const log = createLog();
    const { ops, chmodSync } = createOps({
      lstatSync: vi.fn(() => ({ mode: 0o040755 }) as unknown as Stats),
    });

    applyExpectedModeIfPossible("/fake/dir", 0o700, log, ops);

    expect(chmodSync).toHaveBeenCalledTimes(1);
    expect(chmodSync).toHaveBeenCalledWith("/fake/dir", 0o700);
    expect(log.debug).not.toHaveBeenCalled();
  });

  it("calls chmod when only special bits (setgid/setuid/sticky) differ from expected", () => {
    // Directory currently has setgid bit set on top of 0o700 (= 0o2700 in
    // permission bits). The expected mode is plain 0o700, so the helper must
    // still issue a chmod to strip the setgid bit — matching the original
    // unconditional chmod semantics.
    const log = createLog();
    const { ops, chmodSync } = createOps({
      lstatSync: vi.fn(() => ({ mode: 0o042700 }) as unknown as Stats),
    });

    applyExpectedModeIfPossible("/fake/dir", 0o700, log, ops);

    expect(chmodSync).toHaveBeenCalledTimes(1);
    expect(chmodSync).toHaveBeenCalledWith("/fake/dir", 0o700);
  });

  it("attempts chmod when lstat throws (current mode unknown)", () => {
    const log = createLog();
    const lstatSync = vi.fn(() => {
      throw makeErrnoError("ENOENT");
    });
    const { ops, chmodSync } = createOps({ lstatSync });

    applyExpectedModeIfPossible("/fake/dir", 0o700, log, ops);

    expect(chmodSync).toHaveBeenCalledTimes(1);
  });

  it.each(["EPERM", "EACCES", "EROFS", "ENOTSUP"] as const)(
    "tolerates %s from chmod and emits a single debug log without throwing",
    (code) => {
      const log = createLog();
      const { ops } = createOps({
        lstatSync: vi.fn(() => ({ mode: 0o040755 }) as unknown as Stats),
        chmodSync: vi.fn(() => {
          throw makeErrnoError(code);
        }),
      });

      expect(() => applyExpectedModeIfPossible("/fake/dir", 0o700, log, ops)).not.toThrow();

      expect(log.debug).toHaveBeenCalledTimes(1);
      expect(log.debug).toHaveBeenCalledWith(
        "task-registry permissions: chmod skipped (filesystem/uid disallowed)",
        { target: "/fake/dir", expectedMode: 0o700, code },
      );
      expect(log.warn).not.toHaveBeenCalled();
    },
  );

  it("re-throws unexpected errors like EIO", () => {
    const log = createLog();
    const { ops } = createOps({
      lstatSync: vi.fn(() => ({ mode: 0o040755 }) as unknown as Stats),
      chmodSync: vi.fn(() => {
        throw makeErrnoError("EIO");
      }),
    });

    expect(() => applyExpectedModeIfPossible("/fake/dir", 0o700, log, ops)).toThrow(/EIO/);

    expect(log.debug).not.toHaveBeenCalled();
  });
});

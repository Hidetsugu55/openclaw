import { chmodSync, lstatSync, type Stats } from "node:fs";
import type { SubsystemLogger } from "../logging/subsystem.js";

const TOLERABLE_PERMISSION_ERROR_CODES: ReadonlySet<string> = new Set([
  "EPERM",
  "EACCES",
  "EROFS",
  "ENOTSUP",
]);

export type FilesystemPermissionOps = {
  lstatSync: (target: string) => Stats;
  chmodSync: (target: string, mode: number) => void;
};

const defaultOps: FilesystemPermissionOps = {
  lstatSync,
  chmodSync,
};

export function applyExpectedModeIfPossible(
  target: string,
  expectedMode: number,
  log: SubsystemLogger,
  fs: FilesystemPermissionOps = defaultOps,
): void {
  let currentMode: number | null = null;
  try {
    currentMode = fs.lstatSync(target).mode & 0o777;
  } catch {
    // stat failure — let the chmod attempt surface a real error if needed.
  }
  if (currentMode === expectedMode) {
    return;
  }
  try {
    fs.chmodSync(target, expectedMode);
  } catch (error: unknown) {
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    if (typeof code === "string" && TOLERABLE_PERMISSION_ERROR_CODES.has(code)) {
      log.debug("task-registry permissions: chmod skipped (filesystem/uid disallowed)", {
        target,
        expectedMode,
        code,
      });
      return;
    }
    throw error;
  }
}

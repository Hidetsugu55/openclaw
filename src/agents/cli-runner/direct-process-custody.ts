import { spawnSync } from "node:child_process";
import { isOwnedProcessGroupGone } from "../../process/supervisor/service-child-group-ownership.js";
import type { ManagedRun } from "../../process/supervisor/types.js";
import type { AgentRuntimeDirectLocalProcessCustody } from "../command/types.js";

const GROUP_EXIT_POLL_DELAYS_MS = [0, 25, 75, 150, 250] as const;
const LSOF_TIMEOUT_MS = 1_000;

type DirectLocalProcessCustodyDeps = {
  observeGroupGone: (processGroupId: number) => boolean;
  signalGroup: (processGroupId: number) => void;
  lsofGroupClear: (processGroupId: number) => boolean;
  wait: (ms: number) => Promise<void>;
};

const defaultDeps: DirectLocalProcessCustodyDeps = {
  observeGroupGone: isOwnedProcessGroupGone,
  signalGroup: (processGroupId) => {
    process.kill(-processGroupId, "SIGKILL");
  },
  lsofGroupClear: (processGroupId) => {
    const result = spawnSync("lsof", ["-nP", "-g", String(processGroupId)], {
      stdio: "ignore",
      timeout: LSOF_TIMEOUT_MS,
    });
    // lsof exits 1 when this exact process group has no open files. A missing
    // binary, timeout, signal, or malformed execution stays UNKNOWN.
    return result.error === undefined && result.signal === null && result.status === 1;
  },
  wait: async (ms) => {
    if (ms > 0) {
      await new Promise<void>((resolve) => setTimeout(resolve, ms));
    }
  },
};

function isEsrch(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "ESRCH"
  );
}

async function waitForGroupGone(
  processGroupId: number,
  deps: DirectLocalProcessCustodyDeps,
): Promise<boolean> {
  for (const delayMs of GROUP_EXIT_POLL_DELAYS_MS) {
    await deps.wait(delayMs);
    try {
      if (deps.observeGroupGone(processGroupId)) {
        return true;
      }
    } catch {
      return false;
    }
  }
  return false;
}

/**
 * Capture opaque cleanup custody only for an actual dedicated local process
 * group. The returned closure is safe to retain past terminal output: it never
 * reveals PID, PGID, command, paths, or lsof output to its caller.
 */
export function createDirectLocalProcessCustody(
  run: Pick<ManagedRun, "pid" | "processGroupId" | "wait">,
  deps: DirectLocalProcessCustodyDeps = defaultDeps,
): AgentRuntimeDirectLocalProcessCustody {
  const processGroupId = run.processGroupId;
  if (
    !Number.isSafeInteger(run.pid) ||
    !Number.isSafeInteger(processGroupId) ||
    run.pid === undefined ||
    processGroupId === undefined ||
    run.pid <= 0 ||
    processGroupId <= 0 ||
    run.pid !== processGroupId
  ) {
    throw new Error("Direct local process custody requires a dedicated process group.");
  }

  let receipt: ReturnType<AgentRuntimeDirectLocalProcessCustody["cleanupAndObserve"]> | undefined;
  return Object.freeze({
    kind: "direct-local-process-group",
    cleanupAndObserve: () =>
      (receipt ??= (async () => {
        let processStopped = false;
        try {
          await run.wait();
          processStopped = true;
        } catch {
          return Object.freeze({
            processStopped,
            groupStopped: false,
            containerAbsent: true as const,
            lsofClear: false,
          });
        }

        let groupStopped = await waitForGroupGone(processGroupId, deps);
        if (!groupStopped) {
          try {
            deps.signalGroup(processGroupId);
          } catch (error) {
            if (!isEsrch(error)) {
              return Object.freeze({
                processStopped,
                groupStopped: false,
                containerAbsent: true as const,
                lsofClear: false,
              });
            }
          }
          groupStopped = await waitForGroupGone(processGroupId, deps);
        }
        let lsofClear = false;
        if (groupStopped) {
          try {
            lsofClear = deps.lsofGroupClear(processGroupId);
          } catch {
            lsofClear = false;
          }
        }
        return Object.freeze({
          processStopped,
          groupStopped,
          containerAbsent: true as const,
          lsofClear,
        });
      })()),
  });
}

export type { DirectLocalProcessCustodyDeps };

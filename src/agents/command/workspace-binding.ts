import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { InternalSessionEntry } from "../../config/sessions/types.js";
import { resolveUserPath } from "../../utils.js";

/**
 * Prefer host-persisted session workspace identity over the agent default.
 * Explicit spawned metadata is retained as the one-shot, host-supplied override.
 */
export function resolveAgentCommandWorkspaceDir(params: {
  spawnedWorkspaceDir?: string;
  sessionEntry?: Pick<InternalSessionEntry, "spawnedWorkspaceDir">;
  agentWorkspaceDir: string;
}): string {
  const workspaceDir =
    normalizeOptionalString(params.spawnedWorkspaceDir) ??
    normalizeOptionalString(params.sessionEntry?.spawnedWorkspaceDir) ??
    params.agentWorkspaceDir;
  return resolveUserPath(workspaceDir);
}

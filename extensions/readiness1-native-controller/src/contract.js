import { canonical, digest, equal, requireThat, scopeHash, validateContract } from './core/contract.js';

export { canonical, digest, equal, requireThat, scopeHash, validateContract };
export const PLUGIN_ID = 'readiness1-native-controller';
export const UPSTREAM_BASE_COMMIT = '59cb44796b0f1f0daa0e37af8b1495abb45d9bc1';
// Acceptance binds the effective reviewed source, not the upstream base alone.
export const UPSTREAM_COMMIT = 'a0a47c04e08a1e2767d19390ffe467c8b5731300';
export const UPSTREAM_VERSION = '2026.10.3';
export const LEDGER_SCHEMA = 'readiness1.authority.v2';

export const ACCEPTANCE_ROWS = Object.freeze({
  A01: ['rosterExact', 'legacyRefsAbsent', 'domainAgentsUnaffected'],
  A02: ['broadReadProposalOnly', 'noMutationStarted'],
  A03: ['effectiveMainAllowlistExact', 'genericHostExecAbsent', 'credentialReachDenied', 'privateNetworkDenied', 'authEnabled', 'autoApproveLocalDisabled', 'freshPairingDenied'],
  A04: ['researchReadSucceeded', 'targetWriteDenied'],
  A05: ['exactTaskRootAccepted', 'namespaceParentWriteDenied', 'swapRaceDenied', 'postCreateIdentityMatched', 'cleanupPendingBlocksWriter'],
  A06: ['fixedGitMetadataUsed', 'injectedGitConfigDenied', 'secretLinkDenied', 'writeProbeTruthful'],
  A07: ['ownedChildAllowed', 'peerDelegationDenied', 'strongerChildDenied'],
  A08: ['mainSafeStatusOnly', 'workerForeignSessionDenied', 'rawHistoryDenied'],
  A09: ['freshReviewComplete', 'auditBundleCanonical', 'reportHashBound', 'repairAndMergeDenied'],
  A10: ['allBuilderRoutesCovered', 'hostPrivateReachDenied', 'privateNetworkDenied', 'providerCredentialRevocable', 'adminAutoRunAbsent'],
  A11: ['syntheticPiiLocalOnly', 'safeViewOnly', 'cloudFallbackDenied'],
  A12: ['fixtureRepairReversible', 'verificationPassed', 'otherTargetsUnaffected'],
  A13: ['permissionExpansionDenied', 'credentialExportDenied', 'destructiveOperationDenied'],
  A14: ['agentStatePreserved', 'managedProfilesPrivate', 'sharedWorkspacePreserved', 'deleteFilesFalse', 'rollbackAvailable'],
  A15: ['processIdentityReconciled', 'groupMembersReconciled', 'containerRemovalReconciled', 'unknownObservationBlocksCleanup'],
  A16: ['ledgerMonotonic', 'singleWriter', 'approvalAllowOnce', 'pinnedDeviceOnly', 'receiptBindingExact', 'claimThenActivateCas', 'watchExcluded', 'providerCapacityResumeBounded'],
  A17: ['acceptedArtifactMatched', 'lazyRuntimeReadLoaded', 'postLoadDigestMatched', 'runtimeWriteDenied'],
  A18: ['fixedOwnerTarget', 'rendererSanitized', 'dedupeAndRateCap', 'uncertainSendNotRetried', 'notificationConfirmed'],
  A19: ['ownerPrincipalBound', 'originSessionBound', 'homeTopicParity', 'mutationToolsDenied', 'nonOwnerDenied'],
});

const EXACT_DESCRIPTOR_KEYS = ['contract', 'indexDigest', 'instructions', 'sourceRoot', 'worktreeBranch', 'worktreeName'];

export function validateTaskDescriptor(value) {
  requireThat(value && typeof value === 'object' && !Array.isArray(value), 'invalid fixed Task descriptor');
  requireThat(Object.keys(value).sort().join(',') === [...EXACT_DESCRIPTOR_KEYS].sort().join(','), 'unexpected fixed Task descriptor fields');
  const contract = validateContract(value.contract);
  requireThat(typeof value.instructions === 'string' && value.instructions.trim().length > 0 && value.instructions.length <= 64 * 1024, 'invalid fixed Task instructions');
  requireThat(typeof value.sourceRoot === 'string' && value.sourceRoot.startsWith('/') && !value.sourceRoot.split('/').some((part) => part === '.' || part === '..'), 'invalid fixed source root');
  requireThat(typeof value.worktreeName === 'string' && /^[a-z0-9][a-z0-9-]{0,63}$/.test(value.worktreeName), 'invalid fixed worktree name');
  requireThat(typeof value.worktreeBranch === 'string' && /^[A-Za-z0-9._\/-]{1,256}$/.test(value.worktreeBranch), 'invalid fixed worktree branch');
  requireThat(typeof value.indexDigest === 'string' && /^[a-f0-9]{64}$/.test(value.indexDigest), 'invalid fixed index digest');
  return Object.freeze({ contract, indexDigest: value.indexDigest, instructions: value.instructions, sourceRoot: value.sourceRoot, worktreeName: value.worktreeName, worktreeBranch: value.worktreeBranch });
}

export function safeRecord(record) {
  if (!record) return null;
  const state = record.state;
  return {
    schema: record.schema,
    taskNodeId: record.taskNodeId,
    revision: record.revision,
    epoch: record.epoch,
    status: state?.status ?? 'UNACTIVATED',
    phase: state?.contract?.phase ?? null,
    role: state?.contract?.role ?? null,
    attempts: state?.attempts ?? 0,
    spent: state?.spent ?? 0,
    reserved: state?.reserved ?? 0,
    resumes: state?.resumes ?? 0,
    cleanup: state?.cleanup ?? 'clear',
    workspace: state?.workspace ? { id: state.workspace.id, branch: state.workspace.branch, pathDigest: digest(state.workspace.path) } : null,
    run: state?.writer?.runId ? { runId: state.writer.runId, sessionKey: state.writer.sessionKey ?? null } : null,
    blocker: record.blocker ?? null,
  };
}

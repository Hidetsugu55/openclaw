import { equal, requireThat } from '../contract.js';

function validName(value) {
  return typeof value === 'string' && /^[A-Za-z0-9_.-]+$/.test(value);
}

export function buildNativeProfile({ repo, defaultBranch, verifyContext, integrationId }) {
  requireThat(typeof repo === 'string' && /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo), 'invalid repo');
  requireThat(validName(defaultBranch) && validName(verifyContext), 'invalid ref or check context');
  requireThat(Number.isSafeInteger(integrationId) && integrationId > 0, 'invalid check App');
  return Object.freeze({
    schema: 'readiness3.native-profile.v1',
    repo,
    defaultBranch,
    ruleset: {
      name: `default-${defaultBranch}-guardrails`,
      target: 'branch',
      enforcement: 'active',
      bypass_actors: [],
      conditions: { ref_name: { include: [`refs/heads/${defaultBranch}`], exclude: [] } },
      rules: [
        { type: 'pull_request', parameters: { required_approving_review_count: 0, dismiss_stale_reviews_on_push: true, require_code_owner_review: false, require_last_push_approval: false, required_review_thread_resolution: false } },
        { type: 'deletion' },
        { type: 'non_fast_forward' },
        { type: 'required_linear_history' },
        { type: 'required_status_checks', parameters: { strict_required_status_checks_policy: true, required_status_checks: [{ context: verifyContext, integration_id: integrationId }] } },
      ],
    },
    repository: {
      allow_squash_merge: true,
      allow_merge_commit: false,
      allow_rebase_merge: false,
      allow_auto_merge: false,
      delete_branch_on_merge: true,
    },
  });
}

export function compareNativeProfile(expected, observed) {
  if (!observed || observed.visibility !== 'COMPLETE' || observed.bypassVisibility !== 'COMPLETE' || !observed.profile) return Object.freeze({ decision: 'UNKNOWN', reasons: ['native_profile_visibility_incomplete'] });
  return equal(expected, observed.profile)
    ? Object.freeze({ decision: 'MATCH', reasons: [] })
    : Object.freeze({ decision: 'DRIFT', reasons: ['native_profile_differs'] });
}

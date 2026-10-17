import { createHash } from 'node:crypto';

export const SCHEMA = 'readiness1.task.v1';
export const ACTIONS = Object.freeze(['dispatch', 'resume', 'status', 'notify.owner']);
export const PHASES = Object.freeze(['prepare', 'work', 'cleanup']);
export function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
  if (value === undefined || (typeof value === 'number' && !Number.isFinite(value))) throw new Error('non-canonical value');
  return JSON.stringify(value);
}
export const digest = value => createHash('sha256').update(typeof value === 'string' ? value : canonical(value)).digest('hex');
export const equal = (a, b) => canonical(a) === canonical(b);
export function requireThat(condition, reason) { if (!condition) throw new Error(reason); }
export function integer(value, name) { requireThat(Number.isSafeInteger(value) && value >= 0, `invalid ${name}`); }
export function validateContract(c) {
  requireThat(c?.schema === SCHEMA && /^[A-Za-z0-9_:-]{3,512}$/.test(c.taskNodeId), 'invalid canonical Task');
  requireThat(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(c.repo) && typeof c.ref === 'string' && c.ref.startsWith('refs/heads/') && !/[\s~^:?*\[\\]/.test(c.ref) && !c.ref.includes('..'), 'invalid repo/ref');
  requireThat(/^[a-f0-9]{40}$/.test(c.head) && /^[a-f0-9]{64}$/.test(c.revisionHash), 'invalid exact revision');
  requireThat(typeof c.root === 'string' && c.root.startsWith('/') && !c.root.split('/').some(x => x === '.' || x === '..'), 'invalid root');
  requireThat(PHASES.includes(c.phase) && ['dev-host', 'reviewer', 'ops', 'researcher'].includes(c.role), 'invalid phase/role');
  requireThat(['source', 'audit', 'read', 'diagnostic', 'repair'].includes(c.actionClass), 'invalid action class');
  requireThat(typeof c.originatingSession === 'string' && c.originatingSession.length > 0, 'missing origin');
  integer(c.deadline, 'deadline'); integer(c.hardSunset, 'hard sunset');
  requireThat(c.deadline <= c.hardSunset, 'deadline exceeds hard sunset');
  requireThat(c.limits && Object.keys(c.limits).sort().join(',') === 'attempts,budget,resumes' && c.limits.attempts >= 1 && c.limits.resumes >= 1, 'invalid limits');
  for (const [k, v] of Object.entries(c.limits)) integer(v, k);
  requireThat(c.caps && Object.keys(c.caps).length > 0, 'missing capabilities');
  return structuredClone(c);
}
export const scopeHash = c => digest({ repo: c.repo, ref: c.ref, head: c.head, root: c.root, phase: c.phase, role: c.role, actionClass: c.actionClass, caps: c.caps, limits: c.limits, deadline: c.deadline, hardSunset: c.hardSunset, originatingSession: c.originatingSession });
export function ownerCaller(ctx, policy) {
  if (ctx?.agentId !== 'main' || !ctx.sessionKey || ctx.sandboxed || ctx.trigger !== 'owner') return false;
  // An authenticated native principal takes precedence; absence uses an exact
  // Owner-only session allowlist. Scheduled/hook/webhook/A2A never qualify.
  return ctx.ownerPrincipal != null ? ctx.ownerPrincipal === policy.ownerPrincipal : policy.ownerOnlySessions.includes(ctx.sessionKey);
}
export function projection(record) {
  const s = record.state;
  return { taskNodeId: record.taskNodeId, revision: record.revision, status: s.status, phase: s.contract.phase, role: s.contract.role, attempts: s.attempts, spent: s.spent, deadline: s.contract.deadline, cleanup: s.cleanup, provider: s.wait?.provider ?? null };
}

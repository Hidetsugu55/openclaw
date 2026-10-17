import { requireThat } from '../contract.js';

export const EFFECT_CLASSES = Object.freeze([
  'command', 'api', 'permission', 'filesystem', 'credential', 'hooks', 'mcp',
  'egress', 'externalSend', 'delegation', 'persistence', 'dataMovement', 'cost', 'cleanup',
]);
export const OWNER_CATEGORIES = Object.freeze([
  'none', 'credential', 'permission', 'admin', 'public', 'deploy',
  'destructive', 'expense', 'domain', 'external',
]);

const DESCRIPTOR_KEYS = Object.freeze([
  'schema', 'operation', 'mode', 'route', 'role', 'taskNodeId', 'epoch',
  'contractRevision', 'scopeHash', 'catalogHash', 'resolverHash', 'profileHash',
  'snapshotBase', 'intent', 'dependencies', 'omissions', 'immutableIds', 'effects',
]);
const CAPABILITY_KEYS = Object.freeze([
  'catalogHash', 'resolverHash', 'profileHashes', 'operationLimit', 'grants',
  'omissionOverrides', 'reopenKeys',
]);
const GRANT_KEYS = Object.freeze([
  'operation', 'class', 'target', 'category', 'maxAmount', 'ownerAuthorized',
]);

// Closed schema owned by the 10.3 extension. Deployments install its
// hash-pinned catalog/profile/build outside every Task write root.
export const OPERATIONS = Object.freeze({
  'repo.read': ['READ', 'safe-projection'],
  'file.read': ['READ', 'safe-projection'],
  'issue.read': ['READ', 'safe-projection'],
  'pr.read': ['READ', 'safe-projection'],
  'diff.read': ['READ', 'safe-projection'],
  'checks.read': ['READ', 'safe-projection'],
  'research.read': ['READ', 'read-specialist'],
  'diagnostic.read': ['READ', 'read-specialist'],
  'source.work': ['OPS', 'specialist'],
  'audit.review': ['READ', 'read-specialist'],
  'ops.repair': ['OPS', 'specialist'],
  'ready.consume': ['OPS', 'coordination'],
  'comment.append': ['OPS', 'coordination'],
  'task.status': ['OPS', 'coordination'],
  'snapshot.update': ['OPS', 'snapshot-runner'],
});

export function validateEffect(effect) {
  requireThat(
    effect
      && EFFECT_CLASSES.includes(effect.class)
      && typeof effect.target === 'string'
      && effect.target.length > 0
      && effect.target.length <= 2048
      && OWNER_CATEGORIES.includes(effect.category)
      && Number.isSafeInteger(effect.amount)
      && effect.amount >= 0
      && effect.possible === true
      && ['resolver', 'agent-added'].includes(effect.provenance),
    'UNKNOWN effect',
  );
  requireThat(
    Object.keys(effect).every((key) => [
      'class', 'target', 'category', 'amount', 'possible',
      'provenance', 'scratch', 'readOnly', 'safeView',
    ].includes(key)),
    'UNKNOWN effect field',
  );
  for (const key of ['scratch', 'readOnly', 'safeView']) {
    requireThat(effect[key] === undefined || typeof effect[key] === 'boolean', 'UNKNOWN effect flag');
  }
  return effect;
}

export const effectKey = (effect) => JSON.stringify([
  effect.class,
  effect.target,
  effect.category,
]);

export function validateExecutionGateCapability(capability) {
  requireThat(
    capability
      && typeof capability === 'object'
      && !Array.isArray(capability)
      && Object.keys(capability).every((key) => CAPABILITY_KEYS.includes(key))
      && /^[a-f0-9]{64}$/.test(capability.catalogHash)
      && /^[a-f0-9]{64}$/.test(capability.resolverHash)
      && Array.isArray(capability.profileHashes)
      && capability.profileHashes.length > 0
      && capability.profileHashes.length <= 32
      && capability.profileHashes.every((hash) => /^[a-f0-9]{64}$/.test(hash))
      && new Set(capability.profileHashes).size === capability.profileHashes.length
      && Number.isSafeInteger(capability.operationLimit)
      && capability.operationLimit > 0
      && capability.operationLimit <= 128
      && Array.isArray(capability.grants)
      && capability.grants.length <= 128,
    'BLOCKED invalid Execution Gate capability',
  );
  for (const grant of capability.grants) {
    requireThat(
      grant
        && typeof grant === 'object'
        && !Array.isArray(grant)
        && Object.keys(grant).every((key) => GRANT_KEYS.includes(key))
        && Object.hasOwn(OPERATIONS, grant.operation)
        && EFFECT_CLASSES.includes(grant.class)
        && typeof grant.target === 'string'
        && grant.target.length > 0
        && grant.target.length <= 2048
        && OWNER_CATEGORIES.includes(grant.category)
        && Number.isSafeInteger(grant.maxAmount)
        && grant.maxAmount >= 0
        && (grant.ownerAuthorized === undefined || typeof grant.ownerAuthorized === 'boolean'),
      'BLOCKED invalid Execution Gate grant',
    );
  }
  requireThat(
    new Set(capability.grants.map((grant) => JSON.stringify([
      grant.operation, grant.class, grant.target, grant.category,
    ]))).size === capability.grants.length,
    'BLOCKED duplicate Execution Gate grant',
  );
  for (const key of ['omissionOverrides', 'reopenKeys']) {
    requireThat(
      capability[key] === undefined
        || (
          Array.isArray(capability[key])
          && capability[key].length <= 128
          && capability[key].every((value) => typeof value === 'string' && value.length > 0)
          && new Set(capability[key]).size === capability[key].length
        ),
      `BLOCKED invalid Execution Gate ${key}`,
    );
  }
  return capability;
}

export function validateDescriptor(descriptor) {
  requireThat(
    descriptor
      && typeof descriptor === 'object'
      && !Array.isArray(descriptor)
      && descriptor.schema === 'execution-gate.descriptor.v1'
      && Object.keys(descriptor).every((key) => DESCRIPTOR_KEYS.includes(key))
      && Object.hasOwn(OPERATIONS, descriptor.operation)
      && OPERATIONS[descriptor.operation][0] === descriptor.mode
      && OPERATIONS[descriptor.operation][1] === descriptor.route
      && ['main', 'dev-host', 'researcher', 'reviewer', 'ops'].includes(descriptor.role)
      && typeof descriptor.taskNodeId === 'string'
      && descriptor.taskNodeId.length > 0
      && Number.isSafeInteger(descriptor.epoch)
      && descriptor.epoch >= 0
      && /^[a-f0-9]{64}$/.test(descriptor.contractRevision)
      && /^[a-f0-9]{64}$/.test(descriptor.scopeHash)
      && /^[a-f0-9]{64}$/.test(descriptor.catalogHash)
      && /^[a-f0-9]{64}$/.test(descriptor.resolverHash)
      && /^[a-f0-9]{64}$/.test(descriptor.profileHash)
      && (descriptor.snapshotBase === undefined || /^[a-f0-9]{40}$/.test(descriptor.snapshotBase))
      && (descriptor.intent === null || (
        descriptor.intent
        && typeof descriptor.intent === 'object'
        && !Array.isArray(descriptor.intent)
        && JSON.stringify(descriptor.intent).length <= 4096
      ))
      && Array.isArray(descriptor.dependencies)
      && descriptor.dependencies.length <= 128
      && descriptor.dependencies.every((value) => (
        typeof value === 'string' && value.length > 0 && value.length <= 256
      ))
      && new Set(descriptor.dependencies).size === descriptor.dependencies.length
      && Array.isArray(descriptor.omissions)
      && descriptor.omissions.length <= 128
      && descriptor.omissions.every((omission) => (
        omission
          && typeof omission === 'object'
          && !Array.isArray(omission)
          && Object.keys(omission).sort().join(',') === 'id,protective,reason,state'
          && typeof omission.id === 'string'
          && omission.id.length > 0
          && omission.id.length <= 256
          && typeof omission.protective === 'boolean'
          && ['NOT_EXECUTED', 'EXECUTION_AMBIGUOUS'].includes(omission.state)
          && ['BLOCKED', 'UNKNOWN', 'OWNER_APPROVAL_REQUIRED'].includes(omission.reason)
      ))
      && Array.isArray(descriptor.immutableIds)
      && descriptor.immutableIds.length <= 128
      && descriptor.immutableIds.every((id) => (
        id
          && typeof id.path === 'string'
          && id.path.length > 0
          && /^[a-f0-9]{64}$/.test(id.sha256)
          && Object.keys(id).sort().join(',') === 'path,sha256'
      ))
      && Array.isArray(descriptor.effects)
      && descriptor.effects.length <= 128,
    'UNKNOWN descriptor',
  );
  requireThat(
    new Set(descriptor.immutableIds.map((id) => id.path)).size === descriptor.immutableIds.length,
    'UNKNOWN duplicate immutable ID',
  );
  for (const effect of descriptor.effects) validateEffect(effect);
  requireThat(
    new Set(descriptor.effects.map(effectKey)).size === descriptor.effects.length,
    'UNKNOWN duplicate effect key',
  );
  return descriptor;
}

export function validateCatalog(catalog) {
  requireThat(
    catalog?.schema === 'execution-gate.catalog.v1'
      && catalog.version === 1
      && catalog.entries
      && !Array.isArray(catalog.entries)
      && Object.keys(catalog.entries).length > 0
      && Object.keys(catalog.entries).length <= 32
      && Object.keys(catalog).sort().join(',') === 'entries,schema,version',
    'UNKNOWN catalog version',
  );
  for (const [id, entry] of Object.entries(catalog.entries)) {
    requireThat(
      Object.keys(entry).every((key) => [
        'mode', 'route', 'role', 'profile', 'enforcement', 'contentIds', 'snapshotBase',
      ].includes(key)),
      'UNKNOWN catalog field',
    );
    requireThat(
      Object.hasOwn(OPERATIONS, id)
        && OPERATIONS[id]
        && entry.mode === OPERATIONS[id][0]
        && entry.route === OPERATIONS[id][1]
        && typeof entry.profile === 'string'
        && ['main', 'dev-host', 'researcher', 'reviewer', 'ops'].includes(entry.role),
      'BLOCKED catalog route',
    );
    requireThat(
      (id !== 'source.work' || entry.role === 'dev-host')
        && (id !== 'ops.repair' || entry.role === 'ops')
        && (id !== 'audit.review' || entry.role === 'reviewer'),
      'BLOCKED specialist role ceiling',
    );
    requireThat(
      entry.snapshotBase === undefined
        || (id === 'snapshot.update' && /^[a-f0-9]{40}$/.test(entry.snapshotBase)),
      'UNKNOWN snapshot base',
    );
    requireThat(
      entry.enforcement === 'native'
        && Array.isArray(entry.contentIds)
        && entry.contentIds.length <= 128,
      'BLOCKED undeployed enforcement',
    );
    requireThat(
      new Set(entry.contentIds.map((content) => content.path)).size === entry.contentIds.length,
      'UNKNOWN duplicate content ID',
    );
    for (const content of entry.contentIds) {
      requireThat(
        content
          && Object.keys(content).sort().join(',') === 'path,sha256'
          && typeof content.path === 'string'
          && /^[a-f0-9]{64}$/.test(content.sha256),
        'UNKNOWN content ID',
      );
    }
  }
  return catalog;
}

export function selectIntent({
  toolFree = false,
  diagnosticOnly = false,
  operation,
  requestedMode,
} = {}) {
  if (toolFree) return { mode: 'CHAT', operation: null, tools: false };
  if (!operation) return { mode: diagnosticOnly ? 'READ' : 'CHAT', operation: null, tools: true };
  const item = OPERATIONS[operation];
  if (!Object.hasOwn(OPERATIONS, operation) || !item) {
    return { mode: 'UNKNOWN', operation: null, tools: false };
  }
  if (
    (diagnosticOnly || requestedMode === 'READ' || requestedMode === 'CHAT')
    && item[0] === 'OPS'
  ) return { mode: 'BLOCKED', operation: null, tools: false };
  return { mode: item[0], operation, tools: true };
}

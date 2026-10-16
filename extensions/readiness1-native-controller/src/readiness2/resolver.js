import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { digest, equal, requireThat, scopeHash } from '../contract.js';
import {
  EFFECT_CLASSES,
  selectIntent,
  validateCatalog,
  validateDescriptor,
  validateEffect,
} from './catalog.js';

export async function readPinned(id, taskRoot) {
  requireThat(
    id && path.isAbsolute(id.path) && /^[a-f0-9]{64}$/.test(id.sha256),
    'UNKNOWN artifact pin',
  );
  const real = await fs.realpath(id.path);
  const root = await fs.realpath(taskRoot);
  requireThat(
    real === id.path && real !== root && !real.startsWith(root + path.sep),
    'BLOCKED artifact in Task write scope',
  );
  const file = await fs.open(real, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await file.stat();
    requireThat(
      stat.isFile() && stat.nlink === 1 && stat.size <= 1024 * 1024,
      'BLOCKED artifact identity',
    );
    const bytes = await file.readFile();
    requireThat(
      createHash('sha256').update(bytes).digest('hex') === id.sha256,
      'BLOCKED artifact hash drift',
    );
    return {
      path: real,
      sha256: id.sha256,
      content: new TextDecoder('utf-8', { fatal: true }).decode(bytes),
    };
  } finally {
    await file.close();
  }
}

export function createResolver({
  catalog,
  build,
  profiles,
  inspectNative,
}) {
  requireThat(
    typeof inspectNative === 'function' && catalog && build && profiles,
    'missing independent resolver binding',
  );
  return Object.freeze({
    async resolve(candidate, task, record = null) {
      const catalogFile = await readPinned(catalog, task.root);
      const buildFile = await readPinned(build, task.root);
      const parsedCatalog = validateCatalog(JSON.parse(catalogFile.content));
      const entry = parsedCatalog.entries[candidate.operation];
      requireThat(
        Object.hasOwn(parsedCatalog.entries, candidate.operation) && entry,
        'UNKNOWN operation',
      );
      requireThat(Object.hasOwn(profiles, entry.profile), 'UNKNOWN profile binding');
      const intent = selectIntent({ ...candidate, requestedMode: candidate.requestedMode });
      requireThat(
        intent.mode === entry.mode && intent.tools,
        'BLOCKED Owner intent forbids tools/OPS',
      );
      const profileFile = await readPinned(profiles[entry.profile], task.root);
      const profile = JSON.parse(profileFile.content);
      requireThat(
        Object.keys(profile).every((key) => [
          'schema', 'id', 'route', 'capabilities',
        ].includes(key)),
        'UNKNOWN profile field',
      );
      requireThat(
        profile.schema === 'execution-gate.profile.v1'
          && profile.id === entry.profile
          && profile.route === entry.route
          && Array.isArray(profile.capabilities),
        'UNKNOWN enforcement profile',
      );
      const native = await inspectNative({
        catalogHash: catalog.sha256,
        resolverHash: build.sha256,
        profileHash: profileFile.sha256,
        profileId: profile.id,
      });
      requireThat(
        native?.source === 'native'
          && native.profileHash === profileFile.sha256
          && native.catalogHash === catalog.sha256
          && native.resolverHash === build.sha256
          && native.enforcement === 'accepted'
          && native.states
          && Object.keys(native.states).sort().join(',')
            === [...EFFECT_CLASSES].sort().join(','),
        'UNKNOWN native enforcement',
      );
      const effects = [];
      for (const effectClass of EFFECT_CLASSES) {
        requireThat(
          ['DENIED', 'POSSIBLE'].includes(native.states[effectClass]),
          'UNKNOWN capability',
        );
        const rows = profile.capabilities.filter((row) => row.class === effectClass);
        if (native.states[effectClass] === 'POSSIBLE') {
          requireThat(rows.length > 0, 'UNKNOWN unmodelled capability');
          for (const row of rows) {
            const effect = {
              ...row,
              target: row.target === '$TASK_ROOT' ? task.root : row.target,
              possible: true,
              provenance: 'resolver',
            };
            validateEffect(effect);
            effects.push(effect);
          }
        }
      }
      for (const row of candidate.additionalEffects ?? []) {
        const effect = {
          ...row,
          possible: true,
          provenance: 'agent-added',
        };
        validateEffect(effect);
        effects.push(effect);
      }
      const contents = [];
      for (const id of entry.contentIds) contents.push(await readPinned(id, task.root));
      if (candidate.contentIds) {
        requireThat(
          equal(candidate.contentIds, entry.contentIds),
          'BLOCKED catalog/content mismatch',
        );
      }
      requireThat(
        !candidate.profileHash || candidate.profileHash === profileFile.sha256,
        'BLOCKED candidate profile mismatch',
      );
      const descriptor = {
        schema: 'execution-gate.descriptor.v1',
        operation: candidate.operation,
        mode: entry.mode,
        route: entry.route,
        role: entry.role,
        taskNodeId: task.taskNodeId,
        epoch: record?.epoch ?? 0,
        contractRevision: task.revisionHash,
        scopeHash: scopeHash(task),
        catalogHash: catalog.sha256,
        resolverHash: build.sha256,
        profileHash: profileFile.sha256,
        ...(entry.snapshotBase ? { snapshotBase: entry.snapshotBase } : {}),
        intent: candidate.intent ?? null,
        dependencies: candidate.dependsOn ?? [],
        omissions: record?.state.gate?.omissions ?? [],
        immutableIds: contents.map(({ path: file, sha256 }) => ({ path: file, sha256 })),
        effects: effects.sort((left, right) => (
          JSON.stringify(left).localeCompare(JSON.stringify(right))
        )),
      };
      validateDescriptor(descriptor);
      return {
        descriptor,
        descriptorDigest: digest(descriptor),
        display: Object.fromEntries(EFFECT_CLASSES.map((key) => [
          key,
          effects.filter((effect) => effect.class === key),
        ])),
        immutable: {
          catalog: catalogFile,
          build: buildFile,
          profile: profileFile,
          contents,
        },
      };
    },
  });
}

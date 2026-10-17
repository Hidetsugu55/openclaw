import assert from 'node:assert/strict';
import test from 'node:test';
import { contract, makeTool } from './helpers.mjs';

test('native CAS authority binds exact Task/scope/revision/epoch/effects and spends allow-once', async () => {
  const { tool, approvalState } = makeTool();
  const first = (await tool.execute('approval-1', { action: 'approval.request', taskNodeId: contract.taskNodeId })).details;
  const duplicate = (await tool.execute('approval-2', { action: 'approval.request', taskNodeId: contract.taskNodeId })).details;
  assert.equal(duplicate.approvalId, first.approvalId);
  assert.equal(approvalState.bindings.size, 1);
  const native = approvalState.bindings.get(first.approvalId);
  const detail = JSON.parse(native.presentation.detail);
  assert.equal(detail.decisive.taskNodeId, contract.taskNodeId);
  assert.equal(detail.decisive.revision, contract.revisionHash.slice(0, 12));
  assert.equal(detail.activation.epoch, 1);
  assert.equal(detail.activation.expectedRevision, 0);
  assert.match(detail.activation.effectsDigest, /^[a-f0-9]{64}$/);
  assert.deepEqual(native.presentation.allowedDecisions, ['allow-once', 'deny']);

  const activated = (await tool.execute('activate', { action: 'activate', taskNodeId: contract.taskNodeId, expectedRevision: first.revision, approvalId: first.approvalId })).details.task;
  assert.equal(activated.status, 'ACTIVE');
  await assert.rejects(tool.execute('replay', { action: 'activate', taskNodeId: contract.taskNodeId, expectedRevision: activated.revision, approvalId: first.approvalId }), /already active|spent or unknown/);
});

test('approval mismatch, revision mismatch, and expiry fail closed', async () => {
  let clock = 1_000;
  const { tool } = makeTool({ now: () => clock });
  const requested = (await tool.execute('approval', { action: 'approval.request', taskNodeId: contract.taskNodeId })).details;
  await assert.rejects(tool.execute('wrong-id', { action: 'activate', taskNodeId: contract.taskNodeId, expectedRevision: requested.revision, approvalId: 'plugin:foreign' }), /spent or unknown/);
  await assert.rejects(tool.execute('wrong-revision', { action: 'activate', taskNodeId: contract.taskNodeId, expectedRevision: requested.revision + 1, approvalId: requested.approvalId }), /revision conflict/);
  clock = 20_000;
  await assert.rejects(tool.execute('expired', { action: 'activate', taskNodeId: contract.taskNodeId, expectedRevision: requested.revision, approvalId: requested.approvalId }), /refused or expired/);
  const status = (await tool.execute('status', { action: 'status', taskNodeId: contract.taskNodeId })).details.task;
  assert.equal(status.status, 'UNACTIVATED');
  assert.equal(status.blocker, 'OWNER_APPROVAL_REFUSED_OR_EXPIRED');
});

import { expect, test } from 'bun:test';
import {
  checkedLocalModelEndpoint,
  modelBootstrapCandidate,
  modelBootstrapUpdate,
  type ModelBootstrapIntent,
  waitForModelOwner,
} from '../../../scripts/datasets/model-bootstrap.ts';
import { ModelAlignmentTimeout, ModelWorkBudget } from '../../../scripts/fixture/model-deadline.ts';
import type { FusekiClient } from '../../../services/main/src/infrastructure/fuseki.ts';
import { sha256 } from '../../../scripts/datasets/store.ts';
import { COMMAND_MODULE_VERSION } from '../../../services/main/src/infrastructure/profile.ts';

const target = 'a'.repeat(64),
  old = 'b'.repeat(64);

test('model owner readiness retries restart failures within the shared preparation deadline', async () => {
  let attempts = 0;
  const owner = { commandHealth: async () => {
    if (++attempts < 3) throw new Error('connection refused while TDB2 opens');
    return {} as Awaited<ReturnType<FusekiClient['commandHealth']>>;
  } };
  const deadline = Date.now() + 3000, budget = new ModelWorkBudget(() => deadline - Date.now());
  try {
    await waitForModelOwner(owner, budget);
    expect(attempts).toBe(3);
  } finally { budget.close(); }
});

test('model owner readiness bounds a hung health request and stops on caller cancellation', async () => {
  for (const cancel of [false, true]) {
    const parent = new AbortController(), reason = new Error('restore cancelled');
    const deadline = Date.now() + 20, budget = new ModelWorkBudget(() => deadline - Date.now(), parent.signal);
    let attempts = 0;
    const owner = { commandHealth: () => {
      attempts++;
      if (cancel) parent.abort(reason);
      return new Promise<Awaited<ReturnType<FusekiClient['commandHealth']>>>(() => {});
    } };
    try {
      const waiting = waitForModelOwner(owner, budget);
      if (cancel) await expect(waiting).rejects.toBe(reason);
      else await expect(waiting).rejects.toBeInstanceOf(ModelAlignmentTimeout);
      expect(attempts).toBe(1);
    } finally { budget.close(); }
  }
});
function intent(): ModelBootstrapIntent {
  const generation = `urn:rezics:model-generation:${target}`;
  return {
    format: 'rezics-local-dataset-model-bootstrap-v1',
    predecessor: {
      generation: `urn:rezics:model-generation:${old}`,
      manifest: `urn:rezics:sha256:${'c'.repeat(64)}`,
      generationNumber: '1',
      predecessor: null,
      entailmentProfile: 'NoEntailment',
      receipt: `urn:rezics:receipt:${'d'.repeat(64)}`,
    },
    generation,
    modelManifestSha256: target,
    manifest: `urn:rezics:sha256:${'e'.repeat(64)}`,
    operation: 'https://rezics.com/id/00000000-0000-4000-8000-000000000001',
    receipt: `urn:rezics:receipt:${sha256(`${generation}\0model-generation`)}`,
    digest: sha256(JSON.stringify({ family: 'model-generation-v1', manifest: target })),
    lineage: { dataEpoch: 'fixture-epoch', routingEpoch: 'fixture-routing' },
    observedSequence: '100',
    generationNumber: '2',
    commandModuleVersion: COMMAND_MODULE_VERSION,
  };
}
test('model maintenance is limited to explicit loopback owner endpoints', () => {
  expect(checkedLocalModelEndpoint('http://127.0.0.1:3030/rezics/')).toContain('3030');
  for (const endpoint of [
    'http://remote.example:3030/rezics',
    'http://localhost/rezics',
    'http://user:password@localhost:3030/rezics',
    'file://localhost:3030/rezics',
  ]) {
    expect(() => checkedLocalModelEndpoint(endpoint)).toThrow();
  }
});
test('new generation retains the predecessor and strict generated no-entailment/reject posture', () => {
  const candidate = modelBootstrapCandidate(intent());
  expect(candidate).toContain(`rv:predecessor <urn:rezics:model-generation:${old}>`);
  expect(candidate).toContain('rv:generationNumber 2');
  expect(candidate).toContain('rv:sequence 101');
  expect(candidate).toContain('rv:entailmentProfile rv:NoEntailment');
  expect(candidate).toContain('rv:identityInference rv:Excluded');
  expect(candidate).toContain('rv:validationPosture rv:RejectOnViolation');
  for (const modified of [
    { generationNumber: '1' },
    { manifest: 'invalid' },
    { digest: 'wrong' },
    { operation: 'https://example.com/not-an-owner-operation' },
    { observedSequence: '-1' },
    { commandModuleVersion: 'x'.repeat(33) },
    { modelManifestSha256: 'f'.repeat(64) },
  ]) {
    expect(() => modelBootstrapCandidate({ ...intent(), ...modified })).toThrow();
  }
});
test('guarded maintenance changes only ModelComponent head and sequence, retains all old artifacts, and publishes a relay-readable zero batch', () => {
  const update = modelBootstrapUpdate(intent()),
    deleted = update.split('DELETE {')[1]!.split('INSERT {')[0]!;
  expect(deleted).not.toContain('revisions');
  expect(deleted).not.toContain('receipts');
  expect(deleted).not.toContain('outbox');
  expect(deleted).toContain('<urn:rezics:model:product> rv:generationHead');
  expect(deleted).toContain('<urn:rezics:dataset:product> rv:sequence ?n');
  expect(update).toContain('rv:dataEpoch "fixture-epoch"');
  expect(update).toContain('rv:routingEpoch "fixture-routing"');
  expect(update).toContain('rv:restoreHold true');
  expect(update).toContain('rv:expectedHead');
  expect(update).toContain('local-dataset-model-generation-bootstrap-v1');
  expect(update).toContain('rv:eventCount 0');
  expect(update).not.toContain('ModelGenerationRecordedEvent');
  expect(update).not.toContain('rv:admissionId');
  expect(update).not.toMatch(/\b(?:DROP|CLEAR|LOAD|INSERT DATA)\b/);
  expect(update).toContain('FILTER NOT EXISTS { GRAPH <urn:rezics:graph:revisions>');
  expect(update).toContain('FILTER(?otherHead !=');
});

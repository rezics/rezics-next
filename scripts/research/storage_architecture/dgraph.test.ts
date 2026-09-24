import { expect, test } from 'bun:test';
import { resolve } from 'node:path';
import { fixtureWork, oracle, sampleIds } from './fixture';

const resultPath = resolve(import.meta.dir, '../../../.temp/storage-architecture/dgraph/results.json');
async function evidence(): Promise<any> {
  const file = Bun.file(resultPath);
  if (!await file.exists()) throw new Error('Run `yarn research:architecture dgraph` before this evidence test');
  const result = await file.json();
  if (result.error || !result.completedAt) throw new Error(`Incomplete Dgraph probe: ${result.error}`);
  return result;
}

test('Dgraph fixture graph matches independent 10k Work oracle', async () => {
  const result = await evidence();
  const size = 10_000;
  expect(result.environment.version).toBe('v25.4.1');
  expect(result.checks.ingest.uidCount).toBe(size);
  expect(result.checks.relations.directedEdges).toBe(Array.from({ length: size }, (_, i) => fixtureWork(i, size).related.length).reduce((a, b) => a + b, 0));
  expect(result.checks.sampleOracle.samples.map((s: any) => s.id)).toEqual(oracle(size, sampleIds(size)).map(w => w.id));
  expect(result.checks.hop2.distinctTargets).toBeGreaterThan(0);
});

test('Dgraph claim occurrences and stored context states keep semantic distinctions', async () => {
  const result = await evidence();
  expect(result.checks.occurrences.sameOccurrenceIds).toEqual(['credit-1']);
  expect(result.checks.occurrences.variablePredicateIds).toEqual(['claim-1']);
  expect(result.checks.occurrences.allIds).toHaveLength(4);
  expect(result.checks.selection.storedCases.map((c: any) => [c.key, c.actual])).toEqual([
    ['context-absent', true], ['context-accept', true], ['context-reject', false], ['context-unavailable', 'error']
  ]);
});

test('Dgraph guarded edit persisted exactly one receipt and outbox beside immutable history', async () => {
  const result = await evidence();
  const cas = result.checks.cas;
  expect(cas.attempts).toHaveLength(8);
  expect(cas.committedAttemptCount).toBe(1);
  expect(cas.head['work.head']).toBe(2);
  expect(cas.receipt).toHaveLength(1);
  expect(cas.outbox).toHaveLength(1);
  expect(cas.outbox[0]['outbox.key']).toBe(cas.winner);
  expect(cas.exactOld.data.history).toEqual([{ 'history.rev': 1, 'history.payload': 'payload-v1' }]);
  expect(cas.retry.data.uids).toEqual({});
  expect(cas.afterFailed.data.history).toHaveLength(2);
  expect(cas.afterFailed.data.outbox).toHaveLength(1);
  expect(cas.failedMutation).toContain('not-an-int');
});

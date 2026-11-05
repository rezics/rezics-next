import { expect, test } from 'bun:test';
import { CatalogueArtifactError } from '@rezics/definitions';
import { NativeCollectionWork } from '../../src/library/collection-source-work.ts';
import { CATALOGUE_COMMAND_BOUND } from '../../src/semantic/definition-catalogue-publication-work.ts';
import {
  CATALOGUE_BODY_COST,
  catalogueBodyWork,
  catalogueOperationCost,
} from '../../src/semantic/definition-catalogue-work-cost.ts';
import { catalogueConsumerCaptureDigest } from '../../src/semantic/definition-catalogue-lifecycle.ts';

test('a malformed catalogue step can retain refusal after savepoint rollback without refunding bounded work', async () => {
  const deadline = Date.now() + 10_000,
    cost = CATALOGUE_BODY_COST.control;
  const work = new NativeCollectionWork({ reservationId: 'refusal', remaining: CATALOGUE_COMMAND_BOUND }, deadline);
  await expect(
    catalogueBodyWork(
      work,
      cost,
      async () => {
        throw new CatalogueArtifactError('corrupt', 'wrong directory range');
      },
      deadline,
    ),
  ).rejects.toThrow('wrong directory range');
  expect(work.receipt().used).toEqual(cost);
  await expect(
    catalogueBodyWork(work, catalogueOperationCost('stepRollback'), async () => 'rolled back', deadline),
  ).resolves.toBe('rolled back');
  expect(work.receipt().used.bytes).toBeGreaterThan(cost.bytes);
});

test('withdrawal identity binds the exact consumer, selector, provenance and root/owner restoration capture', () => {
  const capture = {
    root: `sha256:${'a'.repeat(64)}`,
    id: 'consumer',
    sequence: '1',
    closedGeneration: '1',
    consumer: Buffer.from('{"source":"library","key":"collection"}'),
    provenance: Buffer.from('owner-1/restore-1'),
    dependency: Buffer.from('exact-type:Book'),
    enrollmentGeneration: '1',
  };
  const expected = catalogueConsumerCaptureDigest(capture);
  for (const changed of [
    { root: `sha256:${'b'.repeat(64)}` },
    { id: 'other' },
    { sequence: '2' },
    { closedGeneration: '2' },
    { consumer: Buffer.from('other') },
    { provenance: Buffer.from('owner-2/restore-2') },
    { dependency: Buffer.from('exact-type:Movie') },
    { enrollmentGeneration: '2' },
  ])
    expect(catalogueConsumerCaptureDigest({ ...capture, ...changed })).not.toBe(expected);
  expect(catalogueConsumerCaptureDigest({ ...capture })).toBe(expected);
});

test('unexpected failure remains charged and an expired catalogue frame never invokes its body', async () => {
  const deadline = Date.now() + 10_000,
    cost = CATALOGUE_BODY_COST.control;
  const work = new NativeCollectionWork({ reservationId: 'failure', remaining: CATALOGUE_COMMAND_BOUND }, deadline);
  await expect(
    catalogueBodyWork(
      work,
      cost,
      async () => {
        throw new Error('native failure');
      },
      deadline,
    ),
  ).rejects.toThrow('native failure');
  expect(work.receipt().used).toEqual(cost);
  let invoked = false;
  await expect(
    catalogueBodyWork(
      work,
      cost,
      async () => {
        invoked = true;
      },
      deadline,
    ),
  ).rejects.toThrow('native failure');
  const expired = Date.now() - 1;
  await expect(
    catalogueBodyWork(
      new NativeCollectionWork({ reservationId: 'expired', remaining: CATALOGUE_COMMAND_BOUND }, expired),
      cost,
      async () => {
        invoked = true;
      },
      expired,
    ),
  ).rejects.toThrow();
  expect(invoked).toBe(false);
  expect(work.receipt().used).toEqual(cost);
});

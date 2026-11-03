import { expect, test } from 'bun:test';
import { createImportTransport } from '../src/import-client.ts';
import type { ClassificationAssociation } from '../src/import-contract.ts';

const subjectId = '00000000-0000-4000-8000-000000000101';
const association: ClassificationAssociation = {
  subjectId,
  candidateId: '00000000-0000-4000-8000-000000000201',
  contextId: '00000000-0000-4000-8000-000000000202',
  targetId: '00000000-0000-4000-8000-000000000203',
  property: 'wdt:P136',
  revision: 1,
  release: 'a'.repeat(64),
  qualifiersDigest: 'b'.repeat(64),
};
const digest = 'c'.repeat(64);
const observation = {
  sourceAlias: 'trusted-fixture',
  sourceRecordId: 'v123',
  sourceAssociationId: 'g12',
  asOf: '2026-11-03T00:00:00.000Z',
  sourceVersion: { kind: 'revision' as const, revision: '7' },
  attribution: 'Example classification provider',
  licence: 'Fixture-1.0',
  confidence: 2.4,
};

test('import transport posts the documented classification read, put and clear seams', async () => {
  const requests: { method: string; path: string; key: string | null; body: unknown }[] = [];
  const transport = createImportTransport({
    origin: 'https://api.importer.test',
    tokenProvider: async () => 'test-token',
    fetch: (async (request: Request) => {
      requests.push({
        method: request.method,
        path: new URL(request.url).pathname,
        key: request.headers.get('idempotency-key'),
        body: JSON.parse(await request.text()),
      });
      const path = new URL(request.url).pathname;
      if (path.endsWith(':read')) return Response.json({ items: [{ state: 'unavailable', reason: 'not_observed' }] });
      if (path.endsWith(':clear')) return Response.json({ observationDigest: digest, state: 'cleared' });
      return Response.json({ observationDigest: digest, state: 'published' });
    }) as typeof fetch,
    maxAttempts: 1,
  });

  await expect(
    transport.readSourceClassifications({ subjectId, associations: [association] }),
  ).resolves.toEqual([{ state: 'unavailable', reason: 'not_observed' }]);
  await expect(
    transport.writeSourceClassification({
      subjectId,
      association,
      value: observation,
      expectedObservation: null,
      idempotencyKey: 'classification:write-1',
    }),
  ).resolves.toEqual({ observationDigest: digest, state: 'published' });
  await expect(
    transport.clearSourceClassification({
      subjectId,
      association,
      value: {
        sourceAlias: observation.sourceAlias,
        sourceRecordId: observation.sourceRecordId,
        sourceAssociationId: observation.sourceAssociationId,
        asOf: '2026-11-04T00:00:00.000Z',
        cleared: true,
      },
      expectedObservation: digest,
      idempotencyKey: 'classification:clear-1',
    }),
  ).resolves.toEqual({ observationDigest: digest, state: 'cleared' });

  expect(requests).toEqual([
    {
      method: 'POST',
      path: `/v1/subjects/${subjectId}/source-classifications:read`,
      key: null,
      body: { associations: [association] },
    },
    {
      method: 'POST',
      path: `/v1/subjects/${subjectId}/source-classifications:put`,
      key: '"classification:write-1"',
      body: { association, expectedObservation: null, value: observation },
    },
    {
      method: 'POST',
      path: `/v1/subjects/${subjectId}/source-classifications:clear`,
      key: '"classification:clear-1"',
      body: {
        association,
        expectedObservation: digest,
        value: {
          sourceAlias: observation.sourceAlias,
          sourceRecordId: observation.sourceRecordId,
          sourceAssociationId: observation.sourceAssociationId,
          asOf: '2026-11-04T00:00:00.000Z',
          cleared: true,
        },
      },
    },
  ]);
});

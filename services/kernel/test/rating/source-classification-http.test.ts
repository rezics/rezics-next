import { afterAll, beforeAll, expect, test } from 'bun:test';
import { bundledDigest } from '@rezics/definitions/bundled';
import { GLOBAL_CONTEXT } from '../../src/semantic/definitions.ts';
import type { Statement } from '../../src/semantic/item.ts';
import { classificationQualifiersDigest } from '../../src/rating/register.ts';
import {
  createSourceStatisticLifecycleFixture,
  type SourceStatisticLifecycleFixture,
} from './source-statistic-lifecycle-fixture.ts';

let fixture: SourceStatisticLifecycleFixture;
beforeAll(async () => {
  fixture = await createSourceStatisticLifecycleFixture();
}, 180_000);
afterAll(async () => {
  await fixture?.close();
}, 180_000);

async function selected() {
  const targetId = await fixture.createSubject({ type: 'skos:Concept', labels: { en: 'Fixture concept' } });
  const subjectId = await fixture.createSubject({
    type: 'schema:Book',
    labels: { en: 'Fixture book' },
    statements: {
      'schema:keywords': [
        {
          property: { id: 'schema:keywords' },
          value: { type: 'value', content: targetId },
          qualifiers: [],
          references: [
            {
              parts: [
                {
                  property: { id: 'schema:url' },
                  value: { type: 'value', content: 'https://example.org/admitted-fixture' },
                },
              ],
            },
          ],
        },
      ],
    },
  });
  const response = await fixture.request('GET', `/v1/subjects/${subjectId}`);
  expect(response.status).toBe(200);
  const body = (await response.json()) as { subject: { statements: Record<string, Statement[]> } };
  const statement = body.subject.statements['schema:keywords']![0]!;
  return {
    subjectId,
    targetId,
    candidateId: statement.id,
    property: 'schema:keywords',
    contextId: GLOBAL_CONTEXT,
    revision: statement.rezics.revision,
    release: bundledDigest,
    qualifiersDigest: classificationQualifiersDigest(statement.qualifiers),
  };
}
const value = {
  sourceAlias: 'vndb',
  sourceRecordId: 'v17',
  sourceAssociationId: 'g12',
  confidence: 2.5,
  lie: false,
  lieCount: 0,
  asOf: '2026-11-03T00:00:00.000Z',
  sourceVersion: { kind: 'unversioned', digest: 'd'.repeat(64) },
  licence: 'LicenseRef-Authorized-Test-Figures',
  attribution: 'Authorized aggregate fixture; no live provider data',
};

test('mounted admitted aggregate publishes, reads, retries, conflicts and clears', async () => {
  const association = await selected();
  const path = `/v1/subjects/${association.subjectId}/source-classifications`;
  const intent = { association, value, expectedObservation: null };
  const key = crypto.randomUUID();
  const put = await fixture.request('POST', `${path}:put`, { body: intent, key });
  expect(put.status, await put.clone().text()).toBe(200);
  expect(put.headers.get('rezics-session-token')).toBeTruthy();
  const published = await put.json();
  const retry = await fixture.request('POST', `${path}:put`, { body: intent, key });
  expect(retry.status, await retry.clone().text()).toBe(200);
  expect((await retry.json()).observationDigest).toBe(published.observationDigest);
  const read = () =>
    fixture.request('POST', `${path}:read`, { body: { associations: [association] }, anonymous: true });
  const current = await read();
  expect(current.status, await current.clone().text()).toBe(200);
  const projection = await current.json();
  expect(projection.actions).toEqual([]);
  expect(projection.items[0]).toMatchObject({
    state: 'available',
    value: {
      provider: 'vndb',
      association,
      confidence: { state: 'available', value: 2.5 },
      lie: { state: 'available', value: false },
      lieCount: 0,
    },
  });
  expect(projection.items[0].value).not.toHaveProperty('confidenceCount');
  expect(projection.items[0].value.observation.sourceVersion).toEqual(value.sourceVersion);
  const conflict = await fixture.request('POST', `${path}:put`, {
    body: { ...intent, value: { ...value, confidence: 1 } },
  });
  expect(conflict.status).toBe(409);
  const resolved = await fixture.request('POST', `${path}:put`, {
    body: {
      ...intent,
      value: { ...value, confidence: undefined, lie: true },
      expectedObservation: published.observationDigest,
    },
  });
  expect(resolved.status, await resolved.clone().text()).toBe(200);
  const replacement = await resolved.json();
  expect(replacement.figure.confidence).toEqual({ state: 'unavailable', reason: 'not_supplied' });
  const denied = await fixture.request('POST', `${path}:put`, { body: intent, key, bearer: fixture.readerBearer });
  expect(denied.status).toBe(403);
  const cleared = await fixture.request('POST', `${path}:clear`, {
    body: {
      association,
      expectedObservation: replacement.observationDigest,
      value: {
        sourceAlias: value.sourceAlias,
        sourceRecordId: value.sourceRecordId,
        sourceAssociationId: value.sourceAssociationId,
        asOf: '2026-11-04T00:00:00.000Z',
        cleared: true,
      },
    },
  });
  expect(cleared.status, await cleared.clone().text()).toBe(200);
  expect((await (await read()).json()).items).toEqual([{ state: 'unavailable', reason: 'not_observed' }]);
}, 180_000);

test('mounted batch rejects unknown fields and 33 identities before authority work', async () => {
  const association = await selected();
  const path = `/v1/subjects/${association.subjectId}/source-classifications:read`;
  for (const body of [{ associations: [], extra: true }, { associations: Array(33).fill(association) }]) {
    expect((await fixture.request('POST', path, { body, anonymous: true })).status).toBe(400);
  }
  const empty = await fixture.request('POST', path, { body: { associations: [] }, anonymous: true });
  expect(empty.status).toBe(200);
  expect(await empty.json()).toEqual({ items: [], actions: [] });
  const full = await fixture.request('POST', path, {
    body: { associations: Array(32).fill(association) },
    anonymous: true,
  });
  expect(full.status, await full.clone().text()).toBe(200);
  expect((await full.json()).items).toHaveLength(32);
}, 180_000);

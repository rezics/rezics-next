import { afterAll, beforeAll, expect, test } from 'bun:test';
import { bundledDigest } from '@rezics/definitions/bundled';
import { routeOf } from '../../src/route/route.ts';
import { GLOBAL_CONTEXT } from '../../src/semantic/definitions.ts';
import { createContext, contextTarget } from '../../src/semantic/context.ts';
import { createHash } from 'node:crypto';
import { type Statement } from '../../src/semantic/item.ts';
import {
  createSourceClassificationProducer, classificationObservation, classificationQualifiersDigest,
  type ClassificationAssociation, type ClassificationObservation,
} from '../../src/rating/register.ts';
import { createSourceStatisticLifecycleFixture, type SourceStatisticLifecycleFixture } from './source-statistic-lifecycle-fixture.ts';

let fixture: SourceStatisticLifecycleFixture;
let producer: ReturnType<typeof createSourceClassificationProducer>;
beforeAll(async () => {
  fixture = await createSourceStatisticLifecycleFixture();
  producer = createSourceClassificationProducer({ pool: fixture.database.pool, access: fixture.access, routeKey: fixture.routeKey });
}, 180_000);
afterAll(async () => { await fixture?.close(); }, 180_000);
const deadline = () => Date.now() + 120_000;
const value: ClassificationObservation = {
  sourceAlias: 'vndb', sourceRecordId: 'v17', sourceAssociationId: 'g12',
  confidence: 2.5, lie: false, asOf: '2026-11-03T00:00:00.000Z',
  sourceVersion: { kind: 'unversioned', digest: 'd'.repeat(64) },
  licence: 'LicenseRef-Authorized-Test-Figures', attribution: 'Permitted native VNDB fixture',
};
async function actor(bearer = fixture.bearer) {
  return fixture.access.authenticate(bearer, { pool: fixture.database.pool, deadline: deadline() });
}
async function association(): Promise<ClassificationAssociation> {
  const targetId = await fixture.createSubject({ type: 'skos:Concept', labels: { en: 'Classification concept' } });
  const subjectId = await fixture.createSubject({
    type: 'schema:Book', labels: { en: 'Classified book' }, statements: {
      'schema:keywords': [{ property: { id: 'schema:keywords' },
        value: { type: 'value', content: targetId }, qualifiers: [],
        references: [{ parts: [{ property: { id: 'schema:url' },
          value: { type: 'value', content: 'https://example.org/permitted-classification' } }] }],
      }],
    },
  });
  const response = await fixture.request('GET', `/v1/subjects/${subjectId}`);
  expect(response.status, await response.clone().text()).toBe(200);
  const body = await response.json() as { subject: { statements: Record<string, Statement[]> } };
  const statement = body.subject.statements['schema:keywords']![0]!;
  return { subjectId, targetId, candidateId: statement.id, property: 'schema:keywords', contextId: GLOBAL_CONTEXT,
    revision: statement.rezics.revision, release: bundledDigest,
    qualifiersDigest: classificationQualifiersDigest(statement.qualifiers) };
}
async function put(a: ClassificationAssociation, payload = value, expectedObservation: string | null = null, key = crypto.randomUUID()) {
  return producer.put({ actor: await actor(), association: a, value: payload,
    expectedObservation, idempotencyKey: key, deadline: deadline() });
}
async function read(a: ClassificationAssociation, anonymous = true) {
  return producer.readExact({ actor: anonymous ? { kind: 'anonymous' } : await actor(),
    subjectId: a.subjectId, association: a, deadline: deadline() });
}

test('native source observations publish, replay, replace and clear without creating native votes', async () => {
  const a = await association();
  const votesBefore = await fixture.database.admin.query('SELECT count(*)::text AS n FROM rating.vote');
  const key = crypto.randomUUID();
  const first = await put(a, value, null, key);
  expect(first.value.figure.confidence).toEqual({ state: 'available', value: 2.5, unit: 'vndb-tag-rating', minExclusive: 0, max: 3 });
  expect(first.value.figure.lie).toEqual({ state: 'available', value: false, unit: 'boolean' });
  expect(first.value.figure).not.toHaveProperty('confidenceCount');
  expect(first.value.figure).not.toHaveProperty('lieCount');
  expect((await put(a, value, null, key)).replayed).toBe(true);
  expect((await put(a)).value.observationDigest).toBe(first.value.observationDigest);
  expect(await read(a)).toMatchObject({ state: 'available', value: { provider: 'vndb', association: a } });
  expect(await read(a, false)).toMatchObject({ state: 'available' });
  await expect(put(a, { ...value, confidence: 1.5 })).rejects.toMatchObject({ code: 'conflict' });
  const second = await put(a, { ...value, confidence: 1.5 }, first.value.observationDigest);
  const obsolete = await read({ ...a, revision: a.revision + 1 });
  expect(obsolete).toEqual({ state: 'unavailable', reason: 'not_found' });
  expect(await read({ ...a, qualifiersDigest: 'f'.repeat(64) })).toEqual({ state: 'unavailable', reason: 'not_found' });
  const cleared = await producer.clear({ actor: await actor(), association: a,
    expectedObservation: second.value.observationDigest, idempotencyKey: crypto.randomUUID(), deadline: deadline(),
    value: { sourceAlias: value.sourceAlias, sourceRecordId: value.sourceRecordId,
      sourceAssociationId: value.sourceAssociationId, asOf: '2026-11-04T00:00:00.000Z', cleared: true } });
  expect(await read(a)).toEqual({ state: 'unavailable', reason: 'not_observed' });
  await expect(put(a, value, cleared.value.observationDigest)).rejects.toMatchObject({ code: 'conflict' });
  expect((await fixture.database.admin.query('SELECT count(*)::text AS n FROM rating.vote')).rows).toEqual(votesBefore.rows);
  const observations = await fixture.database.admin.query(`SELECT count(*)::int AS n FROM rating.source_classification_observation
    WHERE route=$1 AND subject_id=$2`, [routeOf(a.subjectId), a.subjectId]);
  expect(observations.rows[0].n).toBe(3);
}, 180_000);

test('current Access is checked before replay and concealed associations can still be cleared by governance', async () => {
  const a = await association();
  const key = crypto.randomUUID();
  const first = await put(a, value, null, key);
  await expect(producer.put({ actor: await actor(fixture.readerBearer), association: a, value,
    expectedObservation: null, idempotencyKey: key, deadline: deadline() })).rejects.toThrow();
  await fixture.revokeWriter();
  try { await expect(put(a, value, null, key)).rejects.toThrow(); }
  finally { await fixture.restoreWriter(); }
  await fixture.database.admin.query(`INSERT INTO access.resource_denial
    (route,resource_id,subject_id,subject_role,action,reason,valid,transaction_id)
    VALUES ($1,$2,$3,'','subject:read','resource','(,)'::tstzrange,$4)`,
  [routeOf(a.subjectId), a.subjectId, fixture.actorId, crypto.randomUUID()]);
  expect(await read(a, false)).toEqual({ state: 'unavailable', reason: 'not_found' });
  const cleared = await producer.clear({ actor: await actor(), association: a, expectedObservation: first.value.observationDigest,
    idempotencyKey: crypto.randomUUID(), deadline: deadline(), value: {
      sourceAlias: value.sourceAlias, sourceRecordId: value.sourceRecordId,
      sourceAssociationId: value.sourceAssociationId, asOf: '2026-11-04T00:00:00.000Z', cleared: true,
    } });
  expect(cleared.value.state).toBe('cleared');
}, 180_000);

test('supplied-association batches enforce their limit and stale writers cannot both replace one source head', async () => {
  const a = await association();
  const first = await put(a);
  const outcomes = await Promise.allSettled([1.1, 1.2].map((confidence) =>
    put(a, { ...value, confidence, asOf: '2026-11-04T00:00:00.000Z' }, first.value.observationDigest)));
  expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1);
  expect(outcomes.filter((outcome) => outcome.status === 'rejected')).toHaveLength(1);
  const before = await fixture.database.admin.query('SELECT count(*)::text AS n FROM rating.source_classification_observation');
  await expect(producer.readBatch({ actor: { kind: 'anonymous' }, subjectId: a.subjectId,
    associations: [a, a], limit: 1, deadline: deadline() })).rejects.toThrow(RangeError);
  const rows = await producer.readBatch({ actor: { kind: 'anonymous' }, subjectId: a.subjectId,
    associations: [a], limit: 1, deadline: deadline() });
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ state: 'available' });
  expect(await producer.readBatch({ actor: { kind: 'anonymous' }, subjectId: a.subjectId,
    associations: [], limit: 1, deadline: deadline() })).toEqual([]);
  expect((await fixture.database.admin.query('SELECT count(*)::text AS n FROM rating.source_classification_observation')).rows).toEqual(before.rows);
}, 180_000);


test('facts fences hide only the bound source figure and retained clear needs no public fence read', async () => {
  const a = await association();
  const payload = { ...value, sourceRecordId: 'v4412' };
  const first = await put(a, payload);
  const fence = await fixture.request('POST', '/v1/sourceFences:takedown', { body: {
    source: payload.sourceAlias, externalId: payload.sourceRecordId, fieldGroup: 'facts', reason: 'Classification fixture',
  } });
  expect(fence.status, await fence.clone().text()).toBe(200);
  expect(await read(a)).toEqual({ state: 'unavailable', reason: 'not_found' });
  await expect(put(a, payload, null)).rejects.toMatchObject({ code: 'not_found' });
  const clear = await producer.clear({ actor: await actor(), association: a,
    expectedObservation: first.value.observationDigest, idempotencyKey: crypto.randomUUID(), deadline: deadline(),
    value: { sourceAlias: payload.sourceAlias, sourceRecordId: payload.sourceRecordId,
      sourceAssociationId: payload.sourceAssociationId, asOf: '2026-11-04T00:00:00.000Z', cleared: true } });
  expect(clear.value.state).toBe('cleared');
}, 180_000);

test('protected Context changes are rechecked and never transfer a Global observation', async () => {
  const a = await association();
  const first = await put(a);
  const command = await fixture.identityCommand('context:create');
  const key = crypto.randomUUID();
  const { context } = await createContext(fixture.database.pool, {
    ...command, target: contextTarget(fixture.routeKey, fixture.actorId, key), idempotencyKey: key,
    digest: createHash('sha256').update(key).digest(), input: { labels: { en: 'Classification Context' } },
  });
  const contextual = { ...a, contextId: context.id };
  expect(await read(contextual, false)).toEqual({ state: 'unavailable', reason: 'not_observed' });
  const imported = await put(contextual);
  await fixture.database.admin.query(`INSERT INTO access.resource_denial
    (route,resource_id,subject_id,subject_role,action,reason,valid,transaction_id)
    VALUES ($1,$2,$3,'','context:read','resource','(,)'::tstzrange,$4)`,
  [routeOf(context.id), context.id, fixture.actorId, crypto.randomUUID()]);
  expect(await read(contextual, false)).toEqual({ state: 'unavailable', reason: 'not_found' });
  expect(await read(a, false)).toMatchObject({ state: 'available', value: { observation: { digest: first.value.observationDigest } } });
  await producer.clear({ actor: await actor(), association: contextual, expectedObservation: imported.value.observationDigest,
    idempotencyKey: crypto.randomUUID(), deadline: deadline(), value: {
      sourceAlias: value.sourceAlias, sourceRecordId: value.sourceRecordId, sourceAssociationId: value.sourceAssociationId,
      asOf: '2026-11-04T00:00:00.000Z', cleared: true,
    } });
}, 180_000);

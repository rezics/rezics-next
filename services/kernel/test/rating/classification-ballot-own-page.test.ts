import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { createRealAccess, type RealAccessFixture } from '../semantic/real-access.ts';
import { openGrowthDatabase, type GrowthDatabase } from '../support/growth.ts';
import { createKernel } from '../../src/http/kernel.ts';
import { routeOf } from '../../src/route/route.ts';
import { bundledRelease } from '@rezics/definitions/bundled';
import { bootstrapRelease, GLOBAL_CONTEXT } from '../../src/semantic/definitions.ts';
import type { KeyRing } from '../../src/tokens/seal.ts';

const accounts = {
  owner: '019a1b2c-3d4e-7f00-8a00-5ab1ec702001',
  other: '019a1b2c-3d4e-7f00-8a00-5ab1ec702002',
} as const;
type Persona = keyof typeof accounts;
type TestSubject = { id: string; statements: Record<string, Array<{ id: string }>> };
const actions = [
  'subject:create',
  'subject:read',
  'classification_ballot:set',
  'classification_ballot:read-own',
  'classification_ballot:read-aggregate',
];
const routeKey = new Uint8Array(32).fill(31);
const tokens: KeyRing = { current: 1, keys: new Map([[1, new Uint8Array(32).fill(23)]]) };
const receiptKeys: KeyRing = { current: 1, keys: new Map([[1, new Uint8Array(32).fill(17)]]) };
let database: GrowthDatabase;
let realAccess: RealAccessFixture<Persona>;
let app: ReturnType<typeof createKernel>;

beforeAll(async () => {
  database = await openGrowthDatabase();
  database.pool.options.max = 1;
  await bootstrapRelease(database.pool, bundledRelease);
  realAccess = await createRealAccess(database.admin, accounts, actions, {
    credentialClock: () => new Date(Date.now() - 1_000),
  });
  app = createKernel({
    pool: database.pool,
    access: realAccess.access,
    tokens,
    receiptKeys,
    routeKey,
    writeRate: realAccess.writeRate,
  });
  await realAccess.grant({ route: 0, id: GLOBAL_CONTEXT }, 'owner', 'subject:create');
}, 180_000);

afterAll(async () => {
  await database?.close();
}, 180_000);

function request(persona: Persona, method: string, path: string, body?: unknown, idempotencyKey = randomUUID()) {
  return app.handle(
    new Request(`http://kernel.test${path}`, {
      method,
      headers: {
        authorization: `Bearer ${realAccess.bearer(persona)}`,
        ...(method === 'GET' ? {} : { 'idempotency-key': JSON.stringify(idempotencyKey) }),
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  );
}

async function responseJson(response: Response, status = 200): Promise<Record<string, any>> {
  if (response.status !== status)
    throw new Error(`Expected HTTP ${status}, received ${response.status}: ${await response.clone().text()}`);
  return response.json() as Promise<Record<string, any>>;
}

async function createSubject(body: Record<string, unknown>): Promise<TestSubject> {
  const response = await responseJson(await request('owner', 'POST', '/v1/subjects', body), 201);
  return response.subject as TestSubject;
}

async function setBallot(
  subjectId: string,
  associationId: string,
  assessment: 'support' | 'oppose',
  falsePositive: boolean,
) {
  return responseJson(
    await request('owner', 'PUT', `/v1/subjects/${subjectId}/classification-associations/${associationId}/assessment`, {
      assessment,
      falsePositive,
    }),
  );
}

async function hideSubject(subjectId: string): Promise<void> {
  const result = await database.admin.query(
    `UPDATE semantic.subject SET visibility = 'hidden', security_revision = security_revision + 1
     WHERE route = $1 AND subject_id = $2 AND visibility = 'visible'`,
    [routeOf(subjectId), subjectId],
  );
  expect(result.rowCount).toBe(1);
}

test('the page keeps owner selection private, distinguishes stale writes, and completes withdrawal', async () => {
  const target = await createSubject({ type: 'skos:Concept', labels: { en: 'Own-page concept' } });
  const subject = await createSubject({
    type: 'schema:Book',
    labels: { en: 'Own-page subject' },
    statements: {
      'schema:keywords': [
        { property: { id: 'schema:keywords' }, value: { type: 'value', content: target.id }, qualifiers: [] },
      ],
    },
  });
  const associationId = subject.statements['schema:keywords']![0]!.id;
  await setBallot(subject.id, associationId, 'support', true);

  const page = await responseJson(await request('owner', 'GET', '/v1/me/classification-assessments'));
  expect(page).toMatchObject({
    viewer: { accountId: accounts.owner },
    inventory: { kind: 'current-retained', complete: false },
    items: [
      {
        state: 'available',
        subjectId: subject.id,
        associationId,
        association: {
          targetId: target.id,
          property: 'schema:keywords',
          contextId: GLOBAL_CONTEXT,
          origin: 'global',
        },
        own: { assessment: 'support', falsePositive: true, revision: '1', pending: 'pending' },
        aggregate: { state: 'suppressed' },
        actions: {
          state: 'editable',
          readback: expect.any(String),
          clear: expect.any(String),
          set: expect.any(String),
        },
      },
    ],
    traversal: 'complete',
    next: null,
  });
  expect(page.items[0].aggregate).not.toHaveProperty('supportCount');
  expect(page.items[0]).not.toHaveProperty('sourceFigure');
  expect((await responseJson(await request('other', 'GET', '/v1/me/classification-assessments'))).items).toEqual([]);

  const staleSet = page.items[0].actions.set as string;
  const changeKey = randomUUID();
  expect(
    (
      await responseJson(
        await request('owner', 'PUT', staleSet, { assessment: 'oppose', falsePositive: false }, changeKey),
      )
    ).revision,
  ).toBe('2');
  expect(
    (
      await responseJson(
        await request('owner', 'PUT', staleSet, { assessment: 'oppose', falsePositive: false }, changeKey),
      )
    ).revision,
  ).toBe('2');
  expect((await request('owner', 'PUT', staleSet, { assessment: 'support', falsePositive: false })).status).toBe(409);
  const current = await responseJson(await request('owner', 'GET', '/v1/me/classification-assessments'));
  const clear = current.items[0].actions.clear as string;
  expect(current.items[0].own).toEqual({
    assessment: 'oppose',
    falsePositive: false,
    revision: '2',
    pending: 'pending',
  });
  const clearKey = randomUUID();
  expect((await request('owner', 'DELETE', clear, undefined, clearKey)).status).toBe(204);
  expect((await request('owner', 'DELETE', clear, undefined, clearKey)).status).toBe(204);
  expect((await responseJson(await request('owner', 'GET', '/v1/me/classification-assessments'))).items).toEqual([]);
  expect((await app.handle(new Request('http://kernel.test/v1/me/classification-assessments'))).status).toBe(401);
}, 180_000);

test('a retained ballot after association loss has no restored label and only offers permitted withdrawal', async () => {
  const target = await createSubject({ type: 'skos:Concept', labels: { en: 'Hidden concept label' } });
  const subject = await createSubject({
    type: 'schema:Book',
    labels: { en: 'Hidden work label' },
    statements: {
      'schema:keywords': [
        { property: { id: 'schema:keywords' }, value: { type: 'value', content: target.id }, qualifiers: [] },
      ],
    },
  });
  const associationId = subject.statements['schema:keywords']![0]!.id;
  await setBallot(subject.id, associationId, 'oppose', false);
  await hideSubject(subject.id);

  const page = await responseJson(await request('owner', 'GET', '/v1/me/classification-assessments'));
  expect(page.items).toHaveLength(1);
  expect(page.items[0]).toMatchObject({
    state: 'withheld',
    subjectId: subject.id,
    associationId,
    subject: null,
    target: null,
    association: null,
    own: { assessment: 'oppose' },
    aggregate: null,
    actions: { state: 'withdraw-only', readback: null, set: null, clear: expect.any(String) },
  });
  expect(JSON.stringify(page)).not.toContain('Hidden work label');
  expect(JSON.stringify(page)).not.toContain('Hidden concept label');
  expect((await request('owner', 'DELETE', page.items[0].actions.clear as string)).status).toBe(204);
});

test('the page continues from raw keys and promotes an exact selected slot once', async () => {
  const targets: TestSubject[] = [];
  for (let index = 0; index < 21; index++)
    targets.push(await createSubject({ type: 'skos:Concept', labels: { en: `Page concept ${index}` } }));
  const subject = await createSubject({
    type: 'schema:Book',
    labels: { en: 'Paged classification subject' },
    statements: {
      'schema:keywords': targets.map((target) => ({
        property: { id: 'schema:keywords' },
        value: { type: 'value', content: target.id },
        qualifiers: [],
      })),
    },
  });
  const associationIds = subject.statements['schema:keywords']!.map((statement) => statement.id);
  for (const associationId of associationIds) await setBallot(subject.id, associationId, 'support', false);

  const first = await responseJson(await request('owner', 'GET', '/v1/me/classification-assessments'));
  expect(first.items).toHaveLength(20);
  expect(first.traversal).toBe('more');
  const second = await responseJson(
    await request(
      'owner',
      'GET',
      `/v1/me/classification-assessments?cursor=${encodeURIComponent(first.next as string)}`,
    ),
  );
  expect(second.items).toHaveLength(1);
  expect(second.traversal).toBe('complete');
  expect(
    (
      await request(
        'other',
        'GET',
        `/v1/me/classification-assessments?cursor=${encodeURIComponent(first.next as string)}`,
      )
    ).status,
  ).toBe(400);

  const selectedAssociationId = associationIds[20]!;
  const promoted = await responseJson(
    await request(
      'owner',
      'GET',
      `/v1/me/classification-assessments?selectedSubjectId=${subject.id}&selectedAssociationId=${selectedAssociationId}`,
    ),
  );
  expect(promoted.items).toHaveLength(21);
  expect(
    promoted.items.filter(
      (item: { subjectId: string; associationId: string }) =>
        item.subjectId === subject.id && item.associationId === selectedAssociationId,
    ),
  ).toHaveLength(1);
  expect(promoted.items.every((item: Record<string, unknown>) => !('sourceFigure' in item))).toBe(true);
}, 240_000);

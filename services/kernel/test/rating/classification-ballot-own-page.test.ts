import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { createRealAccess, type RealAccessFixture } from '../semantic/real-access.ts';
import { openGrowthDatabase, type GrowthDatabase } from '../support/growth.ts';
import { createKernel } from '../../src/http/kernel.ts';
import { partitionOf, routeOf } from '../../src/route/route.ts';
import { readPartition } from '../../src/partition/partition.ts';
import { createClassificationBallotOwnPageReader } from '../../src/rating/classification-ballot-own-page.ts';
import { bundledRelease } from '@rezics/definitions/bundled';
import { bootstrapRelease, GLOBAL_CONTEXT } from '../../src/semantic/definitions.ts';
import type { KeyRing } from '../../src/tokens/seal.ts';
import { encodeCursor } from '../../src/tokens/cursor.ts';

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

function ownPageBinding(generation: string | null) {
  return {
    operation: 'rating.own-classification-ballots-page',
    parameters: {
      actor: accounts.owner,
      client: 'web',
      delegator: null,
      authnEpoch: 1,
      scopes: JSON.stringify([...actions].sort()),
      actorGeneration: generation,
      selectedSubject: null,
      selectedAssociation: null,
      order: 'subject-association.v1',
    },
  };
}

async function delegatedBearer(requestedBy: string) {
  const previousFetch = realAccess.auth.fetch;
  if (!previousFetch) throw new Error('Missing test JWKS fetch');
  const signing = await generateKeyPair('ES256', { extractable: true });
  const jwk = { ...(await exportJWK(signing.publicKey)), kid: 'classification-delegated', alg: 'ES256' };
  realAccess.auth.fetch = async (input, init) => {
    const response = await previousFetch(input, init);
    const document = (await response.json()) as { keys: unknown[] };
    return Response.json({ ...document, keys: [...document.keys, jwk] });
  };
  const now = Math.floor(Date.now() / 1000);
  const token = await new SignJWT({
    client_id: 'web',
    scope: actions.join(' '),
    authn_epoch: 1,
    auth_time: now,
    amr: ['pwd'],
    requested_by: requestedBy,
  })
    .setProtectedHeader({ alg: 'ES256', kid: 'classification-delegated', typ: 'at+jwt' })
    .setIssuer(realAccess.auth.issuer)
    .setAudience(realAccess.auth.audience)
    .setSubject(accounts.owner)
    .setIssuedAt(now)
    .setExpirationTime(now + 300)
    .sign(signing.privateKey);
  return { token, restore: () => (realAccess.auth.fetch = previousFetch) };
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
  const staleClear = page.items[0].actions.clear as string;
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
  expect((await request('owner', 'DELETE', staleClear)).status).toBe(409);
  const current = await responseJson(await request('owner', 'GET', '/v1/me/classification-assessments'));
  const clear = current.items[0].actions.clear as string;
  expect(current.items[0].own).toEqual({
    assessment: 'oppose',
    falsePositive: false,
    revision: '2',
    pending: 'pending',
  });
  const savedActions = [...actions];
  actions.splice(0, actions.length, ...savedActions.filter((action) => action !== 'classification_ballot:set'));
  await realAccess.renew('owner');
  try {
    const readOnly = await responseJson(await request('owner', 'GET', '/v1/me/classification-assessments'));
    expect(readOnly.items[0].actions).toMatchObject({ state: 'read-only', set: null, clear: null });
    expect((await request('owner', 'DELETE', current.items[0].actions.clear as string)).status).toBe(403);
  } finally {
    actions.splice(0, actions.length, ...savedActions);
    await realAccess.renew('owner');
  }
  const clearKey = randomUUID();
  await request('owner', 'DELETE', clear, undefined, clearKey);
  expect((await request('owner', 'DELETE', clear, undefined, clearKey)).status).toBe(204);
  expect((await responseJson(await request('owner', 'GET', '/v1/me/classification-assessments'))).items).toEqual([]);
  const otherRoute = routeOf(accounts.other)!;
  await database.admin.query('UPDATE access.account SET minimum_authn_epoch=2 WHERE route=$1 AND account_id=$2', [
    otherRoute,
    accounts.other,
  ]);
  try {
    expect((await request('other', 'GET', '/v1/me/classification-assessments')).status).toBe(401);
  } finally {
    await database.admin.query('UPDATE access.account SET minimum_authn_epoch=1 WHERE route=$1 AND account_id=$2', [
      otherRoute,
      accounts.other,
    ]);
  }
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
  const rebound = await database.admin.query(
    `UPDATE rating.classification_ballot SET binding_hash=decode($5,'hex')
     WHERE route=$1 AND actor_id=$2 AND subject_id=$3 AND association_id=$4`,
    [routeOf(accounts.owner), accounts.owner, subject.id, associationId, 'f'.repeat(64)],
  );
  expect(rebound.rowCount).toBe(1);
  const mismatch = await responseJson(await request('owner', 'GET', '/v1/me/classification-assessments'));
  expect(mismatch.items[0]).toMatchObject({
    state: 'withheld',
    subject: null,
    target: null,
    association: null,
    aggregate: null,
    actions: { state: 'withheld', readback: null, set: null, clear: null },
  });
  expect(
    (
      await request(
        'owner',
        'DELETE',
        `/v1/subjects/${subject.id}/classification-associations/${associationId}/assessment?expectedRevision=1`,
      )
    ).status,
  ).toBe(404);
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
  const clearPath = page.items[0].actions.clear as string;
  const clearKey = randomUUID();
  await request('owner', 'DELETE', clearPath, undefined, clearKey);
  expect((await request('owner', 'DELETE', clearPath, undefined, clearKey)).status).toBe(204);
  expect((await responseJson(await request('owner', 'GET', '/v1/me/classification-assessments'))).items).toEqual([]);
});

test('the page continues from raw keys and promotes an exact selected slot once', async () => {
  const targets: TestSubject[] = [];
  for (let index = 0; index < 22; index++)
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
  const home = await readPartition(database.admin, partitionOf(routeOf(accounts.owner)!)!);
  expect(home).not.toBeNull();
  const stale = encodeCursor(
    tokens,
    ownPageBinding(first.inventory.generation as string),
    { epoch: home!.epoch + 1, after: [subject.id, associationIds[0]!] },
  );
  expect(
    (
      await request('owner', 'GET', `/v1/me/classification-assessments?cursor=${encodeURIComponent(stale)}`)
    ).status,
  ).toBe(409);
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

  const reader = createClassificationBallotOwnPageReader({
    pool: database.pool,
    access: realAccess.access({ actions: new Map() }),
    tokens,
    routeKey,
  });
  const actor = {
    kind: 'account' as const,
    accountId: accounts.owner,
    clientId: 'web',
    scopes: [...actions],
    requestedBy: null,
    authnEpoch: 1,
  };
  for (const changed of [
    { ...actor, clientId: 'desktop' },
    { ...actor, requestedBy: `urn:rezics:request:${accounts.other}:${randomUUID()}` },
    { ...actor, authnEpoch: 2 },
    { ...actor, scopes: [...actor.scopes, 'classification_ballot:read-aggregate'] },
  ])
    await expect(reader.page(changed, { cursor: first.next as string }, Date.now() + 30_000)).rejects.toThrow();
  const delegated = await delegatedBearer(`urn:rezics:request:${accounts.other}:${randomUUID()}`);
  try {
    expect(
      (
        await app.handle(
          new Request(`http://kernel.test/v1/me/classification-assessments?cursor=${encodeURIComponent(first.next)}`, {
            headers: { authorization: `Bearer ${delegated.token}` },
          }),
        )
      ).status,
    ).toBe(401);
  } finally {
    delegated.restore();
  }

  const selectedAssociationId = associationIds[20]!;
  const promoted = await responseJson(
    await request(
      'owner',
      'GET',
      `/v1/me/classification-assessments?selectedSubjectId=${subject.id}&selectedAssociationId=${selectedAssociationId}`,
    ),
  );
  expect(promoted.items).toHaveLength(21);
  expect(promoted.traversal).toBe('more');
  expect(
    promoted.items.filter(
      (item: { subjectId: string; associationId: string }) =>
        item.subjectId === subject.id && item.associationId === selectedAssociationId,
    ),
  ).toHaveLength(1);
  expect(promoted.items.every((item: Record<string, unknown>) => !('sourceFigure' in item))).toBe(true);
  const selectedSecond = await responseJson(
    await request(
      'owner',
      'GET',
      `/v1/me/classification-assessments?selectedSubjectId=${subject.id}&selectedAssociationId=${selectedAssociationId}&cursor=${encodeURIComponent(promoted.next as string)}`,
    ),
  );
  expect(selectedSecond.items).toHaveLength(1);
  expect(selectedSecond.items[0]).not.toMatchObject({ subjectId: subject.id, associationId: selectedAssociationId });
  expect(selectedSecond.traversal).toBe('complete');
  expect(
    (
      await request(
        'owner',
        'GET',
        `/v1/me/classification-assessments?selectedSubjectId=${subject.id}&selectedAssociationId=${associationIds[0]}&cursor=${encodeURIComponent(promoted.next as string)}`,
      )
    ).status,
  ).toBe(400);
}, 240_000);

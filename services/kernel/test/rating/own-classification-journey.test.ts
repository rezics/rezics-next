import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { bundledDigest, bundledRelease } from '@rezics/definitions/bundled';
import { createRealAccess, type RealAccessFixture } from '../semantic/real-access.ts';
import { assertGrowthAccessPaths, checkGrowth, openGrowthDatabase, type GrowthDatabase } from '../support/growth.ts';
import { createKernel } from '../../src/http/kernel.ts';
import { GLOBAL_CONTEXT, bootstrapRelease } from '../../src/semantic/definitions.ts';
import { newId, routeOf } from '../../src/route/route.ts';
import { createClassificationBallotOwnPageReader } from '../../src/rating/classification-ballot-own-page.ts';
import type { AccountActor } from '../../src/request/access.ts';
import type { KeyRing } from '../../src/tokens/seal.ts';

const actions = [
  'subject:create',
  'subject:read',
  'classification_ballot:set',
  'classification_ballot:read_own',
  'classification_ballot:read_aggregate',
];
const routeKey = new Uint8Array(32).fill(53);
const tokens: KeyRing = { current: 1, keys: new Map([[1, new Uint8Array(32).fill(41)]]) };
const receiptKeys: KeyRing = { current: 1, keys: new Map([[1, new Uint8Array(32).fill(37)]]) };

test('own classification retains exact private state, current advice, same-key replay and bounded growth', async () => {
  const ownerId = newId(0x6a20);
  const otherId = newId(0x6a20);
  const accounts = { owner: ownerId, other: otherId } as const;
  const database = await openGrowthDatabase();
  database.pool.options.max = 1;
  let realAccess: RealAccessFixture<'owner' | 'other'> | undefined;
  try {
    await bootstrapRelease(database.pool, bundledRelease);
    realAccess = await createRealAccess(database.admin, accounts, actions, {
      credentialClock: () => new Date(Date.now() - 1_000),
    });
    const app = createKernel({
      pool: database.pool,
      access: realAccess.access,
      tokens,
      receiptKeys,
      routeKey,
      writeRate: realAccess.writeRate,
    });
    await realAccess.grant({ route: routeOf(GLOBAL_CONTEXT)!, id: GLOBAL_CONTEXT }, 'owner', 'subject:create');
    const request = (persona: 'owner' | 'other', method: string, path: string, body?: unknown, key = randomUUID()) =>
      app.handle(
        new Request(`http://kernel.test${path}`, {
          method,
          headers: {
            authorization: `Bearer ${realAccess!.bearer(persona)}`,
            ...(method === 'GET' ? {} : { 'idempotency-key': JSON.stringify(key) }),
            ...(body === undefined ? {} : { 'content-type': 'application/json' }),
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        }),
      );
    const json = async (response: Response, status = 200) => {
      if (response.status !== status)
        throw new Error(`Expected HTTP ${status}, received ${response.status}: ${await response.clone().text()}`);
      return response.json() as Promise<Record<string, any>>;
    };
    const createSubject = async (body: Record<string, unknown>) =>
      (await json(await request('owner', 'POST', '/v1/subjects', body), 201)).subject as {
        id: string;
        statements: Record<string, Array<{ id: string }>>;
      };
    const pagePath = '/v1/me/classification-assessments';
    const empty = await json(await request('owner', 'GET', pagePath));
    expect(empty).toMatchObject({ items: [], traversal: 'complete', next: null });

    const targets = [] as Array<{ id: string }>;
    for (let index = 0; index < 22; index++)
      targets.push(await createSubject({ type: 'skos:Concept', labels: { en: `Recorded concept ${index}` } }));
    const subject = await createSubject({
      type: 'schema:Book',
      labels: { en: 'Recorded own-page subject' },
      statements: {
        'schema:keywords': targets.map((target) => ({
          property: { id: 'schema:keywords' },
          value: { type: 'value', content: target.id },
          qualifiers: [],
        })),
      },
    });
    const associationIds = subject.statements['schema:keywords']!.map(({ id }) => id);
    const subjectRoute = routeOf(subject.id)!;
    for (const action of actions.slice(1))
      await realAccess.grant({ route: subjectRoute, id: subject.id }, 'owner', action);
    for (const target of targets)
      await realAccess.grant({ route: routeOf(target.id)!, id: target.id }, 'owner', 'subject:read');
    const setBallot = (associationId: string) =>
      request('owner', 'PUT', `/v1/subjects/${subject.id}/classification-associations/${associationId}/assessment`, {
        assessment: 'support',
        falsePositive: false,
      });
    for (const associationId of associationIds) await json(await setBallot(associationId));

    const first = await json(await request('owner', 'GET', pagePath));
    expect(first.viewer.accountId).toBe(ownerId);
    expect(first.items).toHaveLength(20);
    expect(first.traversal).toBe('more');
    expect(first.next).toEqual(expect.any(String));
    const selectedAssociation = associationIds[20]!;
    const selected = await json(
      await request(
        'owner',
        'GET',
        `${pagePath}?selectedSubjectId=${subject.id}&selectedAssociationId=${selectedAssociation}`,
      ),
    );
    expect(selected.items).toHaveLength(21);
    expect(
      selected.items.filter(
        (item: { subjectId: string; associationId: string }) =>
          item.subjectId === subject.id && item.associationId === selectedAssociation,
      ),
    ).toHaveLength(1);
    const continuation = await json(
      await request('owner', 'GET', `${pagePath}?cursor=${encodeURIComponent(first.next as string)}`),
    );
    expect(continuation.items).toHaveLength(2);
    expect(continuation.traversal).toBe('complete');
    expect(
      (await request('other', 'GET', `${pagePath}?cursor=${encodeURIComponent(first.next as string)}`)).status,
    ).toBe(400);

    const actor: AccountActor = {
      kind: 'account',
      accountId: ownerId,
      clientId: 'web',
      scopes: [...actions],
      requestedBy: null,
      authnEpoch: 1,
    };
    const reader = createClassificationBallotOwnPageReader({
      pool: database.pool,
      access: realAccess.access({ actions: new Map() }),
      tokens,
      routeKey,
    });
    const base = '80000000-0000-8000-8000-';
    const release = bundledDigest;
    const growthAxes = ['ballots', 'associations', 'identity-history', 'authority'] as const;
    for (const axis of growthAxes) {
      const suffix = crypto.randomUUID().replaceAll('-', '').slice(0, 4);
      const report = await checkGrowth(database, {
        name: `own classification page under independent ${axis} growth`,
        scales: [256, 1024, 4096],
        repetitions: 2,
        includeBackends: true,
        bounds: { rows: 'constant', statements: 'constant', blocks: 'logarithmic' },
        indexProbes: 256,
        grow: async (_db, scale, previous) => {
          if (axis === 'ballots')
            await database.admin.query(
              `INSERT INTO rating.classification_ballot
                 (route, actor_id, subject_id, association_id, binding_hash, assessment, false_positive, revision,
                  eligibility_generation, eligible)
               SELECT $1, $2,
                      ($3 || lpad(to_hex(n * 2), 8, '0') || $4)::uuid,
                      ($3 || lpad(to_hex(n * 2 + 1), 8, '0') || $4)::uuid,
                      decode(repeat('a', 64), 'hex'), 'support', false, 1, 1, true
               FROM generate_series($5::int, $6::int) AS n`,
              [routeOf(ownerId), ownerId, base, suffix, previous + 1, scale],
            );
          else if (axis === 'associations')
            await database.admin.query(
              `INSERT INTO semantic.candidate
                 (route, subject_id, candidate_id, slot_id, property, rank, statement, release, revision, origin,
                  view_order, relation)
               SELECT 32768, ($1 || lpad(to_hex(n * 2), 8, '0') || $2)::uuid,
                      ($1 || lpad(to_hex(n * 2 + 1), 8, '0') || $2)::uuid,
                      ($1 || lpad(to_hex(n * 2 + 1), 8, '0') || $2)::uuid,
                      'schema:keywords', 'normal', '{}'::jsonb, $3, 1, 'compact', 0, false
               FROM generate_series($4::int, $5::int) AS n`,
              [base, suffix, release, previous + 1, scale],
            );
          else if (axis === 'identity-history')
            await database.admin.query(
              `INSERT INTO semantic.revision (route, subject_id, revision, kind, release, recorded_transaction_id)
               SELECT 32768, ($1 || lpad(to_hex(n), 8, '0') || $2)::uuid, n, 'identity', $3, gen_random_uuid()
               FROM generate_series($4::int, $5::int) AS n`,
              [base, suffix, release, previous + 1, scale],
            );
          else
            await database.admin.query(
              `INSERT INTO access.resource_denial
                 (route, resource_id, subject_id, subject_role, action, reason, valid, transaction_id)
               SELECT 32768, ($1 || lpad(to_hex(n), 8, '0') || $2)::uuid, $3, '',
                      'classification_ballot:read_own', 'resource',
                      tstzrange('2000-01-01T00:00:00Z'::timestamptz + n * interval '3 days',
                                '2000-01-02T00:00:00Z'::timestamptz + n * interval '3 days', '[)'), gen_random_uuid()
               FROM generate_series($4::int, $5::int) AS n`,
              [base, suffix, ownerId, previous + 1, scale],
            );
        },
        operation: async () => {
          const observation = await reader.page(actor, {}, Date.now() + 30_000);
          expect(observation.items).toHaveLength(20);
          expect(observation.traversal).toBe('more');
          expect(observation.next).toEqual(expect.any(String));
          return observation;
        },
      });
      const relations = [
        ...new Set(
          report.samples.flatMap(({ repetitions }) => repetitions.flatMap(({ relations }) => Object.keys(relations))),
        ),
      ];
      assertGrowthAccessPaths(report.name, report.samples, relations);
      for (const sample of report.samples) {
        expect(sample.backendRepetitions).toHaveLength(2);
        for (const cost of sample.repetitions) {
          expect(cost.rows).toBeGreaterThan(0);
          expect(cost.statements).toBeGreaterThan(0);
          expect(cost.blocks).toBeGreaterThan(0);
          expect(cost.failedStatements ?? {}).toEqual({});
        }
      }
    }

    const savedActions = [...actions];
    actions.splice(0, actions.length, ...savedActions.filter((action) => action !== 'classification_ballot:set'));
    await realAccess.revoke({ route: subjectRoute, id: subject.id }, 'owner', 'classification_ballot:set');
    await realAccess.renew('owner');
    try {
      const readonly = await json(await request('owner', 'GET', pagePath));
      expect(readonly.items[0].actions).toMatchObject({ state: 'read-only', set: null, clear: null });
    } finally {
      actions.splice(0, actions.length, ...savedActions);
      await realAccess.grant({ route: subjectRoute, id: subject.id }, 'owner', 'classification_ballot:set');
      await realAccess.renew('owner');
    }

    const firstAssociation = associationIds[0]!;
    const originalBinding = first.items[0].association.bindingHash as string;
    const bindingChange = await database.admin.query(
      `UPDATE rating.classification_ballot SET binding_hash=decode($5,'hex')
       WHERE route=$1 AND actor_id=$2 AND subject_id=$3 AND association_id=$4`,
      [routeOf(ownerId), ownerId, subject.id, firstAssociation, 'f'.repeat(64)],
    );
    expect(bindingChange.rowCount).toBe(1);
    const mismatch = await json(
      await request(
        'owner',
        'GET',
        `${pagePath}?selectedSubjectId=${subject.id}&selectedAssociationId=${firstAssociation}`,
      ),
    );
    expect(mismatch.items[0]).toMatchObject({
      state: 'withheld',
      subject: null,
      target: null,
      association: null,
      aggregate: null,
      actions: { state: 'withheld', set: null, clear: null, readback: null },
    });
    await database.admin.query(
      `UPDATE rating.classification_ballot SET binding_hash=decode($5,'hex')
       WHERE route=$1 AND actor_id=$2 AND subject_id=$3 AND association_id=$4`,
      [routeOf(ownerId), ownerId, subject.id, firstAssociation, originalBinding],
    );

    await database.admin.query(
      `UPDATE semantic.subject SET visibility='hidden', security_revision=security_revision+1
       WHERE route=$1 AND subject_id=$2`,
      [subjectRoute, subject.id],
    );
    const hiddenSelection = await json(
      await request(
        'owner',
        'GET',
        `${pagePath}?selectedSubjectId=${subject.id}&selectedAssociationId=${firstAssociation}`,
      ),
    );
    expect(hiddenSelection.items[0]).toMatchObject({
      state: 'withheld',
      subject: null,
      target: null,
      association: null,
      aggregate: null,
      actions: { state: 'withdraw-only', set: null, clear: expect.any(String), readback: null },
    });
    const clearPath = hiddenSelection.items[0].actions.clear as string;
    actions.splice(0, actions.length, ...savedActions.filter((action) => action !== 'classification_ballot:set'));
    await realAccess.revoke({ route: subjectRoute, id: subject.id }, 'owner', 'classification_ballot:set');
    await realAccess.renew('owner');
    try {
      const sparse = await json(await request('owner', 'GET', pagePath));
      expect(sparse).toMatchObject({ items: [], traversal: 'more', next: expect.any(String) });
      const sparseContinuation = await json(
        await request('owner', 'GET', `${pagePath}?cursor=${encodeURIComponent(sparse.next as string)}`),
      );
      expect(sparseContinuation).toMatchObject({ items: [], traversal: 'complete', next: null });
    } finally {
      actions.splice(0, actions.length, ...savedActions);
      await realAccess.grant({ route: subjectRoute, id: subject.id }, 'owner', 'classification_ballot:set');
      await realAccess.renew('owner');
    }
    const clearKey = randomUUID();
    // The first response is intentionally discarded to model a lost acknowledgment.
    await request('owner', 'DELETE', clearPath, undefined, clearKey);
    expect((await request('owner', 'DELETE', clearPath, undefined, clearKey)).status).toBe(204);
    expect((await json(await request('owner', 'GET', pagePath))).items).toHaveLength(21);
  } finally {
    await database.close();
  }
}, 1_800_000);

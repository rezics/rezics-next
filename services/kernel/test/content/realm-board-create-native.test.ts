import { afterAll, beforeAll, expect, test } from 'bun:test';
import { readConceptSchemeReference } from '../../src/semantic/concept-scheme-reference.ts';
import { newId, routeOf } from '../../src/route/route.ts';
import { GLOBAL_CONTEXT } from '../../src/semantic/definitions.ts';
import { SubjectRedirectError } from '../../src/semantic/merges.ts';
import { ACCESS_EVIDENCE_TTL_MS } from '../../src/access/evidence-deadline.ts';
import { observeSql } from './support/sql-observer.ts';
import readVisibility from '../../src/semantic/read-visibility.sql';
import { realmBoardWorld } from './realm-board-create-support.ts';

let world: Awaited<ReturnType<typeof realmBoardWorld>>;
beforeAll(async () => {
  world = await realmBoardWorld();
}, 120_000);
afterAll(async () => {
  await world?.close();
});

test.serial('Realm board creation proves compact membership while native link projection remains behind', async () => {
  const lag = await world.lag();
  expect(BigInt(lag.position)).toBeGreaterThan(BigInt(lag.checkpoint ?? '0'));
  expect(Number(lag.links)).toBe(0);
  const key = crypto.randomUUID();
  const created = await world.board(world.conceptId, key);
  expect(created.response.status).toBe(201);
  expect(created.value.board).toMatchObject({ realmId: world.realm.realmId });
  const effects = await world.effects();
  const replay = await world.board(world.conceptId, key);
  expect(replay.response.status).toBe(201);
  expect(replay.value.board).toEqual(created.value.board);
  expect(await world.effects()).toEqual(effects);
  const stillBehind = await world.lag();
  expect(stillBehind.checkpoint).toBe(lag.checkpoint);
  expect(stillBehind.links).toBe(lag.links);
  expect(BigInt(stillBehind.position)).toBeGreaterThanOrEqual(BigInt(lag.position));
  expect(BigInt(stillBehind.position)).toBeGreaterThan(BigInt(stillBehind.checkpoint ?? '0'));
  const conflict = await world.board();
  expect(conflict.response.status).toBe(409);
  expect(await world.effects()).toEqual(effects);
});

async function refused(id: string) {
  const effects = await world.effects();
  const result = await world.board(id);
  expect(result.response.status).toBe(403);
  expect(result.value.code).toBe('forbidden');
  expect(await world.effects()).toEqual(effects);
}

test.serial('only the current selected expanded Global membership authorizes a Realm board', async () => {
  const id = await world.subject('skos:Concept');
  const candidate = await world.propose(id);
  await refused(id);
  await world.adopt(id, candidate);
  const result = await world.board(id);
  expect(result.response.status).toBe(201);
  expect(result.value.board).toMatchObject({ realmId: world.realm.realmId });
  await world.checked(
    'POST',
    `/v1/subjects/${id}:adopt`,
    { context: GLOBAL_CONTEXT, property: 'skos:inScheme', mode: 'replace', selection: [], expected_head: 1 },
    200,
  );
  await refused(id);
});

test.serial(
  'wrong scheme, wrong type, unknown values and unselected rejected candidates refuse without effects',
  async () => {
    await refused(newId(routeOf(world.conceptId)!));
    await refused(await world.subject('skos:Concept'));
    const wrong = await world.subject('skos:ConceptScheme');
    await refused(await world.subject('skos:Concept', wrong));
    await refused(await world.subject('skos:ConceptScheme'));
    for (const type of ['somevalue', 'novalue']) {
      const id = await world.subject('skos:Concept');
      const candidate = await world.propose(id, { type });
      await world.adopt(id, candidate);
      await refused(id);
    }
    const id = await world.subject('skos:Concept');
    const candidate = await world.propose(id);
    await world.checked(
      'POST',
      `/v1/subjects/${id}/candidates/${candidate}:reject`,
      { context: GLOBAL_CONTEXT, expected_head: null },
      200,
    );
    await refused(id);
  },
);

test.serial('withheld candidates and hidden source or foreign target cannot authorize', async () => {
  const id = await world.subject('skos:Concept');
  const candidate = await world.propose(id);
  await world.adopt(id, candidate);
  await world.checked(
    'POST',
    `/v1/subjects/${id}/candidates/${candidate}:hide`,
    { reason: 'Withheld native membership' },
    200,
  );
  await refused(id);
  const hidden = await world.subject('skos:Concept', world.schemeId);
  await world.checked('POST', `/v1/subjects/${hidden}:hide`, { reason: 'Hidden native Concept' }, 200);
  await refused(hidden);
});

test.serial('imported current membership obeys facts tuple fences and source retractions', async () => {
  const retracted = await world.subject('skos:Concept');
  const first = await world.imported(retracted);
  await world.adopt(retracted, first.candidate);
  const retract = await world.checked(
    'POST',
    '/v1/subjects:batchWrite',
    {
      commands: [
        {
          op: 'retract',
          key: crypto.randomUUID(),
          source: first.source,
          subject: retracted,
          candidate: first.candidate,
          references: first.references,
        },
      ],
    },
    200,
  );
  expect(retract.results[0].status).toBe(200);
  await refused(retracted);
  const id = await world.subject('skos:Concept');
  const imported = await world.imported(id);
  await world.adopt(id, imported.candidate);
  // The unfenced native source is sufficient without any projection runner.
  expect((await world.board(id)).response.status).toBe(201);
  await world.checked(
    'POST',
    '/v1/sourceFences:takedown',
    {
      source: imported.source.source,
      externalId: imported.source.external_id,
      fieldGroup: 'facts',
      reason: 'Native tuple fence',
    },
    200,
  );
  await refused(id);
});

test.serial('native redirect identity refuses without silently following the survivor', async () => {
  const first = await world.subject('skos:Concept', world.schemeId);
  const second = await world.subject('skos:Concept', world.schemeId);
  const merged = await world.checked('POST', '/v1/subjects:merge', { subjects: [first, second] }, 200);
  const effects = await world.effects();
  await expect(world.directBoard(merged.redirected)).rejects.toBeInstanceOf(SubjectRedirectError);
  expect(await world.effects()).toEqual(effects);
});

test.serial('expired native evidence cannot be renewed at the membership preparation boundary', async () => {
  const id = await world.subject('skos:Concept', world.schemeId);
  const observer = observeSql(world.db.pool);
  const barrier = observer.hold({ statement: readVisibility.sql, occurrence: 2 }, 'before');
  const effects = await world.effects();
  const pending = world.board(id);
  try {
    await Promise.race([
      barrier.entered,
      pending.then((result) => {
        throw new Error(`Command missed preparation boundary: ${JSON.stringify(result.value)}`);
      }),
    ]);
    await Bun.sleep(ACCESS_EVIDENCE_TTL_MS);
    barrier.release();
    const result = await pending;
    expect(result.response.status).toBe(503);
    expect(await world.effects()).toEqual(effects);
  } finally {
    barrier.release();
    await observer.close();
    await pending;
  }
});

test.serial('a reached native Concept visibility change invalidates the prepared source version', async () => {
  const id = await world.subject('skos:Concept', world.schemeId);
  world.db.pool.options.max = 2;
  const observer = observeSql(world.db.pool);
  const barrier = observer.hold({ statement: readVisibility.sql, occurrence: 2 }, 'before');
  const pending = world.board(id);
  try {
    await Promise.race([
      barrier.entered,
      pending.then((result) => {
        throw new Error(`Command missed preparation boundary: ${JSON.stringify(result.value)}`);
      }),
    ]);
    await world.checked('POST', `/v1/subjects/${id}:hide`, { reason: 'Reached native source revocation' }, 200);
    const effects = await world.effects();
    barrier.release();
    const result = await pending;
    expect(result.response.status).toBe(503);
    expect(await world.effects()).toEqual(effects);
  } finally {
    barrier.release();
    await observer.close();
    await pending;
    world.db.pool.options.max = 1;
  }
});

test.serial('revoked Realm board authority is checked before receipt replay or board effects', async () => {
  const moderator = await world.person();
  const role = {
    resource: { route: routeOf(world.realm.realmId)!, id: world.realm.realmId },
    subject: { kind: 'account', id: moderator.accountId },
    role: 'community.realm.moderator',
    valid: '(,)',
  };
  const grant = await world.checked('POST', '/v1/roleGrants', role);
  const id = await world.subject('skos:Concept', world.schemeId);
  const key = crypto.randomUUID();
  expect((await world.board(id, key, moderator.bearer)).response.status).toBe(201);
  await world.checked('POST', '/v1/roleGrants:revoke', grant.grant, 200);
  const other = await world.subject('skos:Concept', world.schemeId);
  const effects = await world.effects();
  expect((await world.board(id, key, moderator.bearer)).response.status).toBe(403);
  expect((await world.board(other, crypto.randomUUID(), moderator.bearer)).response.status).toBe(403);
  expect(await world.effects()).toEqual(effects);
});

test.serial('native parent validation rechecks the exact released Realm scheme and head', async () => {
  const id = await world.subject('skos:Concept', world.schemeId);
  const replacement = await world.subject('skos:ConceptScheme');
  world.db.pool.options.max = 2;
  const observer = observeSql(world.db.pool);
  const barrier = observer.hold({ statement: readVisibility.sql, occurrence: 2 }, 'before');
  const pending = world.board(id);
  try {
    await Promise.race([
      barrier.entered,
      pending.then((result) => {
        throw new Error(`Command missed preparation boundary: ${JSON.stringify(result.value)}`);
      }),
    ]);
    const changed = await world.checked(
      'PUT',
      `/v1/realms/${world.realm.realmId}/boardScheme`,
      { schemeId: replacement },
      200,
      { headers: { 'if-match': JSON.stringify(world.realm.headRevisionId) } },
    );
    world.realm.headRevisionId = changed.realm.headRevisionId;
    const effects = await world.effects();
    barrier.release();
    expect((await pending).response.status).toBe(403);
    expect(await world.effects()).toEqual(effects);
  } finally {
    barrier.release();
    await observer.close();
    await pending;
    world.db.pool.options.max = 1;
  }
  const restored = await world.checked(
    'PUT',
    `/v1/realms/${world.realm.realmId}/boardScheme`,
    { schemeId: world.schemeId },
    200,
    { headers: { 'if-match': JSON.stringify(world.realm.headRevisionId) } },
  );
  world.realm.headRevisionId = restored.realm.headRevisionId;
});

test.serial('a hidden foreign scheme denies the otherwise current membership', async () => {
  const id = await world.subject('skos:Concept', world.schemeId);
  await world.checked('POST', `/v1/subjects/${world.schemeId}:hide`, { reason: 'Hidden foreign scheme' }, 200);
  await refused(id);
});

test.serial('only a live native authoritative time object is accepted before I/O', async () => {
  const deadline = Date.now() + 10_000;
  const actor = await world.kernel.testAccess.authenticate(world.owner.bearer, { pool: world.db.pool, deadline });
  const observer = observeSql(world.db.pool);
  try {
    for (const nativeT of [new Date(), new Date().toISOString(), { at: new Date().toISOString() }]) {
      await expect(
        readConceptSchemeReference(world.db.pool, {
          access: world.kernel.testAccess,
          actor,
          routeKey: world.routeKey,
          nativeT: nativeT as never,
          deadline,
          concept: { resource: { route: routeOf(world.conceptId)!, id: world.conceptId }, evidence: null },
          scheme: { resource: { route: routeOf(world.schemeId)!, id: world.schemeId }, evidence: null },
        }),
      ).rejects.toBeInstanceOf(TypeError);
    }
    expect(observer.records).toHaveLength(0);
  } finally {
    await observer.close();
  }
});

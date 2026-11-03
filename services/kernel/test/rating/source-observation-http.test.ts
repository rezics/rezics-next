import { afterAll, beforeAll, expect, test } from 'bun:test';
import type { SourceObservationReadResponse } from '../../src/rating/source-observation-read.ts';
import { sourceObservation } from '../../src/rating/source-provider.ts';
import payloadQuery from '../../src/rating/source-observation-read-payload.sql';
import headQuery from '../../src/rating/source-observation-read-head.sql';
import { decodeCursor, encodeCursor, type CursorBinding } from '../../src/tokens/cursor.ts';
import { partitionOf, routeOf } from '../../src/route/route.ts';
import { observeSql } from '../content/support/sql-observer.ts';
import { createSourceStatisticIsolationFixture } from './source-statistic-isolation-fixture.ts';

type IsolationActor = Awaited<ReturnType<typeof createSourceStatisticIsolationFixture>>['actors']['importer'];
let fixture: Awaited<ReturnType<typeof createSourceStatisticIsolationFixture>>;
let observer: ReturnType<typeof observeSql>;
beforeAll(async () => {
  fixture = await createSourceStatisticIsolationFixture({ sourceFences: true });
  fixture.database.pool.options.max = 4;
  await fixture.grantImporter(fixture.actors.importer);
  await fixture.grantImporter(fixture.actors.secondImporter);
  observer = observeSql(fixture.database.pool);
}, 180_000);
afterAll(async () => {
  await observer?.close();
  await fixture?.close();
});

const path = (id: string) => `/v1/subjects/${id}/source-statistics/bangumi`;
const value = (record: string) => ({
  sourceAlias: `catalogue-${record}`,
  sourceRecordId: record,
  scale: { min: 0, max: 10 },
  mean: 8,
  count: 2,
  asOf: '2026-11-01',
  licence: 'LicenseRef-Authorized-Test',
  attribution: 'Permitted source users',
});
async function json(response: Response, status = 200): Promise<any> {
  const text = await response.text();
  if (response.status !== status) throw new Error(`Expected ${status}, received ${response.status}: ${text}`);
  return text ? JSON.parse(text) : null;
}
const write = (id: string, body: unknown, key = crypto.randomUUID()) =>
  fixture.request('PUT', path(id), { actor: fixture.actors.importer, key, body });
const inspect = (id: string, query = '', actor = fixture.actors.importer) =>
  fixture.request('GET', `${path(id)}/observations${query}`, { actor });
const page = async (id: string, cursor?: string): Promise<SourceObservationReadResponse> =>
  json(await inspect(id, cursor ? `?cursor=${encodeURIComponent(cursor)}` : '?history=true'));
function historyBinding(id: string, caller: IsolationActor): CursorBinding {
  const route = routeOf(id);
  if (route === null) throw new Error('Fixture Subject has no route');
  return {
    operation: 'rating.source-observation.history',
    parameters: {
      account: caller.actor.accountId,
      client: caller.actor.clientId,
      delegator: caller.actor.requestedBy,
      scopes: JSON.stringify([...new Set(caller.actor.scopes)].sort()),
      authnEpoch: caller.actor.authnEpoch,
      home: partitionOf(route),
      route,
      subjectId: id,
      source: 'bangumi',
      query: 'history=true',
      order: 'native.local-order-desc+legacy.digest-desc.v1',
      pageSize: 1,
    },
  };
}
async function expectInvalidCursor(response: Response) {
  expect((await json(response, 400)).code).toBe('invalid_cursor');
}
const fence = async (record: string) =>
  json(
    await fixture.request('POST', '/v1/sourceFences:takedown', {
      actor: fixture.actors.governance,
      key: crypto.randomUUID(),
      body: {
        source: value(record).sourceAlias,
        externalId: record,
        fieldGroup: 'facts',
        reason: 'Protect retained source',
      },
    }),
  );
async function history(records: string[]) {
  const id = await fixture.createSubject();
  const digests: string[] = [];
  for (const record of records) {
    const stored = await json(await write(id, { ...value(record), expectedObservation: digests.at(-1) ?? null }));
    digests.push(stored.observation.digest);
  }
  return { id, digests };
}

test('a concealed lookahead and raw item preserve current head and bounded continuation', async () => {
  const {
    id,
    digests: [old, middle, latest],
  } = await history(['101', '102', '103']);
  await fence('102');
  observer.records.length = 0;
  const first = await page(id);
  expect(first.head.digest).toBe(latest);
  expect(first.history!.items.map((item) => item.digest)).toEqual([latest!]);
  expect(first.history!.nextCursor).toBeString();
  const withheld = await page(id, first.history!.nextCursor!);
  expect(withheld.head).toEqual(first.head);
  expect(withheld.history!.items).toEqual([]);
  expect(withheld.history!.nextCursor).toBeString();
  expect(JSON.stringify(withheld)).not.toContain('catalogue-102');
  const last = await page(id, withheld.history!.nextCursor!);
  expect(last.head).toEqual(first.head);
  expect(last.history!.items.map((item) => item.digest)).toEqual([old!]);
  expect(last.history!.nextCursor).toBeNull();
  const fetched = observer.records.filter((row) => row.statement === payloadQuery.sql);
  expect(fetched).toHaveLength(3);
  expect(JSON.stringify(fetched.map((row) => row.parameters))).not.toContain(middle!);
  await json(await inspect(id, `?digest=${middle}`), 404);
  const exact = await json(await inspect(id, `?digest=${old}`));
  expect(exact.head.digest).toBe(latest);
  expect(exact.selectedObservation.digest).toBe(old);
  await json(await inspect(id, `?digest=${'0'.repeat(64)}`), 404);
  await json(await fixture.request('GET', `${path(id)}/observations`, { actor: null }), 401);
  await json(await inspect(id, '', fixture.actors.author), 403);
  const finalHead = observer.hold({ statement: payloadQuery.sql }, 'after');
  const required = inspect(id, `?digest=${old}`);
  await finalHead.entered;
  try {
    await fence('103');
  } finally {
    finalHead.release();
  }
  const concealed = await json(await required, 404);
  expect(JSON.stringify(concealed)).not.toContain('catalogue-103');
  await json(await inspect(id, `?digest=${old}`), 404);
});

test('history cursors use native caller, home, epoch, expiry and page bindings', async () => {
  const { id } = await history(['111', '112', '113']);
  const first = await page(id);
  const cursor = first.history!.nextCursor!;
  const binding = historyBinding(id, fixture.actors.importer);
  const decoded = decodeCursor(fixture.tokens, binding, cursor);
  expect(decoded.ok).toBe(true);
  if (!decoded.ok) throw new Error('Generated history cursor did not decode');
  expect(decoded.epoch).toBeGreaterThan(0);

  await expectInvalidCursor(
    await inspect(id, `?cursor=${encodeURIComponent(cursor)}`, fixture.actors.secondImporter),
  );
  const parameters = binding.parameters;
  const wrongHome = encodeCursor(
    fixture.tokens,
    { ...binding, parameters: { ...parameters, home: Number(parameters.home) + 1 } },
    decoded,
  );
  await expectInvalidCursor(await inspect(id, `?cursor=${encodeURIComponent(wrongHome)}`));
  const wrongAuthnEpoch = encodeCursor(
    fixture.tokens,
    { ...binding, parameters: { ...parameters, authnEpoch: fixture.actors.importer.actor.authnEpoch + 1 } },
    decoded,
  );
  await expectInvalidCursor(await inspect(id, `?cursor=${encodeURIComponent(wrongAuthnEpoch)}`));
  const wrongNativeEpoch = encodeCursor(
    fixture.tokens,
    binding,
    { epoch: decoded.epoch + 1, after: decoded.after },
  );
  await expectInvalidCursor(await inspect(id, `?cursor=${encodeURIComponent(wrongNativeEpoch)}`));
  const expired = encodeCursor(
    fixture.tokens,
    binding,
    decoded,
    Date.now() - 15 * 60_000 - 1_000,
  );
  await expectInvalidCursor(await inspect(id, `?cursor=${encodeURIComponent(expired)}`));
});

test('history continuation keeps its original native ceiling when a new head arrives', async () => {
  const { id, digests } = await history(['121', '122', '123']);
  const first = await page(id);
  const cursor = first.history!.nextCursor!;
  const newest = { ...value('124'), asOf: '2026-11-02', expectedObservation: digests[2] };
  const added = await json(await write(id, newest));
  const continued = await page(id, cursor);
  expect(continued.head.digest).toBe(added.observation.digest);
  expect(continued.history!.items.map((item) => item.digest)).toEqual([digests[1]]);
});

test('history traverses immutable native rows into legacy rows and exact legacy digests', async () => {
  const id = await fixture.createSubject();
  const legacy = value('131');
  const route = routeOf(id);
  if (route === null) throw new Error('Fixture Subject has no route');
  await fixture.database.pool.query(
    `INSERT INTO rating.source_statistic
       (route, subject_id, source, source_record_id, scale_min, scale_max, mean, count, as_of,
        licence, attribution, transaction_id, source_alias, observation_digest)
     VALUES ($1, $2, 'bangumi', $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, NULL)`,
    [
      route,
      id,
      legacy.sourceRecordId,
      legacy.scale.min,
      legacy.scale.max,
      legacy.mean,
      legacy.count,
      legacy.asOf,
      legacy.licence,
      legacy.attribution,
      crypto.randomUUID(),
      legacy.sourceAlias,
    ],
  );
  const legacyDigest = sourceObservation(id, 'bangumi', legacy).digest;
  const current = { ...value('132'), asOf: '2026-11-02', expectedObservation: legacyDigest };
  const stored = await json(await write(id, current));
  const nativePage = await page(id);
  expect(nativePage.head.digest).toBe(stored.observation.digest);
  expect(nativePage.history!.items[0]).toMatchObject({ legacy: false, nativeOrder: expect.any(String) });
  const legacyPage = await page(id, nativePage.history!.nextCursor!);
  expect(legacyPage.history!.items[0]).toMatchObject({
    digest: legacyDigest,
    legacy: true,
    nativeOrder: null,
  });
  expect(legacyPage.history!.nextCursor).toBeNull();
  const exact = await json(await inspect(id, `?digest=${legacyDigest}`));
  expect(exact.selectedObservation.digest).toBe(legacyDigest);
});

test('source changes and failed fills retry the same raw cursor, without publishing protected content', async () => {
  const { id, digests } = await history(['201', '202', '203']);
  const first = await page(id);
  const cursor = first.history!.nextCursor!;
  const hold = observer.hold({ statement: payloadQuery.sql }, 'after');
  const pending = inspect(id, `?cursor=${encodeURIComponent(cursor)}`);
  await hold.entered;
  try {
    await fence('202');
  } finally {
    hold.release();
  }
  const failure = await json(await pending, 409);
  expect(JSON.stringify(failure)).not.toContain('catalogue-202');
  const retried = await page(id, cursor);
  expect(retried.head.digest).toBe(digests[2]!);
  expect(retried.history!.items).toEqual([]);
  expect(retried.history!.nextCursor).toBeString();
  const finalFill = observer.hold({ statement: headQuery.sql, occurrence: 2 }, 'after');
  const changingLookahead = inspect(id, `?cursor=${encodeURIComponent(cursor)}`);
  await finalFill.entered;
  try {
    await fence('201');
  } finally {
    finalFill.release();
  }
  await json(await changingLookahead, 409);
  const stable = await page(id, cursor);
  expect(stable.history!.items).toEqual([]);
  expect(stable.history!.nextCursor).toBe(retried.history!.nextCursor);
  const end = await page(id, stable.history!.nextCursor!);
  expect(end.head).toEqual(stable.head);
  expect(end.history).toEqual({ items: [], nextCursor: null });
  observer.armFault({
    match: { statement: headQuery.sql },
    boundary: 'before',
    error: new Error('inspection dependency failed'),
  });
  expect((await inspect(id, `?cursor=${encodeURIComponent(cursor)}`)).status).toBeGreaterThanOrEqual(500);
  expect(await page(id, cursor)).toEqual(stable);
});

test('caller revocation and Subject identity changes during hydration withhold the original page', async () => {
  const { id, digests } = await history(['221', '222', '223']);
  const first = await page(id);
  const cursor = first.history!.nextCursor!;
  const heldPayload = observer.hold({ statement: payloadQuery.sql }, 'after');
  const pending = inspect(id, `?cursor=${encodeURIComponent(cursor)}`);
  await heldPayload.entered;
  try {
    await fixture.revokeImporter(fixture.actors.importer);
  } finally {
    heldPayload.release();
  }
  await json(await pending, 403);
  await fixture.grantImporter(fixture.actors.importer);
  expect((await page(id, cursor)).history!.items.map((item) => item.digest)).toEqual([digests[1]]);

  const identity = await history(['231', '232', '233']);
  const identityPage = await page(identity.id);
  const identityCursor = identityPage.history!.nextCursor!;
  const survivor = await fixture.createSubject();
  const heldIdentityPayload = observer.hold({ statement: payloadQuery.sql }, 'after');
  const pendingIdentity = inspect(identity.id, `?cursor=${encodeURIComponent(identityCursor)}`);
  await heldIdentityPayload.entered;
  try {
    await fixture.mergeSubject(identity.id, survivor);
  } finally {
    heldIdentityPayload.release();
  }
  await json(await pendingIdentity, 404);
  await json(await inspect(identity.id, `?cursor=${encodeURIComponent(identityCursor)}`), 404);
});

test('inspection supports deliberate CAS correction, clear, replay and revoked/account-switched recovery', async () => {
  const id = await fixture.createSubject();
  const empty = await page(id);
  expect(empty.head).toEqual({ digest: null, state: 'empty', observation: null });
  expect(empty.history).toEqual({ items: [], nextCursor: null });
  const key = crypto.randomUUID();
  const body = value('301');
  const stored = await json(await write(id, body, key));
  expect(await json(await write(id, body, key))).toEqual(stored);
  const current = await json(await inspect(id));
  await json(await write(id, { ...body, mean: 9 }), 409);
  const corrected = await json(await write(id, { ...body, mean: 9, ...current.resolution.put }));
  await json(await write(id, { ...body, ...current.resolution.put }), 409);
  const clear = {
    sourceAlias: body.sourceAlias,
    sourceRecordId: body.sourceRecordId,
    count: 0,
    asOf: '2026-11-02',
    expectedObservation: corrected.observation.digest,
  };
  await json(
    await fixture.request('POST', `${path(id)}:clear`, {
      actor: fixture.actors.importer,
      key: crypto.randomUUID(),
      body: clear,
    }),
    204,
  );
  const cleared = await json(await inspect(id));
  expect(cleared.head.state).toBe('cleared');
  expect(cleared.head.observation.payload.count).toBe(0);
  await json(await write(id, body), 409);
  expect((await json(await inspect(id, '', fixture.actors.secondImporter))).head).toEqual(cleared.head);
  await fixture.revokeImporter(fixture.actors.importer);
  try {
    await json(await inspect(id), 403);
    await json(await write(id, body, key), 403);
  } finally {
    await fixture.grantImporter(fixture.actors.importer);
  }
  expect((await json(await inspect(id))).head).toEqual(cleared.head);
});

import { afterAll, beforeAll, expect, test } from 'bun:test';
import { readLibraryEntryTiles } from '../../src/library/library-entry-tiles.ts';
import { routeOf } from '../../src/route/route.ts';
import { createProfileEntryFixture, type NativeProfileFixture } from './support/profile-entry-fixture.ts';
let f: NativeProfileFixture;
beforeAll(async () => {
  f = await createProfileEntryFixture();
}, 120000);
afterAll(async () => {
  await f?.close();
});
test('bounded native entry tiles preserve data states and active progress without reading sessions for subjects lacking an entry or exposing private provenance', async () => {
  expect((await f.send('steward', 'POST', '/v1/platform/exposure/reading_progress:open')).status).toBe(200);
  const owner = await f.identity([
    'subject:read',
    'library_entry:update',
    'library_entry:read',
    'library_entry:list',
    'progress_session:create',
    'progress_session:read',
    'progress_session:list',
    'progress_session:update',
  ]);
  const subject = await f.createSubject('record'),
    noEntry = await f.createSubject('record');
  const entryResponse = await f.send(owner.bearer, 'PUT', '/v1/libraryEntries/' + subject, { state: 'listening' });
  expect(entryResponse.status).toBe(201);
  const entry = (await entryResponse.json()).libraryEntry;
  const start = async (subjectId: string) => {
    const r = await f.send(owner.bearer, 'POST', '/v1/progressSessions', {
      subjectId,
      mode: 'scalar_amount',
      unit: 'track',
      total: '10',
    });
    expect(r.status).toBe(201);
    return (await r.json()).progressSession;
  };
  const session = await start(subject);
  await start(noEntry);
  const before = await f.inspect(owner.actor.accountId);
  const c = await f.pool.connect();
  let committed = false;
  try {
    await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const result = await readLibraryEntryTiles(c, {
      route: routeOf(owner.actor.accountId)!,
      accountId: owner.actor.accountId,
      subjectIds: [subject, noEntry, subject],
    });
    expect(result.size).toBe(1);
    expect(result.has(noEntry)).toBe(false);
    const tile = result.get(subject)!;
    expect(tile.state).toBe('listening');
    expect(tile.revision).toBe(entry.revision);
    expect(tile.activeProgressSession).toEqual(session);
    expect(Object.keys(tile).sort()).toEqual(
      [
        'subjectId',
        'state',
        'revision',
        'createdAt',
        'updatedAt',
        'incarnationId',
        'lastActivityAt',
        'finishedAt',
        'activeProgressSession',
      ].sort(),
    );
    const persisted = before.entries.find((x) => x.row.subject_id === subject)!.row;
    expect(tile.incarnationId).toBe(persisted.incarnation_id);
    expect(
      (
        await readLibraryEntryTiles(c, {
          route: routeOf(owner.actor.accountId)!,
          accountId: owner.actor.accountId,
          subjectIds: [],
        })
      ).size,
    ).toBe(0);
    await c.query('COMMIT');
    committed = true;
  } finally {
    if (!committed) await c.query('ROLLBACK');
    c.release();
  }
  expect(await f.inspect(owner.actor.accountId)).toEqual(before);
}, 120000);

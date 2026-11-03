import { afterAll, beforeAll, expect, test } from 'bun:test';
import { createProfileEntryFixture, type NativeProfileFixture } from './support/profile-entry-fixture.ts';
import { accountToken } from '../support/admitted-access.ts';
import { randomUUID } from 'node:crypto';
import { parseMal, malDate, MAL_LIMITS } from '../../src/library/list-import-mal-parser.ts';
const anime = (id: string, extra = '', status = 'Completed') =>
  `<anime><series_animedb_id>${id}</series_animedb_id><series_title><![CDATA[Private title & text]]></series_title><my_status>${status}</my_status>${extra}</anime>`;
const xml = (rows: string) => `<myanimelist><myinfo><user_name>private</user_name></myinfo>${rows}</myanimelist>`;
let native: NativeProfileFixture;
beforeAll(async () => {
  native = await createProfileEntryFixture({ gameUnits: ['minute', 'episode'] });
}, 120_000);
afterAll(async () => {
  await native?.close();
});
async function json(method: string, path: string, body?: unknown, key = randomUUID(), persona = 'owner', status = 200) {
  const response = await native.send(persona, method, path, body, key);
  const data = await response.json();
  expect({ status: response.status, data }).toMatchObject({ status });
  return data;
}
const base = '/v1/libraryImports/mal';
async function upload(rows: string) {
  return (await json('POST', `${base}:preview`, { xml: xml(rows) })).id as string;
}
async function review(id: string, row: number, target: string | null, replace = false, skip = false) {
  const version = randomUUID();
  await json('POST', `${base}/${id}/review`, { row, target, replace, skip }, version);
  return version;
}
const apply = (id: string, row: number, version: string, fields = ['status']) =>
  json('POST', `${base}/${id}/apply`, { confirm: true, rows: [{ row, version, fields }] });
test('MAL retains independent measures, zero, private comments, dates and unknown fields without fabricated sessions', () => {
  const [row] = parseMal(
    xml(
      `<manga><manga_mangadb_id>7</manga_mangadb_id><manga_title>M</manga_title><my_status>Reading</my_status><my_score>0</my_score><my_read_chapters>12</my_read_chapters><my_read_volumes>2</my_read_volumes><my_comments><![CDATA[secret & <text>]]></my_comments><my_start_date>2024-00-00</my_start_date><my_finish_date>2024-02-00</my_finish_date><my_times_read>3</my_times_read><my_tags>a,b</my_tags><my_privacy>1</my_privacy><my_last_updated>123</my_last_updated><unknown>x</unknown></manga>`,
    ),
  );
  expect(row!.identifier.source).toBe('mal_manga');
  expect(row!.score).toMatchObject({ kind: 'zero', value: 0, scale: { min: 1, max: 10, step: 1 } });
  expect(row!.progress.my_read_chapters).toMatchObject({ value: 12 });
  expect(row!.progress.my_read_volumes).toMatchObject({ value: 2 });
  expect(row!.notes.value).toBe('secret & <text>');
  expect(row!.dates).toMatchObject({
    started: { value: '2024', precision: 'year' },
    finished: { value: '2024-02', precision: 'month' },
  });
  expect(row!.repeats.value).toBe(3);
  expect(row!.retained).toContainEqual({ field: 'unknown', reason: 'private-source-evidence' });
  expect(malDate('0000-00-00').kind).toBe('unknown');
  expect(malDate('2024-00-05').kind).toBe('unknown');
  expect(malDate('2023-02-29').kind).toBe('invalid');
  expect(malDate(undefined).kind).toBe('missing');
  expect(malDate('').kind).toBe('unknown');
  expect(() => parseMal('<!DOCTYPE x [<!ENTITY y SYSTEM "file:///etc/passwd">]><myanimelist/>')).toThrow('DTD');
  expect(() => parseMal(xml(anime('0')))).toThrow('row 1');
  expect(() => parseMal('<wrong/>')).toThrow('root');
  expect(() => parseMal('<myanimelist><anime></myanimelist>')).toThrow('malformed');
  expect(() => parseMal(' '.repeat(MAL_LIMITS.bytes + 1))).toThrow('2 MiB');
});
test('MAL adopts only an explicitly selected scalar occurrence and retries the same native receipts', async () => {
  expect(native.original.types['ex:Parent']?.library?.profileId).toBe('fixture.game');
  expect(
    native.original.libraryProfiles?.['fixture.game']?.progress?.allowed[0]?.units.map((unit) => unit.id),
  ).toContain('episode');
  const target = await native.createSubject('game');
  const id = await upload(
    anime('210', '<my_watched_episodes>0</my_watched_episodes>') +
      anime('211') +
      anime('212', '<my_watched_episodes>2</my_watched_episodes>') +
      anime('213', '<my_watched_episodes>3</my_watched_episodes>'),
  );
  const select = async (row: number, occurrence: Record<string, unknown>) => {
    const version = randomUUID();
    await json(
      'POST',
      `${base}/${id}/review`,
      {
        row,
        target,
        skip: false,
        replace: false,
        progress: { occurrence, measures: [{ field: 'my_watched_episodes', action: 'adopt' }] },
      },
      version,
    );
    return version;
  };
  const confirmed = (row: number, version: string) =>
    json('POST', `${base}/${id}/apply`, { confirm: true, rows: [{ row, version, fields: [] }] });
  const page = await json('GET', `${base}/${id}`);
  expect(page.rows[0].progressMeasures[0]).toMatchObject({
    state: 'zero',
    amount: '0',
    unit: 'episode',
    unitSupported: false,
  });
  expect(page.rows[1].progressMeasures[0]).toMatchObject({ state: 'missing', unitSupported: false });

  const zeroReview = await select(0, { kind: 'start', primaryUnit: 'episode' });
  const selectedPage = await json('GET', `${base}/${id}`);
  expect(selectedPage.rows[0].progressMeasures[0]).toMatchObject({ state: 'zero', unitSupported: true });
  expect(selectedPage.rows[1].progressMeasures[0]).toMatchObject({ state: 'missing', unitSupported: false });
  const zero = await confirmed(0, zeroReview);
  expect(zero.outcomes[0].progress.measures).toMatchObject([
    { status: 'applied', sourceAmount: '0', currentAmount: '0' },
  ]);
  const sessionId = zero.outcomes[0].progress.occurrence.sessionId;
  let opened = await json('GET', `/v1/progressSessions/${sessionId}`);
  expect(opened.progressSession).toMatchObject({
    mode: 'scalar_amount',
    unit: 'episode',
    amount: '0',
    state: 'active',
    completedAt: null,
  });
  expect((await json('GET', `/v1/progressSessions/${sessionId}/journal`)).journal).toMatchObject({
    startDate: null,
    finishDate: null,
  });
  expect((await native.inspect()).entries.some((entry) => entry.row.subject_id === target)).toBe(false);

  const absentReview = await select(1, { kind: 'start', primaryUnit: 'episode' });
  const absent = await confirmed(1, absentReview);
  expect(absent.outcomes[0].progress).toMatchObject({
    occurrence: null,
    complete: true,
    measures: [{ status: 'missing' }],
  });
  expect((await json('GET', `/v1/progressSessions?subjectId=${target}`)).progressSessions).toHaveLength(1);

  await json('POST', `/v1/progressSessions/${sessionId}:record`, { revision: 1, measureId: 'episode', amount: '4' });
  const preserveReview = await select(2, { kind: 'existing', sessionId });
  const preserved = await confirmed(2, preserveReview);
  expect(preserved.outcomes[0].progress.measures).toMatchObject([{ status: 'preserved', currentAmount: '4' }]);
  opened = await json('GET', `/v1/progressSessions/${sessionId}`);
  expect(opened.progressSession.amount).toBe('4');

  const staleReview = await select(3, { kind: 'existing', sessionId });
  await json('POST', `/v1/progressSessions/${sessionId}:record`, { revision: 2, measureId: 'episode', amount: '6' });
  const stale = await confirmed(3, staleReview);
  expect(stale.outcomes[0].progress.measures).toMatchObject([{ status: 'stale' }]);
  expect((await json('GET', `/v1/progressSessions/${sessionId}`)).progressSession.amount).toBe('6');
  expect(
    (await json('GET', `/v1/progressSessions/${sessionId}`, undefined, randomUUID(), 'other', 404)).progressSession,
  ).toBeUndefined();

  // A lost provider checkpoint replays both original native receipts instead of making a second occurrence.
  await native.pool.query(
    `UPDATE library.list_import_mal SET document=jsonb_set(document,'{intents,0,progress}',$3::jsonb)
     WHERE account_id=$1 AND id=$2`,
    [
      native.owner.actor.accountId,
      id,
      JSON.stringify({
        startAttempted: true,
        occurrence: null,
        lastRevision: null,
        steps: {},
        measures: [],
        complete: false,
      }),
    ],
  );
  expect((await confirmed(0, zeroReview)).outcomes[0]).toEqual(zero.outcomes[0]);
  expect((await json('GET', `/v1/progressSessions?subjectId=${target}`)).progressSessions).toHaveLength(1);
  await json('DELETE', `${base}/${id}`);
});
test('native HTTP own preview, explicit unmatched resolution, supported status, unsupported evidence, retry and owner fence', async () => {
  const producer = await accountToken({
    accountId: native.steward.actor.accountId,
    clientId: native.steward.actor.clientId,
    scopes: [...native.steward.actor.scopes, 'subject:batch_write'],
  });
  const imported = await json(
    'POST',
    '/v1/subjects:batchWrite',
    {
      commands: [
        {
          op: 'create',
          key: randomUUID(),
          source: {
            source: 'mal_anime',
            external_id: '100',
            record_revision: '1',
            digest: 'a'.repeat(64),
            converter_revision: 'fixture',
            field_group: 'facts',
          },
          subject: { type: 'ex:Child', labels: { en: 'Admitted provider identity' } },
        },
      ],
    },
    randomUUID(),
    producer,
  );
  expect(imported.results[0].status).toBe(201);
  const target = imported.results[0].value.id;
  const id = await upload(
    anime('100', '<my_comments>private note</my_comments><my_score>9</my_score>') +
      ['101', '102', '103'].map((id) => anime(id)).join(''),
  );
  const page = await json('GET', `${base}/${id}`);
  const original = await json('GET', page.sourcePath);
  expect(original.xml).toContain('<user_name>private</user_name>');
  await json('GET', page.sourcePath, undefined, randomUUID(), 'other', 404);
  expect(page.rows[0]).toMatchObject({ match: 'matched', notes: { value: 'private note' }, review: null });
  expect((await native.inspect()).entries.some((e) => e.row.subject_id === target)).toBe(false);
  expect(page.rows[1].match).toBe('unmatched');
  const version = await review(id, 0, null);
  const skip = await review(id, 1, null, false, true);
  const retained = await review(id, 2, target);
  expect((await json('GET', `${base}/${id}`)).rows[2].target).toBe(target);
  expect((await json('GET', `${base}/${id}`)).rows[0].review.state).toBe('completed');
  const resolvedVersion = await review(id, 3, await native.createSubject('game'));
  const result = await json('POST', `${base}/${id}/apply`, {
    confirm: true,
    rows: [
      { row: 0, version, fields: ['status', 'score', 'notes'] },
      { row: 1, version: skip, fields: ['status'] },
    ],
  });
  expect(result.outcomes[1].status).toBe('skipped');
  expect((await apply(id, 3, resolvedVersion)).outcomes[0].status).toBe('applied');
  expect(result.outcomes[0]).toMatchObject({ status: 'applied', applied: ['status'] });
  expect(result.outcomes[0].retained).toContain('my_comments');
  expect((await apply(id, 0, version, ['status', 'score', 'notes'])).outcomes[0]).toEqual(result.outcomes[0]);
  const beforeRetry = await json('GET', `/v1/libraryEntries/${target}`);
  // Fault injection: native effects committed, but the import acknowledgement was lost.
  await native.pool.query(
    `UPDATE library.list_import_mal SET document=document #- '{intents,0,outcome}'
    WHERE account_id=$1 AND id=$2`,
    [native.owner.actor.accountId, id],
  );
  expect((await apply(id, 0, version, ['status', 'score', 'notes'])).outcomes[0]).toEqual(result.outcomes[0]);
  expect((await json('GET', `/v1/libraryEntries/${target}`)).libraryEntry).toEqual(beforeRetry.libraryEntry);
  expect((await apply(id, 1, skip)).outcomes[0].status).toBe('skipped');
  expect((await apply(id, 2, retained, ['score'])).outcomes[0].status).toBe('unsupported');
  const facts = (await native.inspect()).entries.filter((e) => e.row.subject_id === target);
  expect(facts).toHaveLength(1);
  expect(facts[0]!.row.state).toBe('completed');
  const other = await json('GET', `${base}/${id}`, undefined, randomUUID(), 'other', 404);
  expect(JSON.stringify(other)).not.toContain('private note');
  await json(
    'POST',
    `${base}/${id}/apply`,
    { confirm: true, rows: [{ row: 0, version, fields: ['status'] }] },
    randomUUID(),
    'other',
    404,
  );
  await json('DELETE', `${base}/${id}`);
});
test('native conflict defaults preserve facts; replacement has revision and release guards; cancel and terminal stop admission', async () => {
  const target = await native.createSubject('game');
  await json('PUT', `/v1/libraryEntries/${target}`, { state: 'planned' }, randomUUID(), 'owner', 201);
  const id = await upload(anime('200') + anime('201') + anime('202'));
  const keep = await review(id, 0, target);
  expect((await apply(id, 0, keep)).outcomes[0]).toMatchObject({ status: 'skipped', reason: 'preserve-current-fact' });
  const replacement = await review(id, 1, target, true);
  const local = await json('GET', `/v1/libraryEntries/${target}`);
  await json('PUT', `/v1/libraryEntries/${target}`, {
    state: 'paused',
    revision: local.libraryEntry.revision,
    incarnationId: local.libraryEntry.incarnationId,
  });
  expect((await apply(id, 1, replacement)).outcomes[0].status).toBe('stale');
  const refreshed = await review(id, 1, target, true);
  expect((await apply(id, 1, refreshed)).outcomes[0].status).toBe('applied');
  const releaseGuard = await review(id, 2, target, true);
  await native.activate(native.replacementDigest);
  expect((await apply(id, 2, releaseGuard)).outcomes[0].status).toBe('stale');
  await native.activate(native.originalDigest);
  await json('POST', `${base}/${id}/cancel`, {});
  await json(
    'POST',
    `${base}/${id}/apply`,
    { confirm: true, rows: [{ row: 2, version: releaseGuard, fields: ['status'] }] },
    randomUUID(),
    'owner',
    409,
  );
  await json('DELETE', `${base}/${id}`);
  await json('POST', `${base}:preview`, { xml: xml(anime('bad')) }, randomUUID(), 'owner', 400);
  await json('POST', `${base}:preview`, { xml: 'x'.repeat(MAL_LIMITS.bytes + 1) }, randomUUID(), 'owner', 400);
  const denied = await native.identity(native.owner.actor.scopes);
  const deniedUpload = await json('POST', `${base}:preview`, { xml: xml(anime('1')) }, randomUUID(), denied.bearer);
  await native.suspend(denied.actor.accountId);
  await json('GET', `${base}/${deniedUpload.id}`, undefined, randomUUID(), denied.bearer, 401);
  await json(
    'POST',
    `${base}/${deniedUpload.id}/apply`,
    { confirm: true, rows: [{ row: 0, version: 'never', fields: ['status'] }] },
    randomUUID(),
    denied.bearer,
    401,
  );
  await json('POST', `${base}:preview`, { xml: xml(anime('1')) }, randomUUID(), denied.bearer, 401);
});

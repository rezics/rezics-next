import { afterAll, beforeAll, expect, test } from 'bun:test';
import { parseAniList, AniListInputError } from '../../src/library/list-import-anilist-parser.ts';
import { createProfileEntryFixture, entryKey, type NativeProfileFixture } from './support/profile-entry-fixture.ts';
import { createGrantCommands } from '../../src/access/grant-commands.ts';
import { GLOBAL_CONTEXT } from '../../src/semantic/definitions.ts';
import { deadlineFor } from '../../src/request/deadline.ts';

let f: NativeProfileFixture;
beforeAll(async () => { f = await createProfileEntryFixture(); }, 120000);
afterAll(async () => { await f?.close(); });
const base = '/v1/libraryImports/anilist';
const row = { mediaId: 1, media: { id: 1, type: 'ANIME', title: { romaji: 'Private watch list' } }, status: 'PLANNING',
  score: 0, progress: 0, progressVolumes: 2, repeat: 3, private: true, notes: 'private note',
  startedAt: { year: 2023, month: null, day: null }, completedAt: { year: 2024, month: 2, day: 29 },
  updatedAt: 1700000000, customLists: { Favourites: true }, advancedScores: { Story: 8 }, unfamiliar: { keep: true } };
test('the supported GraphQL wrappers preserve distinct zero, missing, fuzzy, invalid and unknown source evidence', () => {
  const document = { data: { MediaListCollection: { hasNextChunk: true, lists: [{ name: 'Private custom', isCustomList: true, entries: [row] }] } } };
  const parsed = parseAniList(JSON.stringify(document), 'POINT_10');
  expect(parsed.document).toEqual(document);
  expect(parsed.rows[0]!.evidence).toEqual(row);
  expect(parsed.rows[0]!.group).toEqual({ name: 'Private custom', isCustomList: true });
  expect(parsed.rows[0]!.identifiers).toEqual([{ source: 'anilist', externalId: '1' }]);
  expect(parsed.rows[0]!.fields.find(f => f.field === 'score')!.validity).toBe('valid');
  const invalid = parseAniList(JSON.stringify([{ status: 'FUTURE', score: 80, progress: -1, completedAt: { year: 2023, month: 2, day: 29 } }]));
  expect(invalid.rows[0]!.fields.map(f => f.validity)).toEqual(['invalid', 'unknown', 'invalid', 'invalid']);
  expect(parseAniList(JSON.stringify([{ id: 9 }])).rows[0]!.identifiers).toEqual([]);
  for (const upload of ['{', '{}', JSON.stringify(Array(201).fill(row)), ' '.repeat(1048577), JSON.stringify([{ notes: 'x'.repeat(65536) }]), JSON.stringify([{ notes: '\0' }])])
    expect(() => parseAniList(upload)).toThrow(AniListInputError);
});
test('mounted own upload, admitted identifier match, explicit resolution, conflict, original-command retry and fences', async () => {
  const importer = await f.identity(['subject:batch_write', 'subject:create', 'subject:read', 'library_entry:update', 'library_entry:read', 'library_entry:list', 'follow:create']);
  await f.grantLibraryGate(importer.actor.accountId);
  await createGrantCommands({ pool: f.pool, access: f.access, managementAction: 'access:grant' }).create(
    { pool: f.pool, actor: f.steward.actor, deadline: deadlineFor(30000) }, {
      resource: { route: 0, id: GLOBAL_CONTEXT }, subject: { kind: 'account', id: importer.actor.accountId },
      actions: ['subject:batch_write'], valid: '(,)', key: entryKey(),
    });
  const mediaId = Math.floor(Math.random() * 1_000_000_000) + 1;
  const made = await f.send(importer.bearer, 'POST', '/v1/subjects:batchWrite', { commands: ['anilist', 'myanimelist'].map(source => ({ op: 'create', key: entryKey(),
    source: { source, external_id: String(mediaId), record_revision: '1', digest: 'a'.repeat(64), converter_revision: 'fixture@1', field_group: 'facts' },
    subject: { type: 'ex:Child', labels: { en: 'Admitted subject' } } })) });
  expect(made.status).toBe(200);
  const result = await made.json();
  expect(result.results[0].status).toBe(201);
  const subjectId = result.results[0].value.id;
  const upload = JSON.stringify([{ ...row, mediaId, media: { ...row.media, id: mediaId } }, { ...row, mediaId: mediaId + 1, media: {} }, { notes: 'retained only' }]);
  const preview = await f.send(importer.bearer, 'POST', base + ':preview', { upload, scoreFormat: 'POINT_10' });
  expect(preview.status).toBe(200);
  const { id } = await preview.json();
  const path = base + '/' + id;
  const page = await f.send(importer.bearer, 'GET', path);
  expect(page.status).toBe(200);
  const body = await page.json();
  expect(body.header.rawUpload).toBe(upload);
  expect(body.rows[0].match).toMatchObject({ state: 'matched', candidates: [subjectId] });
  expect(body.rows[0].source.evidence.notes).toBe('private note');
  expect(body.rows[1].match.state).toBe('unmatched');
  expect((await f.send(importer.bearer, 'GET', `/v1/libraryEntries/${subjectId}`)).status).toBe(404);
  expect((await f.send('other', 'GET', path)).status).toBe(404);
  expect((await f.send('other', 'POST', path + ':review', { ordinal: 0, fields: ['status'] })).status).toBe(404);
  expect((await f.send('anonymous', 'GET', path)).status).toBeGreaterThanOrEqual(401);
  async function review(ordinal: number, input: Record<string, unknown>) {
    const response = await f.send(importer.bearer, 'POST', path + ':review', { ordinal, fields: ['status', 'score'], ...input });
    expect(response.status).toBe(200);
    return { ordinal, reviewId: (await response.json()).review.id };
  }
  const first = await review(0, {}), skipped = await review(2, { skip: true });
  const apply = async (confirmations: unknown[]) => {
    const response = await f.send(importer.bearer, 'POST', path + ':apply', { confirmations });
    expect(response.status).toBe(200);
    return response.json();
  };
  const applied = await apply([first, skipped]);
  expect(applied.outcomes.map((r: { status: string }) => r.status)).toEqual(['applied', 'skipped']);
  expect(applied.outcomes[0].retained).toContain('score');
  expect(await apply([first])).toEqual({ outcomes: [applied.outcomes[0]], complete: true });
  const entry = await (await f.send(importer.bearer, 'GET', `/v1/libraryEntries/${subjectId}`)).json();
  expect(entry.libraryEntry.state).toBe('planned');
  expect(entry.libraryEntry.revision).toBe(1);
  const conflict = await review(1, { subjectId });
  expect((await apply([conflict])).outcomes[0].status).toBe('skipped');
  const resolved = await f.send(importer.bearer, 'POST', base + ':preview', { upload: JSON.stringify([{ status: 'COMPLETED' }, { score: 9 }]) });
  const path2 = base + '/' + (await resolved.json()).id;
  const chosen = await f.send(importer.bearer, 'POST', path2 + ':review', { ordinal: 0, subjectId, fields: ['status'], replace: true });
  expect(chosen.status).toBe(200);
  const chosenId = (await chosen.json()).review.id;
  const replaced = await f.send(importer.bearer, 'POST', path2 + ':apply', { confirmations: [{ ordinal: 0, reviewId: chosenId }] });
  expect((await replaced.json()).outcomes[0].status).toBe('applied');
  const unsupported = await f.send(importer.bearer, 'POST', path2 + ':review', { ordinal: 1, subjectId, fields: ['score'] });
  const unsupportedApply = await f.send(importer.bearer, 'POST', path2 + ':apply', { confirmations: [{ ordinal: 1, reviewId: (await unsupported.json()).review.id }] });
  expect((await unsupportedApply.json()).outcomes[0].status).toBe('unsupported');
  const conflicts = await f.send(importer.bearer, 'POST', base + ':preview', { upload: JSON.stringify([
    { mediaId, media: { idMal: mediaId }, status: 'PLANNING' }, { status: 'PLANNING' }, { status: 'PLANNING' }]) });
  const path3 = base + '/' + (await conflicts.json()).id;
  const ambiguous = await (await f.send(importer.bearer, 'GET', path3)).json();
  expect(ambiguous.rows[0].match.state).toBe('ambiguous');
  expect(ambiguous.rows[0].match.candidates).toHaveLength(2);
  expect((await f.send(importer.bearer, 'POST', path3 + ':review', { ordinal: 0, fields: ['status'] })).status).toBe(409);
  const guarded = await f.send(importer.bearer, 'POST', path3 + ':review', { ordinal: 1, subjectId, fields: ['status'], replace: true });
  const guardedId = (await guarded.json()).review.id;
  const before = (await (await f.send(importer.bearer, 'GET', `/v1/libraryEntries/${subjectId}`)).json()).libraryEntry;
  expect((await f.send(importer.bearer, 'PUT', `/v1/libraryEntries/${subjectId}`, { state: 'planned', revision: before.revision, incarnationId: before.incarnationId })).status).toBe(200);
  const stale = await f.send(importer.bearer, 'POST', path3 + ':apply', { confirmations: [{ ordinal: 1, reviewId: guardedId }] });
  expect((await stale.json()).outcomes[0].status).toBe('stale');
  const pending = await f.send(importer.bearer, 'POST', path3 + ':review', { ordinal: 2, subjectId, fields: ['status'] });
  expect((await f.send(importer.bearer, 'POST', path3 + ':cancel', {})).status).toBe(200);
  const cancelled = await f.send(importer.bearer, 'POST', path3 + ':apply', { confirmations: [{ ordinal: 2, reviewId: (await pending.json()).review.id }] });
  expect(await cancelled.json()).toEqual({ outcomes: [], complete: false });
  expect((await f.send(importer.bearer, 'POST', base + ':preview', { upload: '{' })).status).toBe(400);
  expect((await f.send(importer.bearer, 'POST', base + ':preview', { upload: ' '.repeat(1048577) })).status).toBe(400);
  await f.revokeIdentity(importer.actor.accountId);
  expect((await f.send(importer.bearer, 'GET', path)).status).toBeGreaterThanOrEqual(401);
  expect((await f.send(importer.bearer, 'POST', path + ':apply', { confirmations: [first] })).status).toBeGreaterThanOrEqual(401);
}, 120000);

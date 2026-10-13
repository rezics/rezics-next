import { afterAll, beforeAll, expect } from 'bun:test';
import { randomUUID } from 'node:crypto';
import libraryImport from '../../../../../scripts/qa/cases/outcomes/books/library-import.ts';
import libraryExport from '../../../../../scripts/qa/cases/outcomes/books/library-export.ts';
import interruptedExport from '../../../../../scripts/qa/cases/outcomes/books/resume-an-interrupted-export-interrupted-exports.ts';
import { outcomeTest } from '../../../support/outcome-test.ts';
import { personaSessions, type PersonaName, type PersonaSessions } from '../../../support/personas.ts';
import { pollLibraryImportApply } from '../../library-import-apply-support.ts';

type CanonicalRow = {
  kind: 'source' | 'entry' | 'session' | 'shelf' | 'retained'; sourceId: string; title: string;
  creators: string[]; work: string | null; target: string | null; identifiers: unknown[];
  status: string | null; startedOn: string | null; finishedOn: string | null; score: unknown;
  review: { text: string; language: string; spoiler: boolean } | null; shelves: string[];
  readCount: number | null; progress: unknown; raw: Record<string, unknown>;
  session: { target: string; state: string; startedOn: string | null; finishedOn: string | null;
    selections: { target: string; language?: string; format?: string }[]; locators: unknown[] } | null;
};

type Page = { profile: string; rows: CanonicalRow[]; snapshot: string; nextCursor: string | null };
type Review = { rows: { index: number; version: number; source: CanonicalRow }[]; nextCursor: number | null };
let people: PersonaSessions, book: string, upload: string, originals: CanonicalRow[];
let applied: Promise<void> | undefined;
let continuation: Promise<Page> | undefined;
const own = () => ({ actingSubject: people.owner.actingSubject! });
const query = () => new URLSearchParams(own()).toString();
const root = () => `/v1/me/library-imports/${upload}`;

async function json<T>(response: Promise<Response>, status = 200): Promise<T> {
  const answer = await response, raw = await answer.text();
  if (answer.status !== status) throw new Error(`HTTP ${answer.status}, expected ${status}: ${raw}`);
  return JSON.parse(raw) as T;
}
async function refused(response: Promise<Response>, status: number, code: string) {
  const answer = await response, raw = await answer.text();
  expect({ status: answer.status, ...(answer.status === status ? {} : { raw }) }).toEqual({ status });
  expect(JSON.parse(raw).code).toBe(code);
  expect(raw).not.toContain('Private journal');
  expect(raw).not.toContain('Original private review');
}
function row(kind: CanonicalRow['kind'], sourceId: string): CanonicalRow {
  return { kind, sourceId, title: 'Owned original Book', creators: ['Original fixture owner'], work: book,
    target: null, identifiers: [], status: null, startedOn: null, finishedOn: null, score: null,
    review: null, shelves: [], readCount: null, progress: null, session: null, raw: {} };
}
function create(rows: CanonicalRow[], key = randomUUID()) {
  return people.owner.main('POST', '/v1/me/library-imports', { ...own(), format: 'rezics',
    file: JSON.stringify({ profile: 'rezics-library-export-v1', rows }) }, key);
}
async function review(id: string) {
  let cursor = -1;
  const result: Review['rows'] = [];
  do {
    const page = await json<Review>(people.owner.main('GET',
      `/v1/me/library-imports/${id}/rows?${query()}&cursor=${cursor}`, undefined, randomUUID()));
    result.push(...page.rows); cursor = page.nextCursor ?? -1;
  } while (cursor !== -1);
  return result;
}
async function apply(id: string, key = randomUUID()) {
  const progress = await pollLibraryImportApply(() => people.owner.main('GET',
    `/v1/me/library-imports/${id}/apply?${query()}`, undefined, randomUUID()), {
    started: people.owner.main('POST', `/v1/me/library-imports/${id}/apply`,
      { ...own(), context: null, language: 'en' }, key), deadlineMs: 60_000,
  });
  expect(progress).toMatchObject({ state: 'completed', pending: false, issues: 0 });
  return progress;
}
function read(cursor?: string | null, snapshot?: string, limit = 20) {
  const q = new URLSearchParams({ ...own(), limit: String(limit),
    ...(cursor ? { cursor } : {}), ...(snapshot ? { snapshot } : {}) });
  return json<Page>(people.owner.main('GET', `/v1/me/library-export?${q}`));
}
async function collect(first = read()) {
  let page = await first;
  const rows = [...page.rows], snapshot = page.snapshot;
  while (page.nextCursor) {
    page = await read(page.nextCursor, snapshot);
    expect(page.snapshot).toBe(snapshot); rows.push(...page.rows);
  }
  return rows;
}
function ensureApplied() {
  return applied ??= (async () => {
    const reviewed = await review(upload);
    expect(reviewed.map(item => item.source)).toEqual(originals);
    await json(people.owner.main('PUT', `${root()}/rows/0`, { ...own(),
      expectedVersion: reviewed[0]!.version, choice: 'apply', work: book, conflictChoice: 'replace' }));
    const key = randomUUID();
    expect(await apply(upload, key)).toMatchObject({ completed: originals.length, total: originals.length });
    // Replay the accepted command after completion; its receipt cannot apply another session.
    await json(people.owner.main('POST', `${root()}/apply`, { ...own(), context: null, language: 'en' }, key), 202);
  })();
}
function tokens() {
  return continuation ??= (async () => {
    const first = await read(undefined, undefined, 2);
    expect(first.nextCursor).toBeTruthy();
    return first;
  })();
}

beforeAll(async () => {
  people = await personaSessions('private');
  const created = await json<{ work: string }>(people.owner.main('POST', '/v1/works', {
    profile: 'metadata-only-v1', authoring: 'own-work', title: `Original portable Book ${randomUUID()}`,
    language: 'en', semanticTypes: ['https://schema.org/Book'], ...own(),
  }), 201);
  book = created.work;
  const identified = await json<{ types: string[] }>(people.owner.main('GET',
    `/v1/works/${book.slice(-36)}?${query()}`));
  expect(identified.types).toContain('https://schema.org/Book');
  const statement = { ...row('entry', 'original-statement'), status: 'want-to-read' as const,
    review: { text: 'Original private review', language: 'en', spoiler: true }, shelves: ['Private portable shelf'],
    raw: { sessionProjection: null, privateJournal: 'Private journal' } };
  const attempt = { ...row('session', 'original-attempt'), session: { target: book, state: 'planned' as const,
    startedOn: null, finishedOn: null, selections: [{ target: book }], locators: [] } };
  const emptyShelf = { ...row('shelf', 'original-empty-shelf'), shelves: ['Empty private shelf'],
    raw: { disclosure: 'private' } };
  originals = [statement, attempt, emptyShelf, ...Array.from({ length: 25 }, (_, index) => ({
    ...row('retained', `original-private-${index}`), raw: { note: `Private journal ${index}`, credit: 'Original fixture owner' },
  }))];
  upload = (await json<{ id: string }>(create(originals), 201)).id;
}, 120_000);
afterAll(async () => { await people?.close(); });

async function deniedImports(name: Exclude<PersonaName, 'owner'>) {
  const person = people[name], status = name === 'visitor' ? 401 : 403;
  const code = name === 'visitor' ? 'account_assertion_denied' : 'library_import_denied';
  // These are ordinary member routes. No row-relevant platform import operation exists.
  const calls: [string, string, object?][] = [
    ['POST', '/v1/me/library-imports', { ...own(), format: 'rezics', file: JSON.stringify({ profile: 'rezics-library-export-v1', rows: originals }) }],
    ['GET', `${root()}/rows?${query()}`],
    ['PUT', `${root()}/rows/0`, { ...own(), expectedVersion: 1, choice: 'private' }],
    ['POST', `${root()}/apply`, { ...own(), context: null, language: 'en' }],
    ['GET', `${root()}/apply?${query()}`],
    ['DELETE', `${root()}?${query()}`],
    ['POST', `${root()}/rows/0/adoptions`, { ...own(), workId: 'OL1W' }],
  ];
  for (const [method, path, body] of calls) await refused(person.main(method, path, body, randomUUID()), status, code);
}
async function deniedExport(name: Exclude<PersonaName, 'owner'>, resume = false) {
  const person = people[name], page = resume ? await tokens() : undefined;
  const q = new URLSearchParams({ ...own(), ...(page ? { cursor: page.nextCursor!, snapshot: page.snapshot } : {}) });
  // Platform-admin is established by personaSessions; it supplies no Person-control mandate.
  await refused(person.main('GET', `/v1/me/library-export?${q}`), name === 'visitor' ? 401 : 403,
    name === 'visitor' ? 'account_assertion_denied' : 'library_export_denied');
  if (page && person.actingSubject) {
    q.set('actingSubject', person.actingSubject);
    await refused(person.main('GET', `/v1/me/library-export?${q}`), 400, 'invalid_work_read');
  }
}
function preserved(rows: CanonicalRow[]) {
  expect(rows.filter(item => item.kind === 'retained' && item.sourceId.startsWith('original-private-'))
    .sort((a, b) => a.sourceId.localeCompare(b.sourceId))).toEqual(originals.slice(3)
    .sort((a, b) => a.sourceId.localeCompare(b.sourceId)));
  expect(rows.find(item => item.review)?.review).toEqual(originals[0]!.review);
  expect(rows.find(item => item.sourceId === `status:${book}`)?.status).toBe('want-to-read');
  expect(rows.filter(item => item.kind === 'session')).toHaveLength(1);
  expect(rows.find(item => item.kind === 'session')?.session).toEqual(originals[1]!.session);
  expect(rows.filter(item => item.kind === 'shelf').map(item => [item.shelves[0], item.raw.disclosure]).sort())
    .toEqual([['Empty private shelf', 'private'], ['Private portable shelf', 'private']]);
  expect(rows.some(item => (item.raw.fields as Record<string, unknown> | undefined)?.privateJournal === 'Private journal')).toBe(true);
}

outcomeTest(libraryImport, 'visitor', () => deniedImports('visitor'));
outcomeTest(libraryImport, 'stranger', () => deniedImports('stranger'));
outcomeTest(libraryImport, 'member', () => deniedImports('member'));
outcomeTest(libraryImport, 'moderator', () => deniedImports('moderator'));
outcomeTest(libraryImport, 'operator', () => deniedImports('operator'));
outcomeTest(libraryImport, 'owner', async () => {
  await ensureApplied(); preserved(await collect());
  await refused(people.owner.main('POST', `${root()}/rows/0/adoptions`, { ...own(), workId: 'OL1W' }), 400, 'invalid_library_file');
  const disposable = (await json<{ id: string }>(create([originals[3]!]), 201)).id;
  await json(people.owner.main('DELETE', `/v1/me/library-imports/${disposable}?${query()}`));
  await refused(people.owner.main('GET', `/v1/me/library-imports/${disposable}/rows?${query()}`,
    undefined, randomUUID()), 404, 'library_import_missing');
});
outcomeTest(libraryExport, 'visitor', () => deniedExport('visitor'));
outcomeTest(libraryExport, 'stranger', () => deniedExport('stranger'));
outcomeTest(libraryExport, 'member', () => deniedExport('member'));
outcomeTest(libraryExport, 'moderator', () => deniedExport('moderator'));
outcomeTest(libraryExport, 'operator', () => deniedExport('operator'));
outcomeTest(libraryExport, 'owner', async () => {
  await ensureApplied();
  const before = await collect(); preserved(before);
  const sourceSnapshot = (await read()).snapshot;
  const restored = await json<{ id: string }>(people.owner.main('POST', '/v1/me/library-imports', {
    ...own(), format: 'rezics', file: JSON.stringify({ profile: 'rezics-library-export-v1', rows: before, snapshot: sourceSnapshot }),
  }), 201);
  await review(restored.id); await apply(restored.id);
  preserved(await collect());
  const cache = await people.owner.main('GET', `/v1/me/library-export?${query()}`);
  expect(cache.status).toBe(200); expect(cache.headers.get('cache-control')).toBe('private, no-store');
});
outcomeTest(interruptedExport, 'visitor', () => deniedExport('visitor', true));
outcomeTest(interruptedExport, 'stranger', () => deniedExport('stranger', true));
outcomeTest(interruptedExport, 'member', () => deniedExport('member', true));
outcomeTest(interruptedExport, 'moderator', () => deniedExport('moderator', true));
outcomeTest(interruptedExport, 'operator', () => deniedExport('operator', true));
outcomeTest(interruptedExport, 'owner', async () => {
  await ensureApplied();
  const first = await tokens();
  // Discard a delivered page without acknowledging its nextCursor, then retry the prior cursor.
  const dropped = await read(first.nextCursor, first.snapshot);
  const repeated = await read(first.nextCursor, first.snapshot);
  expect(repeated.rows).toEqual(dropped.rows); expect(repeated.snapshot).toBe(first.snapshot);
  const assembled = [...first.rows, ...await collect(Promise.resolve(repeated))];
  expect(assembled).toEqual(await collect()); preserved(assembled);
  expect(new Set(assembled.map(item => item.sourceId)).size).toBe(assembled.length);
  await refused(people.owner.main('GET', `/v1/me/library-export?${query()}&cursor=${first.nextCursor}`), 409, 'read_basis_changed');
  await json(people.owner.main('PUT', `/v1/me/import-reviews/${book.slice(-36)}`, { ...own(),
    text: 'Later original private review', language: 'en', spoiler: true, expectedVersion: 1 }));
  await refused(people.owner.main('GET', `/v1/me/library-export?${query()}&cursor=${first.nextCursor}&snapshot=${first.snapshot}`), 409, 'read_basis_changed');
  expect((await collect()).find(item => item.review)?.review?.text).toBe('Later original private review');
});

import { afterAll, beforeAll, expect, setDefaultTimeout } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import tracking from '../../../../../scripts/qa/cases/outcomes/books/collection-tracking-and-progress.ts';
import devices from '../../../../../scripts/qa/cases/outcomes/books/continue-progress-across-devices-two-device-progress.ts';
import loans from '../../../../../scripts/qa/cases/outcomes/books/loans.ts';
import expired from '../../../../../scripts/qa/cases/outcomes/books/return-an-expired-loan-expired-loans.ts';
import { signIn } from '../../../../../scripts/lib/oauth-client.ts';
import { OutcomeRecorder, outcomeResponse, outcomeTest } from '../../../support/outcome-test.ts';
import { personaSessions, type PersonaName, type PersonaSessions } from '../../../support/personas.ts';

type Work = { work: string; mainVersion: string; workRevision: string };
type Structure = { structure: string; revision: string; occurrences: string[] };
type RecordState = { id: string; version: number; state: string; returnedAt: string | null; replayed: boolean };
type Progress = { version: number; completed: boolean; position: string | null };
setDefaultTimeout(60_000);
let people: PersonaSessions, book: Work, series: Work, chapters: Structure, seriesParts: Structure;
let release: string, privateCopy: RecordState, privateLoan: RecordState;
let secondDevice: PersonaSessions['owner']['main'];
const short = (value: string) => value.slice(-36);
const subject = () => people.owner.actingSubject!;
const own = () => ({ actingSubject: subject() });
const query = () => `actingSubject=${encodeURIComponent(subject())}`;
const ownerCall = (method: string, path: string, body?: object, key?: string) => people.owner.main(method, path, body, key);
const progressPath = (index = 0) => `/v1/compositions/${short(chapters.structure)}/occurrences/${short(chapters.occurrences[index]!)}/progress`;
const statusPath = () => `/v1/works/${short(book.work)}/reader-status`;
const readerPath = () => `/v1/works/${short(book.work)}/reader-state?${query()}`;
const loanPage = (state: string) => `/v1/me/library-loans?${query()}&state=${state}`;
const recordings = {
  tracking: new OutcomeRecorder(tracking), devices: new OutcomeRecorder(devices),
  loans: new OutcomeRecorder(loans), expired: new OutcomeRecorder(expired),
};
type Sample = ReturnType<OutcomeRecorder['session']>;
async function json<T>(request: Promise<Response>, status = 200): Promise<T> {
  const response = await request, raw = await response.text();
  if (response.status !== status) console.info('Outcome answer', JSON.stringify({
    url: response.url, expectedStatus: status, status: response.status,
    answer: raw, headers: Object.fromEntries(response.headers.entries()),
  }));
  expect({ status: response.status, ...(response.status === status ? {} : { raw }) }).toEqual({ status });
  return JSON.parse(raw) as T;
}
const chapterPosition = (index: number) => ({ work: book.work, structure: chapters.structure,
  revision: chapters.revision, occurrence: chapters.occurrences[index], parent: chapters.structure,
  role: 'chapter', target: 'https://schema.org/DigitalDocument',
  labels: [{ value: `Chapter ${index + 1}`, language: 'en' }] });
const bookCard = (work: Work, title: string) => ({ id: work.work,
  title: { value: title, language: 'en' }, types: ['https://schema.org/Book'] });
async function emptyPage(request: Promise<Response>) {
  expect(await json(request)).toMatchObject({ items: [], nextCursor: null });
}
async function ratingContexts(sample: Sample, label: string) {
  const page = await json<{ items: { context: string }[] }>(sample(label, 'GET', '/v1/rating-contexts?scope=global&limit=1'));
  expect(page).toMatchObject({ profile: 'standing-rating-contexts-v1', scope: { kind: 'global', realm: null } });
  expect(page.items.length).toBeLessThanOrEqual(1);
  for (const item of page.items) expect(item.context).toMatch(/^https:\/\/rezics\.com\/id\//);
  return page;
}
async function privateReply(response: Response, expected: number) {
  const raw = await response.text();
  expect({ status: response.status, ...(response.status === expected ? {} : { raw }) }).toEqual({ status: expected });
  expect(raw).not.toContain('private owner bookmark');
  expect(raw).not.toContain(privateLoan.id);
  expect(raw).not.toContain('Private fixture borrower');
}
async function createBook(title: string): Promise<Work> {
  const work = await json<Work>(ownerCall('POST', '/v1/works', {
    profile: 'metadata-only-v1', authoring: 'own-work', ...own(), title, language: 'en', semanticTypes: ['https://schema.org/Book'],
  }), 201);
  const draft = await json<{ contribution: string; draftRevision: string; author: string }>(ownerCall('POST', '/v1/contributions', {
    profile: 'text-contribution-v1', ...own(), work: work.work, language: 'en', body: `Original outcome fixture: ${title}.`,
  }), 201);
  expect(draft.author).toBe(subject());
  const publication = await json<{ publicationDecision: string }>(ownerCall('POST', '/v1/contribution-publications', {
    profile: 'text-publication-v1', ...own(), contribution: draft.contribution, expectedDraftHead: draft.draftRevision,
    expectedPublicationHead: null, rightsBasis: 'original-contribution', disclosure: 'public',
  }), 201);
  await json(ownerCall('POST', '/v1/publication-selections', {
    profile: 'main-default-selection-v1', ...own(), context: { kind: 'main-version-default', id: work.mainVersion },
    work: work.work, contribution: draft.contribution, publicationDecision: publication.publicationDecision,
    expectedSelectionHead: null, selectionBasis: 'main-maintainer',
  }), 201);
  return work;
}
async function compose(work: Work, profile: string, operations: (root: string) => object[]) {
  const base = await json<Structure>(ownerCall('POST', '/v1/compositions', { ...own(), profile, work: work.work, mainVersion: work.mainVersion }), 201);
  const changed = await json<Structure>(ownerCall('POST', `/v1/compositions/${short(base.structure)}/changes`, {
    ...own(), profile, expectedHead: base.revision, operations: operations(base.structure),
  }));
  return { ...changed, structure: base.structure };
}
const makeCopy = (sample: Sample = (_label, ...args) => ownerCall(...args)) => json<RecordState>(sample('create-copy', 'POST', '/v1/me/library-copies', {
  ...own(), expectedVersion: 0, release, format: 'paperback', acquiredFrom: { kind: 'name', name: 'Private fixture library' },
}), 201);
const openBody = (copy: string, overdue = true) => ({
  ...own(), expectedVersion: 0, copy, direction: 'lent', counterparty: { kind: 'name', name: 'Private fixture borrower' },
  startedAt: new Date(Date.now() - 3 * 86_400_000).toISOString(),
  dueAt: new Date(Date.now() + (overdue ? -1 : 7) * 86_400_000).toISOString(),
});

beforeAll(async () => {
  people = await personaSessions('public');
  for (const recording of Object.values(recordings)) await recording.prepare();
  // A second OAuth grant and session key represent another device, with the same Account/Person.
  const directory = join('.temp/stack', `rezics-qa-${Bun.env.REZICS_QA_RUN_ID}`);
  const auth = readdirSync(directory).filter(name => name.startsWith('g-1005-auth-'));
  if (auth.length !== 1) throw new Error(`Expected one persona OAuth configuration, found ${auth.length}`);
  const config = JSON.parse(readFileSync(join(directory, auth[0]!, 'public.json'), 'utf8')) as {
    clientId: string; redirectUris: string[]; scope: string; resource: string; mainBaseUrl: string;
  };
  const accountBase = Bun.env.ACCOUNT_BASE_URL!;
  const device = await signIn({ account: accountBase, clientId: config.clientId,
    redirectUri: config.redirectUris[0]!, scope: config.scope, resource: config.resource,
    fetch: (url, init) => new URL(url).pathname.endsWith('/authorize')
      ? people.owner.account('GET', String(url)) : fetch(url, init),
  }, '');
  const sessionKey = randomUUID();
  secondDevice = async (method, path, body, key) => {
    const token = await device.current();
    const request = (signal: AbortSignal) => fetch(new URL(path, config.mainBaseUrl), {
      method, headers: { authorization: `Bearer ${token}`, 'x-session-key': sessionKey,
        'idempotency-key': key ?? randomUUID(), ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      redirect: 'manual', signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]),
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return method === 'GET' ? outcomeResponse(request) : request(AbortSignal.timeout(30_000));
  };
  book = await createBook('Original outcome volume');
  series = await createBook('Original outcome series');
  chapters = await compose(book, 'book-composition', root => [1, 2].map(number => ({
    op: 'insert', parent: root, position: 'last', role: 'chapter', target: 'https://schema.org/DigitalDocument',
    label: { value: `Chapter ${number}`, language: 'en' },
  })));
  seriesParts = await compose(series, 'work-composition', root => [{
    op: 'insert', parent: root, position: 'last', role: 'part', target: book.work, displayLabel: '1', inclusion: 'required',
  }]);
  release = `https://rezics.com/id/${randomUUID()}`;
  await json(ownerCall('PUT', `/v1/works/${short(book.work)}/releases/${short(release)}`, {
    profile: 'release-v1', ...own(), expectedHead: null, id: release, kind: 'formal', status: 'official',
    contentLanguages: ['en'], isTranslation: false, originalLanguages: [], titleLanguage: 'en', tracklistLanguage: null,
    title: { value: 'Original outcome paperback', language: 'en' }, editionStatement: null, publisher: null,
    publicationYear: null, isbn13: null, originalUrl: null, fixedRelease: null, coverage: null, evidence: null,
  }));
  await json(ownerCall('PUT', statusPath(), { ...own(), expectedVersion: 0, status: 'reading' }));
  await json(ownerCall('PUT', `/v1/works/${short(series.work)}/reader-status`, { ...own(), expectedVersion: 0, status: 'reading' }));
  await json(ownerCall('PUT', progressPath(), { ...own(), expectedVersion: 0, completed: false, position: 'private owner bookmark' }));
  privateCopy = await makeCopy();
  privateLoan = await json<RecordState>(ownerCall('POST', '/v1/me/library-loans', openBody(privateCopy.id)), 201);
}, 120_000);
afterAll(async () => {
  try { for (const recording of Object.values(recordings)) await recording.publish(); }
  finally { await people?.close(); }
});

async function ownerLibrary() {
  const state = await json<Record<string, unknown>>(ownerCall('GET', readerPath()));
  const shelf = await json<{ items: { work: string }[] }>(ownerCall('GET',
    `/v1/me/shelves/status/reading/works?${query()}&sort=last-read&order=desc`));
  const { sourcePosition: _position, ...readerState } = state;
  return { readerState, shelf: shelf.items.map(item => item.work) };
}
async function deniedTracking(name: PersonaName) {
  // Operator requests use ordinary member routes; these rows have no platform operation.
  const person = people[name], expected = name === 'visitor' ? 401 : 403;
  const sample = recordings.tracking.session(name, person);
  // Establish a different most-recent Work before each attempted foreign write.
  // Reader-state alone cannot reveal a changed last-read shelf ordering.
  const anchor = `/v1/compositions/${short(seriesParts.structure)}/occurrences/${short(seriesParts.occurrences[0]!)}/progress`;
  const current = await json<Progress>(ownerCall('GET', `${anchor}?${query()}`));
  await json(ownerCall('PUT', anchor, { ...own(), expectedVersion: current.version, completed: false, position: null }));
  const before = await ownerLibrary();
  expect(before.shelf).toEqual([series.work, book.work]);
  if (name === 'visitor') {
    const empty = await json<{ status: { status: null }; progress: null }>(sample('signed-out-reader-state', 'GET', readerPath()));
    expect(empty).toMatchObject({ status: { status: null }, progress: null });
  } else await privateReply(await sample('foreign-reader-state', 'GET', readerPath()), expected);
  await privateReply(await sample('status-refused', 'PUT', statusPath(), { ...own(), expectedVersion: 1, status: 'want-to-read' }), expected);
  const response = await sample('chapter-save-refused', 'PUT', progressPath(), { ...own(), expectedVersion: 0, completed: true, position: null });
  const raw = await response.text(), after = await ownerLibrary();
  const observed = { status: response.status, ...(response.status === expected ? {} : { raw }),
    ownerReaderStateUnchanged: JSON.stringify(before.readerState) === JSON.stringify(after.readerState),
    ownerShelfUnchanged: JSON.stringify(before.shelf) === JSON.stringify(after.shelf) };
  if (response.status !== expected || !observed.ownerShelfUnchanged) {
    console.info('Outcome answer', JSON.stringify({ row: tracking.rowId, persona: name,
      request: { method: 'PUT', path: progressPath(), actingSubject: subject(), expectedVersion: 0, completed: true, position: null },
      ...observed, shelfBefore: before.shelf, shelfAfter: after.shelf }));
  }
  expect(observed).toEqual({ status: expected, ownerReaderStateUnchanged: true, ownerShelfUnchanged: true });
  if (name === 'member') {
    await emptyPage(sample('empty-reading-shelf', 'GET', `/v1/me/shelves/status/reading/works?actingSubject=${encodeURIComponent(person.actingSubject!)}&sort=last-read&order=desc&limit=3`));
  }
}
async function deniedDevices(name: PersonaName) {
  const person = people[name], expected = name === 'visitor' ? 401 : 403;
  const sample = recordings.devices.session(name, person);
  const occurrence = await sample('chapter-progress-refused', 'GET', `${progressPath()}?${query()}`);
  const completed = await sample('completions-refused', 'GET', `/v1/compositions/${short(chapters.structure)}/progress?${query()}`);
  const replies = [{ status: occurrence.status, raw: await occurrence.text() },
    { status: completed.status, raw: await completed.text() }];
  if (replies.some(reply => reply.status !== expected)) {
    console.info('Outcome answer', JSON.stringify({ row: devices.rowId, persona: name,
      requests: [`${progressPath()}?${query()}`, `/v1/compositions/${short(chapters.structure)}/progress?${query()}`], replies }));
  }
  expect(replies.map(reply => ({ status: reply.status,
    ...(reply.status === expected ? {} : { raw: reply.raw }) }))).toEqual([{ status: expected }, { status: expected }]);
  for (const reply of replies) expect(reply.raw).not.toContain('private owner bookmark');
  if (name === 'member') {
    const actor = `actingSubject=${encodeURIComponent(person.actingSubject!)}`;
    expect(await json(sample('empty-chapter-progress', 'GET', `${progressPath()}?${actor}`)))
      .toMatchObject({ structure: chapters.structure, occurrence: chapters.occurrences[0],
        completed: false, position: null, version: 0 });
    await emptyPage(sample('empty-completions', 'GET', `/v1/compositions/${short(chapters.structure)}/progress?${actor}&limit=20`));
    expect(await json(sample('no-saved-position', 'GET', `/v1/reading-positions/${short(book.work)}?${actor}&position=mine&limit=20`)))
      .toMatchObject({ profile: 'reading-positions-v1', work: book.work, resolved: 'start',
        items: [chapterPosition(0), chapterPosition(1)], complete: true, nextCursor: null });
  }
}
async function deniedLoans(name: PersonaName) {
  const person = people[name], expected = name === 'visitor' ? 401 : 403;
  const sample = recordings.loans.session(name, person);
  await privateReply(await sample('copies-refused', 'GET', `/v1/works/${short(book.work)}/copies?${query()}`), expected);
  await privateReply(await sample('active-loans-refused', 'GET', `${loanPage('active')}&limit=20`), expected);
  await privateReply(await sample('open-loan-refused', 'POST', '/v1/me/library-loans', openBody(privateCopy.id)), expected);
  await privateReply(await sample('extend-loan-refused', 'POST', `/v1/me/library-loans/${short(privateLoan.id)}/extend`, {
    ...own(), expectedVersion: 1, dueAt: new Date(Date.now() + 10 * 86_400_000).toISOString(),
  }), expected);
  await privateReply(await sample('return-loan-refused', 'POST', `/v1/me/library-loans/${short(privateLoan.id)}/return`, { ...own(), expectedVersion: 1 }), expected);
  if (name === 'member') await emptyPage(sample('empty-active-loans', 'GET',
    `/v1/me/library-loans?actingSubject=${encodeURIComponent(person.actingSubject!)}&state=active&limit=20`));
}
async function deniedExpired(name: PersonaName) {
  const expected = name === 'visitor' ? 401 : 403;
  const sample = recordings.expired.session(name, people[name]);
  await privateReply(await sample('overdue-loans-refused', 'GET', loanPage('overdue')), expected);
  await privateReply(await sample('returned-loans-refused', 'GET', loanPage('returned')), expected);
  await privateReply(await sample('return-loan-refused', 'POST', `/v1/me/library-loans/${short(privateLoan.id)}/return`, { ...own(), expectedVersion: 1 }), expected);
  const page = await json<{ items: RecordState[] }>(ownerCall('GET', loanPage('overdue')));
  expect(page.items.find(loan => loan.id === privateLoan.id)).toMatchObject({ state: 'overdue', version: 1, returnedAt: null });
  if (name === 'member') await emptyPage(sample('empty-active-loans', 'GET',
    `/v1/me/library-loans?actingSubject=${encodeURIComponent(people[name].actingSubject!)}&state=active&limit=20`));
}

// `/library` and `/library/loans` share the shelf navigation reads.
async function libraryOverviewReads(sample: Sample, bookStatus: 'reading' | 'read') {
  expect(await json(sample('shelf-directory', 'GET', `/v1/me/shelves?${query()}&limit=20`)))
    .toMatchObject({ profile: 'reader-shelves-v1', items: [], nextCursor: null,
      statusShelves: expect.arrayContaining([
        expect.objectContaining({ status: 'reading', count: bookStatus === 'reading' ? 2 : 1 }),
        expect.objectContaining({ status: 'read', count: bookStatus === 'read' ? 1 : 0 }),
        expect.objectContaining({ status: 'want-to-read', count: 0 }),
      ]) });
  expect(await json(sample('library-visibility', 'GET', `/v1/agents/${short(subject())}/library-visibility`)))
    .toMatchObject({ visibility: 'private', version: 0 });
  await ratingContexts(sample, 'global-rating-context');
}

// The reading strip and a status shelf use different page sizes and their own reader-state batch.
async function libraryRenderReads(sample: Sample) {
  await libraryOverviewReads(sample, 'reading');
  expect(await json(sample('yearly-reading-goal', 'GET', `/v1/me/reading-goal?${query()}&year=${new Date().getUTCFullYear()}`)))
    .toMatchObject({ year: new Date().getUTCFullYear(), target: null, completed: 0, version: 0 });
  await emptyPage(sample('followed-authors', 'GET', `/v1/me/follows/authors?${query()}`));
  for (const [label, limit] of [['currently-reading-preview', 3], ['reading-shelf', 20]] as const) {
    expect(await json(sample(label, 'GET', `/v1/me/shelves/status/reading/works?${query()}&sort=last-read&order=desc&limit=${limit}`)))
      .toMatchObject({ status: 'reading', nextCursor: null, items: [
        { work: series.work, status: 'reading', card: bookCard(series, 'Original outcome series') },
        { work: book.work, status: 'reading', card: bookCard(book, 'Original outcome volume') },
      ] });
  }
  expect(await json(sample('reading-work-states', 'GET', `/v1/me/work-states?${query()}&works=${encodeURIComponent(`${book.work},${series.work}`)}`)))
    .toMatchObject({ profile: 'reader-work-state-batch-v1', items: [
      { work: book.work, status: { status: 'reading' }, progress: {
        occurrence: chapters.occurrences[0], completed: false, position: 'private owner bookmark' } },
      { work: series.work, status: { status: 'reading' } },
    ] });
  for (const [label, work, title] of [['book', book, 'Original outcome volume'], ['series', series, 'Original outcome series']] as const) {
    expect(await json(sample(`${label}-card-and-chapter-count`, 'GET', `/v1/works/${short(work.work)}?${query()}`)))
      .toMatchObject({ profile: 'work-read-v1', mainVersion: work.mainVersion, ...bookCard(work, title) });
    expect(await json(sample(`${label}-reading-resume`, 'GET', `/v1/me/continue/${short(work.work)}?${query()}`)))
      .toMatchObject({ profile: 'work-resume-v1', work: work.work,
        nextUnread: label === 'series' ? null : { occurrence: chapters.occurrences[0], title: 'Chapter 1',
          href: `/w/${short(book.work)}/read/${short(chapters.occurrences[0]!)}?language=en` },
        unreadCount: label === 'series' ? null : { value: 2, kind: 'exact' },
        lastPosition: label === 'series' ? null : {
          occurrence: chapters.occurrences[0], completed: false, position: 'private owner bookmark' } });
  }
}

async function finishedShelfReads(sample: Sample) {
  expect(await json(sample('finished-shelf', 'GET', `/v1/me/shelves/status/read/works?${query()}&sort=added&order=desc&limit=20`)))
    .toMatchObject({ status: 'read', nextCursor: null, items: [
      { work: book.work, status: 'read', card: bookCard(book, 'Original outcome volume') },
    ] });
  expect(await json(sample('finished-work-states', 'GET', `/v1/me/work-states?${query()}&works=${encodeURIComponent(book.work)}`)))
    .toMatchObject({ profile: 'reader-work-state-batch-v1', items: [
      { work: book.work, status: { status: 'read' }, progress: {
        occurrence: chapters.occurrences[1], completed: true, position: null } },
    ] });
  expect(await json(sample('private-import-reviews', 'GET', `/v1/me/import-reviews?${query()}&works=${encodeURIComponent(book.work)}`)))
    .toEqual({ items: [] });
  const contexts = await ratingContexts(sample, 'finished-rating-context');
  if (contexts.items[0]) await emptyPage(sample('finished-work-reviews', 'GET',
    `/v1/resources/${short(book.work)}/reviews?${query()}&context=${encodeURIComponent(contexts.items[0].context)}&limit=1&showSpoilers=true`));
}

// Loan labels come from the private export, the Work and its exact release, rather than invented cards.
async function loanRenderReads(sample: Sample, bookStatus: 'reading' | 'read', copy: RecordState, loan: RecordState) {
  await libraryOverviewReads(sample, bookStatus);
  expect(await json(sample('active-loans-page', 'GET', `${loanPage('active')}&limit=20`)))
    .toMatchObject({ items: expect.arrayContaining([
      expect.objectContaining({ id: privateLoan.id, copy: privateCopy.id, state: 'overdue', returnedAt: null }),
      expect.objectContaining({ id: loan.id, copy: copy.id, state: bookStatus === 'reading' ? 'overdue' : 'open', returnedAt: null }),
    ]), nextCursor: null, complete: true });
  let cursor: string | null = null, snapshot: string | undefined, page = 0;
  const exported: { sourceId: string; work: string; target: string; raw: unknown }[] = [];
  do {
    const answer = await json<{ snapshot: string; nextCursor: string | null; rows: typeof exported }>(sample(`copy-export-${page++}`, 'GET',
      `/v1/me/library-export?${query()}&limit=20${snapshot ? `&snapshot=${encodeURIComponent(snapshot)}` : ''}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`));
    expect(answer.snapshot).toBeTruthy();
    if (snapshot) expect(answer.snapshot).toBe(snapshot);
    expect(answer).toMatchObject({ profile: 'rezics-library-export-v1' });
    expect(answer.rows.length).toBeLessThanOrEqual(20);
    exported.push(...answer.rows);
    snapshot = answer.snapshot;
    cursor = answer.nextCursor;
  } while (cursor);
  expect(exported.find(item => item.sourceId === `copy:${copy.id}`)).toMatchObject({ work: book.work,
    target: release, raw: { libraryCopy: { id: copy.id, release, format: 'paperback', removed: false } } });
  expect(exported.find(item => item.sourceId === `loan:${loan.id}`)).toMatchObject({ work: book.work,
    target: release, raw: { libraryLoan: { id: loan.id, copy: copy.id, returnedAt: null,
      counterparty: { kind: 'name', name: 'Private fixture borrower' } } } });
  expect(await json(sample('loan-work-label', 'GET', `/v1/works/${short(book.work)}?${query()}&language=en`)))
    .toMatchObject({ profile: 'work-read-v1', ...bookCard(book, 'Original outcome volume') });
  expect(await json(sample('loan-release-label', 'GET', `/v1/works/${short(book.work)}/releases/${short(release)}?${query()}`)))
    .toMatchObject({ profile: 'release-v2', id: release, kind: 'formal', status: 'official',
      title: { value: 'Original outcome paperback', language: 'en' },
      coverage: expect.arrayContaining([expect.objectContaining({ work: book.work, mainVersion: book.mainVersion })]) });
}

// ChapterProgress reads the saved position, then the chapter choices and the selected occurrence.
async function progressRenderReads(sample: Sample) {
  expect(await json(sample('book-type', 'GET', `/v1/works/${short(book.work)}?${query()}`)))
    .toMatchObject({ profile: 'work-read-v1', ...bookCard(book, 'Original outcome volume') });
  expect(await json(sample('series-volumes', 'GET', `/v1/resources/${short(series.work)}/parts?${query()}&limit=20`)))
    .toMatchObject({ resource: series.work, mainVersion: series.mainVersion,
      structure: seriesParts.structure, revision: seriesParts.revision, next: null,
      parts: [{ occurrence: seriesParts.occurrences[0], parent: seriesParts.structure,
        role: 'part', work: book.work, mainVersion: book.mainVersion, displayLabel: '1', inclusion: 'required' }] });
  expect(await json(sample('chapter-resume', 'GET', `/v1/reading-positions/${short(book.work)}?${query()}&position=mine&limit=20`)))
    .toMatchObject({ profile: 'reading-positions-v1', work: book.work, resolved: chapters.occurrences[0],
      items: [chapterPosition(0)], complete: true, nextCursor: null });
  expect(await json(sample('chapter-choices', 'GET', `/v1/reading-positions/${short(book.work)}?${query()}&position=start&limit=20`)))
    .toMatchObject({ profile: 'reading-positions-v1', work: book.work, resolved: 'start',
      items: [chapterPosition(0), chapterPosition(1)], complete: true, nextCursor: null });
  expect(await json(sample('completed-chapters', 'GET', `/v1/compositions/${short(chapters.structure)}/progress?${query()}&limit=20`)))
    .toMatchObject({ structure: chapters.structure, items: [{ occurrence: chapters.occurrences[0], completed: true }],
      complete: true, nextCursor: null });
  expect(await json(sample('series-composition', 'GET', `/v1/compositions/${short(seriesParts.structure)}?${query()}&limit=20`)))
    .toMatchObject({ structure: seriesParts.structure, work: series.work, mainVersion: series.mainVersion,
      revision: seriesParts.revision, next: null, occurrences: [
        { occurrence: seriesParts.occurrences[0], state: 'active', parent: seriesParts.structure,
          role: 'part', target: book.work, qualifier: { type: 'work-part', displayLabel: '1', inclusion: 'required' } },
      ] });
  // A chapter without a selected body remains listed; it does not make the page unavailable.
  const contents = await json(sample('book-contents', 'GET', `/v1/works/${short(book.work)}/contents?${query()}&limit=20`));
  expect(contents).toMatchObject({ profile: 'work-contents-v1', work: book.work, version: book.mainVersion,
    composition: chapters.structure, compositionRevision: chapters.revision, language: 'en',
    nextCursor: null, count: { value: 2, kind: 'exact-page', total: null },
    items: chapters.occurrences.map((occurrence, index) => ({ occurrence, parent: chapters.structure,
      role: 'chapter', label: { value: `Chapter ${index + 1}`, language: 'en' }, number: index + 1,
      division: null, childCount: null, target: null, selectedRevision: null, progress: null,
      availability: 'unavailable' })) });
}

outcomeTest(expired, 'visitor', () => deniedExpired('visitor'), recordings.expired);
outcomeTest(expired, 'stranger', () => deniedExpired('stranger'), recordings.expired);
outcomeTest(expired, 'member', () => deniedExpired('member'), recordings.expired);
outcomeTest(expired, 'moderator', () => deniedExpired('moderator'), recordings.expired);
outcomeTest(expired, 'operator', () => deniedExpired('operator'), recordings.expired);
outcomeTest(expired, 'owner', async () => {
  const sample = recordings.expired.session('owner', people.owner);
  const copy = await makeCopy(sample), loan = await json<RecordState>(sample('open-overdue-loan', 'POST', '/v1/me/library-loans', openBody(copy.id)), 201);
  const before = await json<{ items: RecordState[] }>(sample('overdue-before-return', 'GET', loanPage('overdue')));
  expect(before.items.find(item => item.id === loan.id)).toMatchObject({ state: 'overdue', returnedAt: null });
  await loanRenderReads(sample, 'reading', copy, loan);
  await json(sample('loaned-copy-removal-refused', 'DELETE', `/v1/me/library-copies/${short(copy.id)}`, { ...own(), expectedVersion: 1 }), 409);
  const path = `/v1/me/library-loans/${short(loan.id)}/return`, key = randomUUID(), body = { ...own(), expectedVersion: 1 };
  const returned = await json<RecordState>(sample('return-overdue-loan', 'POST', path, body, key));
  expect(returned).toMatchObject({ state: 'returned', version: 2 });
  expect(returned.returnedAt).toBeTruthy();
  expect(await json(sample('return-replayed', 'POST', path, body, key))).toEqual({ ...returned, replayed: true });
  await json(sample('stale-return-refused', 'POST', path, body), 409);
  expect((await json<{ items: RecordState[] }>(sample('overdue-after-return', 'GET', loanPage('overdue')))).items.some(item => item.id === loan.id)).toBe(false);
  expect((await json<{ items: RecordState[] }>(sample('returned-history', 'GET', loanPage('returned')))).items.find(item => item.id === loan.id)).toMatchObject({ state: 'returned', version: 2 });
  expect(await json(sample('remove-returned-copy', 'DELETE', `/v1/me/library-copies/${short(copy.id)}`, { ...own(), expectedVersion: 1 }))).toMatchObject({ removed: true });
}, recordings.expired);

outcomeTest(tracking, 'visitor', () => deniedTracking('visitor'), recordings.tracking);
outcomeTest(tracking, 'stranger', () => deniedTracking('stranger'), recordings.tracking);
outcomeTest(tracking, 'member', () => deniedTracking('member'), recordings.tracking);
outcomeTest(tracking, 'moderator', () => deniedTracking('moderator'), recordings.tracking);
outcomeTest(tracking, 'operator', () => deniedTracking('operator'), recordings.tracking);
outcomeTest(tracking, 'owner', async () => {
  const sample = recordings.tracking.session('owner', people.owner);
  await libraryRenderReads(sample);
  const date = new Date().toISOString().slice(0, 10);
  const key = randomUUID(), body = { ...own(), expectedVersion: 1, status: 'reading', startedOn: date };
  const saved = await json<{ version: number }>(sample('save-reading-status', 'PUT', statusPath(), body, key));
  expect(saved.version).toBe(2);
  expect(await json(sample('status-replayed', 'PUT', statusPath(), body, key))).toMatchObject({ ...saved, replayed: true });
  await json(sample('stale-status-refused', 'PUT', statusPath(), body), 409);
  expect(await json(sample('reading-reader-state', 'GET', readerPath())))
    .toMatchObject({ status: { status: 'reading', version: 2, startedOn: date } });
  const current = await json<Progress>(sample('chapter-before-completion', 'GET', `${progressPath()}?${query()}`));
  expect(current).toMatchObject({ structure: chapters.structure, occurrence: chapters.occurrences[0],
    completed: false, position: 'private owner bookmark', version: 1 });
  await json(sample('complete-chapter', 'PUT', progressPath(), { ...own(), expectedVersion: current.version, completed: true, position: null }));
  const stats = await sample('chapter-reading-stats', 'GET', `/v1/me/reading-stats?${query()}&year=${new Date().getUTCFullYear()}`);
  expect(stats.headers.get('cache-control')).toBe('private, no-store');
  expect(await json(Promise.resolve(stats))).toMatchObject({ books: 0, chapters: 1 });
  expect(await json(sample('continue-next-chapter', 'GET', `/v1/me/continue/${short(book.work)}?${query()}`)))
    .toMatchObject({ nextUnread: { occurrence: chapters.occurrences[1] } });
  await json(sample('finish-book', 'PUT', statusPath(), { ...own(), expectedVersion: 2, status: 'read', finishedOn: date }));
  expect(await json(sample('finished-reading-stats', 'GET', `/v1/me/reading-stats?${query()}&year=${new Date().getUTCFullYear()}`)))
    .toMatchObject({ books: 1, chapters: 2 });
  await finishedShelfReads(sample);
}, recordings.tracking);
outcomeTest(devices, 'visitor', () => deniedDevices('visitor'), recordings.devices);
outcomeTest(devices, 'stranger', () => deniedDevices('stranger'), recordings.devices);
outcomeTest(devices, 'member', () => deniedDevices('member'), recordings.devices);
outcomeTest(devices, 'moderator', () => deniedDevices('moderator'), recordings.devices);
outcomeTest(devices, 'operator', () => deniedDevices('operator'), recordings.devices);
outcomeTest(devices, 'owner', async () => {
  const sample = recordings.devices.session('owner', people.owner);
  const deviceSample = recordings.devices.session('owner', { main: secondDevice });
  const path = progressPath(1), stale = await json<Progress>(deviceSample('device-two-before-save', 'GET', `${path}?${query()}`));
  expect(stale).toMatchObject({ structure: chapters.structure, occurrence: chapters.occurrences[1],
    completed: true, position: null, version: 1 });
  await json(sample('device-one-save', 'PUT', path, { ...own(), expectedVersion: stale.version, completed: true, position: 'device one paragraph' }));
  expect(await json(deviceSample('device-two-resumed-chapter', 'GET', `${path}?${query()}`))).toMatchObject({ completed: true, position: 'device one paragraph', version: stale.version + 1 });
  expect(await json(deviceSample('device-two-series-resume', 'GET', `/v1/reading-positions/${short(series.work)}?${query()}&position=mine&limit=1`)))
    .toMatchObject({ resolved: chapters.occurrences[1], profile: 'reading-positions-v1', work: series.work,
      items: [chapterPosition(1)], complete: true, nextCursor: null });
  await json(deviceSample('device-two-stale-save-refused', 'PUT', path, { ...own(), expectedVersion: stale.version, completed: false, position: null }), 409);
  const fresh = await json<Progress>(deviceSample('device-two-conflict-current', 'GET', `${path}?${query()}`));
  expect(fresh).toMatchObject({ structure: chapters.structure, occurrence: chapters.occurrences[1],
    completed: true, position: 'device one paragraph', version: stale.version + 1 });
  await json(deviceSample('device-two-recovered-save', 'PUT', path, { ...own(), expectedVersion: fresh.version, completed: false, position: null }));
  expect(await json(sample('device-one-sees-recovery', 'GET', `${path}?${query()}`))).toMatchObject({ completed: false, version: fresh.version + 1,
    structure: chapters.structure, occurrence: chapters.occurrences[1], position: null });
  await progressRenderReads(sample);
}, recordings.devices);
outcomeTest(loans, 'visitor', () => deniedLoans('visitor'), recordings.loans);
outcomeTest(loans, 'stranger', () => deniedLoans('stranger'), recordings.loans);
outcomeTest(loans, 'member', () => deniedLoans('member'), recordings.loans);
outcomeTest(loans, 'moderator', () => deniedLoans('moderator'), recordings.loans);
outcomeTest(loans, 'operator', () => deniedLoans('operator'), recordings.loans);
outcomeTest(loans, 'owner', async () => {
  const sample = recordings.loans.session('owner', people.owner);
  const copy = await makeCopy(sample), key = randomUUID(), body = openBody(copy.id, false);
  const loan = await json<RecordState>(sample('open-loan', 'POST', '/v1/me/library-loans', body, key), 201);
  expect(loan).toMatchObject({ state: 'open', copy: copy.id, version: 1 });
  expect(await json(sample('open-loan-replayed', 'POST', '/v1/me/library-loans', body, key), 201)).toMatchObject({ ...loan, replayed: true });
  await loanRenderReads(sample, 'read', copy, loan);
  const root = `/v1/me/library-loans/${short(loan.id)}`;
  await json(sample('extend-loan', 'POST', `${root}/extend`, { ...own(), expectedVersion: 1, dueAt: new Date(Date.now() + 14 * 86_400_000).toISOString() }));
  await json(sample('stale-return-refused', 'POST', `${root}/return`, { ...own(), expectedVersion: 1 }), 409);
  expect(await json(sample('return-loan', 'POST', `${root}/return`, { ...own(), expectedVersion: 2 }))).toMatchObject({ state: 'returned', version: 3 });
  expect(await json(sample('release-copies', 'GET', `/v1/works/${short(book.work)}/copies?${query()}`)))
    .toMatchObject({ items: expect.arrayContaining([expect.objectContaining({ id: copy.id, release })]) });
}, recordings.loans);

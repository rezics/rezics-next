import { afterAll, beforeAll, expect } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import tracking from '../../../../../scripts/qa/cases/outcomes/books/collection-tracking-and-progress.ts';
import devices from '../../../../../scripts/qa/cases/outcomes/books/continue-progress-across-devices-two-device-progress.ts';
import loans from '../../../../../scripts/qa/cases/outcomes/books/loans.ts';
import expired from '../../../../../scripts/qa/cases/outcomes/books/return-an-expired-loan-expired-loans.ts';
import { signIn } from '../../../../../scripts/lib/oauth-client.ts';
import { outcomeTest } from '../../../support/outcome-test.ts';
import { personaSessions, type PersonaName, type PersonaSessions } from '../../../support/personas.ts';

type Work = { work: string; mainVersion: string; workRevision: string };
type Structure = { structure: string; revision: string; occurrences: string[] };
type RecordState = { id: string; version: number; state: string; returnedAt: string | null; replayed: boolean };
type Progress = { version: number; completed: boolean; position: string | null };
let people: PersonaSessions, book: Work, series: Work, chapters: Structure;
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
async function json<T>(request: Promise<Response>, status = 200): Promise<T> {
  const response = await request, raw = await response.text();
  expect({ status: response.status, ...(response.status === status ? {} : { raw }) }).toEqual({ status });
  return JSON.parse(raw) as T;
}
async function privateReply(response: Response, expected: number) {
  const raw = await response.text();
  expect({ status: response.status, ...(response.status === expected ? {} : { raw }) }).toEqual({ status: expected });
  expect(raw).not.toContain('private owner bookmark');
  expect(raw).not.toContain(privateLoan.id);
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
  await json(ownerCall('POST', '/v1/work-publications', {
    profile: 'work-structure-publication-v1', operation: 'publish', ...own(), work: work.work,
    expectedWorkHead: work.workRevision, expectedMainVersion: work.mainVersion, structure: base.structure,
    expectedStructureHead: changed.revision, expectedPublicationHead: null, disclosure: 'public', rightsBasis: 'original-contribution',
  }), 201);
  return { ...changed, structure: base.structure };
}
const makeCopy = () => json<RecordState>(ownerCall('POST', '/v1/me/library-copies', {
  ...own(), expectedVersion: 0, release, format: 'paperback', acquiredFrom: { kind: 'name', name: 'Private fixture library' },
}), 201);
const openBody = (copy: string, overdue = true) => ({
  ...own(), expectedVersion: 0, copy, direction: 'lent', counterparty: { kind: 'name', name: 'Private fixture borrower' },
  startedAt: new Date(Date.now() - 3 * 86_400_000).toISOString(),
  dueAt: new Date(Date.now() + (overdue ? -1 : 7) * 86_400_000).toISOString(),
});

beforeAll(async () => {
  people = await personaSessions('public');
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
  secondDevice = async (method, path, body, key) => fetch(new URL(path, config.mainBaseUrl), {
    method, headers: { authorization: `Bearer ${await device.current()}`, 'x-session-key': sessionKey,
      'idempotency-key': key ?? randomUUID(), ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    redirect: 'manual', signal: AbortSignal.timeout(30_000), ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  book = await createBook('Original outcome volume');
  series = await createBook('Original outcome series');
  chapters = await compose(book, 'book-composition', root => [1, 2].map(number => ({
    op: 'insert', parent: root, position: 'last', role: 'chapter', target: 'https://schema.org/DigitalDocument',
    label: { value: `Chapter ${number}`, language: 'en' },
  })));
  await compose(series, 'work-composition', root => [{
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
  await json(ownerCall('PUT', progressPath(), { ...own(), expectedVersion: 0, completed: false, position: 'private owner bookmark' }));
  privateCopy = await makeCopy();
  privateLoan = await json<RecordState>(ownerCall('POST', '/v1/me/library-loans', openBody(privateCopy.id)), 201);
}, 120_000);
afterAll(async () => { await people?.close(); });

async function deniedTracking(name: PersonaName) {
  // Operator requests use ordinary member routes; these rows have no platform operation.
  const person = people[name], expected = name === 'visitor' ? 401 : 403;
  const before = await json(ownerCall('GET', readerPath()));
  if (name === 'visitor') {
    const empty = await json<{ status: { status: null }; progress: null }>(person.main('GET', readerPath()));
    expect(empty).toMatchObject({ status: { status: null }, progress: null });
  } else await privateReply(await person.main('GET', readerPath()), expected);
  await privateReply(await person.main('PUT', statusPath(), { ...own(), expectedVersion: 1, status: 'want-to-read' }), expected);
  const response = await person.main('PUT', progressPath(), { ...own(), expectedVersion: 0, completed: true, position: null });
  const raw = await response.text(), after = await json(ownerCall('GET', readerPath()));
  expect({ status: response.status, ...(response.status === expected ? {} : { raw }), ownerLibraryUnchanged: JSON.stringify(before) === JSON.stringify(after) })
    .toEqual({ status: expected, ownerLibraryUnchanged: true });
}
async function deniedDevices(name: PersonaName) {
  const person = people[name], expected = name === 'visitor' ? 401 : 403;
  await privateReply(await person.main('GET', `${progressPath()}?${query()}`), expected);
  await privateReply(await person.main('GET', `/v1/compositions/${short(chapters.structure)}/progress?${query()}`), expected);
}
async function deniedLoans(name: PersonaName) {
  const person = people[name], expected = name === 'visitor' ? 401 : 403;
  await privateReply(await person.main('GET', `/v1/works/${short(book.work)}/copies?${query()}`), expected);
  await privateReply(await person.main('GET', loanPage('active')), expected);
  await privateReply(await person.main('POST', '/v1/me/library-loans', openBody(privateCopy.id)), expected);
  await privateReply(await person.main('POST', `/v1/me/library-loans/${short(privateLoan.id)}/extend`, {
    ...own(), expectedVersion: 1, dueAt: new Date(Date.now() + 10 * 86_400_000).toISOString(),
  }), expected);
  await privateReply(await person.main('POST', `/v1/me/library-loans/${short(privateLoan.id)}/return`, { ...own(), expectedVersion: 1 }), expected);
}
async function deniedExpired(name: PersonaName) {
  const expected = name === 'visitor' ? 401 : 403;
  await privateReply(await people[name].main('GET', loanPage('overdue')), expected);
  await privateReply(await people[name].main('POST', `/v1/me/library-loans/${short(privateLoan.id)}/return`, { ...own(), expectedVersion: 1 }), expected);
  const page = await json<{ items: RecordState[] }>(ownerCall('GET', loanPage('overdue')));
  expect(page.items.find(loan => loan.id === privateLoan.id)).toMatchObject({ state: 'overdue', version: 1, returnedAt: null });
}

outcomeTest(tracking, 'visitor', () => deniedTracking('visitor'));
outcomeTest(tracking, 'stranger', () => deniedTracking('stranger'));
outcomeTest(tracking, 'member', () => deniedTracking('member'));
outcomeTest(tracking, 'moderator', () => deniedTracking('moderator'));
outcomeTest(tracking, 'operator', () => deniedTracking('operator'));
outcomeTest(tracking, 'owner', async () => {
  const key = randomUUID(), body = { ...own(), expectedVersion: 1, status: 'read', finishedOn: new Date().toISOString().slice(0, 10) };
  const saved = await json<{ version: number }>(ownerCall('PUT', statusPath(), body, key));
  expect(saved.version).toBe(2);
  expect(await json(ownerCall('PUT', statusPath(), body, key))).toMatchObject({ ...saved, replayed: true });
  await json(ownerCall('PUT', statusPath(), body), 409);
  const current = await json<Progress>(ownerCall('GET', `${progressPath()}?${query()}`));
  await json(ownerCall('PUT', progressPath(), { ...own(), expectedVersion: current.version, completed: true, position: null }));
  const stats = await ownerCall('GET', `/v1/me/reading-stats?${query()}&year=${new Date().getUTCFullYear()}`);
  expect(stats.headers.get('cache-control')).toBe('private, no-store');
  expect(await json(Promise.resolve(stats))).toMatchObject({ books: 1, chapters: 1 });
  expect(await json(ownerCall('GET', `/v1/me/continue/${short(book.work)}?${query()}`)))
    .toMatchObject({ nextUnread: { occurrence: chapters.occurrences[1] } });
});
outcomeTest(devices, 'visitor', () => deniedDevices('visitor'));
outcomeTest(devices, 'stranger', () => deniedDevices('stranger'));
outcomeTest(devices, 'member', () => deniedDevices('member'));
outcomeTest(devices, 'moderator', () => deniedDevices('moderator'));
outcomeTest(devices, 'operator', () => deniedDevices('operator'));
outcomeTest(devices, 'owner', async () => {
  const path = progressPath(1), stale = await json<Progress>(secondDevice('GET', `${path}?${query()}`));
  await json(ownerCall('PUT', path, { ...own(), expectedVersion: stale.version, completed: true, position: 'device one paragraph' }));
  expect(await json(secondDevice('GET', `${path}?${query()}`))).toMatchObject({ completed: true, position: 'device one paragraph', version: stale.version + 1 });
  expect(await json(secondDevice('GET', `/v1/reading-positions/${short(series.work)}?${query()}&position=mine&limit=1`)))
    .toMatchObject({ resolved: chapters.occurrences[1] });
  await json(secondDevice('PUT', path, { ...own(), expectedVersion: stale.version, completed: false, position: null }), 409);
  const fresh = await json<Progress>(secondDevice('GET', `${path}?${query()}`));
  await json(secondDevice('PUT', path, { ...own(), expectedVersion: fresh.version, completed: false, position: null }));
  expect(await json(ownerCall('GET', `${path}?${query()}`))).toMatchObject({ completed: false, version: fresh.version + 1 });
});
outcomeTest(loans, 'visitor', () => deniedLoans('visitor'));
outcomeTest(loans, 'stranger', () => deniedLoans('stranger'));
outcomeTest(loans, 'member', () => deniedLoans('member'));
outcomeTest(loans, 'moderator', () => deniedLoans('moderator'));
outcomeTest(loans, 'operator', () => deniedLoans('operator'));
outcomeTest(loans, 'owner', async () => {
  const copy = await makeCopy(), key = randomUUID(), body = openBody(copy.id, false);
  const loan = await json<RecordState>(ownerCall('POST', '/v1/me/library-loans', body, key), 201);
  expect(loan).toMatchObject({ state: 'open', copy: copy.id, version: 1 });
  expect(await json(ownerCall('POST', '/v1/me/library-loans', body, key), 201)).toMatchObject({ ...loan, replayed: true });
  const root = `/v1/me/library-loans/${short(loan.id)}`;
  await json(ownerCall('POST', `${root}/extend`, { ...own(), expectedVersion: 1, dueAt: new Date(Date.now() + 14 * 86_400_000).toISOString() }));
  await json(ownerCall('POST', `${root}/return`, { ...own(), expectedVersion: 1 }), 409);
  expect(await json(ownerCall('POST', `${root}/return`, { ...own(), expectedVersion: 2 }))).toMatchObject({ state: 'returned', version: 3 });
  expect(await json(ownerCall('GET', `/v1/works/${short(book.work)}/copies?${query()}`)))
    .toMatchObject({ items: expect.arrayContaining([expect.objectContaining({ id: copy.id, release })]) });
});
outcomeTest(expired, 'visitor', () => deniedExpired('visitor'));
outcomeTest(expired, 'stranger', () => deniedExpired('stranger'));
outcomeTest(expired, 'member', () => deniedExpired('member'));
outcomeTest(expired, 'moderator', () => deniedExpired('moderator'));
outcomeTest(expired, 'operator', () => deniedExpired('operator'));
outcomeTest(expired, 'owner', async () => {
  const copy = await makeCopy(), loan = await json<RecordState>(ownerCall('POST', '/v1/me/library-loans', openBody(copy.id)), 201);
  const before = await json<{ items: RecordState[] }>(ownerCall('GET', loanPage('overdue')));
  expect(before.items.find(item => item.id === loan.id)).toMatchObject({ state: 'overdue', returnedAt: null });
  await json(ownerCall('DELETE', `/v1/me/library-copies/${short(copy.id)}`, { ...own(), expectedVersion: 1 }), 409);
  const path = `/v1/me/library-loans/${short(loan.id)}/return`, key = randomUUID(), body = { ...own(), expectedVersion: 1 };
  const returned = await json<RecordState>(ownerCall('POST', path, body, key));
  expect(returned).toMatchObject({ state: 'returned', version: 2 });
  expect(returned.returnedAt).toBeTruthy();
  expect(await json(ownerCall('POST', path, body, key))).toEqual({ ...returned, replayed: true });
  await json(ownerCall('POST', path, body), 409);
  expect((await json<{ items: RecordState[] }>(ownerCall('GET', loanPage('overdue')))).items.some(item => item.id === loan.id)).toBe(false);
  expect((await json<{ items: RecordState[] }>(ownerCall('GET', loanPage('returned')))).items.find(item => item.id === loan.id)).toMatchObject({ state: 'returned', version: 2 });
  expect(await json(ownerCall('DELETE', `/v1/me/library-copies/${short(copy.id)}`, { ...own(), expectedVersion: 1 }))).toMatchObject({ removed: true });
});

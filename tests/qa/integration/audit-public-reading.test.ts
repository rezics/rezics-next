import { afterAll, beforeAll, expect, setDefaultTimeout, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { personaNames, type PersonaName } from '../support/personas.ts';
import { identityReaderFixture, reached, short, type ChapterFixture,
  type IdentityReaderFixture } from '../support/identity-reader-fixture.ts';

setDefaultTimeout(60_000);
let fixture: IdentityReaderFixture;
type Requester = (method: string, path: string, body?: unknown) => Promise<Response>;
type Client = Awaited<ReturnType<IdentityReaderFixture['login']>>;
const clients = new Map<Exclude<PersonaName, 'visitor'>, Client>();
beforeAll(async () => {
  fixture = await identityReaderFixture();
  for (const name of personaNames) if (name !== 'visitor')
    clients.set(name, await fixture.login(name, `/en/books?reader=${name}&next=%2Fen%2Flibrary`));
}, 600_000);
afterAll(async () => { await fixture?.close(); });

function anonymous(method: string, path: string, body?: unknown, authorization?: string) {
  return fetch(new URL(path, fixture.mainOrigin), { method, redirect: 'manual', signal: AbortSignal.timeout(30_000),
    headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(authorization === undefined ? {} : { authorization }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
}
function reader(name: PersonaName): Requester {
  return name === 'visitor' ? anonymous : clients.get(name)!.request;
}
async function answer<T>(id: string, label: string, request: Promise<Response>, status = 200): Promise<T> {
  const response = await request, raw = await response.text();
  reached(id, `${label}: HTTP ${status}`);
  expect(response.status, `${label}: ${response.status} ${raw}`).toBe(status);
  if (status === 200) expect(response.headers.get('cache-control'), label).toContain('no-store');
  return JSON.parse(raw) as T;
}
type Exact = { reference: { owner: string; resourceId: string; variantId: string;
  revisionId: string; byteDigest: string }; serializedJson: string; body: Record<string, unknown> };
type Contents = { profile: string; work: string; version: string; composition: string; compositionRevision: string;
  items: { occurrence: string; target: string | null; selectedRevision: string | null;
    availability: string; role: string }[]; nextCursor: string | null };
type Chapter = { profile: string; work: string; version: string; occurrence: string; selectedRevision: string;
  previous: string | null; next: string | null; content: Exact };
type Hit = { resource: string; variant: string; revision: string;
  matchedPlacements?: { resource: string; work: string; occurrence: string; profile: string }[] };
type Search = { profile: string; resultGrain: string; complete?: boolean; relationComplete?: boolean;
  total: number; results: Hit[]; next?: Record<string, unknown> | null };
const revision = (chapter: ChapterFixture) => `urn:rezics:content:revision:${chapter.revisionId}`;
function exact(body: Exact, chapter: ChapterFixture) {
  expect(body.reference).toMatchObject({ owner: 'content', resourceId: chapter.post,
    variantId: chapter.variantId, revisionId: chapter.revisionId, byteDigest: chapter.byteDigest });
  expect(body.serializedJson).toContain(chapter.text);
  expect(JSON.parse(body.serializedJson)).toEqual(body.body);
  expect(body.serializedJson).not.toContain('PRIVATE unpublished correction');
}
async function unchangedAccount(name: PersonaName, id: string) {
  if (name === 'visitor') return;
  const person = clients.get(name)!.person;
  const response = await person.account('GET', '/api/auth/get-session');
  reached(id, 'signed-in Account survives reader failure');
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ user: { id: person.accountId } });
}

// These are ordinary assertions against a pending contract. Neither an expected
// failure wrapper nor a process health check can count as a reader outcome.
for (const name of personaNames) {
  test(`D4-008 / ${name}: public Book contents, chapter and default links select the same published bytes`, async () => {
    const id = `D4-008/${name}/links`, call = reader(name), book = fixture.corpus.publicBook;
    const root = `/v1/works/${short(book.work)}`;
    const header = await answer<{ id: string; types: string[] }>(id, 'public Work header', call('GET', root));
    expect(header).toMatchObject({ profile: 'work-read-v1', id: book.work, mainVersion: book.mainVersion,
      title: { value: book.title }, disclosure: 'public', publicationState: 'published' });
    expect(header.types).toContain('https://schema.org/Book');
    // The consuming default reader first requests this exact unparameterized
    // contents URL. No test-only start API, actingSubject or privileged version.
    const defaults = await answer<Contents>(id, 'default contents request', call('GET', `${root}/contents`));
    expect(defaults).toMatchObject({ profile: 'work-contents-v1', work: book.work,
      version: book.mainVersion, composition: book.structure, compositionRevision: book.compositionRevision, nextCursor: null });
    expect(defaults.items.map(item => ({ occurrence: item.occurrence, target: item.target,
      selectedRevision: item.selectedRevision, availability: item.availability, role: item.role })))
      .toEqual(book.chapters.map(chapter => ({ occurrence: chapter.occurrence, target: chapter.post,
        selectedRevision: revision(chapter), availability: 'available', role: 'chapter' })));
    const pagePath = `${root}/contents?version=${encodeURIComponent(book.mainVersion)}&language=en&limit=1`;
    const page = await answer<Contents>(id, 'bounded first contents page', call('GET', pagePath));
    expect(page.items.map(item => item.occurrence)).toEqual([book.chapters[0]!.occurrence]);
    expect(typeof page.nextCursor).toBe('string');
    const last = await answer<Contents>(id, 'opaque contents continuation', call('GET',
      `${pagePath}&cursor=${encodeURIComponent(page.nextCursor!)}`));
    expect(last.items.map(item => item.occurrence)).toEqual([book.chapters[1]!.occurrence]);
    expect(last.nextCursor).toBeNull();
    for (const [index, chapter] of book.chapters.entries()) {
      const linked = await answer<Chapter>(id, `chapter link ${index + 1}`, call('GET',
        `/v1/chapters/${short(chapter.occurrence)}?language=en`));
      expect(linked).toMatchObject({ profile: 'work-chapter-v1', work: book.work,
        version: book.mainVersion, occurrence: chapter.occurrence, selectedRevision: revision(chapter),
        previous: book.chapters[index - 1]?.occurrence ?? null, next: book.chapters[index + 1]?.occurrence ?? null });
      exact(linked.content, chapter);
      exact(await answer<Exact>(id, `exact content link ${index + 1}`, call('GET',
        `/v1/content-revisions/${chapter.revisionId}`)), chapter);
    }
    expect(defaults.items[0]!.occurrence).toBe(book.chapters[0]!.occurrence);
    for (const query of ['', '?language=en']) {
      const selected = await answer<{ body: string }>(id, 'existing main default text link', call('GET',
        `/v1/main-versions/${short(book.mainVersion)}/selection${query}`));
      expect(selected).toMatchObject({ work: book.work, mainVersion: book.mainVersion,
        contribution: book.contribution, language: 'en',
        body: 'An original catalogue introduction about a garden beside a river.' });
    }
    await unchangedAccount(name, id);
  });

  test(`D4-008 / ${name}: audited public phrase search and its continuation lead to readable chapters`, async () => {
    const id = `D4-008/${name}/search`, call = reader(name), { publicBook: book, phrase } = fixture.corpus;
    // Retain the audited POST /queries shape even though a bounded page profile
    // also exists. Replacing the first request would conceal its own failure.
    const query = { profile: 'public-content-phrase-v1', phrase, language: 'en' };
    const full = await answer<Search>(id, 'audited phrase request', call('POST', '/v1/queries', query));
    expect(full).toMatchObject({ profile: query.profile, resultGrain: 'content-variant', complete: true, total: 2 });
    const input = { profile: 'public-content-phrase-page-v1', phrase, language: 'en', pageSize: 1 };
    const first = await answer<Search>(id, 'bounded phrase first page', call('POST', '/v1/queries/page', input));
    expect(first).toMatchObject({ profile: input.profile, resultGrain: 'content-variant', relationComplete: true, total: 2 });
    expect(first.results).toHaveLength(1);
    expect(first.next).toBeObject();
    const second = await answer<Search>(id, 'opaque phrase continuation', call('POST', '/v1/queries/page', {
      ...input, continuation: first.next,
    }));
    expect(second.results).toHaveLength(1);
    expect(second.next).toBeNull();
    const hits = [...first.results, ...second.results];
    expect(hits.map(hit => hit.revision).sort()).toEqual(book.chapters.map(revision).sort());
    expect(full.results.map(hit => hit.revision).sort()).toEqual(hits.map(hit => hit.revision).sort());
    for (const chapter of book.chapters) {
      const hit = hits.find(hit => hit.revision === revision(chapter))!;
      expect(hit).toMatchObject({ resource: chapter.post, variant: chapter.variantId });
      expect(hit.matchedPlacements).toEqual(expect.arrayContaining([expect.objectContaining({
        resource: chapter.post, work: book.work, occurrence: chapter.occurrence, profile: 'book-composition',
      })]));
      const linked = await answer<Chapter>(id, 'follow actual search placement', call('GET',
        `/v1/chapters/${short(hit.matchedPlacements!.find(place => place.work === book.work)!.occurrence)}`));
      exact(linked.content, chapter);
    }
    for (const path of ['/v1/queries', '/v1/queries/page']) {
      const empty = await answer<Search>(id, 'successful empty search', call('POST', path, path.endsWith('/page')
        ? { ...input, phrase: `Absent${phrase}` } : { ...query, phrase: `Absent${phrase}` }));
      expect(empty).toMatchObject({ total: 0, results: [] });
      if (path.endsWith('/page')) expect(empty.next).toBeNull();
    }
    await unchangedAccount(name, id);
  });

  test(`D4-008 / ${name}: empty, private, unpublished and missing reader data remain distinct`, async () => {
    const id = `D4-008/${name}/concealment`, call = reader(name), corpus = fixture.corpus;
    const empty = await answer<Contents>(id, 'public Book with no chapters', call('GET',
      `/v1/works/${short(corpus.emptyBook.work)}/contents`));
    expect(empty).toMatchObject({ profile: 'work-contents-v1', work: corpus.emptyBook.work, items: [], nextCursor: null });
    for (const suffix of ['', '/contents']) {
      const missing = await answer<{ code: string }>(id, 'absent Work', call('GET', `/v1/works/${randomUUID()}${suffix}`), 404);
      expect(missing.code).toBe('work_unavailable');
      for (const book of [corpus.privateBook, corpus.unpublishedBook]) {
        const hidden = await answer(id, 'concealed Work', call('GET', `/v1/works/${short(book.work)}${suffix}`), 404);
        expect(hidden).toEqual(missing);
      }
    }
    const absentChapter = await answer<{ code: string }>(id, 'absent occurrence', call('GET', `/v1/chapters/${randomUUID()}`), 404);
    expect(absentChapter.code).toBe('work_unavailable');
    for (const book of [corpus.privateBook, corpus.unpublishedBook]) {
      expect(await answer(id, 'concealed occurrence', call('GET',
        `/v1/chapters/${short(book.chapters[0]!.occurrence)}`), 404)).toEqual(absentChapter);
    }
    const absentRevision = await answer<{ code: string }>(id, 'absent exact revision', call('GET',
      `/v1/content-revisions/${randomUUID()}`), 404);
    expect(absentRevision.code).toBe('revision_unavailable');
    for (const revisionId of [corpus.privateBook.chapters[0]!.revisionId,
      corpus.unpublishedBook.chapters[0]!.revisionId, corpus.unpublishedRevision]) {
      expect(await answer(id, 'concealed exact revision', call('GET', `/v1/content-revisions/${revisionId}`), 404))
        .toEqual(absentRevision);
    }
    await unchangedAccount(name, id);
  });

  test(`D4-008 / ${name}: owner failure is unavailable and recovery retains the Book and Account`, async () => {
    const id = `D4-008/${name}/recovery`, call = reader(name), book = fixture.corpus.publicBook;
    const headerPath = `/v1/works/${short(book.work)}`;
    const known = await answer<{ id: string; types: string[]; title: unknown }>(id, 'known Book before owner failure', call('GET', headerPath));
    const failures = fixture.fault.failures;
    fixture.fault.fail(true);
    try {
      for (const path of [headerPath, `${headerPath}/contents`, `/v1/chapters/${short(book.chapters[0]!.occurrence)}`]) {
        const unavailable = await answer<{ code: string }>(id, 'failed owner read', call('GET', path), 503);
        expect(unavailable.code).toBe('work_read_unavailable');
      }
      expect(fixture.fault.failures).toBeGreaterThan(failures);
      await unchangedAccount(name, id);
    } finally { fixture.fault.fail(false); }
    const recovered = await answer<typeof known>(id, 'one explicit retry after owner recovery', call('GET', headerPath));
    expect({ id: recovered.id, types: recovered.types, title: recovered.title })
      .toEqual({ id: known.id, types: known.types, title: known.title });
    const contents = await answer<Contents>(id, 'recovered public contents', call('GET', `${headerPath}/contents`));
    expect(contents.items.map(item => item.selectedRevision)).toEqual(book.chapters.map(revision));
    await unchangedAccount(name, id);
  });
}

test('D4-008 / authenticated empty Account: public reading requires no anonymous authority change', async () => {
  const id = 'D4-008/authenticated-empty', client = await fixture.login('empty', '/en/library?view=reading');
  expect(await answer(id, 'real signed-in empty Agent inventory', client.request('GET', '/v1/me/agents')))
    .toEqual({ profile: 'agent-discovery-v1', complete: true, items: [] });
  const book = fixture.corpus.publicBook;
  const linked = await answer<Chapter>(id, 'signed-in reader without an Agent', client.request('GET',
    `/v1/chapters/${short(book.chapters[0]!.occurrence)}`));
  exact(linked.content, book.chapters[0]!);
  expect(await answer(id, 'reading did not choose an Agent', client.request('GET', '/v1/me/session-agent')))
    .toMatchObject({ sessionAgent: { actingSubject: null, revision: null, eligible: false }, initialActingSubject: null });
  expect(await fixtureCommandAccount(client)).toMatchObject({ user: { id: client.person.accountId } });
});

async function fixtureCommandAccount(client: Client) {
  const response = await client.person.account('GET', '/api/auth/get-session');
  reached('D4-008/authenticated-empty', 'Account remains signed in after public reading');
  expect(response.status).toBe(200);
  return response.json();
}

// Optional public authentication has an explicit policy in this pending matrix:
// validate a supplied bearer. Never discard it and retry as the visitor.
for (const surface of ['header', 'contents', 'chapter', 'exact', 'default', 'search', 'search-page'] as const) {
  test(`D4-008 / invalid bearer: ${surface} returns authentication refusal without anonymous retry`, async () => {
    const id = `D4-008/invalid-bearer/${surface}`, { publicBook: book, phrase } = fixture.corpus;
    const root = `/v1/works/${short(book.work)}`;
    const paths = { header: root, contents: `${root}/contents`,
      chapter: `/v1/chapters/${short(book.chapters[0]!.occurrence)}`,
      exact: `/v1/content-revisions/${book.chapters[0]!.revisionId}`,
      default: `/v1/main-versions/${short(book.mainVersion)}/selection`,
      search: '/v1/queries', 'search-page': '/v1/queries/page' };
    const body = surface === 'search' ? { profile: 'public-content-phrase-v1', phrase, language: 'en' }
      : surface === 'search-page' ? { profile: 'public-content-phrase-page-v1', phrase, language: 'en', pageSize: 1 } : undefined;
    const denied = await answer<{ code: string }>(id, `invalid bearer on ${surface}`,
      anonymous(body ? 'POST' : 'GET', paths[surface], body, 'Bearer invalid'), 401);
    expect(denied.code).toBe('account_assertion_denied');
  });
}

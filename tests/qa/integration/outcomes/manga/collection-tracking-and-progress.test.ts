import { localizedPath } from '../../../../../apps/web/i18n/locale.ts';
import { workHref } from '../../../../../apps/web/features/work-page/route.ts';
import { afterAll, beforeAll, expect, setDefaultTimeout } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import outcome from '../../../../../scripts/qa/cases/outcomes/manga/collection-tracking-and-progress.ts';
import { classificationContextBody, classifiedStatementBody } from '../../../../../scripts/dev/seed/classified-statement.ts';
import { grantMangaFixtureAuthority } from '../../../../../scripts/qa/cases/outcomes/manga/work-hub-and-edition-choice.ts';
import { OutcomeRecorder, outcomeTest } from '../../../support/outcome-test.ts';
import { browserMainApi, BFF_PREFIX } from '../../../../../apps/web/features/api/browser.ts';
import { booksEditionReads } from '../../../../../apps/web/features/work-page/books-edition-page.read.ts';
import { loadBooksLibrary } from '../../../../../apps/web/features/library/books-library-recorded-page.ts';
import { parseLibraryState } from '../../../../../apps/web/features/library/state.ts';
import { mainMediaApi } from '../../../../../apps/web/features/tracking/media-api.ts';
import { createReaderStore } from '../../../../../apps/web/features/catalogue/reader-store.ts';
import { readResourcePage } from '../../../../../apps/web/features/work-page/anime-hub-recorded-page.ts';
import { mangaWorkVisit } from '../../../../../apps/web/features/tracking/manga-collection-recorded-page.work.tsx';
import { finishMangaSlots } from '../../../../../apps/web/features/tracking/manga-collection-recorded-page.test-support.ts';
import { mainTrackingApi } from '../../../../../apps/web/features/tracking/api.ts';
import { mainRelationships } from '../../../../../apps/web/features/relationships/api.ts';
import { personaSessions, type PersonaName, type PersonaSession, type PersonaSessions } from '../../../support/personas.ts';

type Work = { work: string; mainVersion: string };
type Composition = { structure: string; revision: string; occurrences: string[] };
type Progress = { completed: boolean; version: number; occurrence: string; position: string | null };
type State = { status: { status: string | null; version: number; changedAt: string | null }; progress: unknown };
type Positions = { resolved: string | null; scope: string; items: { occurrence: string; role: string }[]; nextCursor: string | null };
setDefaultTimeout(90_000);
let sessions: PersonaSessions, access: Pool, content: Pool;
let manga: Work, omnibus: Work, volume1: Work, volume2: Work, first: Composition, second: Composition;
const recording = new OutcomeRecorder(outcome);
let activePersona: PersonaName | null = null;
let phase = 'proof';
let requestNumber = 0;
const proof = (name: PersonaName, run: () => Promise<void>) => async () => {
  activePersona = name;
  phase = 'proof';
  requestNumber = 0;
  try { await run(); } finally { activePersona = null; }
};
const short = (id: string) => id.slice(-36);
const acting = (actor: string) => `actingSubject=${encodeURIComponent(actor)}`;
async function answer<T>(request: Promise<Response>, status = 200): Promise<T> {
  const response = await request, raw = await response.text();
  expect(response.status, `${response.status}: ${raw}`).toBe(status);
  return JSON.parse(raw) as T;
}
const grant = (person: PersonaSession, scope: string, action: string) => grantMangaFixtureAuthority(access, person, scope, action);
async function create(title: string, type: string): Promise<Work> {
  const owner = sessions.owner, actor = owner.actingSubject;
  const work = await answer<Work>(owner.main('POST', '/v1/works', {
    profile: 'metadata-only-v1', title: `${title} ${randomUUID()}`, language: 'en',
    semanticTypes: [`https://schema.org/${type}`], authoring: 'own-work', actingSubject: actor,
  }), 201);
  const draft = await answer<{ contribution: string; draftRevision: string; author: string }>(owner.main('POST', '/v1/contributions', {
    profile: 'text-contribution-v1', work: work.work, language: 'en',
    body: 'An original fictional manga: a gardener follows an ink river through two volumes of gardens.', actingSubject: actor,
  }), 201);
  expect(draft.author).toBe(actor);
  const publication = await answer<{ publicationDecision: string }>(owner.main('POST', '/v1/contribution-publications', {
    profile: 'text-publication-v1', contribution: draft.contribution, expectedDraftHead: draft.draftRevision,
    expectedPublicationHead: null, rightsBasis: 'original-contribution', disclosure: 'public', actingSubject: actor,
  }), 201);
  await answer(owner.main('POST', '/v1/publication-selections', {
    profile: 'main-default-selection-v1', work: work.work, contribution: draft.contribution,
    publicationDecision: publication.publicationDecision, expectedSelectionHead: null,
    context: { kind: 'main-version-default', id: work.mainVersion }, selectionBasis: 'main-maintainer', actingSubject: actor,
  }), 201);
  return work;
}
async function compose(profile: string, work: Work, operations: (structure: string) => object[]): Promise<Composition> {
  const owner = sessions.owner, actor = owner.actingSubject;
  const base = await answer<Composition>(owner.main('POST', '/v1/compositions', {
    profile, work: work.work, mainVersion: work.mainVersion, actingSubject: actor,
  }), 201);
  const changed = await answer<{ revision: string; occurrences: string[] }>(owner.main('POST', `/v1/compositions/${short(base.structure)}/changes`, {
    profile, expectedHead: base.revision, actingSubject: actor, operations: operations(base.structure),
  }));
  return { ...base, ...changed };
}
beforeAll(async () => {
  await recording.prepare();
  sessions = await personaSessions('public');
  for (const name of ['visitor', 'stranger', 'member', 'owner', 'moderator', 'operator'] as const) {
    const person = sessions[name], send = person.main.bind(person);
    person.main = (...args) => activePersona
      ? recording.session(activePersona, { main: send })(`${phase}-${++requestNumber}`, ...args)
      : send(...args);
  }
  access = new Pool({ connectionString: Bun.env.ACCESS_DATABASE_URL });
  content = new Pool({ connectionString: Bun.env.CONTENT_DATABASE_URL });
  volume1 = await create('Ink Garden volume 1', 'Book');
  volume2 = await create('Ink Garden volume 2', 'Book');
  manga = await create('Ink Garden Manga series', 'BookSeries');
  omnibus = await create('Ink Garden omnibus', 'BookSeries');
  const owner = sessions.owner, actor = owner.actingSubject!;
  for (const [scope, action] of [
    ['classification:define:global', 'classification.proposition.define'],
    ['classification:decide:global', 'statement.decide'], ['context:create:root', 'context.create'],
  ]) await grant(owner, scope!, action!);
  const term = await answer<{ concept: string; definitionRevision: string }>(owner.main('POST', '/v1/classification-vocabulary', {
    profile: 'classification-proposition-v2', scheme: null, labels: [{ language: 'en', value: 'Manga' }],
    alternativeLabels: [], broader: [], narrower: [], actingSubject: actor,
  }), 201);
  const context = await answer<{ context: string; semanticRevision: string }>(owner.main('POST', '/v1/contexts', classificationContextBody(actor, [term])), 201);
  const classified = await answer<{ meaningKey: string; statement: string }>(owner.main('POST', '/v1/statements', classifiedStatementBody(actor, manga.mainVersion, term.concept, context)), 201);
  await answer(owner.main('POST', '/v1/statement-decisions', {
    profile: 'statement-decision-v1', target: { kind: 'qualified-fact', meaningKey: classified.meaningKey, support: [classified.statement] },
    acceptance: { kind: 'global' }, expectedDecisionHead: null, outcome: 'accepted', actingSubject: actor,
  }), 201);
  const chapters = (number: number) => (structure: string) => [1, 2].map(chapter => ({
    op: 'insert', role: 'chapter', parent: structure, position: 'last', target: 'https://schema.org/DigitalDocument',
    label: { value: `Volume ${number}, chapter ${chapter}`, language: 'en' },
  }));
  first = await compose('book-composition', volume1, chapters(1));
  second = await compose('book-composition', volume2, chapters(2));
  const part = (parent: string, target: string, label: string) => ({
    op: 'insert', role: 'part', parent, position: 'last', target, displayLabel: label, inclusion: 'required',
  });
  await compose('work-composition', manga, structure => [part(structure, volume1.work, '1'), part(structure, volume2.work, '2')]);
  await compose('work-composition', omnibus, structure => [part(structure, volume2.work, 'Omnibus')]);
  // Every affected reader has a real library row before a foreign-subject attempt.
  for (const name of ['owner', 'member'] as const) {
    const person = sessions[name];
    for (const work of [volume1, volume2, manga]) await answer(person.main('PUT', `/v1/works/${short(work.work)}/reader-status`, {
      actingSubject: person.actingSubject, status: 'reading', expectedVersion: 0,
    }));
  }
}, 240_000);
afterAll(async () => { await recording.publish(); await sessions?.close(); await access?.end(); await content?.end(); });

/** Reach the production readers with the same HTTP boundary as the session client. */
async function productionVisit(person: PersonaSession) {
  const request = (session: PersonaSession) => (async (input, init) => {
    const request = new Request(input, init), url = new URL(request.url);
    const raw = await request.text();
    return session.main(request.method, url.pathname.slice(BFF_PREFIX.length) + url.search,
      raw ? JSON.parse(raw) : undefined, request.headers.get('idempotency-key') ?? undefined);
  }) as typeof fetch;
  const client = (session: PersonaSession) => browserMainApi('https://recorded.invalid', { fetcher: request(session) });
  const main = client(person), actingSubject = person.actingSubject ?? undefined;
  const reads = booksEditionReads({ main, actingSubject });
  phase = 'work-header'; requestNumber = 0;
  expect((await reads.readWorkHeader(short(manga.work))).ok).toBe(true);
  phase = 'work-agent-credits'; requestNumber = 0;
  expect((await reads.readAgentCredits(short(manga.work))).ok).toBe(true);
  phase = 'work-credits'; requestNumber = 0;
  expect((await reads.readCredits(short(manga.work))).ok).toBe(true);
  phase = 'work-projection'; requestNumber = 0;
  expect((await readResourcePage(main, actingSubject, short(manga.work))).ok).toBe(true);
  const host = { main, anonymous: client(sessions.visitor), actingSubject, signedIn: Boolean(actingSubject),
    avatarQuery: actingSubject ? `?actingSubject=${encodeURIComponent(actingSubject)}` : '',
    publicFetch: request(sessions.visitor), pageUrl: new URL(localizedPath(workHref(short(manga.work)), 'en'), 'https://rezics.com').href };
  phase = 'work-overview'; requestNumber = 0;
  const overview = await mangaWorkVisit(host, short(manga.work), 'overview');
  expect(overview.ok).toBe(true);
  if (!overview.ok) throw new Error(overview.failure);
  await finishMangaSlots(overview.page);
  if (actingSubject) {
    // The existing mounted edition and series controls use these same production adapters.
    const tracking = mainTrackingApi(actingSubject, () => main);
    await tracking.preference(manga.work);
    await tracking.editions(manga.work);
    await tracking.relations(manga.work);
    await tracking.definition('correspondence-equivalent');
    await tracking.series(manga.work, 'en');
    await mainMediaApi(actingSubject, () => main).types(manga.work);
    await mainMediaApi(actingSubject, () => main).standing(manga.work);
    await mainMediaApi(actingSubject, () => main).positions(manga.work);
    await mainRelationships(actingSubject, { origin: 'https://recorded.invalid/api/main', fetch: request(person) })
      .state(manga.work, 'work');
  } else {
    for (const [name, work] of [['inventory-series', manga], ['inventory-volume1', volume1], ['inventory-volume2', volume2]] as const) {
      phase = name; requestNumber = 0;
      const inventoryPage = await mangaWorkVisit(host, short(work.work), 'contents');
      expect(inventoryPage.ok).toBe(true);
      if (!inventoryPage.ok) throw new Error(inventoryPage.failure);
      await finishMangaSlots(inventoryPage.page);
    }
  }
  phase = 'chapter-standing'; requestNumber = 0;
  const media = mainMediaApi(actingSubject!, () => main);
  expect((await media.standing(manga.work)).ok).toBe(true);
  phase = 'chapter-inventory'; requestNumber = 0;
  const inventory = await media.positions(manga.work);
  expect(inventory.ok).toBe(true);
  if (!inventory.ok) throw new Error(inventory.failure);
  if (actingSubject) {
    phase = 'library'; requestNumber = 0;
    const loaded = await loadBooksLibrary({ main, anonymous: client(sessions.visitor), actingSubject }, {
      state: parseLibraryState({ shelf: 'reading', view: 'grid' }), locale: 'en', year: new Date().getUTCFullYear(), first: false,
    });
    expect(loaded.overview.ok).toBe(true);
    expect(loaded.view.ok).toBe(true);
    // The Library's disclosure opens this same chapter control. Keep both volumes' identity
    // and the control's own compare-and-set reads instead of reshaping the proof commands.
    const chapter = inventory.data.items.find(item => item.occurrence === second.occurrences[0])!;
    expect(chapter).toBeDefined();
    phase = 'chapter-selected'; requestNumber = 0;
    const selected = await media.progress(chapter);
    expect(selected.ok).toBe(true);
    if (!selected.ok) throw new Error(selected.failure);
    phase = 'chapter-mark'; requestNumber = 0;
    const marked = await media.mark(chapter, { completed: true, position: selected.data.position, expectedVersion: selected.data.version });
    expect(marked.ok).toBe(true);
    if (!marked.ok) throw new Error(marked.failure);
    phase = 'chapter-after-mark'; requestNumber = 0;
    expect((await media.standing(manga.work)).ok).toBe(true);
    phase = 'chapter-clear'; requestNumber = 0;
    expect((await media.mark(chapter, { completed: false, position: null, expectedVersion: marked.data.version })).ok).toBe(true);
    phase = 'chapter-after-clear'; requestNumber = 0;
    expect((await media.standing(manga.work)).ok).toBe(true);
    phase = 'status-change'; requestNumber = 0;
    const actions = createReaderStore({ main: () => main, actingSubject, seed: loaded.view.ok ? loaded.view.data.seed : {} });
    expect(await actions.setStatus(manga.work, 'read')).toBe(true);
    expect(actions.stateOf(manga.work).status).toBe('read');
    phase = 'status-return'; requestNumber = 0;
    expect(await actions.setStatus(manga.work, 'reading')).toBe(true);
    expect(actions.stateOf(manga.work).status).toBe('reading');
  }
  phase = 'proof'; requestNumber = 100;
}
const path = (composition: Composition, occurrence: string) =>
  `/v1/compositions/${short(composition.structure)}/occurrences/${short(occurrence)}/progress`;
const read = (person: PersonaSession, composition: Composition, occurrence: string, actor = person.actingSubject!) =>
  answer<Progress>(person.main('GET', `${path(composition, occurrence)}?${acting(actor)}`));
const write = (person: PersonaSession, composition: Composition, occurrence: string, completed: boolean, expectedVersion: number,
  actor = person.actingSubject!, key = randomUUID()) =>
  person.main('PUT', path(composition, occurrence), { actingSubject: actor, completed, expectedVersion, position: null }, key);
const state = (person: PersonaSession, work: Work, actor = person.actingSubject!) =>
  answer<State>(person.main('GET', `/v1/works/${short(work.work)}/reader-state?${acting(actor)}`));
const positions = (person: PersonaSession, work: Work, position = 'mine', actor = person.actingSubject) =>
  answer<Positions>(person.main('GET', `/v1/reading-positions/${short(work.work)}?${new URLSearchParams({
    position, limit: '20', ...(actor ? { actingSubject: actor } : {}),
  })}`));

// Private last_read_at is not exported by the shelf API. Read-only storage observation
// verifies that an HTTP attempt cannot silently touch the affected reader's timestamp.
async function timestamps(actor: string) {
  return (await content.query('SELECT work, changed_at::text, last_read_at::text FROM reader.library_status WHERE agent = $1 ORDER BY work', [actor])).rows;
}
async function foreign(name: Exclude<PersonaName, 'visitor'>) {
  const person = sessions[name], target = name === 'owner' ? sessions.member : sessions.owner, actor = target.actingSubject!;
  const before = await state(target, volume2), stamp = await timestamps(actor);
  const progress = await read(target, second, second.occurrences[1]!);
  for (const endpoint of [
    `/v1/works/${short(volume2.work)}/reader-state`, '/v1/me/shelves', '/v1/me/shelves/status/reading/works',
  ]) expect(await answer(person.main('GET', `${endpoint}?${acting(actor)}`), 403)).toMatchObject({ code: 'reader_library_denied' });
  expect(await answer(person.main('PUT', `/v1/works/${short(volume2.work)}/reader-status`, {
    actingSubject: actor, status: 'read', expectedVersion: before.status.version,
  }), 403)).toMatchObject({ code: 'reader_library_denied' });
  const foreignPath = `${path(second, second.occurrences[1]!)}?${acting(actor)}`;
  const foreignResponse = await person.main('GET', foreignPath), foreignAnswer = await foreignResponse.json();
  const readEvidence = { persona: name, method: 'GET', path: foreignPath,
    callerAccount: person.accountId, callerPerson: person.actingSubject,
    targetAccount: target.accountId, targetPerson: actor, status: foreignResponse.status, answer: foreignAnswer };
  console.info('foreign_progress_read_outcome', JSON.stringify(readEvidence));
  expect(foreignResponse.status, JSON.stringify(readEvidence)).toBe(403);
  expect(foreignAnswer).toMatchObject({ code: 'authority_denied' });
  const ownForeignView = await read(person, second, second.occurrences[1]!);
  expect(ownForeignView).toMatchObject({ completed: false, version: 0 });
  const fallback = await positions(person, manga, 'mine', actor);
  expect(fallback.scope).not.toBe('resume');
  // The API may keep this principal's own progress. It may never project it
  // into an uncontrolled reader's library, regardless of the response policy.
  const response = await write(person, second, second.occurrences[1]!, true, ownForeignView.version, actor);
  expect([200, 403]).toContain(response.status);
  const result = await response.json();
  expect(await read(target, second, second.occurrences[1]!)).toEqual(progress);
  expect(await state(target, volume2)).toEqual(before);
  const after = await timestamps(actor);
  const evidence = { persona: name, method: 'PUT', path: path(second, second.occurrences[1]!), actingSubject: actor,
    status: response.status, answer: result, before: stamp, after };
  console.info('foreign_progress_outcome', JSON.stringify(evidence));
  expect(after, JSON.stringify(evidence)).toEqual(stamp);
}
async function track(name: Exclude<PersonaName, 'visitor'>) {
  const person = sessions[name], actor = person.actingSubject!;
  const initial = await state(person, manga);
  const key = randomUUID(), statusCommand = { actingSubject: actor, status: 'reading', expectedVersion: initial.status.version };
  const saved = await answer<{ status: string; version: number }>(person.main('PUT', `/v1/works/${short(manga.work)}/reader-status`, statusCommand, key));
  expect(saved.status).toBe('reading');
  expect(await answer(person.main('PUT', `/v1/works/${short(manga.work)}/reader-status`, statusCommand, key))).toMatchObject({ ...saved, replayed: true });
  const shelves = await answer<{ statusShelves: { status: string; count: number }[] }>(person.main('GET', `/v1/me/shelves?${acting(actor)}`));
  expect(shelves.statusShelves.find(shelf => shelf.status === 'reading')!.count).toBeGreaterThan(0);
  const shelf = await answer<{ items: { work: string }[] }>(person.main('GET', `/v1/me/shelves/status/reading/works?${acting(actor)}`));
  expect(shelf.items.map(item => item.work)).toContain(manga.work);
  const opening = await positions(person, manga, 'start');
  expect(opening.items.filter(item => item.role === 'chapter').map(item => item.occurrence)).toEqual([...first.occurrences, ...second.occurrences]);
  expect(opening.nextCursor).toBeNull();
  const last = first.occurrences[1]!, next = second.occurrences[0]!;
  expect(await read(person, first, last)).toMatchObject({ completed: false, version: 0 });
  expect(await answer(write(person, first, last, true, 0))).toMatchObject({ completed: true, version: 1 });
  expect(await positions(person, manga)).toMatchObject({ resolved: last, scope: 'resume' });
  expect(await answer(write(person, second, next, true, 0))).toMatchObject({ completed: true, version: 1 });
  expect(await positions(person, omnibus)).toMatchObject({ resolved: next, scope: 'resume' });
  expect(await answer(write(person, second, next, false, 0), 409)).toMatchObject({ code: 'stale_progress' });
  const current = await read(person, second, next);
  expect(await answer(write(person, second, next, false, current.version))).toMatchObject({ completed: false, version: 2 });
  expect(await positions(person, manga)).toMatchObject({ resolved: last, scope: 'resume' });
  expect((await state(person, manga)).status).toMatchObject({ status: 'reading', version: saved.version });
  if (name === 'operator') {
    await grant(person, `work:read:${volume2.work}`, 'work.read');
    await grant(person, `work:edit:${manga.work}`, 'work.edit');
  }
  await foreign(name);
  await productionVisit(person);
}
outcomeTest(outcome, 'visitor', proof('visitor', async () => {
  const person = sessions.visitor, actor = sessions.owner.actingSubject!;
  expect(await state(person, manga, actor)).toMatchObject({ status: { status: null, version: 0, changedAt: null }, progress: null });
  const opening = await positions(person, manga), mine = await positions(person, manga, 'mine');
  expect(mine.items).toEqual(opening.items);
  expect(mine.scope).not.toBe('resume');
  await answer(person.main('GET', `${path(first, first.occurrences[1]!)}?${acting(actor)}`), 401);
  await answer(write(person, first, first.occurrences[1]!, true, 0, actor), 401);
  await answer(person.main('PUT', `/v1/works/${short(manga.work)}/reader-status`, { actingSubject: actor, status: 'reading', expectedVersion: 0 }), 401);
  await answer(person.main('GET', `/v1/me/shelves?${acting(actor)}`), 401);
  await productionVisit(person);
}), recording);
outcomeTest(outcome, 'stranger', proof('stranger', () => track('stranger')), recording);
outcomeTest(outcome, 'member', proof('member', () => track('member')), recording);
outcomeTest(outcome, 'owner', proof('owner', () => track('owner')), recording);
outcomeTest(outcome, 'moderator', proof('moderator', () => track('moderator')), recording);
outcomeTest(outcome, 'operator', proof('operator', () => track('operator')), recording);

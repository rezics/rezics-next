import { afterAll, beforeAll, expect, setDefaultTimeout } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { signIn } from '../../../../../scripts/lib/oauth-client.ts';
import outcome from '../../../../../scripts/qa/cases/outcomes/manga/continue-progress-across-devices-two-device-progress.ts';
import { classificationContextBody, classifiedStatementBody } from '../../../../../scripts/dev/seed/classified-statement.ts';
import { grantMangaFixtureAuthority } from '../../../../../scripts/qa/cases/outcomes/manga/work-hub-and-edition-choice.ts';
import { OutcomeRecorder, outcomeResponse, outcomeTest } from '../../../support/outcome-test.ts';
import { personaSessions, type PersonaName, type PersonaSession, type PersonaSessions } from '../../../support/personas.ts';
import { browserMainApi, BFF_PREFIX } from '../../../../../apps/web/features/api/browser.ts';
import { booksEditionReads } from '../../../../../apps/web/features/work-page/books-edition-page.read.ts';
import { mainMediaApi } from '../../../../../apps/web/features/tracking/media-api.ts';
import { mainTrackingApi } from '../../../../../apps/web/features/tracking/api.ts';
import { displayLanguageHeaders } from '../../../../../apps/web/i18n/display-languages.ts';
import { readContentsInventory } from '../../../../../apps/web/features/work-page/books-contents-recorded-page.tsx';
import { readAnimeReaderState } from '../../../../../apps/web/features/work-page/anime-hub-recorded-page.ts';
import { mainRelationships } from '../../../../../apps/web/features/relationships/api.ts';

const recording = new OutcomeRecorder(outcome);
let currentPersona: PersonaName | null = null;
const proofCounts = new Map<PersonaName, number>();
const sample = (name: PersonaName, person: PersonaSession, label: string, ...args: Parameters<PersonaSession['main']>) =>
  recording.session(name, person)(label, ...args);

/** Run the real browser adapters over a real authenticated device, recording their wire requests. */
function recordedTransport(name: PersonaName, person: PersonaSession, prefix: string, loseWrite = false): typeof fetch {
  let count = 0;
  return Object.assign(async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init), url = new URL(request.url);
    const body = request.method === 'GET' ? undefined : await request.json();
    const response = await sample(name, person, `${prefix}-${++count}`, request.method,
      url.pathname.slice(BFF_PREFIX.length) + url.search, body,
      request.headers.get('idempotency-key') ?? undefined, { headers: displayLanguageHeaders({
        signedIn: name !== 'visitor', pageUrl: `https://rezics.com/en/w/${short(manga.work)}`,
      }) });
    // Drop one received command answer. The production adapter retries with its original key.
    if (loseWrite && request.method === 'PUT' && response.ok) { loseWrite = false; throw new TypeError('Connection lost after save'); }
    return response;
  }, { preconnect: fetch.preconnect });
}
function recordedClient(name: PersonaName, person: PersonaSession, prefix: string, loseWrite = false) {
  return browserMainApi('https://recorded.invalid', { anonymous: name === 'visitor',
    fetcher: recordedTransport(name, person, prefix, loseWrite) });
}

async function recordedFrame(name: PersonaName, person: PersonaSession) {
  const reads = booksEditionReads({ main: recordedClient(name, person, 'frame'), actingSubject: person.actingSubject ?? undefined });
  const id = short(manga.work);
  for (const read of [() => reads.readWorkHeader(id), () => reads.readAgentCredits(id), () => reads.readCredits(id),
    () => reads.readClassifications(id, { kind: 'global' }), () => reads.readFacets(),
    () => reads.readAlsoEnjoyed(id), () => reads.readAdoptions(id)]) expect((await read()).ok).toBe(true);
  if (person.actingSubject) {
    const main = recordedClient(name, person, 'tracking');
    const tracking = mainTrackingApi(person.actingSubject, () => main);
    expect((await tracking.preference(manga.work)).ok).toBe(true);
    expect((await tracking.series(manga.work, 'en')).ok).toBe(true);
    expect(await readAnimeReaderState(recordedClient(name, person, 'reader-state'), person.actingSubject, id)).not.toBeNull();
    await mainRelationships(person.actingSubject, { origin: 'https://recorded.invalid/api/main',
      fetch: recordedTransport(name, person, 'relationships') }).state(manga.work, 'work');
  } else {
    const opening = await readContentsInventory({ main: recordedClient(name, person, 'public-contents') }, {
      workId: id, workRef: id, workIri: manga.work, locale: 'en', limit: 20,
    });
    expect(opening.kind).toBe('page');
  }
}

async function recordedControls(name: Exclude<PersonaName, 'visitor'>, person: PersonaSession, device: PersonaSession) {
  const actor = person.actingSubject!;
  const firstMain = recordedClient(name, person, 'mark', true);
  const firstChain = mainMediaApi(actor, () => firstMain);
  expect((await firstChain.types(manga.work)).ok).toBe(true);
  const opening = await firstChain.standing(manga.work);
  expect(opening.ok).toBe(true);
  const choices = await firstChain.positions(manga.work);
  if (!choices.ok) throw new Error('Production chapter inventory did not answer');
  const chapter = choices.data.items.find(item => item.occurrence === second.occurrences[0]);
  if (!chapter) throw new Error('Production chapter inventory omitted volume two');
  const before = await firstChain.progress(chapter);
  if (!before.ok) throw new Error('Production private chapter read did not answer');
  expect(before.data.completed).toBe(false);
  expect(await firstChain.mark(chapter, { completed: true, position: null, expectedVersion: before.data.version }))
    .toMatchObject({ ok: true, data: { completed: true, replayed: true } });
  expect((await firstChain.standing(manga.work)).ok).toBe(true);
  // Both controls reopen on the same saved version before the first device undoes it.
  const undoMain = recordedClient(name, person, 'first-undo'), secondMain = recordedClient(name, device, 'second-undo');
  const firstApi = mainMediaApi(actor, () => undoMain), secondApi = mainMediaApi(actor, () => secondMain);
  for (const [api, work] of [[firstApi, manga], [secondApi, omnibus]] as const) {
    expect((await api.types(work.work)).ok).toBe(true);
    expect((await api.standing(work.work)).ok).toBe(true);
    expect((await api.positions(work.work)).ok).toBe(true);
  }
  const own = await firstApi.progress(chapter), cached = await secondApi.progress(chapter);
  if (!own.ok || !cached.ok) throw new Error('Production saved chapter read did not answer');
  expect(own.data).toEqual(cached.data);
  expect(own.data.completed).toBe(true);
  expect((await firstApi.mark(chapter, { completed: false, position: null, expectedVersion: own.data.version })).ok).toBe(true);
  expect((await firstApi.standing(manga.work)).ok).toBe(true);
  const stale = await secondApi.mark(chapter, { completed: false, position: null, expectedVersion: cached.data.version });
  expect(stale).toMatchObject({ ok: false, failure: 'stale' });
  if (stale.ok || stale.failure !== 'stale') throw new Error('Production undo did not reach stale conflict');
  expect((await secondApi.standing(omnibus.work)).ok).toBe(true);
  expect((await secondApi.mark(chapter, { ...stale.submitted, expectedVersion: stale.current.version })).ok).toBe(true);
  expect((await secondApi.standing(omnibus.work)).ok).toBe(true);
  // Both are fresh HTTP reads after undo; neither view is local progress state.
  for (const [label, reader, work] of [['first-after-undo', person, manga], ['second-after-undo', device, omnibus]] as const) {
    const main = recordedClient(name, reader, label), api = mainMediaApi(actor, () => main);
    expect((await api.types(work.work)).ok).toBe(true);
    expect((await api.standing(work.work)).ok).toBe(true);
    expect((await api.positions(work.work)).ok).toBe(true);
    expect(await api.progress(chapter)).toMatchObject({ ok: true, data: { completed: false, version: before.data.version + 3 } });
  }
}

type Work = { work: string; mainVersion: string };
type Composition = { structure: string; revision: string; occurrences: string[] };
type Progress = { completed: boolean; version: number; occurrence: string; position: string | null };
type State = { status: { status: string | null; version: number; changedAt: string | null }; progress: unknown };
type Positions = { resolved: string | null; scope: string; items: { occurrence: string; role: string }[]; nextCursor: string | null };
setDefaultTimeout(90_000);
let sessions: PersonaSessions, access: Pool, content: Pool;
let manga: Work, omnibus: Work, volume1: Work, volume2: Work, first: Composition, second: Composition;
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
  for (const person of Object.values(sessions).filter((person): person is PersonaSession => typeof person === 'object' && 'main' in person)) {
    const main = person.main;
    person.main = (...args) => {
      if (!currentPersona) return main(...args);
      const count = (proofCounts.get(currentPersona) ?? 0) + 1;
      proofCounts.set(currentPersona, count);
      return recording.session(currentPersona, { main })(`proof-${count}`, ...args);
    };
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
afterAll(async () => { try { await recording.publish(); } finally { await sessions?.close(); await access?.end(); await content?.end(); } });
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

// A second authorization code is issued over the existing real Account session.
// The transport delegates authenticated Account calls to its cookie-bearing HTTP client.
async function otherDevice(person: PersonaSession): Promise<PersonaSession> {
  const root = join('.temp/stack', `rezics-qa-${Bun.env.REZICS_QA_RUN_ID}`);
  const directories = readdirSync(root).filter(name => name.startsWith('g-1005-auth-'));
  expect(directories).toHaveLength(1);
  const config = JSON.parse(readFileSync(join(root, directories[0]!, 'public.json'), 'utf8')) as {
    clientId: string; redirectUris: string[]; scope: string;
  };
  const oauth = await signIn({
    account: Bun.env.ACCOUNT_BASE_URL!, clientId: config.clientId, redirectUri: config.redirectUris[0]!,
    scope: config.scope, resource: Bun.env.ACCOUNT_MAIN_RESOURCE,
    fetch: async (input, init) => {
      const url = new URL(input);
      if (url.pathname === '/api/auth/oauth2/authorize') return person.account('GET', url.pathname + url.search);
      if (url.pathname === '/api/account/consent') return person.account('POST', url.pathname, JSON.parse(String(init?.body)));
      return fetch(input, init);
    },
  }, '');
  const sessionKey = randomUUID();
  const main: PersonaSession['main'] = async (method, path, body, key) => {
    const headers = new Headers({ authorization: `Bearer ${await oauth.current()}`, 'x-session-key': sessionKey });
    if (body !== undefined) headers.set('content-type', 'application/json');
    if (!['GET', 'HEAD'].includes(method)) headers.set('idempotency-key', key ?? randomUUID());
    const request = (signal: AbortSignal) => fetch(new URL(path, `http://127.0.0.1:${Bun.env.MAIN_PORT}`), {
      method, headers, signal, redirect: 'manual', ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return ['GET', 'HEAD'].includes(method) ? outcomeResponse(request) : request(AbortSignal.timeout(30_000));
  };
  const device = { ...person, main };
  await answer(device.main('PUT', '/v1/me/session-agent', { actingSubject: person.actingSubject, expectedRevision: null }));
  expect(await answer(device.main('GET', '/v1/me/session-agent'))).toMatchObject({ sessionAgent: { actingSubject: person.actingSubject, eligible: true } });
  return device;
}

async function track(name: Exclude<PersonaName, 'visitor'>) {
  currentPersona = name;
  const person = sessions[name], actor = person.actingSubject!, device = await otherDevice(person);
  const deviceMain = device.main;
  let deviceCount = 0;
  device.main = (...args) => recording.session(name, { main: deviceMain })(`device-${++deviceCount}`, ...args);
  await sample(name, person, 'first-device-identity', 'GET', '/v1/me/session-agent');
  await sample(name, device, 'second-device-identity', 'GET', '/v1/me/session-agent');
  await recordedFrame(name, person);
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
  expect(await positions(device, manga)).toMatchObject({ resolved: last, scope: 'resume' });
  const cached = await read(device, second, next);
  expect(cached).toMatchObject({ completed: false, version: 0 });
  const commandKey = randomUUID();
  const completed = await answer<Progress>(write(person, second, next, true, 0, actor, commandKey));
  expect(completed).toMatchObject({ completed: true, version: 1 });
  expect(await answer(write(person, second, next, true, 0, actor, commandKey))).toMatchObject({ ...completed, replayed: true });
  expect(await read(device, second, next)).toMatchObject({ completed: true, version: 1 });
  expect(await positions(device, omnibus)).toMatchObject({ resolved: next, scope: 'resume' });
  expect(await answer(write(device, second, next, false, cached.version), 409)).toMatchObject({ code: 'stale_progress' });
  const current = await read(device, second, next);
  expect(await answer(write(device, second, next, false, current.version))).toMatchObject({ completed: false, version: 2 });
  expect(await positions(person, manga)).toMatchObject({ resolved: last, scope: 'resume' });
  expect(await read(person, second, next)).toMatchObject({ completed: false, version: 2 });
  expect((await state(person, manga)).status).toMatchObject({ status: 'reading', version: saved.version });
  if (name === 'operator') {
    await grant(person, `work:read:${volume2.work}`, 'work.read');
    await grant(person, `work:edit:${manga.work}`, 'work.edit');
  }
  await foreign(name);
  await recordedControls(name, person, device);
}
outcomeTest(outcome, 'visitor', async () => {
  currentPersona = 'visitor';
  const person = sessions.visitor, actor = sessions.owner.actingSubject!;
  await recordedFrame('visitor', person);
  expect(await state(person, manga, actor)).toMatchObject({ status: { status: null, version: 0, changedAt: null }, progress: null });
  const opening = await positions(person, manga), mine = await positions(person, manga, 'mine');
  expect(mine.items).toEqual(opening.items);
  expect(mine.scope).not.toBe('resume');
  await answer(person.main('GET', `${path(first, first.occurrences[1]!)}?${acting(actor)}`), 401);
  await answer(write(person, first, first.occurrences[1]!, true, 0, actor), 401);
  await answer(person.main('PUT', `/v1/works/${short(manga.work)}/reader-status`, { actingSubject: actor, status: 'reading', expectedVersion: 0 }), 401);
  await answer(person.main('GET', `/v1/me/shelves?${acting(actor)}`), 401);
}, recording);
outcomeTest(outcome, 'stranger', () => track('stranger'), recording);
outcomeTest(outcome, 'member', () => track('member'), recording);
outcomeTest(outcome, 'owner', () => track('owner'), recording);
outcomeTest(outcome, 'moderator', () => track('moderator'), recording);
outcomeTest(outcome, 'operator', () => track('operator'), recording);

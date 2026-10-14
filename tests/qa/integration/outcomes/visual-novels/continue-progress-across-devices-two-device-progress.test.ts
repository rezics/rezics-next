import { afterAll, beforeAll, expect, setDefaultTimeout } from 'bun:test';
import { AsyncLocalStorage } from 'node:async_hooks';
import { discoverActingContexts, discoverAgents, readMainSessionAgent } from '../../../../../apps/web/features/auth/session.ts';
import { readAgentProfile } from '../../../../../apps/web/features/auth/agent-profile.ts';
import { BFF_PREFIX, browserMainApi } from '../../../../../apps/web/features/api/browser.ts';
import { loadBooksLibrary } from '../../../../../apps/web/features/library/books-library-recorded-page.ts';
import { parseLibraryState } from '../../../../../apps/web/features/library/state.ts';
import { booksEditionReads, settle } from '../../../../../apps/web/features/work-page/books-edition-page.read.ts';
import { readAnimeReaderState, readResourcePage, readLinkedStatements, readWorkParts, readWorkRealizations }
  from '../../../../../apps/web/features/work-page/anime-hub-recorded-page.ts';
import { mainRelationships } from '../../../../../apps/web/features/relationships/api.ts';
import { hubPlan } from '../../../../../apps/web/features/work-page/hub.ts';
import { followHref } from '../../../../../apps/web/features/entity-page/href.ts';
import { mainTrackingApi } from '../../../../../apps/web/features/tracking/api.ts';
import { progressControl } from '../../../../../apps/web/features/tracking/medium-progress.tsx';
import { typeEntry } from '../../../../../apps/web/features/catalogue/types.ts';
import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import continuity from '../../../../../scripts/qa/cases/outcomes/visual-novels/continue-progress-across-devices-two-device-progress.ts';
import { signIn } from '../../../../../scripts/lib/oauth-client.ts';
import { OutcomeRecorder, outcomeResponse, outcomeTest } from '../../../support/outcome-test.ts';
import { personaSessions, type PersonaName, type PersonaSession, type PersonaSessions } from '../../../support/personas.ts';

setDefaultTimeout(185_000);

const fileWall = setTimeout(() => { throw new Error('Library recording file exceeded 480 s'); }, 480_000);
const proofDeadlineMs = 60_000; // These 60 seconds belong to the existing proof, excluding production visits.
const visitDeadlineMs = 120_000;
const phases = new AsyncLocalStorage<{
  proofMs: number; visitMs: number; started: number; pause: () => void; resume: () => void;
}>();
async function personaRun(name: PersonaName, proof: () => Promise<void>) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let rejectDeadline: (error: Error) => void = () => {};
  const phase = {
    proofMs: 0, visitMs: 0, started: performance.now(),
    pause: () => { clearTimeout(timer); phase.proofMs += performance.now() - phase.started; },
    resume: () => {
      phase.started = performance.now();
      timer = setTimeout(() => rejectDeadline(new Error('Persona proof exceeded 60 s')), proofDeadlineMs - phase.proofMs);
    },
  };
  try {
    await Promise.race([
      phases.run(phase, async () => {
        phase.resume();
        await proof();
        await productionVisit(name, async () => {
          await libraryVisit(name, 'final');
          for (const shelf of ['reading', 'want-to-read', 'read']) await libraryVisit(name, 'final', shelf);
        });
      }),
      new Promise<never>((_, reject) => { rejectDeadline = reject; }),
    ]);
  } finally {
    phase.pause();
    console.info(`[persona-timing] ${name} proofMs=${Math.round(phase.proofMs)} visitMs=${Math.round(phase.visitMs)}`);
  }
}
async function productionVisit(name: PersonaName, visit: () => Promise<void>) {
  const phase = phases.getStore()!;
  phase.pause();
  const started = performance.now();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([visit(), new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${name} production visits exceeded 120 s`)), visitDeadlineMs - phase.visitMs);
    })]);
  } finally {
    clearTimeout(timer);
    phase.visitMs += performance.now() - started;
    phase.resume();
  }
}

/** The transport records Eden's exact path, query and body; the imported readers choose the requests. */
function visitClient(name: PersonaName, region: string) {
  const person = sessions[name];
  const sample = recording.session(name, person);
  const pending = new Map<string, Promise<Response>>();
  const fetcher: typeof fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const route = url.pathname.startsWith(BFF_PREFIX) ? url.pathname.slice(BFF_PREFIX.length) : url.pathname;
    const path = route + url.search;
    const method = init?.method ?? 'GET';
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) as unknown : undefined;
    const key = `${method}:${path}:${JSON.stringify(body)}`;
    let response = pending.get(key);
    if (!response) {
      const own = pairs.get(name)!;
      const known = [...pairs.entries()].find(([, works]) => works.some(work => route.includes(short(work))));
      const target = known?.[1].findIndex(work => route.includes(short(work))) ?? -1;
      const suffix = target < 0 ? '' : `${known?.[1] === own ? '' : `-${known![0]}`}${target === 0 ? '-work' : '-other-work'}`;
      const labels: Record<string, string> = {
        '/v1/me/shelves': 'overview', '/v1/rating-contexts': 'rating-context',
        '/v1/me/reading-goal': 'reading-goal', '/v1/me/reading-stats': 'reading-stats',
        '/v1/me/follows/authors': 'followed-authors', '/v1/me/work-states': 'work-states',
        '/v1/me/import-reviews': 'import-reviews',
        '/v1/me/acting-contexts': 'acting-contexts', '/v1/me/agents': 'agents',
        '/v1/me/session-agent': 'session-agent', '/v1/me/person-preferences': 'person-preferences',
      };
      const label = labels[route]
        ?? (route === `/v1/agents/${short(person.actingSubject!)}` ? 'agent-profile'
          : route.endsWith('/library-visibility') ? 'visibility'
          : route.startsWith('/v1/me/shelves/status/') ? `shelf-${route.split('/')[5]}`
          : route.startsWith('/v1/me/continue/') ? `resume${suffix}`
          : route.endsWith('/reviews') ? `reviews${suffix}`
          : route.startsWith('/v1/works/') ? `header${suffix}` : undefined);
      if (!label) throw new Error(`Unlabelled production library request: ${method} ${path}`);
      response = sample(`${region}-${label}`, method, path, body);
      pending.set(key, response);
    }
    return (await response).clone();
  };
  return { main: browserMainApi('http://record.invalid', { fetcher }), fetcher };
}
async function libraryVisit(name: PersonaName, checkpoint: string, shelf?: string) {
  const person = sessions[name];
  // The route redirects signed-out visitors before any Main library read.
  if (!person.actingSubject) return;
  const region = `visit-library-${checkpoint}-${shelf ?? 'all'}`;
  const { main, fetcher } = visitClient(name, region);
  // The supplied transport owns the real persona bearer and session key. These
  // placeholders only let the production readers enter their explicit-client path.
  const [discovery, agents, selected] = await Promise.all([
    discoverActingContexts('persona-transport', fetcher),
    discoverAgents('persona-transport', 'en', fetcher),
    readMainSessionAgent('persona-transport', randomUUID(), fetcher),
  ]);
  if (!discovery || !agents || !selected?.sessionAgent.eligible) return;
  await Promise.all([
    readAgentProfile(person.actingSubject, 'persona-transport', fetcher),
    main.v1.me['person-preferences'].get({ query: { actingSubject: person.actingSubject } }),
  ]);
  const state = parseLibraryState(shelf ? { shelf } : {});
  const reader = { main, anonymous: main, actingSubject: person.actingSubject };
  await loadBooksLibrary(reader, { state, locale: 'en', year: new Date().getUTCFullYear(), first: !shelf });
}

const short = (id: string) => id.slice(-36);
const query = (person: PersonaSession) => `actingSubject=${encodeURIComponent(person.actingSubject!)}`;
let sessions: PersonaSessions;
const recording = new OutcomeRecorder(continuity);
const pairs = new Map<PersonaName, string[]>();
async function answer<T>(request: Promise<Response>, status = 200): Promise<T> {
  const response = await request;
  const raw = await response.text();
  expect(response.status, `${response.status}: ${raw}`).toBe(status);
  return JSON.parse(raw) as T;
}
beforeAll(async () => {
  sessions = await personaSessions('public');
  await recording.prepare();
  const owner = sessions.owner;
  const actingSubject = owner.actingSubject;
  for (const name of ['visitor', 'member', 'owner'] as const) {
    const pair: string[] = [];
    for (let index = 0; index < 2; index++) {
      const work = await answer<{ work: string; mainVersion: string }>(owner.main('POST', '/v1/works', {
        profile: 'metadata-only-v1', title: `Orchard Continuity ${name} ${index}`, language: 'en',
        semanticTypes: ['https://schema.org/VideoGame'], authoring: 'own-work', actingSubject,
      }), 201);
      const draft = await answer<{ contribution: string; draftRevision: string }>(owner.main('POST', '/v1/contributions', {
        profile: 'text-contribution-v1', work: work.work, language: 'en',
        body: `An original partless visual novel: gardener ${index} chooses a path through an orchard.`, actingSubject,
      }), 201);
      const publication = await answer<{ publicationDecision: string }>(owner.main('POST', '/v1/contribution-publications', {
        profile: 'text-publication-v1', contribution: draft.contribution, expectedDraftHead: draft.draftRevision,
        expectedPublicationHead: null, rightsBasis: 'original-contribution', disclosure: 'public', actingSubject,
      }), 201);
      await answer(owner.main('POST', '/v1/publication-selections', {
        profile: 'main-default-selection-v1', context: { kind: 'main-version-default', id: work.mainVersion },
        work: work.work, contribution: draft.contribution, publicationDecision: publication.publicationDecision,
        expectedSelectionHead: null, selectionBasis: 'main-maintainer', actingSubject,
      }), 201);
      pair.push(work.work);
    }
    pairs.set(name, pair);
  }
  for (const name of ['stranger', 'moderator', 'operator'] as const) pairs.set(name, pairs.get('visitor')!);
}, 180_000);
afterAll(async () => {
  clearTimeout(fileWall);
  try { await recording.publish(); }
  finally { await sessions?.close(); }
});
type State = { status: { work: string; status: string | null; version: number; changedAt: string | null }; progress: unknown };
type Mark = { standing: string; version: number; replayed?: boolean };
const state = (person: PersonaSession, work: string) => answer<State>(person.main('GET', `/v1/works/${short(work)}/reader-state?${query(person)}`));
const mark = (person: PersonaSession, work: string) => answer<Mark>(person.main('GET', `/v1/works/${short(work)}/progress?${query(person)}`));
const status = (person: PersonaSession, work: string, value: string | null, version: number) => answer(person.main('PUT', `/v1/works/${short(work)}/reader-status`, { actingSubject: person.actingSubject, status: value, expectedVersion: version }));
const progress = (person: PersonaSession, work: string, standing: string, expectedVersion: number, key?: string) => answer<Mark>(person.main('PUT', `/v1/works/${short(work)}/progress`, { actingSubject: person.actingSubject, standing, expectedVersion }, key));
async function shelf(person: PersonaSession, selected: string[]) {
  const params = new URLSearchParams({ actingSubject: person.actingSubject!, sort: 'last-read', order: 'desc', limit: '1' });
  const seen: string[] = [];
  let page: { items: Array<{ work: string }>; nextCursor: string | null };
  do {
    page = await answer(person.main('GET', `/v1/me/shelves/status/reading/works?${params}`));
    seen.push(...page.items.map(item => item.work));
    if (page.nextCursor) params.set('cursor', page.nextCursor);
  } while (page.nextCursor);
  return seen.filter(work => selected.includes(work));
}

async function foreign(name: PersonaName) {
  const person = proofSession(name);
  const victim = name === 'owner' ? sessions.member : sessions.owner;
  const [work, other] = pairs.get(name)! as [string, string];
  for (const id of [work, other]) {
    await status(victim, id, 'reading', (await state(victim, id)).status.version);
    await progress(victim, id, 'started', (await mark(victim, id)).version);
  }
  const before = await state(victim, work);
  const victimMark = await mark(victim, work);
  const shelvesBefore = await answer(victim.main('GET', `/v1/me/shelves?${query(victim)}`));
  const ownMark = await mark(person, work);
  expect(await shelf(victim, [work, other])).toEqual([other, work]);
  await answer(person.main('GET', `/v1/works/${short(work)}/reader-state?${query(victim)}`), 403);
  await answer(person.main('PUT', `/v1/works/${short(work)}/reader-status`, { actingSubject: victim.actingSubject, expectedVersion: 1, status: 'read' }), 403);
  // Standing belongs to the principal. A foreign subject must never project that principal's mark into the victim's library.
  const read = await person.main('GET', `/v1/works/${short(work)}/progress?${query(victim)}`);
  if (read.status === 200) expect(await read.json()).toMatchObject({ standing: ownMark.standing, version: ownMark.version });
  else expect(read.status).toBe(403);
  const path = `/v1/works/${short(work)}/progress`;
  const command = { actingSubject: victim.actingSubject, expectedVersion: ownMark.version, standing: 'completed' };
  const write = await person.main('PUT', path, command);
  const reply = await write.text();
  console.info(JSON.stringify({ row: continuity.rowId, persona: name, request: { method: 'PUT', path, body: command }, answer: { status: write.status, body: JSON.parse(reply) } }));
  expect([200, 403]).toContain(write.status);
  expect(await state(victim, work)).toEqual(before);
  expect(await mark(victim, work)).toEqual(victimMark);
  expect(await answer(victim.main('GET', `/v1/me/shelves?${query(victim)}`))).toEqual(shelvesBefore);
  expect(await shelf(victim, [work, other])).toEqual([other, work]);
}

async function secondDevice(person: PersonaSession): Promise<PersonaSession> {
  const stackDirectory = resolve('.temp/stack', `rezics-qa-${Bun.env.REZICS_QA_RUN_ID}`);
  const directory = readdirSync(stackDirectory).find(name => name.startsWith('g-1005-auth-'));
  if (!directory) throw new Error('No persona OAuth client configuration');
  const config = JSON.parse(readFileSync(resolve(stackDirectory, directory, 'public.json'), 'utf8')) as { clientId: string; redirectUris: string[]; scope: string };
  // Account authenticates this fresh PKCE authorization using the reader's real cookie.
  // The second device receives a separate OAuth grant and Main session key.
  const oauth = await signIn({ account: Bun.env.ACCOUNT_BASE_URL!, clientId: config.clientId,
    redirectUri: config.redirectUris[0]!, scope: config.scope, resource: Bun.env.ACCOUNT_MAIN_RESOURCE,
    fetch: async (input, init) => {
      const url = new URL(input);
      if (url.pathname === '/api/auth/oauth2/authorize') return person.account('GET', `${url.pathname}${url.search}`);
      if (url.pathname === '/api/account/consent') return person.account('POST', url.pathname, JSON.parse(String(init?.body)));
      return fetch(input, init);
    },
  }, '');
  const sessionKey = randomUUID();
  return { ...person, main: async (method, path, body, key) => {
    const headers = new Headers({ authorization: `Bearer ${await oauth.current()}`, 'x-session-key': sessionKey });
    if (body !== undefined) headers.set('content-type', 'application/json');
    if (method !== 'GET') headers.set('idempotency-key', key ?? randomUUID());
    const request = (signal: AbortSignal) => fetch(new URL(path, `http://127.0.0.1:${Bun.env.MAIN_PORT}`), {
      method, headers, signal, redirect: 'manual', ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return method === 'GET' ? outcomeResponse(request) : request(AbortSignal.timeout(30_000));
  } };
}

// Stable route labels keep repeated reads and saves distinct without recording fixture setup.
const sampleCounts = new Map<string, number>();
function proofSession(name: PersonaName, session = sessions[name], device = 'primary'): PersonaSession {
  const sample = recording.session(name, session);
  return { ...session, main: (method, path, ...args) => {
    const route = path.split('?')[0]!.split('/').slice(2)
      .filter(part => !/^[0-9a-f]{8}-[0-9a-f-]{27}$/.test(part)).join('-');
    const label = `${device}-${method.toLowerCase()}-${route}`;
    const key = `${name}:${label}`;
    const index = sampleCounts.get(key) ?? 0;
    sampleCounts.set(key, index + 1);
    return sample(`${label}-${index}`, method, path, ...args);
  } };
}

// Home Continue, Library resume and the work-page identity/progress panel.
async function pageReads(name: PersonaName, checkpoint: string) {
  const person = sessions[name];
  const sample = recording.session(name, person);
  const work = pairs.get(name)![0]!;
  const root = `/v1/works/${short(work)}`;
  const viewer = (path: string) => `${path}${path.includes('?') ? '&' : '?'}${query(person)}`;
  const read = <T,>(label: string, path: string) => answer<T>(sample(`continue-${checkpoint}-${label}`, 'GET', viewer(path)));
  await read('home', '/v1/me/continue?limit=6');
  const resume = await sample(`continue-${checkpoint}-work-resume`, 'GET', viewer(`/v1/me/continue/${short(work)}`));
  expect([200, 404]).toContain(resume.status);
  await resume.body?.cancel();
  const header = await read<{ mainVersion: string; selectedLanguage: string | null }>('header', root);
  if (checkpoint === 'empty') {
    const contents = await sample('continue-contents', 'GET', viewer(`${root}/contents`));
    expect([200, 404]).toContain(contents.status);
    await contents.body?.cancel();
    await answer(sample('continue-selected-text', 'GET', `/v1/main-versions/${short(header.mainVersion)}/selection?language=${header.selectedLanguage ?? 'en'}`));
  }
  const requests: Array<[string, string]> = [
    ['reader-state', `${root}/reader-state`],
    ['progress-summary', `/v1/me/progress-summaries/${short(work)}?language=en`],
    ['work-states', `/v1/me/work-states?works=${encodeURIComponent(work)}`],
  ];
  if (checkpoint === 'empty') requests.push(
    ['edition-preference', `/v1/me/edition-preferences/${short(work)}`],
    ['releases-empty', `${root}/releases?limit=20`],
  );
  for (let offset = 0; offset < requests.length; offset += 3) {
    const results = await Promise.allSettled(requests.slice(offset, offset + 3).map(([label, path]) => read(label, path)));
    for (const result of results) if (result.status === 'rejected') throw result.reason;
  }
}

async function continueReading(name: PersonaName) {
  if (name === 'member') await pageReads(name, 'empty');
  const person = proofSession(name);
  const work = pairs.get(name)![0]!;
  const root = `/v1/works/${short(work)}`;
  if (name === 'visitor') {
    await answer(person.main('GET', `${root}/progress?${query(sessions.owner)}`), 401);
    await answer(person.main('PUT', `${root}/progress`, { actingSubject: sessions.owner.actingSubject, expectedVersion: 0, standing: 'started' }), 401);
    expect((await state(sessions.owner, work)).status).toMatchObject({ status: null, version: 0 });
    return;
  }
  if (['stranger', 'moderator', 'operator'].includes(name)) return foreign(name);
  const deviceB = proofSession(name, await secondDevice(person), 'second-device');
  const initial = await mark(deviceB, work);
  expect(initial).toMatchObject({ parts: false, standing: 'not-started', version: 0 });
  expect(await progress(person, work, 'started', initial.version)).toMatchObject({ standing: 'started', version: 1 });
  expect(await mark(deviceB, work)).toMatchObject({ standing: 'started', version: 1 });
  if (name === 'member') await pageReads(name, 'started');
  expect(await answer(deviceB.main('PUT', `${root}/progress`, { actingSubject: person.actingSubject, expectedVersion: initial.version, standing: 'completed' }), 409)).toMatchObject({ code: 'stale_progress' });
  const current = await mark(deviceB, work);
  expect(current).toMatchObject({ standing: 'started', version: 1 });
  const key = randomUUID();
  const saved = await progress(deviceB, work, 'completed', current.version, key);
  expect(saved).toMatchObject({ standing: 'completed', version: 2 });
  expect(await progress(deviceB, work, 'completed', current.version, key)).toMatchObject({ ...saved, replayed: true });
  expect(await mark(person, work)).toMatchObject({ standing: 'completed', version: 2 });
  if (name === 'member') await pageReads(name, 'completed');
  await productionVisit(name, async () => {
    await libraryVisit(name, 'completed');
    for (const shelf of ['reading', 'want-to-read', 'read']) await libraryVisit(name, 'completed', shelf);
    await workVisit(name);
  });
  expect(await answer(person.main('GET', `/v1/me/progress-summaries/${short(work)}?${query(person)}`))).toMatchObject({ status: 'finished' });
  expect(await progress(deviceB, work, 'not-started', saved.version)).toMatchObject({ standing: 'not-started', version: 3 });
  expect(await mark(person, work)).toMatchObject({ standing: 'not-started', version: 3 });
  expect(await mark(sessions.stranger, work)).toMatchObject({ standing: 'not-started', version: 0 });
  if (name === 'owner') await foreign(name);
}

outcomeTest(continuity, 'visitor', () => personaRun('visitor', () => continueReading('visitor')), recording);
outcomeTest(continuity, 'stranger', () => personaRun('stranger', () => continueReading('stranger')), recording);
outcomeTest(continuity, 'member', () => personaRun('member', () => continueReading('member')), recording);
outcomeTest(continuity, 'owner', () => personaRun('owner', () => continueReading('owner')), recording);
outcomeTest(continuity, 'moderator', () => personaRun('moderator', () => continueReading('moderator')), recording);
outcomeTest(continuity, 'operator', () => personaRun('operator', () => continueReading('operator')), recording);

async function workVisit(name: PersonaName) {
  const person = sessions[name];
  const sample = recording.session(name, person);
  const labels = new AsyncLocalStorage<string>();
  const fetcher: typeof fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const label = labels.getStore();
    if (!label) throw new Error('Unlabelled Work page request');
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) as unknown : undefined;
    const requestLabel = label === 'series-editions'
      ? `${label}-${url.pathname.endsWith('/releases') ? 'releases' : 'realizations'}` : label;
    return sample(`visit-work-completed-${requestLabel}`, init?.method ?? 'GET',
      (url.pathname.startsWith(BFF_PREFIX) ? url.pathname.slice(BFF_PREFIX.length) : url.pathname) + url.search, body);
  };
  const main = browserMainApi('http://record.invalid', { fetcher });
  const actingSubject = person.actingSubject!;
  const work = pairs.get(name)![0]!;
  const id = short(work);
  const reads = booksEditionReads({ main, actingSubject });
  const call = <T,>(label: string, run: () => Promise<T>) => labels.run(label, run);
  const selected = await call('session-agent', () => readMainSessionAgent('persona-transport', randomUUID(), fetcher));
  if (!selected?.sessionAgent.eligible) return;
  await call('person-preferences', () => main.v1.me['person-preferences'].get({ query: { actingSubject } }));
  const header = await call('header', () => reads.readWorkHeader(id));
  if (!header.ok) return;
  const [projection, seed, contexts, credits] = await Promise.all([
    call('projection', () => readResourcePage(main, actingSubject, id)),
    call('reader-state', () => readAnimeReaderState(main, actingSubject, id)),
    call('rating-contexts', () => settle(() => main.v1.resources({ resource: id })['rating-contexts'].get({ query: {
      actingSubject, scope: 'global' } }))),
    call('agent-credits', () => reads.readAgentCredits(id)),
    call('credits', () => reads.readCredits(id)),
    call('showcase', () => main.v1.resources.showcase.post({ profile: 'work-showcase-batch-v1', targets: [work] })),
    call('platform-access', () => main.v1.me['platform-access'].get()),
  ]);
  const plan = hubPlan(projection.ok ? projection.data : null);
  const context = contexts.ok ? contexts.data.items[0]?.context : undefined;
  const tasks: Promise<unknown>[] = [
    call('ratings', () => settle(() => main.v1.resources({ resource: id }).ratings.get({ query: {
      actingSubject, scope: 'global', context } }))).then(ratings => call('reader-stats', () =>
        main.v1.works({ id })['reader-stats'].get({ query: { actingSubject, context: ratings.ok ? context : undefined } }))),
    call('rating-populations', () => main.v1['rating-populations'].get({ query: { actingSubject, target: work, limit: 20 } })),
    call('adoptions', () => reads.readAdoptions(id)),
    call('also-enjoyed', () => reads.readAlsoEnjoyed(id)),
    call('follow-state', () => mainRelationships(actingSubject, {
      origin: `http://record.invalid${BFF_PREFIX}`, fetch: fetcher,
    }).state(work)),
  ];
  if (plan.includes('availability')) tasks.push(
    call('realizations', () => readWorkRealizations(main, actingSubject, id)),
    call('releases', () => reads.readReleases(id)),
    call('availability-parts', () => readWorkParts(main, actingSubject, id, { limit: 1 })),
  );
  if (plan.includes('parts')) tasks.push(
    call('parts', () => readWorkParts(main, actingSubject, id, { limit: 7 })),
    call('wholes', () => main.v1.resources({ resource: id }).wholes.get({ query: { actingSubject, limit: 3 } })),
    call('relations', () => main.v1.resources({ resource: id }).relations.get({ query: { actingSubject, limit: 20 } })),
  );
  if (plan.includes('about')) tasks.push(
    call('classifications', () => reads.readClassifications(id, { kind: 'global' })),
    call('facets', () => reads.readFacets()));
  if (plan.includes('ratings')) {
    if (context) tasks.push(call('reviews', () => main.v1.resources({ resource: id }).reviews.get({ query: {
      context, sort: 'helpful', limit: 10, actingSubject } })));
  }
  if (projection.ok) {
    const statements = projection.data.sections.find(section => section.id === 'statements');
    if (statements) tasks.push(call('statements', () => readLinkedStatements(main, actingSubject, statements.href)));
    const discussion = projection.data.sections.find(section => section.id === 'discussion');
    if (plan.includes('discussion') && discussion) tasks.push(call('discussion', () => settle(followHref(main,
      discussion.href, { actingSubject }))));
  }
  if (plan.includes('lists') && credits.ok) for (const author of credits.data.items.filter(item => item.role === 'author').slice(0, 1)) {
    tasks.push(call('author-profile', () => main.v1.agents({ id: short(author.agent) }).get({ query: { actingSubject } })),
      call('author-works', () => main.v1.agents({ id: short(author.agent) }).works.get({ query: { actingSubject, limit: 12 } })));
  }
  await Promise.all(tasks);
  // Parts mounts these browser panels only when the frame supplied a reader seed.
  if (!plan.includes('parts') || !seed) return;
  const tracking = mainTrackingApi(actingSubject, () => main);
  const media = tracking.media!;
  await Promise.all([
    (async () => {
      const types = await call('medium-types', () => media.types(work));
      if (!types.ok && types.failure === 'missing') return;
      const presentation = types.ok && types.data ? typeEntry(types.data)?.presentation ?? null : null;
      const control = await call('medium-parts', () => progressControl(media, tracking.episodes!, work, presentation));
      if (control.kind === 'work') await call('winning-mark', () => media.workStanding(work));
      else if (control.kind === 'game') {
        // A failed parts choice still mounts GameProgress; its opening read
        // owns the displayed refusal. It must not invent a whole-Work mark.
        const routes = await call('game-routes', () => media.routes(work));
        if (routes.ok) await Promise.all(routes.data.items.map(route =>
          call(`game-part-${short(route.occurrence)}`, () => media.progress(route))));
      }
    })(),
    (async () => {
      const [preference] = await Promise.all([
        call('series-preference', () => tracking.preference(work)),
        call('series-editions', () => tracking.editions(work)),
        call('series-relations', () => tracking.relations(work)),
        call('correspondence-definition', () => tracking.definition('correspondence-equivalent')),
      ]);
      await call('series-progress', () => tracking.series(work,
        preference.ok && preference.data ? preference.data.language : 'en'));
    })(),
  ]);
}

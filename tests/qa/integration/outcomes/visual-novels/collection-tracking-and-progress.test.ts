import { afterAll, beforeAll, expect, setDefaultTimeout } from 'bun:test';
import { AsyncLocalStorage } from 'node:async_hooks';
import { BFF_PREFIX, browserMainApi } from '../../../../../apps/web/features/api/browser.ts';
import { loadBooksLibrary } from '../../../../../apps/web/features/library/books-library-recorded-page.ts';
import { parseLibraryState } from '../../../../../apps/web/features/library/state.ts';
import { randomUUID } from 'node:crypto';
import collection from '../../../../../scripts/qa/cases/outcomes/visual-novels/collection-tracking-and-progress.ts';
import { OutcomeRecorder, outcomeTest } from '../../../support/outcome-test.ts';
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
        await productionVisit(name, () => libraryVisit(name, 'final'));
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
    const path = url.pathname.slice(BFF_PREFIX.length) + url.search;
    const method = init?.method ?? 'GET';
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) as unknown : undefined;
    const key = `${method}:${path}:${JSON.stringify(body)}`;
    let response = pending.get(key);
    if (!response) {
      const route = url.pathname.slice(BFF_PREFIX.length);
      const works = pairs.get(name)!;
      const target = works.findIndex(work => route.includes(short(work)));
      const suffix = target < 0 ? '' : target === 0 ? '-work' : '-other-work';
      const labels: Record<string, string> = {
        '/v1/me/shelves': 'overview', '/v1/rating-contexts': 'rating-context',
        '/v1/me/reading-goal': 'reading-goal', '/v1/me/reading-stats': 'reading-stats',
        '/v1/me/follows/authors': 'followed-authors', '/v1/me/work-states': 'work-states',
        '/v1/me/import-reviews': 'import-reviews',
      };
      const label = labels[route]
        ?? (route.endsWith('/library-visibility') ? 'visibility'
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
  return browserMainApi('http://record.invalid', { fetcher });
}
async function libraryVisit(name: PersonaName, checkpoint: string, shelf?: string) {
  const person = sessions[name];
  // The route redirects signed-out visitors before any Main library read.
  if (!person.actingSubject) return;
  const region = `visit-library-${checkpoint}-${shelf ?? 'all'}`;
  const main = visitClient(name, region);
  const state = parseLibraryState(shelf ? { shelf } : {});
  const reader = { main, anonymous: main, actingSubject: person.actingSubject };
  await loadBooksLibrary(reader, { state, locale: 'en', year: new Date().getUTCFullYear(), first: !shelf });
}

const short = (id: string) => id.slice(-36);
const query = (person: PersonaSession) => `actingSubject=${encodeURIComponent(person.actingSubject!)}`;
let sessions: PersonaSessions;
const recording = new OutcomeRecorder(collection);
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
        profile: 'metadata-only-v1', title: `Orchard Choices ${name} ${index}`, language: 'en',
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
  console.info(JSON.stringify({ row: collection.rowId, persona: name, request: { method: 'PUT', path, body: command }, answer: { status: write.status, body: JSON.parse(reply) } }));
  expect([200, 403]).toContain(write.status);
  expect(await state(victim, work)).toEqual(before);
  expect(await mark(victim, work)).toEqual(victimMark);
  expect(await answer(victim.main('GET', `/v1/me/shelves?${query(victim)}`))).toEqual(shelvesBefore);
  expect(await shelf(victim, [work, other])).toEqual([other, work]);
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

// Library overview, status rows and the Work's tracking control read these answers.
async function pageReads(name: PersonaName, checkpoint: string) {
  const person = sessions[name];
  const sample = recording.session(name, person);
  const works = pairs.get(name)!;
  const work = works[0]!;
  const viewer = (path: string) => `${path}${path.includes('?') ? '&' : '?'}${query(person)}`;
  const read = <T,>(label: string, path: string) => answer<T>(sample(`library-${checkpoint}-${label}`, 'GET', viewer(path)));
  const requests = [
    () => read('overview', '/v1/me/shelves?limit=20'),
    () => read('work-states', `/v1/me/work-states?works=${encodeURIComponent(works.join(','))}`),
    () => read('reading-preview', '/v1/me/shelves/status/reading/works?sort=last-read&order=desc&limit=3'),
  ];
  if (checkpoint === 'empty') requests.push(
    () => answer(sample('library-visibility', 'GET', `/v1/agents/${short(person.actingSubject!)}/library-visibility`)),
    () => read('work-header', `/v1/works/${short(work)}`),
    () => read('progress-summary', `/v1/me/progress-summaries/${short(work)}?language=en`),
    () => read('reading-goal', `/v1/me/reading-goal?year=${new Date().getUTCFullYear()}`),
    () => read('reading-stats', `/v1/me/reading-stats?year=${new Date().getUTCFullYear()}`),
    () => read('followed-authors', '/v1/me/follows/authors'),
  );
  for (let offset = 0; offset < requests.length; offset += 3) {
    const results = await Promise.allSettled(requests.slice(offset, offset + 3).map(request => request()));
    for (const result of results) if (result.status === 'rejected') throw result.reason;
  }
  const contexts = await answer<{ items: Array<{ context: string }> }>(sample(`library-${checkpoint}-rating-context`, 'GET', '/v1/rating-contexts?scope=global&limit=1'));
  if (checkpoint === 'reading') {
    const resume = await sample('library-reading-resume', 'GET', viewer(`/v1/me/continue/${short(work)}`));
    expect([200, 404]).toContain(resume.status);
    await resume.body?.cancel();
  }
  if (checkpoint === 'read') {
    const context = contexts.items[0]?.context;
    if (context) await read('reviews-empty', `/v1/resources/${short(work)}/reviews?context=${encodeURIComponent(context)}&limit=1&showSpoilers=true`);
    await read('import-reviews-empty', `/v1/me/import-reviews?works=${encodeURIComponent(work)}`);
  }
}

async function track(name: PersonaName) {
  if (name === 'member') await pageReads(name, 'empty');
  const person = proofSession(name);
  const work = pairs.get(name)![0]!;
  const root = `/v1/works/${short(work)}`;
  if (name === 'visitor') {
    expect(await answer(person.main('GET', `${root}/reader-state`))).toMatchObject({ status: { status: null, version: 0, changedAt: null }, progress: null });
    await answer(person.main('PUT', `${root}/reader-status`, { actingSubject: sessions.owner.actingSubject, status: 'reading', expectedVersion: 0 }), 401);
    await answer(person.main('GET', `${root}/progress?${query(sessions.owner)}`), 401);
    await answer(person.main('PUT', `${root}/progress`, { actingSubject: sessions.owner.actingSubject, expectedVersion: 0, standing: 'started' }), 401);
    expect((await state(sessions.owner, work)).status).toMatchObject({ status: null, version: 0 });
    return;
  }
  if (['stranger', 'moderator', 'operator'].includes(name)) return foreign(name);
  expect((await state(person, work)).status).toMatchObject({ status: null, version: 0 });
  let version = 0;
  for (const value of ['want-to-read', 'reading', 'read', null]) {
    expect(await status(person, work, value, version++)).toMatchObject({ status: value, version });
    expect((await state(person, work)).status).toMatchObject({ status: value, version });
    if (name === 'member' && (value === 'reading' || value === 'read')) {
      await pageReads(name, value);
      await productionVisit(name, async () => {
        await libraryVisit(name, value);
        await libraryVisit(name, value, value);
      });
    }
    if (value) {
      const shelves = await answer<{ statusShelves: Array<{ status: string; count: number }> }>(person.main('GET', `/v1/me/shelves?${query(person)}`));
      expect(shelves.statusShelves.find(item => item.status === value)!.count).toBeGreaterThanOrEqual(1);
      const savedWorks = await answer<{ items: Array<{ work: string }> }>(person.main('GET', `/v1/me/shelves/status/${value}/works?${query(person)}`));
      expect(savedWorks.items).toContainEqual(expect.objectContaining({ work }));
    }
  }
  expect(await mark(person, work)).toMatchObject({ parts: false, standing: 'not-started', version: 0 });
  let markVersion = 0;
  for (const standing of ['started', 'completed', 'not-started', 'dropped']) {
    const key = randomUUID();
    const saved = await progress(person, work, standing, markVersion, key);
    expect(saved).toMatchObject({ standing, version: ++markVersion });
    expect(await progress(person, work, standing, markVersion - 1, key)).toMatchObject({ ...saved, replayed: true });
    expect(await mark(person, work)).toMatchObject({ standing, version: markVersion });
  }
  expect(await answer(person.main('GET', `/v1/me/progress-summaries/${short(work)}?${query(person)}`))).toMatchObject({ status: 'dropped' });
  if (name === 'owner') await foreign(name);
}

outcomeTest(collection, 'visitor', () => personaRun('visitor', () => track('visitor')), recording);
outcomeTest(collection, 'stranger', () => personaRun('stranger', () => track('stranger')), recording);
outcomeTest(collection, 'member', () => personaRun('member', () => track('member')), recording);
outcomeTest(collection, 'owner', () => personaRun('owner', () => track('owner')), recording);
outcomeTest(collection, 'moderator', () => personaRun('moderator', () => track('moderator')), recording);
outcomeTest(collection, 'operator', () => personaRun('operator', () => track('operator')), recording);

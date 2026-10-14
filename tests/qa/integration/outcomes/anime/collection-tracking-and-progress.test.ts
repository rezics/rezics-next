import { afterAll, beforeAll, expect, setDefaultTimeout } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { mkdirSync, writeFileSync } from 'node:fs';
import { Pool } from 'pg';
import { sourceIdentity } from '../../../../../scripts/qa/core.ts';
import { grantLaunchRecipeAuthority } from '../../../../../scripts/load/launch-corpus.ts';
import { OutcomeRecorder, outcomeTest } from '../../../support/outcome-test.ts';
import { settledWrite } from '../../../support/settled-write.ts';
import { personaSessions, type PersonaName, type PersonaSession, type PersonaSessions } from '../../../support/personas.ts';
import { browserMainApi } from '../../../../../apps/web/features/api/browser.ts';
import { createReaderStore } from '../../../../../apps/web/features/catalogue/reader-store.ts';
import { mainTrackingApi } from '../../../../../apps/web/features/tracking/api.ts';
import { mainEpisodeApi } from '../../../../../apps/web/features/tracking/episode-api.ts';
import { markPosition, standingOf } from '../../../../../apps/web/features/tracking/episodes.ts';
import { readAnimeAgentCredits, readAnimeWorkCredits, readResourcePage } from '../../../../../apps/web/features/work-page/anime-hub-recorded-page.ts';
import { readCustomShelves } from '../../../../../apps/web/features/library/read.ts';
import { followHref } from '../../../../../apps/web/features/entity-page/href.ts';
import { hubPlan } from '../../../../../apps/web/features/work-page/hub.ts';
import { PREVIEW_COUNTS } from '../../../../../apps/web/features/work-levels/previews.tsx';

setDefaultTimeout(210_000);
let sessions: PersonaSessions;
const requests = new WeakMap<Response, { method: string; path: string; body: unknown; key?: string;
  caller: { persona: PersonaName; accountId: string | null; actingSubject: string | null } }>();
const failures: { request: unknown; status: number; answer: string }[] = [];
const preparation = { durationMs: 0 };
let preparing = true;
const short = (id: string) => id.slice(-36);
const acting = (person: PersonaSession) => `actingSubject=${encodeURIComponent(person.actingSubject!)}`;
type Work = { work: string; mainVersion: string };
async function answer<T>(pending: Promise<Response>, status = 200): Promise<T> {
  const response = await pending;
  const raw = await response.text();
  if (response.status !== status) {
    failures.push({ request: requests.get(response), status: response.status, answer: raw });
    await Bun.write(`.temp/anime-collection-tracking-and-progress-failures-${Bun.env.REZICS_QA_RUN_ID}.json`,
      JSON.stringify({ preparation, failures }, null, 2));
  }
  expect(response.status, `${response.status}: ${raw}`).toBe(status);
  return JSON.parse(raw) as T;
}
async function grant(person: PersonaSession, scope: string, action: string) {
  const pool = new Pool({ connectionString: Bun.env.ACCESS_DATABASE_URL });
  try {
    const principal = await pool.query<{ id: string }>(
      'SELECT id FROM access.principal WHERE account_subject = $1 AND active', [person.accountId]);
    expect(principal.rows).toHaveLength(1);
    await grantLaunchRecipeAuthority(pool, principal.rows[0]!.id, person.actingSubject!, scope, action);
  } finally { await pool.end(); }
}
async function publish(title: string): Promise<Work> {
  const owner = sessions.owner;
  const work = await answer<Work>(owner.main('POST', '/v1/works', {
    profile: 'metadata-only-v1', title, language: 'en', semanticTypes: ['https://schema.org/TVSeries'],
    authoring: 'own-work', actingSubject: owner.actingSubject,
  }), 201);
  const draft = await answer<{ contribution: string; draftRevision: string }>(
    owner.main('POST', '/v1/contributions', { profile: 'text-contribution-v1',
      work: work.work, language: 'en', body: `Original fixture animation script by Outcome owner: ${title}.`,
      actingSubject: owner.actingSubject }), 201);
  const publication = await answer<{ publicationDecision: string }>(
    owner.main('POST', '/v1/contribution-publications', { profile: 'text-publication-v1',
      contribution: draft.contribution, expectedDraftHead: draft.draftRevision,
      expectedPublicationHead: null, rightsBasis: 'original-contribution', disclosure: 'public',
      actingSubject: owner.actingSubject }), 201);
  await answer(owner.main('POST', '/v1/publication-selections', {
    profile: 'main-default-selection-v1', context: { kind: 'main-version-default', id: work.mainVersion },
    work: work.work, contribution: draft.contribution, publicationDecision: publication.publicationDecision,
    expectedSelectionHead: null, selectionBasis: 'main-maintainer', actingSubject: owner.actingSubject,
  }), 201);
  return work;
}
afterAll(async () => {
  try { await recording.publish(); }
  finally { await sessions?.close(); }
});
import row from '../../../../../scripts/qa/cases/outcomes/anime/collection-tracking-and-progress.ts';
const recording = new OutcomeRecorder(row);
type Sample = ReturnType<OutcomeRecorder['session']>;

type Progress = { completed: boolean; version: number; position: string | null; replayed?: boolean };
let show: Work, structure: string;
const occurrences: string[] = [], targets: string[] = [];
beforeAll(async () => {
  const started = Date.now();
  try {
  const source = sourceIdentity(process.cwd());
  const evidenceDirectory = `.temp/anime-collection-tracking-and-progress-evidence-${Bun.env.REZICS_QA_RUN_ID}`;
  mkdirSync(evidenceDirectory, { recursive: true });
  writeFileSync(`${evidenceDirectory}/source.json`, JSON.stringify(source, null, 2), { flag: 'wx' });
  sessions = await personaSessions({ observeMain: async observed => {
    if (observed.response.status < 500) return;
    const persona = sessions && (['visitor', 'stranger', 'member', 'owner', 'moderator', 'operator'] as const)
      .find(name => sessions[name] === observed.caller);
    const failure = { source, phase: preparing ? 'preparation' : 'proof',
      caller: { persona: persona ?? null, accountId: observed.caller.accountId,
        actingSubject: observed.caller.actingSubject },
      request: observed.request, status: observed.response.status, answer: observed.response.body,
      requestStartedAt: observed.requestStartedAt, answeredAt: observed.answeredAt };
    writeFileSync(`${evidenceDirectory}/failure-${randomUUID()}.json`, JSON.stringify(failure, null, 2), { flag: 'wx' });
    if (preparing) return;
    failures.push(failure);
    // Observe before the shared transport can repeat a read: an eventual 200
    // cannot prove a journey whose first answer was a dependency refusal.
    expect(observed.response.status, `${observed.response.status}: ${observed.response.body}`).toBe(200);
  } });
  await recording.prepare();
  for (const name of ['visitor', 'stranger', 'member', 'owner', 'moderator', 'operator'] as const) {
    const person = sessions[name], main = person.main;
    person.main = async (method, path, body, key, options) => {
      key ??= method === 'GET' ? undefined : randomUUID();
      const response = !preparing || method === 'GET' ? await main(method, path, body, key, options)
        : await settledWrite(main, method, path, body, key);
      requests.set(response, { method, path, body, key,
        caller: { persona: name, accountId: person.accountId, actingSubject: person.actingSubject } });
      if (!preparing && response.status >= 500) {
        await answer(Promise.resolve(response));
      }
      return response;
    };
  }
  const owner = sessions.owner;
  show = await publish('Original animation: Three lantern episodes');
  await grant(owner, 'semantic:create:root', 'semantic.change');
  for (let index = 1; index <= 3; index++) {
    const episode = await answer<{ component: string }>(owner.main('POST', '/v1/semantic/changes', {
      profile: 'semantic-change-v1', expectedHead: null, actingSubject: owner.actingSubject,
      state: { component: 'resource', types: ['https://schema.org/Episode'], properties: [
        { predicate: 'https://schema.org/name', value: { kind: 'language-string', lexical: `Original episode ${index}`, language: 'en' } },
        { predicate: 'https://rezics.com/vocab/semanticWork', value: { kind: 'resource', ref: show.work } },
      ] },
    }), 201);
    targets.push(episode.component);
    await grant(owner, `semantic:read:${episode.component}`, 'semantic.read');
  }
  const composition = await answer<{ structure: string; revision: string }>(
    owner.main('POST', '/v1/compositions', { profile: 'work-composition',
      work: show.work, mainVersion: show.mainVersion, actingSubject: owner.actingSubject }), 201);
  structure = composition.structure;
  const changed = await answer<{ occurrences: string[] }>(
    owner.main('POST', `/v1/compositions/${short(structure)}/changes`, {
      profile: 'work-composition', expectedHead: composition.revision, actingSubject: owner.actingSubject,
      operations: targets.map((target, index) => ({ op: 'insert', role: 'part', parent: structure,
        position: 'last', target, displayLabel: `Episode ${index + 1}`, inclusion: 'required' })),
    }));
  occurrences.push(...changed.occurrences);
  expect(occurrences).toHaveLength(3);
  } finally {
    preparing = false;
    preparation.durationMs = Date.now() - started;
    await Bun.write(`.temp/anime-collection-tracking-and-progress-preparation-${Bun.env.REZICS_QA_RUN_ID}.json`,
      JSON.stringify(preparation, null, 2));
  }
}, 180_000);
const progressPath = (index = 0) => `/v1/compositions/${short(structure)}/occurrences/${short(occurrences[index]!)}/progress`;
const write = (person: PersonaSession, sample: Sample, completed: boolean, expectedVersion: number, key = randomUUID(), index = 0) =>
  sample('episode-completed', 'PUT', progressPath(index), { actingSubject: person.actingSubject, completed, expectedVersion, position: null }, key);
async function publicOpening(person: PersonaSession, sample: Sample) {
  const query = person.actingSubject ? `&${acting(person)}` : '';
  const opening = await answer<{ items: { occurrence: string; target: string }[]; nextCursor: string | null }>(
    sample('episode-opening', 'GET', `/v1/reading-positions/${short(show.work)}?position=start&limit=1${query}`));
  expect(opening.items).toMatchObject([{ occurrence: occurrences[0], target: targets[0] }]);
  expect(opening.nextCursor).not.toBeNull();
  const page = await answer<{ items: { occurrence: string; target: string }[]; nextCursor: string | null }>(
    sample('episode-opening-page', 'GET', `/v1/reading-positions/${short(show.work)}?position=start&limit=20${query}`));
  expect(page.items).toMatchObject(occurrences.map((occurrence, index) => ({ occurrence, target: targets[index] })));
  expect(page.nextCursor).toBeNull();
}

/** A control can show a refusal too; dependencies failing is never a recorded answer. */
type ControlAnswer = { items: unknown[]; nextCursor: string | null; next: string | null;
  definition: string; resource: string; structure: string; scope: string;
  occurrences: { occurrence: string }[] };
async function controlRead(sample: Sample, label: string, path: string, shown: (body: ControlAnswer) => void, status = 200) {
  const response = await sample(label, 'GET', path);
  const body = await answer<ControlAnswer>(Promise.resolve(response), status);
  shown(body);
}

async function collectionControls(person: PersonaSession, sample: Sample) {
  const query = acting(person), work = short(show.work);
  await controlRead(sample, 'collection-reader-seed', `/v1/me/work-states?${new URLSearchParams({ works: show.work, actingSubject: person.actingSubject! })}`,
    body => expect(body.items).toMatchObject([{ work: show.work, status: { status: null, version: 0 } }]));
  await controlRead(sample, 'collection-custom-shelves', `/v1/me/shelves?${query}&limit=20`,
    body => expect(body).toMatchObject({ items: [], nextCursor: null }));
  await controlRead(sample, 'collection-attempts', `/v1/me/sessions?${query}&target=${encodeURIComponent(show.work)}&limit=50`,
    body => expect(body).toMatchObject({ items: [], nextCursor: null }));
  await controlRead(sample, 'collection-realizations', `/v1/works/${work}/realizations?${query}&limit=20`,
    body => expect(body).toMatchObject({ items: [], nextCursor: null }));
  await controlRead(sample, 'collection-releases', `/v1/works/${work}/releases?${query}&limit=20`,
    body => expect(body).toMatchObject({ items: [], nextCursor: null }));
  await controlRead(sample, 'collection-edition-preference', `/v1/me/edition-preferences/${work}?${query}`,
    body => expect(body).toBeNull());
  await controlRead(sample, 'collection-relations', `/v1/resources/${work}/relations?${query}&limit=20`,
    body => expect(body).toMatchObject({ items: [], next: null }));
  await controlRead(sample, 'collection-equivalence-definition', `/v1/lexicon/definitions/correspondence-equivalent?${query}`,
    body => expect(body).toMatchObject({ code: 'definition_unavailable' }), 404);
  await controlRead(sample, 'collection-series-progress', `/v1/me/progress-summaries/${work}?${query}&language=en`,
    body => expect(body).toMatchObject({ resource: show.work }));
  await controlRead(sample, 'episode-structure', `/v1/resources/${work}/parts?${query}&limit=20`,
    body => expect(body.structure).toBe(structure));
  await controlRead(sample, 'episode-structure-page', `/v1/compositions/${short(structure)}?${query}&limit=20`,
    body => expect(body.occurrences.map((item: { occurrence: string }) => item.occurrence)).toEqual(occurrences));
  await controlRead(sample, 'episode-resume-before-watching', `/v1/reading-positions/${work}?${query}&position=mine&limit=1`,
    body => expect(body).toMatchObject({ scope: 'positions', items: [{ occurrence: occurrences[0] }] }));
}
async function isolated(name: PersonaName, person: PersonaSession, affected: PersonaSession, sample: Sample) {
  const affectedSample = recording.session(name, affected);
  const path = `/v1/works/${short(show.work)}`;
  expect(await answer(sample('foreign-reader-state-refused', 'GET', `${path}/reader-state?${acting(affected)}`), 403))
    .toMatchObject({ code: 'reader_library_denied' });
  await answer(sample('foreign-reader-status-refused', 'PUT', `${path}/reader-status`, {
    actingSubject: affected.actingSubject, expectedVersion: 0, status: 'reading',
  }), 403);
  expect(await answer(sample('own-unstarted-episode', 'GET', `${progressPath(2)}?${acting(person)}`)))
    .toMatchObject({ completed: false, version: 0, position: null });
  const foreignPath = `${progressPath(2)}?${acting(affected)}`;
  const foreign = await sample('foreign-episode-progress-refused', 'GET', foreignPath);
  const before = await answer(affectedSample('foreign-episode-before', 'GET', `${progressPath(2)}?${acting(affected)}`));
  const body = { actingSubject: affected.actingSubject, completed: true, expectedVersion: 0, position: null };
  const response = await sample('foreign-episode-completion-refused', 'PUT', progressPath(2), body);
    const persona = (['stranger', 'member', 'owner', 'moderator', 'operator'] as const)
      .find(name => sessions[name] === person)!;
    await Bun.write(`.temp/anime-collection-tracking-and-progress-${Bun.env.REZICS_QA_RUN_ID}-${persona}.json`,
      JSON.stringify({ persona, get: { request: { method: 'GET', path: foreignPath },
        status: foreign.status, answer: await foreign.clone().text() },
        put: { request: requests.get(response),
          status: response.status, answer: await response.clone().text() } }, null, 2));
  const after = await answer(affectedSample('foreign-episode-after', 'GET', `${progressPath(2)}?${acting(affected)}`));
  // The caller's Account progress must not project a last-read timestamp onto an uncontrolled Person.
  expect(after).toEqual(before);
  await answer(Promise.resolve(response), 403);
  // Reading progress requires control of the presented Person, even for an empty Account row.
  expect(await answer(Promise.resolve(foreign), 403)).toMatchObject({ code: 'authority_denied' });
}

async function journey(name: PersonaName) {
  const person = sessions[name];
  const sample = recording.session(name, person);
  await publicOpening(person, sample);
  const path = `/v1/works/${short(show.work)}`;
  if (name === 'visitor') {
    expect(await answer(sample('anonymous-reader-state', 'GET', `${path}/reader-state`))).toMatchObject({
      status: { status: null, version: 0 }, progress: null });
    await answer(sample('reader-status-sign-in', 'PUT', `${path}/reader-status`, {
      actingSubject: sessions.member.actingSubject, expectedVersion: 0, status: 'reading' }), 401);
    await answer(sample('episode-progress-sign-in', 'GET', `${progressPath()}?${acting(sessions.member)}`), 401);
    await answer(sample('episode-completion-sign-in', 'PUT', progressPath(), {
      actingSubject: sessions.member.actingSubject, completed: true, expectedVersion: 0, position: null }), 401);
    await answer(sample('shelves-sign-in', 'GET', `/v1/me/shelves?${acting(sessions.member)}`), 401);
    return;
  }
  await collectionControls(person, sample);
  expect(await answer(sample('reader-state-before-watching', 'GET', `${path}/reader-state?${acting(person)}`)))
    .toMatchObject({ work: show.work, status: { status: null, version: 0 }, progress: null });
  const statusBody = { actingSubject: person.actingSubject, expectedVersion: 0, status: 'reading' };
  expect(await answer(sample('start-watching', 'PUT', `${path}/reader-status`, statusBody)))
    .toMatchObject({ work: show.work, status: 'reading', version: 1 });
  const shelf = await answer<{ items: { work: string }[]; nextCursor: string | null }>(
    sample('watching-shelf', 'GET', `/v1/me/shelves/status/reading/works?${acting(person)}&sort=added&order=desc&limit=1`));
  expect(shelf.items).toMatchObject([{ work: show.work, status: 'reading', version: 1 }]);
  expect(shelf.nextCursor).toBeNull();
  expect(await answer(sample('episode-progress-before-completion', 'GET', `${progressPath()}?${acting(person)}`)))
    .toMatchObject({ completed: false, version: 0, position: null });
  expect(await answer<Progress>(write(person, sample, true, 0))).toMatchObject({ completed: true, version: 1 });
  const completed = await answer<{ items: { occurrence: string }[] }>(
    sample('completed-episodes', 'GET', `/v1/compositions/${short(structure)}/progress?${acting(person)}&limit=1`));
  expect(completed.items.map(item => item.occurrence)).toEqual([occurrences[0]!]);
  expect(await answer(sample('resume-watching', 'GET', `/v1/reading-positions/${short(show.work)}?${acting(person)}&position=mine&limit=1`)))
    .toMatchObject({ resolved: occurrences[0], scope: 'resume' });
  await isolated(name, person, name === 'owner' ? sessions.member : sessions.owner, sample);
}

/** One English `/library?shelf=reading&view=grid` visit, using the server's exact reads. */
async function libraryVisit(name: PersonaName, person: PersonaSession, sample: Sample) {
  // LibraryRoute redirects an anonymous visitor before it reads the library.
  if (name === 'visitor') return;
  await Promise.all([
    answer(sample('library-session-acting-contexts', 'GET', '/v1/me/acting-contexts?task=work.create')),
    answer(sample('library-session-agents', 'GET', '/v1/me/agents?languages=en')),
    answer(sample('library-session-agent', 'GET', '/v1/me/session-agent')),
  ]);
  const query = (fields: Record<string, string> = {}) => new URLSearchParams({
    actingSubject: person.actingSubject!, ...fields,
  });
  await answer(sample('library-session-agent-profile', 'GET',
    `/v1/agents/${short(person.actingSubject!)}?${query()}`));
  const year = String(new Date().getUTCFullYear());
  await Promise.all([
    (async () => {
      let cursor: string | null = null;
      for (let page = 0; page < 5; page++) {
        const shelves = await answer<{ nextCursor: string | null }>(sample(
          page ? `library-custom-shelves-page-${page + 1}` : 'library-custom-shelves', 'GET',
          `/v1/me/shelves?${query({ limit: '20', ...(cursor ? { cursor } : {}) })}`));
        cursor = shelves.nextCursor;
        if (!cursor) break;
      }
    })(),
    answer(sample('library-visibility', 'GET',
      `/v1/agents/${short(person.actingSubject!)}/library-visibility`)),
    // readOverview deliberately reads the global question without the session bearer.
    answer(recording.session(name, sessions.visitor)('library-rating-context', 'GET',
      '/v1/rating-contexts?scope=global&limit=1')),
    answer(sample('library-yearly-goal', 'GET', `/v1/me/reading-goal?${query({ year })}`)),
    answer(sample('library-reading-year', 'GET', `/v1/me/reading-stats?${query({ year })}`)),
    (async () => {
      let nextCursor: string | null = null;
      for (let page = 0; ; page++) {
        const shelf = await answer<{ items: { work: string; card: unknown }[]; nextCursor: string | null }>(sample(
          page ? `library-watching-shelf-page-${page + 1}` : 'library-watching-shelf', 'GET',
          `/v1/me/shelves/status/reading/works?${query({ sort: 'added', order: 'desc', limit: '20',
            ...(nextCursor ? { cursor: nextCursor } : {}) })}`));
        const works = shelf.items.filter(item => item.card).map(item => item.work);
        await Promise.all([
          (async () => {
            if (works.length) {
              await answer(sample(page ? `library-work-states-page-${page + 1}` : 'library-work-states', 'GET',
                `/v1/me/work-states?${new URLSearchParams({ works: works.join(','), actingSubject: person.actingSubject! })}`));
            }
          })(),
          ...works.map(async (work, index) => {
            const label = `${page ? `library-page-${page + 1}` : 'library'}-work-${index + 1}`;
            const resume = await answer<{ unreadCount?: { kind: string } }>(sample(`${label}-continue`, 'GET',
              `/v1/me/continue/${short(work)}?${query()}`));
            if (resume.unreadCount?.kind === 'exact') {
              await answer(sample(`${label}-header`, 'GET', `/v1/works/${short(work)}?${query()}`));
            }
          }),
        ]);
        nextCursor = shelf.nextCursor;
        if (!nextCursor) break;
      }
    })(),
  ]);
}

/** Transport only: production owns paths, serialization, versions and command keys. */
async function productionVisit(name: PersonaName, person: PersonaSession, sample: Sample) {
  const labels = new AsyncLocalStorage<(method: string, url: URL) => string>();
  const named = <T,>(label: string, run: () => Promise<T>) => labels.run(() => label, run);
  const routed = <T,>(names: Record<string, string>, run: () => Promise<T>) => labels.run((method, url) => {
    const route = Object.keys(names).find(route => route.startsWith(`${method} `) && url.pathname.endsWith(route.slice(method.length + 1)));
    if (!route) throw new Error(`Production request has no fixed label: ${method} ${url.pathname}`);
    return names[route]!;
  }, run);
  const client = (anonymous = false) => browserMainApi('http://record.invalid', { fetcher: (async (input, init) => {
    const url = new URL(String(input)), method = init?.method ?? 'GET';
    const label = labels.getStore()?.(method, url);
    if (!label) throw new Error(`Production request has no label: ${method} ${url.pathname}`);
    const body = init?.body === undefined ? undefined : JSON.parse(String(init.body));
    const key = new Headers(init?.headers).get('idempotency-key') ?? undefined;
    return (anonymous ? recording.session(name, sessions.visitor) : sample)(
      label, method, url.pathname.replace(/^\/api\/main/, '') + url.search, body, key);
  }) as typeof fetch });
  const main = client(), publicMain = client(true), agent = person.actingSubject!;
  const official = named('frame-official-zones', () => publicMain.v1.zones.get({ query: { official: 'true', limit: 6 } }))
    .then(zones => Promise.all((zones.data?.items.slice(0, 6) ?? []).map(zone =>
      named(`frame-official-realm-${short(zone.realm)}`, () => publicMain.v1.realms({ realm: short(zone.realm) }).get()))));
  await Promise.all([
    libraryVisit(name, person, sample),
    named('frame-platform-access', () => main.v1.me['platform-access'].get()),
    named('frame-type-registry', () => publicMain.v1.types.get()),
    official,
    ...name === 'visitor' ? [] : [
      named('frame-person-preferences', () => main.v1.me['person-preferences'].get({ query: { actingSubject: agent } })),
      named('frame-pinned-follows', () => main.v1.me.follows.get({ query: { actingSubject: agent, limit: 20, order: 'pinned', include: 'newSince' } })),
      named('frame-space-follows', () => main.v1.me.follows.get({ query: { actingSubject: agent, limit: 20, kind: 'space', order: 'recent', include: 'newSince' } })),
      named('frame-follow-inventory', () => main.v1.me.follows.get({ query: { actingSubject: agent, limit: 20 } })),
      named('frame-managed-realms', () => main.v1.me['managed-realms'].get({ query: { actingSubject: agent } })),
      named('frame-notification-unread-count', () => main.v1.me.notifications['unread-count'].get()),
    ],
  ]);
  // The visitor is redirected by LibraryRoute; no private Library or Work control is reached.
  if (name === 'visitor') return;
  await named('library-production-custom-shelves', () => readCustomShelves(main, agent));
  const id = short(show.work), query = { actingSubject: agent };
  const contextsRead = named('work-rating-contexts', () => main.v1.resources({ resource: id })['rating-contexts'].get({ query: { ...query, scope: 'global' } }));
  const projectionRead = named('work-resource-page', () => readResourcePage(main, agent, id));
  const [projection, contexts] = await Promise.all([
    projectionRead, contextsRead,
    named('work-header', () => main.v1.works({ id }).get({ query })),
    named('work-reader-state', () => main.v1.works({ id })['reader-state'].get({ query })),
    named('work-agent-credits', () => readAnimeAgentCredits(main, agent, id)),
    named('work-credits-query', () => readAnimeWorkCredits(main, agent, id)),
    named('work-showcase', () => publicMain.v1.resources.showcase.post({ profile: 'work-showcase-batch-v1', targets: [show.work] })),
    named('work-rating-populations', () => main.v1['rating-populations'].get({ query: { limit: 20, target: show.work, ...query } })),
  ]);
  const context = contexts.data?.items[0]?.context;
  const plan = hubPlan(projection.ok ? projection.data : null);
  const tracking = mainTrackingApi(agent, () => main), episodes = mainEpisodeApi(agent, () => main);
  const standing = (phase: 'work' | 'watched' | 'cleared') => routed({
    'GET /parts': `${phase}-episode-structure`,
    [`GET /compositions/${short(structure)}`]: `${phase}-episode-page`,
    [`GET /reading-positions/${id}`]: `${phase}-episode-resume`,
  }, () => standingOf(episodes, show.work));
  const episodeStanding = plan.includes('parts') ? standing('work') : Promise.resolve(null);
  await Promise.all([
    named('work-rating-summary', () => main.v1.resources({ resource: id }).ratings.get({ query: { ...query, scope: 'global', context } })),
    named('work-reader-statistics', () => main.v1.works({ id })['reader-stats'].get({ query: { ...query, context } })),
    ...plan.includes('availability') ? [
      named('work-availability-realizations', () => main.v1.works({ id }).realizations.get({ query: { ...query, limit: 20 } })),
      named('work-availability-releases', () => main.v1.works({ id }).releases.get({ query: { limit: 20, ...query } })),
      named('work-availability-parts', () => main.v1.resources({ resource: id }).parts.get({ query: { ...query, limit: 1 } })),
    ] : [],
    ...plan.includes('parts') ? [
      named('work-preview-parts', () => main.v1.resources({ resource: id }).parts.get({ query: { ...query, limit: PREVIEW_COUNTS.parts + 1 } })),
      named('work-preview-wholes', () => main.v1.resources({ resource: id }).wholes.get({ query: { ...query, limit: PREVIEW_COUNTS.wholes } })),
      named('work-preview-relations', () => main.v1.resources({ resource: id }).relations.get({ query: { ...query, limit: 20 } })),
      named('panel-work-types', () => tracking.media!.types(show.work)).then(() =>
        named('panel-progress-structure', () => tracking.episodes!.structure(show.work))),
      Promise.all([
        named('panel-edition-preference', () => tracking.preference(show.work)),
        routed({ 'GET /realizations': 'panel-realizations', 'GET /releases': 'panel-releases' }, () => tracking.editions(show.work)),
        named('panel-relations', () => tracking.relations(show.work)),
        named('panel-equivalence-definition', () => tracking.definition('correspondence-equivalent')),
      ]).then(() => named('panel-series-progress', () => tracking.series(show.work, 'en'))),
      episodeStanding,
    ] : [],
    ...projection.ok ? projection.data.sections.flatMap(section => {
      if (section.id === 'statements') return [named('work-linked-statements', () => followHref(main, section.href, query)())];
      if (section.id === 'discussion') return [named('work-linked-discussion', () => followHref(main, section.href, query)())];
      return [];
    }) : [],
    ...plan.includes('about') ? [named('work-classifications', () => main.v1.works({ id }).classifications.get({ query: { ...query, scope: 'global' } }))] : [],
    ...plan.includes('ratings') && context ? [named('work-reviews', () => main.v1.resources({ resource: id }).reviews.get({ query: { context, sort: 'helpful', limit: 10, ...query } }))] : [],
    ...plan.includes('lists') ? [named('work-also-enjoyed', () => main.v1.works({ id })['also-enjoyed'].get({ query: { ...query, limit: 12 } }))] : [],
    ...plan.includes('lists') || plan.includes('discussion') ? [named('work-adoptions-query', () => main.v1.query.post({
      profile: 'template-query-v1', query: 'https://rezics.com/query/work-adoptions', revision: 1,
      parameters: { roots: [show.work] }, presentation: { actingSubject: agent },
    }))] : [],
  ]);
  if (!plan.includes('parts')) return;
  // Episode 2 is untouched by the proof, and all proof assertions have finished.
  const loaded = await episodeStanding;
  const episode = loaded?.ok ? loaded.data?.mains.items[1] : undefined;
  const store = createReaderStore({ actingSubject: agent, main: () => main });
  // Read would project completion onto episode 3, which later proof personas inspect.
  await routed({ 'GET /reader-state': 'status-control-reader-state', 'PUT /reader-status': 'status-control-write' },
    () => store.setStatus(show.work, 'want-to-read'));
  await Promise.all([
    named('status-series-refresh', () => tracking.series(show.work, 'en')),
    named('status-navigation-refresh', () => main.v1.me.follows.get({ query: { actingSubject: agent, limit: 20 } })),
  ]);
  if (!episode) throw new Error('Production episode chooser did not reach episode 2');
  await named('episode-select-progress', () => episodes.progress(episode));
  const watched = await routed({ 'GET /progress': 'episode-watched-before-write', 'PUT /progress': 'episode-watched-write' },
    () => episodes.mark(episode, { completed: true, position: markPosition(episode) }));
  if (!watched.ok) throw new Error(`Production episode mark failed: ${watched.failure}`);
  await standing('watched');
  // The control omits position; episode-api carries Main's current position into the PUT.
  const cleared = await routed({ 'GET /progress': 'episode-cleared-before-write', 'PUT /progress': 'episode-cleared-write' },
    () => episodes.mark(episode, { completed: false }));
  if (!cleared.ok) throw new Error(`Production episode clear failed: ${cleared.failure}`);
  await standing('cleared');
}

const qualification: { persona: string; passed: boolean; error?: string }[] = [];
async function within<T>(milliseconds: number, part: string, run: () => Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([run(), new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${part} exceeded ${milliseconds} ms`)), milliseconds);
    })]);
  } finally { clearTimeout(timer); }
}
async function qualify(name: PersonaName) {
  const started = Date.now();
  let proofMs = 0, visitStarted = 0;
  try {
    // The API proof owns its original 90 s; production recording has a separate 120 s afterwards.
    await within(90_000, 'API proof', () => journey(name));
    proofMs = Date.now() - started;
    visitStarted = Date.now();
    await within(120_000, 'production recording', async () => {
      const person = sessions[name], sample = recording.session(name, person);
      await productionVisit(name, person, sample);
    });
    qualification.push({ persona: name, passed: true });
  } catch (error) {
    qualification.push({ persona: name, passed: false, error: String(error) });
    throw error;
  } finally {
    console.info(`[persona-timing] ${name} proofMs=${proofMs || Date.now() - started} visitMs=${visitStarted ? Date.now() - visitStarted : 0}`);
    await Bun.write(`.temp/anime-collection-tracking-and-progress-qualification-${Bun.env.REZICS_QA_RUN_ID}.json`,
      JSON.stringify({ preparation, qualification, failures }, null, 2));
  }
}
outcomeTest(row, 'visitor', () => qualify('visitor'), recording);
outcomeTest(row, 'stranger', () => qualify('stranger'), recording);
outcomeTest(row, 'member', () => qualify('member'), recording);
outcomeTest(row, 'owner', () => qualify('owner'), recording);
outcomeTest(row, 'moderator', () => qualify('moderator'), recording);
outcomeTest(row, 'operator', () => qualify('operator'), recording);


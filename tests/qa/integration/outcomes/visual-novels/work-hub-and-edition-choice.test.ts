import { afterAll, beforeAll, expect, setDefaultTimeout } from 'bun:test';
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { BFF_PREFIX, browserMainApi } from '../../../../../apps/web/features/api/browser.ts';
import { mainTrackingApi } from '../../../../../apps/web/features/tracking/api.ts';
import { readAnimeReaderState, readLinkedStatements, readResourcePage, readWorkParts, readWorkRealizations } from '../../../../../apps/web/features/work-page/anime-hub-recorded-page.ts';
import { PREVIEW_COUNTS } from '../../../../../apps/web/features/work-levels/previews.tsx';
import { discoveryApi } from '../../../../../apps/web/features/discover/api.ts';
import { followHref } from '../../../../../apps/web/features/entity-page/href.ts';
import { booksEditionReads } from '../../../../../apps/web/features/work-page/books-edition-page.read.ts';
import hub from '../../../../../scripts/qa/cases/outcomes/visual-novels/work-hub-and-edition-choice.ts';
import { OutcomeRecorder, outcomeTest } from '../../../support/outcome-test.ts';
import { personaSessions, type PersonaName, type PersonaSession, type PersonaSessions } from '../../../support/personas.ts';

setDefaultTimeout(185_000);
const proofDeadlineMs = 60_000; // The original persona proof owns these 60 seconds.
const visitDeadlineMs = 120_000;
let fileWall: ReturnType<typeof setTimeout>;
async function withinDeadline(part: string, milliseconds: number, run: () => Promise<void>) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([run(), new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${part} exceeded ${milliseconds} ms`)), milliseconds);
    })]);
  } finally { clearTimeout(timer); }
}
const short = (id: string) => id.slice(-36);
const native = () => `https://rezics.com/id/${randomUUID()}`;
let sessions: PersonaSessions;
const recording = new OutcomeRecorder(hub);
let work: { work: string; mainVersion: string };
let realization: { resource: string; revision: string };
let releases: Array<{ resource: string; revision: string; title: string }> = [];
let visitFixture: Awaited<ReturnType<typeof seedHub>>;
const query = (person: PersonaSession) => `actingSubject=${encodeURIComponent(person.actingSubject!)}`;
async function answer<T>(request: Promise<Response>, status = 200): Promise<T> {
  const response = await request;
  const raw = await response.text();
  expect(response.status, `${response.status}: ${raw}`).toBe(status);
  return JSON.parse(raw) as T;
}

beforeAll(async () => {
  fileWall = setTimeout(() => { throw new Error('Work hub file exceeded 480000 ms'); }, 480_000);
  sessions = await personaSessions('public');
  await recording.prepare();
  for (const name of Object.keys(sessions) as PersonaName[]) {
    const person = sessions[name];
    if (!person || typeof person.main !== 'function') continue;
    const send = person.main;
    person.main = async (...args) => {
      const started = performance.now();
      try { return await send(...args); }
      finally {
        const elapsed = Math.round(performance.now() - started);
        if (elapsed >= 1_000) console.info(`[persona-request] ${name} ${args[0]} ${args[1]} ${elapsed} ms`);
      }
    };
  }
  ({ work, realization, releases } = await seedHub(sessions.owner));
  // The proof changes private preferences. A separate fixture lets the later
  // production visit start empty without undoing any proved state.
  visitFixture = await seedHub(sessions.owner);
}, 180_000);
afterAll(async () => {
  try { await recording.publish(); }
  finally { clearTimeout(fileWall); await sessions?.close(); }
});

async function seedHub(owner: PersonaSession) {
  let work: { work: string; mainVersion: string };
  let realization: { resource: string; revision: string };
  const releases: Array<{ resource: string; revision: string; title: string }> = [];
  const actingSubject = owner.actingSubject;
  work = await answer(owner.main('POST', '/v1/works', {
    profile: 'metadata-only-v1', title: 'Lantern Orchard', language: 'en',
    semanticTypes: ['https://schema.org/VideoGame'], authoring: 'own-work', actingSubject,
  }), 201);
  const draft = await answer<{ contribution: string; draftRevision: string }>(owner.main('POST', '/v1/contributions', {
    profile: 'text-contribution-v1', work: work.work, language: 'en',
    body: 'An original visual novel: Mira lights the orchard lanterns and chooses which path leads home.', actingSubject,
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
  const resource = native();
  const text = await answer<{ revision: string }>(owner.main('PUT', `/v1/works/${short(work.work)}/realizations/${short(resource)}`, {
    profile: 'realization-v1', id: resource, expectedHead: null, actingSubject,
    language: 'en', kind: 'original', translators: [], publishers: [],
    source: { kind: 'unresolved', work: work.work }, status: 'official', verification: 'verified', evidence: native(),
  }));
  realization = { resource, revision: text.revision };
  for (const platform of ['Windows', 'Linux']) {
    const id = native();
    const title = `Lantern Orchard ${platform}`;
    const saved = await answer<{ revision: string }>(owner.main('PUT', `/v1/works/${short(work.work)}/releases/${short(id)}`, {
      profile: 'release-v2', id, expectedHead: null, actingSubject, kind: 'formal', status: 'official',
      titleLanguage: 'en', tracklistLanguage: null, title: { value: title, language: 'en' },
      editionStatement: null, publisher: 'Original fixture author', publicationYear: 2026, isbn13: null,
      originalUrl: null, fixedRelease: null, identifiers: [], platform, territory: null,
      coverage: [{ realization: resource, revision: text.revision, completeness: 'complete' }], evidence: null,
    }));
    releases.push({ resource: id, revision: saved.revision, title });
  }
  return { work, realization, releases };
}

type Preference = { work: string; language: string; edition: { kind: string; resource: string; revision: string }; version: number; changedAt: string; replayed?: boolean };

// Proof requests remain independent of the production visit record.
const unrecordedSample = (person: PersonaSession) => (_label: string, ...args: Parameters<PersonaSession['main']>) => person.main(...args);
function proofSession(name: PersonaName): PersonaSession { return sessions[name]; }

// Work overview, frame and availability reads from work-page and work-levels.
async function pageReads(name: PersonaName) {
  const person = sessions[name];
  const sample = unrecordedSample(person);
  const id = short(work.work);
  const viewer = (path: string) => person.actingSubject
    ? `${path}${path.includes('?') ? '&' : '?'}${query(person)}` : path;
  const read = <T,>(label: string, path: string) => answer<T>(sample(label, 'GET', viewer(path)));
  const readBatch = async (requests: Array<[string, string]>) => {
    for (let offset = 0; offset < requests.length; offset += 3) {
      const results = await Promise.allSettled(requests.slice(offset, offset + 3).map(([label, path]) => read(label, path)));
      for (const result of results) if (result.status === 'rejected') throw result.reason;
    }
  };
  const projection = await read<{ sections: Array<{ id: string; href: string }> }>('hub-projection', `/v1/resources/${id}/page`);
  for (const section of projection.sections.filter(section => ['statements', 'relations', 'discussion', 'lists'].includes(section.id))) {
    await read(`hub-${section.id}`, section.href);
  }
  for (const template of ['work-credits', 'work-adoptions', 'work-versions']) {
    await answer(sample(`hub-${template}`, 'POST', '/v1/query', {
      profile: 'template-query-v1', query: `https://rezics.com/query/${template}`, revision: 1,
      parameters: { roots: [work.work], ...(template === 'work-versions' ? { kind: 'text-variant' } : {}) },
      presentation: { ...(person.actingSubject ? { actingSubject: person.actingSubject } : {}) },
    }));
  }
  await readBatch([
    ['hub-agent-credits', `/v1/works/${id}/agent-credits`],
    ['hub-author-profile', `/v1/agents/${short(sessions.owner.actingSubject!)}`],
    ['hub-author-works', `/v1/agents/${short(sessions.owner.actingSubject!)}/works?limit=12`],
    ['hub-classifications', `/v1/works/${id}/classifications?scope=global`],
  ]);
  await answer(sample('hub-facet-labels', 'GET', '/v1/facets'));
  if (person.actingSubject) await answer(sample('hub-platform-access', 'GET', '/v1/me/platform-access'));
  const contexts = await read<{ items: Array<{ context: string }> }>('hub-rating-contexts', `/v1/resources/${id}/rating-contexts?scope=global`);
  const context = contexts.items[0]?.context;
  const contextQuery = context ? `&context=${encodeURIComponent(context)}` : '';
  await readBatch([
    ['hub-ratings', `/v1/resources/${id}/ratings?scope=global${contextQuery}`],
    ['hub-reader-stats', `/v1/works/${id}/reader-stats?${contextQuery.slice(1)}`],
    ['hub-rating-populations', `/v1/rating-populations?target=${encodeURIComponent(work.work)}&limit=20`],
    ['hub-also-enjoyed', `/v1/works/${id}/also-enjoyed?limit=12`],
    ['hub-realizations', `/v1/works/${id}/realizations?limit=20`],
    ['hub-releases', `/v1/works/${id}/releases?limit=20`],
  ]);
  if (context) await read('hub-reviews-empty', `/v1/resources/${id}/reviews?context=${encodeURIComponent(context)}&sort=helpful&limit=10`);
  await answer(sample('hub-parts-unavailable', 'GET', viewer(`/v1/resources/${id}/parts?limit=1`)), 404);
  await answer(sample('hub-parts-preview-unavailable', 'GET', viewer(`/v1/resources/${id}/parts?limit=7`)), 404);
  const wholes = await sample('hub-wholes-empty', 'GET', viewer(`/v1/resources/${id}/wholes?limit=3`));
  expect([200, 404]).toContain(wholes.status);
  await wholes.body?.cancel();
  await read('hub-relations-empty', `/v1/resources/${id}/relations?limit=20`);
  const contents = await sample('hub-contents', 'GET', viewer(`/v1/works/${id}/contents`));
  expect([200, 404]).toContain(contents.status);
  await contents.body?.cancel();
  if (person.actingSubject) {
    await read('hub-reader-state-empty', `/v1/works/${id}/reader-state`);
    await read(name === 'member' || name === 'stranger' ? 'hub-progress-empty' : 'hub-progress-saved',
      `/v1/me/progress-summaries/${id}?language=en`);
    await read('hub-continue-empty', '/v1/me/continue?limit=6');
  }
  await answer(sample('hub-selected-text', 'GET', `/v1/main-versions/${short(work.mainVersion)}/selection?language=en`));
  await answer(sample('hub-showcase-empty', 'POST', '/v1/resources/showcase', { profile: 'work-showcase-batch-v1', targets: [work.work] }));
}

// These are the bounded reads PrimaryAction and Availability actually send.
// The member's initial page proof already supplies its inventory and start reads.
async function chooserReads(name: PersonaName) {
  const person = sessions[name];
  const sample = unrecordedSample(person);
  const id = short(work.work);
  const viewer = (path: string) => person.actingSubject
    ? `${path}${path.includes('?') ? '&' : '?'}${query(person)}` : path;
  if (name !== 'member') {
    for (const kind of ['releases', 'realizations']) {
      const page = await answer<{ items: Array<{ id: string }> }>(sample(`chooser-${kind}`, 'GET',
        viewer(`/v1/works/${id}/${kind}?limit=20`)));
      expect(page.items.map(item => item.id).sort()).toEqual(kind === 'releases'
        ? releases.map(item => item.resource).sort() : [realization.resource]);
    }
    expect(await answer(sample('chooser-parts', 'GET', viewer(`/v1/resources/${id}/parts?limit=1`)), 404))
      .toMatchObject({ code: expect.any(String) });
    if (person.actingSubject) {
      expect(await answer(sample('chooser-continue', 'GET', viewer('/v1/me/continue?limit=6'))))
        .toMatchObject({ items: [] });
    }
    const contents = await sample('chooser-contents', 'GET', viewer(`/v1/works/${id}/contents`));
    expect([200, 404]).toContain(contents.status);
    const body = await contents.json();
    expect(body).toMatchObject(contents.status === 200 ? { items: [] } : { code: expect.any(String) });
  }
  if (person.actingSubject) {
    if (name === 'stranger') {
      expect(await answer(sample('chooser-preference-empty', 'GET', viewer(`/v1/me/edition-preferences/${id}`))))
        .toBeNull();
    }
    if (name !== 'member') {
      expect(await answer(sample('chooser-progress-empty', 'GET', viewer(`/v1/me/progress-summaries/${id}?language=en`))))
        .toMatchObject({ preference: null });
    }
  }
}

// A lexical label follows concurrent client calls through their asynchronous transport.
function productionClient(name: PersonaName, record = true) {
  const person = sessions[name];
  const sample = record ? recording.session(name, { main: async (...args) => {
    const response = await person.main(...args);
    if (response.status >= 500) console.error(`[production-final] ${name} ${args[0]} ${args[1]} ${response.status}: ${await response.clone().text()}`);
    return response;
  } }) : unrecordedSample(person);
  const labels = new AsyncLocalStorage<string | Record<string, string>>();
  const main = browserMainApi('https://recorded.invalid', { anonymous: !person.actingSubject,
    fetcher: (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      const path = url.pathname.slice(BFF_PREFIX.length) + url.search;
      const context = labels.getStore();
      const label = typeof context === 'string' ? context : context?.[url.pathname.split('/').at(-1)!];
      if (!label) throw new Error(`Production request has no lexical label: ${path}`);
      const headers = new Headers(init?.headers);
      return sample(label, init?.method ?? 'GET', path,
        init?.body ? JSON.parse(String(init.body)) : undefined, headers.get('idempotency-key') ?? undefined);
    }) as typeof fetch,
  });
  return { main, read: <T,>(label: string | Record<string, string>, call: () => Promise<T>): Promise<T> => labels.run(label, call) };
}

async function productionVisit(name: PersonaName) {
  const transport = productionClient(name);
  const { main, read } = transport;
  const actingSubject = sessions[name].actingSubject ?? undefined;
  const { work, realization, releases } = visitFixture;
  const id = short(work.work);
  const books = booksEditionReads({ main, actingSubject });
  const render = async (phase: string) => {
    const read = <T,>(label: string, call: () => Promise<T>) => transport.read(phase === 'visit'
      ? label === 'work-header' ? 'primary-get-works-0'
        : label === 'releases' || label === 'realizations'
          ? `${name === 'member' ? 'hub' : 'chooser'}-${label}`
          : `hub-${label}`
      : `${phase}-${label}`, call);
    // All empty namesOf calls share the request-cached readNames('') answer.
    let names: Promise<unknown> | undefined;
    const emptyNames = () => names ??= read('empty-names', () => main.v1.resources.summaries.post({
      profile: 'resource-summary-batch-v1', resources: [], actingSubject }));
    const header = await read('work-header', () => books.readWorkHeader(id));
    if (!header.ok) return;
    // /w/[ref]/(work)/layout and overview stream their regions together. The
    // request-cached header, projection and inventory are shared by those regions.
    const [projection, credits, contexts] = await Promise.all([
      read('projection', () => readResourcePage(main, actingSubject, id)),
      read('agent-credits', () => books.readAgentCredits(id)),
      read('rating-contexts', () => main.v1.resources({ resource: id })['rating-contexts'].get({ query: { actingSubject, scope: 'global' } })),
      read('work-credits', () => books.readCredits(id)),
      read('reader-state', () => readAnimeReaderState(main, actingSubject, id)),
      read('showcase', () => main.v1.resources.showcase.post({ profile: 'work-showcase-batch-v1', targets: [work.work] })),
      read('adoptions', () => books.readAdoptions(id)),
      read('classifications', () => books.readClassifications(id, { kind: 'global' })),
      read('facets', () => books.readFacets()),
      read('rating-populations', () => discoveryApi(main, 'en', actingSubject).populations(work.work, { limit: 20 })),
      read('also-enjoyed', () => books.readAlsoEnjoyed(id)),
      read('releases', () => books.readReleases(id)),
      read('realizations', () => readWorkRealizations(main, actingSubject, id)),
      read('availability-parts', () => readWorkParts(main, actingSubject, id, { limit: 1 })),
      read('preview-parts', () => readWorkParts(main, actingSubject, id, { limit: PREVIEW_COUNTS.parts + 1 })).then(() =>
        emptyNames()),
      read('preview-wholes', () => main.v1.resources({ resource: id }).wholes.get({ query: { actingSubject, limit: PREVIEW_COUNTS.wholes } })).then(() =>
        emptyNames()),
      read('preview-relations', () => main.v1.resources({ resource: id }).relations.get({ query: { actingSubject, limit: 20 } })),
      actingSubject ? read('platform-access', () => main.v1.me['platform-access'].get()) : Promise.resolve(null),
      actingSubject ? read('follow-state', () => main.v1.me['follow-state'].get({ query: { actingSubject, target: work.work, kind: 'work' } })) : Promise.resolve(null),
    ]);
    const context = contexts.data?.items[0]?.context;
    await Promise.all([
      read('ratings', () => main.v1.resources({ resource: id }).ratings.get({ query: { actingSubject, scope: 'global', context } })),
      read('reader-stats', () => main.v1.works({ id })['reader-stats'].get({ query: { actingSubject, context } })),
      ...(credits.ok ? [...new Set(credits.data.items.filter(item => item.role === 'author').map(item => item.agent))].map(agent =>
        Promise.all([
          read('author-works', () => main.v1.agents({ id: short(agent) }).works.get({ query: { actingSubject, limit: 12 } })),
        ])) : []),
      ...(projection.ok ? projection.data.sections.filter(section => ['statements', 'discussion'].includes(section.id)).map(section =>
        section.id === 'statements'
          ? Promise.all([read('facts-statements', () => readLinkedStatements(main, actingSubject, section.href)),
            read('wiki-statements', () => readLinkedStatements(main, actingSubject, section.href))])
          : read('discussion', () => followHref(main, section.href, { actingSubject })())) : []),
      ...(context ? [read('review-releases', () => books.readReleases(id)),
        read('review-realizations', () => readWorkRealizations(main, actingSubject, id)),
        read('reviews', () => main.v1.resources({ resource: id }).reviews.get({ query: { context, sort: 'helpful', limit: 10, actingSubject } })),
        read('review-relations', () => main.v1.resources({ resource: id }).relations.get({ query: { actingSubject, limit: 32 } })).then(() =>
          emptyNames())] : []),
    ]);
  };
  await render('visit');
  // YourEdition and SeriesProgressPanel use the signed-in reader's own client.
  // There is no foreign-preference form, and signed-out controls link to sign-in.
  if (!actingSubject) return;
  const api = mainTrackingApi(actingSubject, () => main);
  const preferenceLabel = name === 'stranger' ? 'chooser-preference-empty' : 'primary-get-me-edition-preferences-1';
  const [preference] = await Promise.all([
    read(preferenceLabel, () => api.preference(work.work)),
    read({ realizations: 'visit-chooser-realizations', releases: 'visit-chooser-releases' }, () => api.editions(work.work)),
    read('visit-series-preference', () => api.preference(work.work)),
    read({ realizations: 'visit-series-realizations', releases: 'visit-series-releases' }, () => api.editions(work.work)),
    read('visit-series-relations', () => api.relations(work.work)),
    read('hub-correspondence-definition', () => api.definition('correspondence-equivalent')),
  ]);
  if (!preference.ok) return;
  const originalVersion = preference.data?.version ?? 0;
  await read(name === 'member' ? 'hub-progress-empty' : 'chooser-progress-empty',
    () => api.series(work.work, preference.data?.language ?? 'en'));
  if (name === 'member') {
    // Returning to the same hub in Chinese changes the content-language fallback.
    await render('locale-zh-Hans');
    await read('hub-progress-empty-zh-Hans', () => books.readProgressSummary(id, 'zh-Hans'));
  }
  // Foreign preferences have no production page: never forge a foreign actor
  // request to manufacture the proof's denial in the page record.
  if (name === 'stranger') return;
  const release = { kind: 'release' as const, resource: releases[0]!.resource, revision: releases[0]!.revision };
  const saved = await read('primary-put-me-edition-preferences-1', () => api.setPreference(work.work,
    originalVersion, { language: 'en', edition: release }));
  if (!saved.ok) return;
  await Promise.all([
    read('saved-release-detail', () => api.edition(work.work, release)),
    read('chooser-progress-release', () => api.series(work.work, 'en')),
    render('release-refresh'),
  ]);
  // Return after saving: the chooser reads the committed choice, while a
  // second already-open chooser retains the version it originally displayed.
  const returned = await read('primary-get-me-edition-preferences-2', () => api.preference(work.work));
  if (!returned.ok) return;
  const chosen = { kind: 'realization' as const, ...realization };
  const stale = await read('primary-put-me-edition-preferences-3', () => api.setPreference(work.work,
    originalVersion, { language: 'en', edition: chosen }));
  if (stale.ok || stale.failure !== 'stale') return;
  const changed = await read('primary-put-me-edition-preferences-4', () => api.setPreference(work.work,
    stale.current?.version ?? 0, { language: 'en', edition: chosen }));
  if (!changed.ok) return;
  await Promise.all([
    read('saved-realization-detail', () => api.edition(work.work, chosen)),
    read('primary-get-me-progress-summaries-0', () => api.series(work.work, 'en')),
    render('realization-refresh'),
  ]);
  await read('primary-get-me-edition-preferences-3', () => api.preference(work.work));
  // mainTrackingApi generates a fresh command key per invocation. It has no
  // same-key retry entry point, so the proof's replay is not a production sample.

}

async function choice(name: PersonaName) {
  if (name === 'member') {
    await pageReads(name);
    // This sample must precede the proof's preference writes to keep the empty choice exact.
    const { main, read } = productionClient(name, false);
    const reads = booksEditionReads({ main, actingSubject: sessions[name].actingSubject! });
    await read('hub-progress-empty-zh-Hans', () => reads.readProgressSummary(short(work.work), 'zh-Hans'));
  }
  await chooserReads(name);
  const person = proofSession(name);
  const root = `/v1/works/${short(work.work)}`;
  const publicQuery = person.actingSubject ? query(person) : '';
  expect(await answer(person.main('GET', `${root}?${publicQuery}`))).toMatchObject({ id: work.work, title: { value: 'Lantern Orchard' } });
  const credits = await answer<{ items: Array<{ role: string; agent: string }> }>(person.main('GET', `${root}/credits?${publicQuery}`));
  expect(credits.items).toContainEqual(expect.objectContaining({ role: 'author', agent: sessions.owner.actingSubject }));
  expect(await answer(person.main('GET', `${root}/editions?${publicQuery}`))).toMatchObject({ items: [], nextCursor: null });
  const seen: Array<{ id: string; revision: string; title: { value: string } }> = [];
  let after: string | null = null;
  do {
    const page: { items: typeof seen; nextCursor: string | null } = await answer(person.main('GET', `${root}/releases?limit=1&${publicQuery}${after ? `&cursor=${encodeURIComponent(after)}` : ''}`));
    seen.push(...page.items);
    after = page.nextCursor;
  } while (after);
  expect(seen.map(item => item.id).sort()).toEqual(releases.map(item => item.resource).sort());
  for (const release of releases) expect(seen).toContainEqual(expect.objectContaining({ id: release.resource, revision: release.revision, title: expect.objectContaining({ value: release.title }) }));
  const path = `/v1/me/edition-preferences/${short(work.work)}`;
  const victim = name === 'owner' ? sessions.member : sessions.owner;
  const pin = { kind: 'release', resource: releases[0]!.resource, revision: releases[0]!.revision };
  if (name === 'visitor') {
    await answer(person.main('GET', `${path}?${query(victim)}`), 401);
    await answer(person.main('PUT', path, { actingSubject: victim.actingSubject, expectedVersion: 0, language: 'en', edition: pin }), 401);
    expect(await answer(victim.main('GET', `${path}?${query(victim)}`))).toBeNull();
    return;
  }
  const before = await answer(victim.main('GET', `${path}?${query(victim)}`));
  expect(await answer<{ code: string }>(person.main('GET', `${path}?${query(victim)}`), 403)).toMatchObject({ code: 'progress_denied' });
  await answer(person.main('PUT', path, { actingSubject: victim.actingSubject, expectedVersion: 0, language: 'en', edition: pin }), 403);
  expect(await answer(victim.main('GET', `${path}?${query(victim)}`))).toEqual(before);
  if (name === 'stranger') return;
  expect(await answer(person.main('GET', `${path}?${query(person)}`))).toBeNull();
  const body = { actingSubject: person.actingSubject, expectedVersion: 0, language: 'en', edition: pin };
  const key = `${hub.rowId}:${name}:edition-choice`;
  const saved = await answer<Preference>(person.main('PUT', path, body, key));
  expect(saved).toMatchObject({ work: work.work, edition: pin, language: 'en', version: 1, replayed: false });
  const { replayed: _replayed, ...persisted } = saved;
  expect(await answer(person.main('GET', `${path}?${query(person)}`))).toEqual(persisted);
  expect(await answer(unrecordedSample(sessions[name])('chooser-progress-release', 'GET',
    `/v1/me/progress-summaries/${short(work.work)}?language=en&${query(person)}`)))
    .toMatchObject({ preference: { edition: pin, version: 1 } });
  expect(await answer(person.main('PUT', path, body, key))).toEqual({ ...saved, replayed: true });
  expect(await answer(person.main('PUT', path, { ...body, edition: { kind: 'realization', ...realization } }), 409)).toMatchObject({ code: 'stale_edition_preference', current: persisted });
  const recovered = await answer<Preference>(person.main('PUT', path, { ...body, expectedVersion: 1, edition: { kind: 'realization', ...realization } }));
  expect(recovered).toMatchObject({ edition: { kind: 'realization', ...realization }, version: 2 });
  expect(await answer(person.main('GET', `${path}?${query(person)}`))).toMatchObject({ edition: recovered.edition, version: 2 });
  expect(await answer(person.main('GET', `/v1/me/progress-summaries/${short(work.work)}?language=en&${query(person)}`))).toMatchObject({ preference: { edition: recovered.edition, version: 2 } });
  expect(await answer(victim.main('GET', `${path}?${query(victim)}`))).toEqual(before);
}

async function recordedChoice(name: PersonaName) {
  const started = performance.now();
  let proved: number | undefined;
  try {
    await withinDeadline(`${name} proof`, proofDeadlineMs, () => choice(name));
    proved = performance.now();
    await withinDeadline(`${name} production visit`, visitDeadlineMs, () => productionVisit(name));
  } finally {
    const ended = performance.now();
    console.info(`[work-hub] ${name} proof ${Math.round((proved ?? ended) - started)} ms; visit ${Math.round(proved === undefined ? 0 : ended - proved)} ms`);
  }
}

outcomeTest(hub, 'visitor', () => recordedChoice('visitor'), recording);
outcomeTest(hub, 'stranger', () => recordedChoice('stranger'), recording);
outcomeTest(hub, 'member', () => recordedChoice('member'), recording);
outcomeTest(hub, 'owner', () => recordedChoice('owner'), recording);
outcomeTest(hub, 'moderator', () => recordedChoice('moderator'), recording);
outcomeTest(hub, 'operator', () => recordedChoice('operator'), recording);

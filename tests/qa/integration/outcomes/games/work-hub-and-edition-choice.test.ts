import { afterAll, beforeAll, expect, setDefaultTimeout } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { BFF_PREFIX, browserMainApi } from '../../../../../apps/web/features/api/browser.ts';
import { mainTrackingApi } from '../../../../../apps/web/features/tracking/api.ts';
import { followHref } from '../../../../../apps/web/features/entity-page/href.ts';
import declaration from '../../../../../scripts/qa/cases/outcomes/games/work-hub-and-edition-choice.ts';
import { OutcomeRecorder, outcomeTest } from '../../../support/outcome-test.ts';
import { personaSessions, type PersonaName, type PersonaSession, type PersonaSessions } from '../../../support/personas.ts';

setDefaultTimeout(185_000);
const proofDeadlineMs = 60_000; // The original outcome proof owns these 60 seconds.
const visitDeadlineMs = 120_000;
const fileWall = setTimeout(() => { throw new Error('Work hub file exceeded 480 s'); }, 480_000);
async function within(part: string, milliseconds: number, run: () => Promise<void>) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([run(), new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${part} exceeded ${milliseconds} ms`)), milliseconds);
    })]);
  } finally { clearTimeout(timer); }
}
type Work = { work: string; mainVersion: string };
let sessions: PersonaSessions;
const recording = new OutcomeRecorder(declaration);
// Reuse proof answers when the visit sends exactly the same request. The last
// preference read is the saved answer; no old sample is relabelled or replaced.
const proofAnswers = new Map<string, Response>();
function requestKey(name: PersonaName, method: string, path: string, body?: unknown) {
  const url = new URL(path, 'http://record.invalid');
  url.searchParams.sort();
  return JSON.stringify([name, method, url.pathname, url.searchParams.toString(), body]);
}
function proofSamples(name: PersonaName, person: PersonaSession) {
  const sample = recording.session(name, person);
  return async (label: string, ...args: Parameters<PersonaSession['main']>) => {
    const response = await sample(label, ...args);
    proofAnswers.set(requestKey(name, args[0], args[1], args[2]), response.clone());
    return response;
  };
}
const short = (id: string) => id.slice(-36);
const acting = (person: PersonaSession) => person.actingSubject
  ? `actingSubject=${encodeURIComponent(person.actingSubject)}` : '';
async function answer<T>(request: Promise<Response>, status = 200): Promise<T> {
  const response = await request;
  const raw = await response.text();
  expect(response.status, `${response.status}: ${raw}`).toBe(status);
  return JSON.parse(raw) as T;
}
// Fixture refusal is a setup failure, never an expected pending outcome.
async function fixture<T>(request: Promise<Response>, status = 200): Promise<T> {
  const response = await request;
  const raw = await response.text();
  if (response.status !== status) throw new Error(`Fixture HTTP ${response.status}: ${raw}`);
  return JSON.parse(raw) as T;
}
async function createGame(title: string, semanticType = 'VideoGame'): Promise<Work> {
  return fixture<Work>(sessions.owner.main('POST', '/v1/works', {
    profile: 'metadata-only-v1', title, language: 'en',
    description: { value: 'An original game about planting lights in a synthetic garden.', language: 'en' },
    semanticTypes: [`https://schema.org/${semanticType}`],
    authoring: 'own-work', actingSubject: sessions.owner.actingSubject,
  }), 201);
}
async function publish(game: Work) {
  const owner = sessions.owner;
  const draft = await fixture<{ contribution: string; draftRevision: string }>(
    owner.main('POST', '/v1/contributions', {
      profile: 'text-contribution-v1', work: game.work, language: 'en',
      body: 'Original fixture game: plant a light, visit the garden, and find a new route.',
      actingSubject: owner.actingSubject,
    }), 201);
  const published = await fixture<{ publicationDecision: string }>(
    owner.main('POST', '/v1/contribution-publications', {
      profile: 'text-publication-v1', contribution: draft.contribution,
      expectedDraftHead: draft.draftRevision, expectedPublicationHead: null,
      rightsBasis: 'original-contribution', disclosure: 'public', actingSubject: owner.actingSubject,
    }), 201);
  const selection = { work: game.work, contribution: draft.contribution,
    publicationDecision: published.publicationDecision, expectedSelectionHead: null,
    actingSubject: owner.actingSubject };
  await fixture(owner.main('POST', '/v1/publication-selections', {
    ...selection, profile: 'main-default-selection-v1',
    context: { kind: 'main-version-default', id: game.mainVersion },
    selectionBasis: 'main-maintainer',
  }), 201);
  return selection;
}
async function credit(person: PersonaSession, game: Work, sample: ReturnType<typeof recording.session>) {
  const page = await answer<{ items: { role: string; participantKind: string; agent: string | null }[] }>(
    sample('work-credits', 'GET', `/v1/works/${short(game.work)}/credits?${acting(person)}`));
  expect(page.items).toContainEqual(expect.objectContaining({
    role: 'author', participantKind: 'agent', agent: sessions.owner.actingSubject,
  }));
}
afterAll(async () => {
  try { await recording.publish(); }
  finally { clearTimeout(fileWall); await sessions?.close(); }
});

let game: Work;
let draft: Work;
let release: { release: string; revision: string };
let releaseCommand: object;
beforeAll(async () => {
  sessions = await personaSessions('public');
  await recording.prepare();
  game = await createGame('Original garden game');
  draft = await createGame('Unpublished garden draft');
  await publish(game);
  await fixture(sessions.owner.main('PUT', `/v1/works/${short(game.work)}/metadata`, {
    profile: 'work-metadata-details-v1', expectedHead: null,
    actingSubject: sessions.owner.actingSubject,
    state: { kind: 'header', originalTitle: null, localized: [{
      language: 'en', title: null, mainVersionLabel: null,
      description: 'An original game about planting lights in a synthetic garden.',
    }] },
  }));
  const releaseId = `https://rezics.com/id/${randomUUID()}`;
  releaseCommand = {
    profile: 'release-v1', expectedHead: null, id: releaseId,
    actingSubject: sessions.owner.actingSubject, kind: 'formal', status: 'official',
    contentLanguages: ['en'], isTranslation: false, originalLanguages: [],
    titleLanguage: 'en', tracklistLanguage: null,
    title: { value: 'Garden game desktop release', language: 'en' },
    editionStatement: 'Desktop PC; version 1.0; digital format',
    publisher: null, publicationYear: null, isbn13: null, originalUrl: null,
    fixedRelease: null, coverage: null, evidence: null,
  };
  release = await fixture(sessions.owner.main('PUT',
    `/v1/works/${short(game.work)}/releases/${short(releaseId)}`, releaseCommand));
}, 180_000);

async function hub(name: PersonaName) {
  const person = sessions[name];
  const sample = proofSamples(name, person);
  const root = `/v1/works/${short(game.work)}`;
  const header = await answer<{ id: string; disclosure: string; description: { value: string } | null }>(
    sample('work-header', 'GET', `${root}?${acting(person)}`));
  expect(header).toMatchObject({ id: game.work, disclosure: 'public' });
  expect(header.description?.value).toBe('An original game about planting lights in a synthetic garden.');
  await credit(person, game, sample);
  // This endpoint requires a composition; the published partless game remains readable.
  expect(await answer(sample('partless-parts', 'GET',
    `/v1/resources/${short(game.work)}/parts?${acting(person)}`), 404))
    .toMatchObject({ code: 'work_unavailable' });
  expect(await answer<{ items: unknown[] }>(sample('editions-empty', 'GET',
    `${root}/editions?${acting(person)}`))).toMatchObject({ items: [] });
  const releases = await answer<{ items: { id: string; revision: string; editionStatement: string }[] }>(
    sample('releases', 'GET', `${root}/releases?${acting(person)}`));
  expect(releases.items).toContainEqual(expect.objectContaining({
    id: release.release, revision: release.revision,
    editionStatement: 'Desktop PC; version 1.0; digital format',
  }));
  await answer(sample('release-details', 'GET', `${root}/releases/${short(release.release)}?${acting(person)}`));
  // Match the bounded reads PrimaryAction and non-book Availability send.
  const viewer = (path: string) => person.actingSubject
    ? `${path}${path.includes('?') ? '&' : '?'}${acting(person)}` : path;
  const hubReleases = await answer<{ items: { id: string; revision: string }[] }>(
    sample('hub-releases', 'GET', viewer(`${root}/releases?limit=20`)));
  expect(hubReleases.items).toContainEqual(expect.objectContaining({
    id: release.release, revision: release.revision,
  }));
  expect(await answer(sample('hub-partless-parts', 'GET',
    viewer(`/v1/resources/${short(game.work)}/parts?limit=1`)), 404))
    .toMatchObject({ code: 'work_unavailable' });
  if (name !== 'member') {
    expect(await answer(sample('hub-realizations-empty', 'GET', viewer(`${root}/realizations?limit=20`))))
      .toMatchObject({ items: [] });
    expect(await answer(sample('hub-contents-unavailable', 'GET', viewer(`${root}/contents`)), 404))
      .toMatchObject({ code: 'work_unavailable' });
    if (person.actingSubject) {
      expect(await answer(sample('hub-continue-reading', 'GET', viewer('/v1/me/continue?limit=6'))))
        .toMatchObject({ items: [] });
      expect(await answer(sample('hub-progress-summary', 'GET',
        viewer(`/v1/me/progress-summaries/${short(game.work)}?language=en`))))
        .toMatchObject({ resource: game.work, language: 'en', status: 'not-started' });
    }
  }
  const preferencePath = `/v1/me/edition-preferences/${short(game.work)}`;
  const choice = { actingSubject: person.actingSubject ?? sessions.owner.actingSubject,
    expectedVersion: 0, language: 'en',
    edition: { kind: 'release', resource: release.release, revision: release.revision } };
  if (name === 'visitor') {
    await answer(sample('preference-sign-in', 'GET', `${preferencePath}?${acting(sessions.owner)}`), 401);
    await answer(sample('choose-edition-sign-in', 'PUT', preferencePath, choice), 401);
  } else {
    expect(await answer(sample('preference-empty', 'GET', `${preferencePath}?${acting(person)}`))).toBeNull();
    const saved = await answer(sample('choose-edition', 'PUT', preferencePath, choice));
    expect(saved).toMatchObject({ work: game.work, language: 'en', edition: choice.edition, version: 1 });
    expect(await answer(sample('preference-saved', 'GET', `${preferencePath}?${acting(person)}`)))
      .toMatchObject({ edition: choice.edition, version: 1 });
    const other = name === 'member' ? sessions.stranger : sessions.member;
    await answer(sample('preference-private', 'GET', `${preferencePath}?${acting(other)}`), 403);
    await answer(sample('choose-edition-private', 'PUT', preferencePath, { ...choice, actingSubject: other.actingSubject }), 403);
  }
  const privatePath = `/v1/works/${short(draft.work)}?${acting(person)}`;
  await answer(sample('unpublished-work', 'GET', privatePath), name === 'owner' ? 200 : 404);
  if (name !== 'owner') {
    await answer(sample('release-edit-refused', 'PUT', `${root}/releases/${short(release.release)}`, {
      ...releaseCommand, expectedHead: release.revision,
      actingSubject: person.actingSubject ?? sessions.owner.actingSubject,
    }), name === 'visitor' ? 401 : 403);
  }
  if (name === 'member') await supportingReads(person, sample);
}

async function supportingReads(person: PersonaSession, sample: ReturnType<typeof recording.session>) {
  const root = `/v1/works/${short(game.work)}`;
  const resource = `/v1/resources/${short(game.work)}`;
  const viewer = (path: string) => `${path}${path.includes('?') ? '&' : '?'}${acting(person)}`;
  const projection = await answer<{ sections: { id: string; href: string }[] }>(
    sample('hub-projection', 'GET', viewer(`${resource}/page`)));
  for (const [label, path] of [
    ['agent-credits', `${root}/agent-credits`],
    ['reader-state', `${root}/reader-state`],
    ['realizations-empty', `${root}/realizations?limit=20`],
    ['work-relations', `${resource}/relations?limit=20`],
    ['progress-summary', `/v1/me/progress-summaries/${short(game.work)}?language=en`],
    ['continue-reading', '/v1/me/continue?limit=6'],
    ['reader-stats', `${root}/reader-stats`],
    ['also-enjoyed', `${root}/also-enjoyed?limit=12`],
    ['author-works', `/v1/agents/${short(sessions.owner.actingSubject!)}/works?limit=12`],
    ['facets', '/v1/facets'],
    ['classifications', `${root}/classifications?scope=global`],
    ['follow-context', `/v1/follows/${short(game.work)}?kind=work`],
    ['edition-sessions-empty', `/v1/me/sessions?${new URLSearchParams({ target: game.work, limit: '50' })}`],
    ['text-selection', `/v1/main-versions/${short(game.mainVersion)}/selection?language=en`],
  ] as const) await answer(sample(label, 'GET', label === 'text-selection' ? path : viewer(path)));
  await answer(sample('contents-unavailable', 'GET', viewer(`${root}/contents`)), 404);
  await answer(sample('work-showcase-empty', 'POST', '/v1/resources/showcase', {
    profile: 'work-showcase-batch-v1', targets: [game.work],
  }));
  await answer(sample('rating-populations', 'GET', viewer(`/v1/rating-populations?${new URLSearchParams({
    target: game.work, limit: '20',
  })}`)));
  const definition = await sample('correspondence-definition', 'GET', viewer('/v1/lexicon/definitions/correspondence-equivalent'));
  expect([200, 404]).toContain(definition.status);
  await definition.body?.cancel();
  for (const query of ['work-credits', 'work-adoptions']) {
    await answer(sample(`${query}-template`, 'POST', '/v1/query', {
      profile: 'template-query-v1', query: `https://rezics.com/query/${query}`, revision: 1,
      parameters: { roots: [game.work] }, presentation: { actingSubject: person.actingSubject },
    }));
  }
  const contexts = await answer<{ items: { context: string }[] }>(
    sample('rating-contexts', 'GET', viewer(`${resource}/rating-contexts?scope=global`)));
  const context = contexts.items[0]?.context;
  await answer(sample('rating-summary', 'GET', viewer(`${resource}/ratings${context
    ? `?context=${encodeURIComponent(context)}` : ''}`)));
  for (const section of projection.sections) {
    if (['statements', 'discussion', 'lists'].includes(section.id)) {
      await answer(sample(`hub-${section.id}`, 'GET', viewer(section.href)));
    } else if (section.id === 'reviews' && context) {
      await answer(sample('hub-reviews', 'GET', viewer(`${section.href}?${new URLSearchParams({
        context, sort: 'helpful', limit: '10',
      })}`)));
    }
  }
}

// WorkFrameView, WorkOverview, hub-sections and YourEdition's initial render.
// Labels belong to calls, including the two inventory calls inside tracking.editions.
async function visit(name: PersonaName) {
  const person = sessions[name];
  const labels = new AsyncLocalStorage<string | ((path: string) => string)>();
  const recorded = recording.session(name, person);
  const publicSample = recording.session(name, sessions.visitor);
  const seen = new Map<string, Promise<Response>>();
  const fetcher: typeof fetch = async (input, init) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    const path = url.pathname.slice(BFF_PREFIX.length) + url.search;
    const method = init?.method ?? 'GET';
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) as unknown : undefined;
    const label = labels.getStore();
    if (!label) throw new Error(`Unlabelled hub request: ${method} ${path}`);
    const anonymous = ['/v1/types', '/v1/facets', '/v1/resources/showcase'].includes(url.pathname.slice(BFF_PREFIX.length));
    const key = requestKey(name, method, path, body) + (anonymous ? ':anonymous' : '');
    const old = anonymous && person.actingSubject ? undefined : proofAnswers.get(requestKey(name, method, path, body));
    if (old) return old.clone();
    let pending = seen.get(key);
    if (!pending) {
      const stableLabel = typeof label === 'function' ? label(path) : label;
      pending = (anonymous ? publicSample : recorded)(stableLabel, method, path, body);
      seen.set(key, pending);
    }
    try { return (await pending).clone(); }
    catch (error) { throw new Error(`Hub visit ${name}: ${method} ${path}: ${String(error)}`, { cause: error }); }
  };
  const main = browserMainApi('http://record.invalid', { fetcher });
  const call = <T,>(label: string | ((path: string) => string), read: () => Promise<T>) => labels.run(label, read);
  const actingSubject = person.actingSubject ?? undefined;
  const id = short(game.work);
  const work = main.v1.works({ id });
  const resource = main.v1.resources({ resource: id });
  const query = { actingSubject };
  const template = (kind: 'work-credits' | 'work-adoptions') => call(`hub-${kind}`, () => main.v1.query.post({
    profile: 'template-query-v1', query: `https://rezics.com/query/${kind}`, revision: 1,
    parameters: { roots: [game.work] }, presentation: { actingSubject },
  }));
  // The signed-in shell's Main reads have no acting query until selection is known.
  await Promise.all([
    call('hub-types', () => main.v1.types.get()),
    person.actingSubject ? (async () => {
      const [state] = await Promise.all([
        call('hub-session-agent', () => main.v1.me['session-agent'].get()),
        call('hub-acting-contexts', () => main.v1.me['acting-contexts'].get({ query: { task: 'work.create' } })),
        call('hub-session-agents', () => main.v1.me.agents.get({ query: { languages: 'en' } })),
      ]);
      if (state.data?.sessionAgent.eligible) await Promise.all([
        call('hub-person-preferences', () => main.v1.me['person-preferences'].get({ query })),
        call('hub-session-profile', () => main.v1.agents({ id: short(person.actingSubject!) }).get({ query })),
      ]);
    })() : null,
  ]);
  const header = await call('hub-header', () => work.get({ query }));
  if (header.error || !header.data) return; // The route cannot render a Work frame without its header.
  const [projection, contexts, credits] = await Promise.all([
    call('hub-projection', () => resource.page.get({ query })),
    call('hub-rating-contexts', () => resource['rating-contexts'].get({ query: { ...query, scope: 'global' } })),
    call('hub-agent-credits', () => work['agent-credits'].get({ query })),
    template('work-credits'), template('work-adoptions'),
    call('hub-showcase', () => main.v1.resources.showcase.post({ profile: 'work-showcase-batch-v1', targets: [game.work] })),
    call('hub-facets', () => main.v1.facets.get()),
    call('hub-classifications', () => work.classifications.get({ query: { ...query, scope: 'global' } })),
    call('hub-rating-populations', () => main.v1['rating-populations'].get({ query: { ...query, target: game.work, limit: 20 } })),
    call('hub-also-enjoyed', () => work['also-enjoyed'].get({ query: { ...query, limit: 12 } })),
    person.actingSubject ? call('hub-reader-state', () => work['reader-state'].get({ query })) : null,
    person.actingSubject ? call('hub-platform-access', () => main.v1.me['platform-access'].get()) : null,
  ]);
  const context = contexts.data?.items[0]?.context;
  const sections = projection.data?.sections ?? [];
  // Game availability is non-book; the releases make YourEdition reachable.
  await Promise.all([
    contexts.error ? null : call('hub-ratings-global', () => resource.ratings.get({ query: { ...query, scope: 'global', context } })),
    call('hub-reader-stats', () => work['reader-stats'].get({ query: { ...query, context } })),
    context ? call('hub-reviews', () => resource.reviews.get({ query: { ...query, context, sort: 'helpful', limit: 10 } })).then(async () => {
      await call('hub-review-relations', () => resource.relations.get({ query: { ...query, limit: 32 } }));
    }) : null,
    (async () => {
      const [realizations, releases] = await Promise.all([
        call('hub-realizations', () => work.realizations.get({ query: { ...query, limit: 20 } })),
        call('hub-releases', () => work.releases.get({ query: { ...query, limit: 20 } })),
        call('hub-partless-parts', () => resource.parts.get({ query: { ...query, limit: 1 } })),
      ]);
      if (person.actingSubject && (releases.data?.items.length || realizations.data?.items.length)) {
        const tracking = mainTrackingApi(person.actingSubject, () => main);
        await Promise.all([
          call('hub-edition-preference', () => tracking.preference(game.work)),
          call(path => path.includes('/realizations') ? 'hub-realizations' : 'hub-releases', () => tracking.editions(game.work)),
        ]);
      }
    })(),
    call('hub-parts-preview', () => resource.parts.get({ query: { ...query, limit: 7 } })),
    call('hub-wholes', () => resource.wholes.get({ query: { ...query, limit: 3 } })),
    call('hub-relations', () => resource.relations.get({ query: { ...query, limit: 20 } })),
    person.actingSubject ? (async () => {
      const tracking = mainTrackingApi(person.actingSubject!, () => main);
      const [preference] = await Promise.all([
        call('hub-edition-preference', () => tracking.preference(game.work)),
        call(path => path.includes('/realizations') ? 'hub-realizations' : 'hub-releases', () => tracking.editions(game.work)),
        call('hub-relations', () => tracking.relations(game.work)),
        call('hub-correspondence-definition', () => tracking.definition('correspondence-equivalent')),
      ]);
      await call('hub-series-progress', () => tracking.series(game.work, preference.ok ? preference.data?.language ?? 'en' : 'en'));
    })() : null,
    ...sections.filter(section => ['statements', 'discussion'].includes(section.id)).map(section =>
      call(`hub-${section.id}`, followHref(main, section.href, query))),
    ...(credits.data?.items.filter(credit => credit.role === 'author').slice(0, 1).map(credit =>
      call('hub-author-works', () => main.v1.agents({ id: short(credit.agent) }).works.get({ query: { ...query, limit: 12 } }))) ?? []),
  ]);
}

async function proveAndVisit(name: PersonaName) {
  const started = performance.now();
  let proved = started;
  try {
    await within('proof', proofDeadlineMs, () => hub(name));
    proved = performance.now();
    await within('visit', visitDeadlineMs, () => visit(name));
  } finally {
    console.info(`[work-hub] ${name} proof=${Math.round(proved - started)}ms visit=${Math.round(performance.now() - proved)}ms`);
  }
}

outcomeTest(declaration, 'visitor', () => proveAndVisit('visitor'), recording);

outcomeTest(declaration, 'stranger', () => proveAndVisit('stranger'), recording);

outcomeTest(declaration, 'member', () => proveAndVisit('member'), recording);

outcomeTest(declaration, 'owner', () => proveAndVisit('owner'), recording);

outcomeTest(declaration, 'moderator', () => proveAndVisit('moderator'), recording);

outcomeTest(declaration, 'operator', () => proveAndVisit('operator'), recording);


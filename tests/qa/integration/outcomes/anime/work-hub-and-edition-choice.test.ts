import { afterAll, beforeAll, expect, setDefaultTimeout } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { BFF_PREFIX, browserMainApi } from '../../../../../apps/web/features/api/browser.ts';
import { typeEntry, seedTypes } from '../../../../../apps/web/features/catalogue/types.ts';
import { progressControl } from '../../../../../apps/web/features/tracking/medium-progress.tsx';
import { standingOf } from '../../../../../apps/web/features/tracking/episodes.ts';
import { workExperience } from '../../../../../apps/web/features/entity-page/experience.ts';
import { mainTrackingApi } from '../../../../../apps/web/features/tracking/api.ts';
import { mainRelationships } from '../../../../../apps/web/features/relationships/api.ts';
import { pinnedCommunities, spaceCommunities } from '../../../../../apps/web/features/shell/communities-relationships.ts';
import { booksEditionReads, readBooksEditionStatus } from '../../../../../apps/web/features/work-page/books-edition-page.read.ts';
import { readResourcePage, readLinkedStatements, readAnimeAgentCredits, readAnimeReaderState,
  readWorkRealizations, readWorkParts, readWorkWholes, readWorkRelations, availabilityShown } from '../../../../../apps/web/features/work-page/anime-hub-recorded-page.ts';
import { followHref } from '../../../../../apps/web/features/entity-page/href.ts';
import { hubPlan } from '../../../../../apps/web/features/work-page/hub.ts';
import { Pool } from 'pg';
import { grantLaunchRecipeAuthority } from '../../../../../scripts/load/launch-corpus.ts';
import { OutcomeRecorder, outcomeTest } from '../../../support/outcome-test.ts';
import { settledWrite } from '../../../support/settled-write.ts';
import { personaSessions, type PersonaName, type PersonaSession, type PersonaSessions } from '../../../support/personas.ts';

setDefaultTimeout(215_000);
const fileWall = setTimeout(() => { throw new Error('Anime work hub file exceeded 480 s'); }, 480_000);
async function within<T>(milliseconds: number, part: string, run: () => Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([run(), new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${part} exceeded ${milliseconds} ms`)), milliseconds);
    })]);
  } finally { clearTimeout(timer); }
}
let sessions: PersonaSessions;
const short = (id: string) => id.slice(-36);
const acting = (person: PersonaSession) => `actingSubject=${encodeURIComponent(person.actingSubject!)}`;
type Work = { work: string; mainVersion: string };
async function answer<T>(pending: Promise<Response>, status = 200): Promise<T> {
  const response = await pending;
  const raw = await response.text();
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
  const work = await answer<Work>(preparation('POST', '/v1/works', {
    profile: 'metadata-only-v1', title, language: 'en', semanticTypes: ['https://schema.org/TVSeries'],
    authoring: 'own-work', actingSubject: owner.actingSubject,
  }), 201);
  const draft = await answer<{ contribution: string; draftRevision: string }>(
    preparation('POST', '/v1/contributions', { profile: 'text-contribution-v1',
      work: work.work, language: 'en', body: `Original fixture animation script by Outcome owner: ${title}.`,
      actingSubject: owner.actingSubject }), 201);
  const publication = await answer<{ publicationDecision: string }>(
    preparation('POST', '/v1/contribution-publications', { profile: 'text-publication-v1',
      contribution: draft.contribution, expectedDraftHead: draft.draftRevision,
      expectedPublicationHead: null, rightsBasis: 'original-contribution', disclosure: 'public',
      actingSubject: owner.actingSubject }), 201);
  await answer(preparation('POST', '/v1/publication-selections', {
    profile: 'main-default-selection-v1', context: { kind: 'main-version-default', id: work.mainVersion },
    work: work.work, contribution: draft.contribution, publicationDecision: publication.publicationDecision,
    expectedSelectionHead: null, selectionBasis: 'main-maintainer', actingSubject: owner.actingSubject,
  }), 201);
  return work;
}
afterAll(async () => {
  try { await recording.publish(); } finally { clearTimeout(fileWall); await sessions?.close(); }
});

import hub from '../../../../../scripts/qa/cases/outcomes/anime/work-hub-and-edition-choice.ts';
import { seedFirstPublicationDate } from '../../../../../scripts/dev/seed/relation-lexicon.ts';
const recording = new OutcomeRecorder(hub);
const preparation: PersonaSession['main'] = (method, path, body, key) =>
  method === 'GET' ? sessions.owner.main(method, path, body, key)
    : settledWrite(sessions.owner.main.bind(sessions.owner), method, path, body, key);
const DATE_PUBLISHED_PREDICATE = 'https://schema.org/datePublished';
const DATE_PUBLISHED_DEFINITION_NOTATION = 'statement-first-publication-date-v1';
let dated: Work, undated: Work;
const releases: { id: string; revision: string; title: string }[] = [];
beforeAll(async () => {
  sessions = await personaSessions();
  await recording.prepare();
  const owner = sessions.owner, actor = owner.actingSubject!;
  dated = await publish('Original animation: Lantern harbour');
  undated = await publish('Original animation: Undated harbour');
  for (const [scope, action] of [
    ['semantic:create:root', 'semantic.change'],
    [`statement:speak:${actor}`, 'statement.record'],
    ['classification:decide:global', 'statement.decide'],
    ['classification:define:global', 'classification.proposition.define'],
    ['catalogue:verify:root', 'catalogue.verify'],
  ]) await grant(owner, scope!, action!);
  // Public vocabulary creation establishes the Global acceptance context for date decisions.
  await answer(preparation('POST', '/v1/classification-vocabulary', {
    profile: 'classification-proposition-v2', scheme: null,
    labels: [{ language: 'en', value: 'Original fixture TV animation' }],
    alternativeLabels: [], broader: [], narrower: [], actingSubject: actor,
  }), 201);
  const definition = await seedFirstPublicationDate({
    post: <T,>(path: string, body: object, key: string) => answer<T>(preparation('POST', path, body, key), 201),
    authorizeDefinition: receipt => grant(owner, `semantic:read:${receipt.component}`, 'semantic.read'),
    currentDefinition: async key => {
      const response = await preparation('GET', `/v1/lexicon/definitions/${key}?${acting(owner)}`);
      if (response.status === 404) return null;
      const value = await answer<{ definition: string; revision: string; kind: string; lifecycle: string }>(Promise.resolve(response));
      return { component: value.definition, revision: value.revision,
        state: { component: 'definition', kind: 'property', notation: DATE_PUBLISHED_DEFINITION_NOTATION,
          lifecycle: 'active', successor: null, roles: [] } };
    },
  }, actor);
  const statement = await answer<{ statement: string }>(preparation('POST', '/v1/statements', {
    profile: 'statement-v1', speaker: { kind: 'personal' }, subject: dated.work,
    predicate: definition.component, relationDefinition: definition.revision,
    value: { kind: 'literal', lexical: '2004-04-01', datatype: 'http://www.w3.org/2001/XMLSchema#date', language: null },
    applicability: [], interpretation: { kind: 'selected' }, evidence: [], actingSubject: actor,
  }), 201);
  await answer(preparation('POST', '/v1/statement-decisions', {
    profile: 'statement-decision-v1', target: { kind: 'statement', statement: statement.statement },
    acceptance: { kind: 'global' }, expectedDecisionHead: null, outcome: 'accepted', actingSubject: actor,
  }), 201);
  const realization = `https://rezics.com/id/${randomUUID()}`;
  const text = await answer<{ revision: string }>(preparation('PUT',
    `/v1/works/${short(dated.work)}/realizations/${short(realization)}`, {
      profile: 'realization-v1', id: realization, expectedHead: null, actingSubject: actor,
      language: 'en', kind: 'original', translators: [], publishers: [],
      source: { kind: 'unresolved', work: dated.work }, status: 'official', verification: 'verified',
      evidence: `https://rezics.com/id/${randomUUID()}`,
    }));
  for (const title of ['Lantern harbour broadcast', 'Lantern harbour restored release']) {
    const id = `https://rezics.com/id/${randomUUID()}`;
    const release = await answer<{ revision: string }>(preparation('PUT',
      `/v1/works/${short(dated.work)}/releases/${short(id)}`, {
        profile: 'release-v2', id, expectedHead: null, actingSubject: actor,
        kind: 'formal', status: 'official', titleLanguage: 'en', tracklistLanguage: null,
        title: { value: title, language: 'en' }, editionStatement: null, publisher: 'Fixture owner',
        publicationYear: 2004, isbn13: null, originalUrl: null, fixedRelease: null,
        identifiers: [], platform: 'Broadcast', territory: null,
        coverage: [{ realization, revision: text.revision, completeness: 'complete' }], evidence: null,
      }));
    releases.push({ id, revision: release.revision, title });
  }
  await answer(preparation('POST', '/v1/compositions', { profile: 'work-composition',
    work: dated.work, mainVersion: dated.mainVersion, actingSubject: actor }), 201);
}, 180_000);

function samplesFor(name: PersonaName, person: PersonaSession) {
  return recording.session(name, {
    main: async (...args) => {
      const response = await person.main(...args);
      if (response.status >= 500) {
        throw new Error(`API fault ${args[0]} ${args[1]} body=${JSON.stringify(args[2])}: ${response.status} ${await response.text()}`);
      }
      return response;
    },
  });
}

// /w/{ref}: server readers share their cache; browser controls use the same typed command client.
async function recordHubVisit(name: PersonaName, person: PersonaSession, target: Work) {
  const labels = new AsyncLocalStorage<string | ((path: string) => string)>();
  const sample = samplesFor(name, person);
  const publicSample = samplesFor(name, sessions.visitor);
  const requests = new Map<string, Promise<Response>>();
  const faults: Error[] = [];
  const transport = (anonymous = false): typeof fetch => async (input, init) => {
    const url = new URL(String(input)), method = init?.method ?? 'GET';
    const path = (url.pathname.startsWith(BFF_PREFIX) ? url.pathname.slice(BFF_PREFIX.length) : url.pathname) + url.search;
    const label = labels.getStore();
    if (!label) throw new Error(`Unlabelled production request ${method} ${path}`);
    const baseLabel = typeof label === 'function' ? label(path) : label;
    const fixed = target === dated ? baseLabel : baseLabel === 'hub-releases'
      ? 'hub-undated-releases-empty' : `undated-${baseLabel}`;
    const body = init?.body === undefined ? undefined : JSON.parse(String(init.body));
    const key = new Headers(init?.headers).get('idempotency-key') ?? undefined;
    // A repeated server reader shares one answer, as React's request cache does.
    const cacheKey = JSON.stringify([anonymous, method, path, body, fixed]);
    let pending = requests.get(cacheKey);
    if (!pending) {
      pending = (anonymous ? publicSample : sample)(fixed, method, path, body, key).catch(error => {
        const fault = new Error(`${name} ${fixed}: ${method} ${path} body=${JSON.stringify(body)}: ${String(error)}`);
        faults.push(fault);
        throw fault;
      });
      requests.set(cacheKey, pending);
    }
    return (await pending).clone();
  };
  const main = browserMainApi('http://record.invalid', { fetcher: transport() });
  const publicMain = browserMainApi('http://record.invalid', { anonymous: true, fetcher: transport(true) });
  const named = <T,>(label: string | ((path: string) => string), run: () => Promise<T>) => labels.run(label, run);
  const actingSubject = person.actingSubject ?? undefined, query = { actingSubject };
  const reads = booksEditionReads({ main, actingSubject });
  const id = short(target.work), work = main.v1.works({ id }), resource = main.v1.resources({ resource: id });
  const official = named('frame-official-zones', () => publicMain.v1.zones.get({ query: { official: 'true', limit: 6 } }))
    .then(zones => Promise.all((zones.data?.items.slice(0, 6) ?? []).map(zone =>
      named(`frame-official-realm-${zone.routeSegment}`, () => publicMain.v1.realms({ realm: short(zone.realm) }).get()))));
  const [state] = await Promise.all([
    actingSubject ? named('hub-session-agent', () => main.v1.me['session-agent'].get()) : null,
    named('hub-platform-access', () => main.v1.me['platform-access'].get()),
    named('frame-type-registry', () => publicMain.v1.types.get()).then(answer => { if (answer.data) seedTypes(answer.data); }),
    official,
    actingSubject ? named('frame-acting-contexts', () => main.v1.me['acting-contexts'].get({ query: { task: 'work.create' } })) : null,
    actingSubject ? named('frame-session-agents', () => main.v1.me.agents.get({ query: { languages: 'en' } })) : null,
  ]);
  let navigation: Promise<unknown> = Promise.resolve();
  if (actingSubject && state?.data?.sessionAgent.eligible) {
    await Promise.all([
      named('frame-person-preferences', () => main.v1.me['person-preferences'].get({ query })),
      named('frame-agent-profile', () => main.v1.agents({ id: short(actingSubject) }).get({ query })),
    ]);
    const relationships = mainRelationships(actingSubject, { origin: 'http://record.invalid', fetch: transport() });
    navigation = Promise.all([
      named('frame-pinned-follows', () => pinnedCommunities(relationships, '', null)),
      named('frame-space-follows', () => spaceCommunities(relationships, '', null)),
      named('frame-follow-inventory', () => relationships.follows()),
      named('frame-managed-realms', () => main.v1.me['managed-realms'].get({ query })),
      named('frame-notification-unread-count', () => main.v1.me.notifications['unread-count'].get()),
    ]);
  }
  const header = await named('hub-work-header', () => reads.readWorkHeader(id));
  if (!header.ok) { await navigation; if (faults.length) throw faults[0]; return; }
  const [projection, contexts, credits] = await Promise.all([
    named('hub-resource-page', () => readResourcePage(main, actingSubject, id)),
    named('hub-rating-contexts', () => resource['rating-contexts'].get({ query: { ...query, scope: 'global' } })),
    named('hub-agent-credits', () => readAnimeAgentCredits(main, actingSubject, id)),
    named('hub-reader-state', () => readAnimeReaderState(main, actingSubject, id)),
    named('hub-work-credits', () => reads.readCredits(id)),
    named('hub-work-adoptions', () => reads.readAdoptions(id)),
    named('hub-showcase', () => publicMain.v1.resources.showcase.post({ profile: 'work-showcase-batch-v1', targets: [target.work] })),
    named('hub-facets', () => booksEditionReads({ main: publicMain }).readFacets()),
    named('hub-rating-populations', () => main.v1['rating-populations'].get({ query: { limit: 20, target: target.work, ...query } })),
  ]);
  const context = contexts.data?.items[0]?.context;
  const plan = hubPlan(projection.ok ? projection.data : null);
  const experience = workExperience(projection.ok ? projection.data : null, header.data.types);
  const statusShown = experience.kind === 'book' || experience.primaryAction === 'watch' || experience.primaryAction === 'play';
  const tracking = actingSubject ? mainTrackingApi(actingSubject, () => main) : null;
  const inventories = () => named(path => path.includes('/realizations') ? 'chooser-realizations' : 'chooser-releases',
    () => tracking!.editions(target.work));
  const availability = plan.includes('availability') ? Promise.all([
    named('hub-realizations', () => readWorkRealizations(main, actingSubject, id)),
    named('hub-releases', () => reads.readReleases(id)),
    named('hub-availability-parts', () => readWorkParts(main, actingSubject, id, { limit: 1 })),
  ]) : Promise.resolve(null);
  const chooser = availability.then(offered => tracking && offered && availabilityShown({
    realizations: offered[0], releases: offered[1], parts: offered[2],
  }) ? Promise.all([named('chooser-preference', () => tracking.preference(target.work)), inventories()]).then(async setup => {
    const preference = setup[0];
    if (preference.ok && preference.data?.edition) await named('chooser-current-edition',
      () => tracking.edition(target.work, preference.data!.edition!));
    return setup;
  }) : null);
  const mediumProgress = async () => {
    if (!tracking?.media) return;
    const types = await named('panel-work-types', () => tracking.media!.types(target.work));
    if (!types.ok && types.failure === 'missing') return;
    const presentation = types.ok && types.data ? typeEntry(types.data)?.presentation ?? null : null;
    const choice = await named(path => path.includes('/parts') ? 'panel-progress-structure' : 'panel-progress-scope',
      () => progressControl(tracking.media!, tracking.episodes ?? null, target.work, presentation));
    if (choice.kind === 'episodes' && tracking.episodes) await named(path => path.includes('/parts')
      ? 'panel-progress-structure' : path.includes('/compositions/') ? 'panel-episode-page' : 'panel-episode-resume',
    () => standingOf(tracking.episodes!, target.work));
    else if (choice.kind === 'chapters') {
      const standing = await named('panel-chapter-standing', () => tracking.media!.standing(target.work));
      if (standing.ok && !standing.data.opened) await named('panel-chapter-positions', () => tracking.media!.positions(target.work));
    } else if (choice.kind === 'work') await named('panel-work-standing', () => tracking.media!.workStanding(target.work));
  };
  await Promise.all([
    navigation,
    chooser,
    !contexts.error ? named('hub-ratings', () => resource.ratings.get({ query: { ...query, scope: 'global', context } })) : null,
    named('hub-reader-stats', () => work['reader-stats'].get({ query: { ...query, context } })),
    plan.includes('about') ? named('hub-classifications', () => reads.readClassifications(id, { kind: 'global' })) : null,
    plan.includes('lists') ? named('hub-also-enjoyed', () => reads.readAlsoEnjoyed(id)) : null,
    availability,
    statusShown ? named(path => path.includes('/edition-preferences/') ? 'hub-status-preference'
      : path.includes('/progress-summaries/') ? 'hub-status-progress' : 'hub-status-release',
    () => readBooksEditionStatus(reads, id, 'en')) : null,
    ...plan.includes('parts') ? [
      mediumProgress(),
      named('hub-parts-preview', () => readWorkParts(main, actingSubject, id, { limit: 7 })),
      named('hub-wholes-preview', () => readWorkWholes(main, actingSubject, id, { limit: 3 })),
      named('hub-connections-preview', () => readWorkRelations(main, actingSubject, id, { limit: 20 })),
      tracking ? Promise.all([
        named('panel-preference', () => tracking.preference(target.work)),
        named(path => path.includes('/realizations') ? 'panel-realizations' : 'panel-releases', () => tracking.editions(target.work)),
        named('panel-relations', () => tracking.relations(target.work)),
        named('panel-correspondence-definition', () => tracking.definition('correspondence-equivalent')),
      ]).then(([preference]) => named('panel-series-progress', () => tracking.series(target.work,
        preference.ok ? preference.data?.language ?? 'en' : 'en'))) : null,
    ] : [],
    ...projection.ok ? projection.data.sections.flatMap(section => {
      if (section.id === 'statements') return [named('hub-facts', () => readLinkedStatements(main, actingSubject, section.href))];
      if (section.id === 'discussion') return [named('hub-discussion', followHref(main, section.href, query))];
      return [];
    }) : [],
    context && plan.includes('ratings') ? named('hub-reviews', () => resource.reviews.get({
      query: { context, sort: 'helpful', limit: 10, ...query } })).then(() => Promise.all([
      named('hub-review-target-relations', () => readWorkRelations(main, actingSubject, id, { limit: 32 })),
      named('hub-releases', () => reads.readReleases(id)),
      named('hub-realizations', () => readWorkRealizations(main, actingSubject, id)),
    ])) : null,
    ...credits.ok ? credits.data.items.filter(item => item.role === 'author').slice(0, 1).map(author =>
      named('hub-author-works', () => main.v1.agents({ id: short(author.agent) }).works.get({ query: { ...query, limit: 12 } }))) : [],
  ]);
  if (faults.length) throw faults[0];
  const setup = await chooser;
  // Signed out, YourEdition links to sign-in. A refused preference stops before the form.
  if (!tracking || !setup || !setup[0].ok || !setup[1].ok || target === undated) return;
  const offered = setup[1].data.releases.find(release => release.id === releases[0]!.id);
  if (!offered) throw new Error('Production edition chooser did not offer the broadcast release');
  const saved = await named('chooser-broadcast-save', () => tracking.setPreference(target.work,
    setup[0].data?.version ?? 0, { language: 'en', edition: { kind: 'release', resource: offered.id, revision: offered.revision } }));
  if (faults.length) throw faults[0];
  if (!saved.ok) return;
  // YourEdition refreshes the server and notifies the series panel after the command succeeds.
  await Promise.all([
    named('chooser-saved-progress', () => tracking.series(target.work, saved.data?.language ?? 'en')),
    saved.data?.edition ? named('chooser-selected-edition', () => tracking.edition(target.work, saved.data!.edition!)) : null,
    statusShown ? named(path => path.includes('/edition-preferences/') ? 'chooser-saved-preference'
      : path.includes('/progress-summaries/') ? 'chooser-status-progress' : 'chooser-status-release',
    () => readBooksEditionStatus(reads, id, 'en')) : null,
  ]);
  if (faults.length) throw faults[0];
}

async function journey(name: PersonaName) {
  const person = sessions[name];
  const sample = samplesFor(name, person);
  for (const work of [dated, undated]) {
    const label = work === dated ? 'work' : 'undated-work';
    const query = person.actingSubject ? `?${acting(person)}` : '';
    expect(await answer(sample(`${label}-header`, 'GET', `/v1/works/${short(work.work)}${query}`)))
      .toMatchObject({ id: work.work, disclosure: 'public', selectedLanguage: 'en', types: ['https://schema.org/TVSeries'] });
    const statements = await answer<{ groups: { predicate: string; items: { value?: { lexical: string } }[] }[] }>(
      sample(`${label}-publication-date`, 'GET', `/v1/resources/${short(work.work)}/statements${query}`));
    const dates = statements.groups.filter(group => group.predicate === DATE_PUBLISHED_PREDICATE)
      .flatMap(group => group.items.map(item => item.value?.lexical));
    expect(dates).toEqual(work === dated ? ['2004-04-01'] : []);
    const credit = await sample(`${label}-publication-credit`, 'GET', `/v1/works/${short(work.work)}/credits${query}`);
    expect(credit.status).toBe(200);
    expect(await credit.text()).toContain(sessions.owner.actingSubject!);
  }
  const root = `/v1/works/${short(dated.work)}`;
  const query = person.actingSubject ? `?${acting(person)}` : '';
  const list = await answer<{ items: { id: string }[] }>(sample('edition-inventory', 'GET', `${root}/releases${query}`));
  expect(list.items.map(item => item.id).sort()).toEqual(releases.map(item => item.id).sort());
  for (const release of releases) {
    expect(await answer(sample(release === releases[0] ? 'broadcast-edition' : 'restored-edition', 'GET', `${root}/releases/${short(release.id)}${query}`)))
      .toMatchObject({ id: release.id, revision: release.revision, title: { value: release.title } });
  }
  const path = `/v1/me/edition-preferences/${short(dated.work)}`;
  const affected = name === 'owner' ? sessions.member : sessions.owner;
  const deniedStatus = name === 'visitor' ? 401 : 403;
  expect(await answer<{ code: string }>(sample('other-reader-preference-refused', 'GET', `${path}?${acting(affected)}`), deniedStatus))
    .toMatchObject({ code: name === 'visitor' ? 'account_assertion_denied' : 'progress_denied' });
  await answer(sample('other-reader-edition-write-refused', 'PUT', path, { actingSubject: affected.actingSubject, expectedVersion: 0,
    language: 'en', edition: { kind: 'release', resource: releases[0]!.id, revision: releases[0]!.revision } }), deniedStatus);
  if (name === 'visitor') return;
  expect(await answer(sample('edition-preference-empty', 'GET', `${path}?${acting(person)}`))).toBeNull();
  const choices = releases.map(release => ({ key: randomUUID(), body: { actingSubject: person.actingSubject,
    expectedVersion: 0, language: 'en', edition: { kind: 'release', resource: release.id, revision: release.revision } } }));
  const raced = await Promise.all(choices.map((choice, index) => sample(index === 0 ? 'broadcast-edition-choice' : 'restored-edition-choice', 'PUT', path, choice.body, choice.key)));
  expect(raced.map(response => response.status).sort()).toEqual([200, 409]);
  const index = raced.findIndex(response => response.status === 200);
  const saved = await answer<{ version: number; edition: object }>(Promise.resolve(raced[index]!));
  expect(saved).toMatchObject({ version: 1, edition: choices[index]!.body.edition, replayed: false });
  expect(await answer(Promise.resolve(raced[1 - index]!), 409)).toMatchObject({ code: 'stale_edition_preference' });
  expect(await answer(sample('edition-choice-replay', 'PUT', path, choices[index]!.body, choices[index]!.key)))
    .toMatchObject({ ...saved, replayed: true });
  expect(await answer(sample('chosen-edition-progress', 'GET', `/v1/me/progress-summaries/${short(dated.work)}?${acting(person)}&language=en`)))
    .toMatchObject({ preference: { version: 1, edition: choices[index]!.body.edition } });
}
async function proveAndVisit(name: PersonaName) {
  const started = performance.now();
  let proved = started;
  try {
    // The unchanged API proof owns its original 90 s deadline.
    await within(90_000, 'proof', () => journey(name));
    proved = performance.now();
    await within(120_000, 'production visit', async () => {
      await recordHubVisit(name, sessions[name], dated);
      await recordHubVisit(name, sessions[name], undated);
    });
  } finally {
    console.info(`[anime-hub] ${name} proof=${Math.round(proved - started)}ms visit=${Math.round(performance.now() - proved)}ms`);
  }
}
outcomeTest(hub, 'visitor', () => proveAndVisit('visitor'), recording);
outcomeTest(hub, 'stranger', () => proveAndVisit('stranger'), recording);
outcomeTest(hub, 'member', () => proveAndVisit('member'), recording);
outcomeTest(hub, 'owner', () => proveAndVisit('owner'), recording);
outcomeTest(hub, 'moderator', () => proveAndVisit('moderator'), recording);
outcomeTest(hub, 'operator', () => proveAndVisit('operator'), recording);


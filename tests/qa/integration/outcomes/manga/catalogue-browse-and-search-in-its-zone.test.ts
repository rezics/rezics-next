import { afterAll, beforeAll, expect, setDefaultTimeout } from 'bun:test';
import { recordZoneBrowseContinuation } from '../../../support/catalogue-story-reads.ts';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { fromPlainText } from '@rezics/document';
import catalogue from '../../../../../scripts/qa/cases/outcomes/manga/catalogue-browse-and-search-in-its-zone.ts';
import { classificationContextBody, classifiedStatementBody, discloseClassificationConcept, type ClassificationPost } from '../../../../../scripts/dev/seed/classified-statement.ts';
import { seedFirstPublicationDate } from '../../../../../scripts/dev/seed/relation-lexicon.ts';
import { grantMangaFixtureAuthority } from '../../../../../scripts/qa/cases/outcomes/manga/work-hub-and-edition-choice.ts';
import { OutcomeRecorder, outcomeTest } from '../../../support/outcome-test.ts';
import { recordFrameReads } from '../../../support/frame-reads.ts';
import { personaSessions, type PersonaName, type PersonaSession, type PersonaSessions } from '../../../support/personas.ts';
import { mainBrowseQuery, parseBrowseState } from '../../../../../apps/web/features/zones/browse-state.ts';
import { catalogueYearParam } from '../../../../../apps/web/features/zones/catalogue-year.ts';

type Work = { work: string; mainVersion: string; contribution: string; publicationDecision: string; concept: string | null; year: number | null; status: string };
type Page = { items: { id: string; primaryCredits: { agent: string | null; role: string }[] }[]; nextCursor: string | null;
  matches: { value: number; kind: string }; query: { publicationYear?: string; filter: { all: unknown[] } }; window: { complete: boolean } };
setDefaultTimeout(90_000);
let sessions: PersonaSessions, pool: Pool;
let manga: string, oneShot: string, statement: string, privateWork: string;
const works: Work[] = [];
const recording = new OutcomeRecorder(catalogue);
const phrase = `InkCatalogue${randomUUID().replaceAll('-', '')}`;
const short = (id: string) => id.slice(-36);
const acting = (person: PersonaSession) => `actingSubject=${encodeURIComponent(person.actingSubject!)}`;
async function answer<T>(request: Promise<Response>, status = 200): Promise<T> {
  const response = await request, raw = await response.text();
  expect(response.status, `${response.status}: ${raw}`).toBe(status);
  return JSON.parse(raw) as T;
}
const grant = (person: PersonaSession, scope: string, action: string) => grantMangaFixtureAuthority(pool, person, scope, action);
beforeAll(async () => {
  sessions = await personaSessions('public');
  await recording.prepare();
  pool = new Pool({ connectionString: Bun.env.ACCESS_DATABASE_URL });
  const owner = sessions.owner, actor = owner.actingSubject!;
  const root = `/v1/realms/${short(sessions.realm)}`;
  const roleId = randomUUID();
  for (const change of [
    { kind: 'role', roleId, name: 'Original catalogue publishers', permissions: ['publication.adopt'] },
    { kind: 'assignment', roleId, member: actor, assigned: true, validUntil: new Date(Date.now() + 3_600_000).toISOString() },
  ]) {
    const roles = await answer<{ generation: string }>(owner.main('GET', `${root}/roles?${acting(owner)}`));
    const command = { actingSubject: actor, expectedGeneration: roles.generation, reason: 'Publish the original Manga fixtures', change };
    const preview = await answer<{ digest: string }>(owner.main('POST', `${root}/role-impact`, command));
    await answer(owner.main('POST', `${root}/role-changes`, { ...command, impactDigest: preview.digest }), 201);
  }
  for (const [scope, action] of [
    ['semantic:create:root', 'semantic.change'], ['classification:define:global', 'classification.proposition.define'],
    ['classification:decide:global', 'statement.decide'], ['context:create:root', 'context.create'],
  ]) await grant(owner, scope!, action!);
  const terms: { concept: string; definitionRevision: string }[] = [];
  for (const label of ['Manga', 'One-shot']) {
    const term = await answer<{ concept: string; definitionRevision: string }>(owner.main('POST', '/v1/classification-vocabulary', {
      profile: 'classification-proposition-v2', scheme: null, labels: [{ language: 'en', value: label }], alternativeLabels: [],
      broader: [], narrower: [], actingSubject: actor,
    }), 201);
    terms.push(term);
    const post: ClassificationPost = <T,>(path: string, body: unknown, _token: string, key: string) => answer<T>(owner.main('POST', path, body, key), 201);
    await discloseClassificationConcept(post, '', actor, term.concept, randomUUID());
  }
  manga = terms[0]!.concept; oneShot = terms[1]!.concept;
  const context = await answer<{ context: string; semanticRevision: string }>(owner.main('POST', '/v1/contexts', classificationContextBody(actor, terms)), 201);
  const published = await seedFirstPublicationDate({
    post: <T,>(path: string, body: object, key: string) => answer<T>(owner.main('POST', path, body, key), 201),
    authorizeDefinition: receipt => grant(owner, `semantic:read:${receipt.component}`, 'semantic.read'),
    currentDefinition: async notation => {
      const response = await owner.main('GET', `/v1/lexicon/definitions/${notation}?${acting(owner)}`);
      if (response.status === 404) return null;
      const current = await answer<{ definition: string; revision: string; kind: string; lifecycle: string; roles: never[] }>(Promise.resolve(response));
      if (current.kind !== 'property' || current.lifecycle !== 'active' || current.roles.length) return null;
      return { component: current.definition, revision: current.revision,
        state: { component: 'definition' as const, kind: 'property' as const, lifecycle: 'active' as const,
          successor: null, roles: [], notation } };
    },
  }, actor);
  for (let index = 0; index < 10; index++) {
    const work = await answer<{ work: string; mainVersion: string }>(owner.main('POST', '/v1/works', {
      profile: 'metadata-only-v1', title: `${phrase} ${index}`, language: 'en', semanticTypes: ['https://schema.org/Book'],
      authoring: 'own-work', actingSubject: actor,
    }), 201);
    if (index === 9) {
      privateWork = work.work;
      await grant(sessions.operator, `work:read:${work.work}`, 'work.read');
      continue;
    }
    const draft = await answer<{ contribution: string; draftRevision: string; author: string }>(owner.main('POST', '/v1/contributions', {
      profile: 'text-contribution-v1', work: work.work, language: 'en', body: `An original fictional manga chapter: ink gardener ${index} draws a new garden.`, actingSubject: actor,
    }), 201);
    expect(draft.author).toBe(actor);
    const publication = await answer<{ publicationDecision: string }>(owner.main('POST', '/v1/contribution-publications', {
      profile: 'text-publication-v1', contribution: draft.contribution, expectedDraftHead: draft.draftRevision,
      expectedPublicationHead: null, rightsBasis: 'original-contribution', disclosure: 'public', actingSubject: actor,
    }), 201);
    const selection = { work: work.work, contribution: draft.contribution, publicationDecision: publication.publicationDecision,
      expectedSelectionHead: null, actingSubject: actor };
    await answer(owner.main('POST', '/v1/publication-selections', { ...selection, profile: 'main-default-selection-v1',
      context: { kind: 'main-version-default', id: work.mainVersion }, selectionBasis: 'main-maintainer' }), 201);
    await answer(owner.main('POST', '/v1/publication-selections', { ...selection, profile: 'realm-local-selection-v1',
      context: { kind: 'realm-local', id: sessions.realm }, mainVersion: work.mainVersion, selectionBasis: 'realm-manager-review' }), 201);
    const status = index % 3 === 0 ? 'upcoming' : index % 3 === 1 ? 'completed' : 'cancelled';
    await answer(owner.main('PUT', `/v1/works/${short(work.work)}/metadata`, { profile: 'work-metadata-details-v1', expectedHead: null,
      state: { kind: 'header', originalTitle: null, localized: [], completionStatus: status }, actingSubject: actor }));
    const concept = index === 7 ? oneShot : index === 8 ? null : manga;
    if (concept) {
      const recorded = await answer<{ statement: string; meaningKey: string }>(owner.main('POST', '/v1/statements', classifiedStatementBody(actor, work.mainVersion, concept, context)), 201);
      statement ??= recorded.statement;
      await answer(owner.main('POST', '/v1/statement-decisions', { profile: 'statement-decision-v1',
        target: { kind: 'qualified-fact', meaningKey: recorded.meaningKey, support: [recorded.statement] },
        acceptance: { kind: 'global' }, expectedDecisionHead: null, outcome: 'accepted', actingSubject: actor }), 201);
    }
    const year = index === 6 || index === 8 ? null : index < 6 ? 1995 : 2001;
    if (year) {
      const recorded = await answer<{ statement: string }>(owner.main('POST', '/v1/statements', {
        profile: 'statement-v1', speaker: { kind: 'personal' }, subject: work.work, predicate: published.component,
        relationDefinition: published.revision, value: { kind: 'literal', lexical: `${year}-07-12`, datatype: 'http://www.w3.org/2001/XMLSchema#date', language: null },
        applicability: [], interpretation: { kind: 'selected' }, evidence: [], actingSubject: actor,
      }), 201);
      await answer(owner.main('POST', '/v1/statement-decisions', { profile: 'statement-decision-v1',
        target: { kind: 'statement', statement: recorded.statement }, acceptance: { kind: 'global' },
        expectedDecisionHead: null, outcome: 'accepted', actingSubject: actor }), 201);
    }
    works.push({ ...work, ...selection, concept, year, status });
  }
  const zoneRoot = `/v1/zones/${short(sessions.zone)}`;
  const current = await answer<{ revision: string }>(owner.main('GET', `${zoneRoot}/configuration?${acting(owner)}`));
  await answer(owner.main('PUT', `${zoneRoot}/configuration`, {
    expectedHead: current.revision, prepareHomeDocument: true, actingSubject: actor,
  }));
  const configuration = await answer<{ revision: string; configuration: { homeDocument: string } }>(
    owner.main('GET', `${zoneRoot}/configuration?${acting(owner)}`));
  const navigation = await answer<{ revision: string }>(owner.main('GET', `${zoneRoot}?${acting(owner)}`));
  const variantId = `urn:rezics:variant:${randomUUID()}`;
  const draft = await answer<{ revisionId: string; byteDigest: string; sourcePosition: { dataEpoch: string } }>(
    owner.main('POST', '/v1/content-drafts', { profile: 'content-text-v1', resourceId: configuration.configuration.homeDocument,
      variantId, expectedHead: null, document: fromPlainText('Original Manga fixture catalogue', 'blocks'),
      language: { kind: 'tag', tag: 'en', originalTag: 'en' }, direction: 'ltr', actingSubject: actor }), 201);
  await answer(owner.main('POST', `${zoneRoot}/site-publications`, {
    routesRevision: navigation.revision, navigationRevision: navigation.revision,
    expectedHead: configuration.revision, actingSubject: actor,
    pages: [{ page: configuration.configuration.homeDocument, variantId, revisionId: draft.revisionId,
      byteDigest: draft.byteDigest, contentEpoch: draft.sourcePosition.dataEpoch }],
  }), 201);
  // Catalogue filters consume a Realm Discovery generation. Build it through
  // its separately mandated platform API after all fixture publication writes.
  // The refresh worker may already hold a build for this public Realm.
  await answer(sessions.visitor.main('GET', `${root}/modules/browse?limit=3`));
  const operator = sessions.operator;
  await grant(operator, 'recommendation:manage', 'recommendation.generation.manage');
  const build = {
    profile: 'discovery-generation-build-v1', actingSubject: operator.actingSubject,
    basis: { scope: 'realm', realm: sessions.realm, context: null },
  };
  let generation: { generation: string; checkpoint: string; complete: boolean } | undefined;
  for (let attempt = 0; attempt < 45 && !generation; attempt++) {
    const response = await operator.main('POST', '/v1/discovery/generation-builds', build);
    const raw = await response.text();
    if (response.status === 409 && raw.includes('"code":"discovery_conflict"')) {
      await Bun.sleep(1_000);
      continue;
    }
    expect(response.status, `${response.status}: ${raw}`).toBe(200);
    generation = JSON.parse(raw) as { generation: string; checkpoint: string; complete: boolean };
  }
  if (!generation) throw new Error('Discovery build stayed in conflict');
  while (!generation.complete) generation = await answer(operator.main('POST', `/v1/discovery/generations/${generation.generation}/advance`, {
    actingSubject: operator.actingSubject, expectedCheckpoint: generation.checkpoint,
  }));
}, 300_000);
afterAll(async () => {
  try { await recording.publish(); }
  finally { await sessions?.close(); await pool?.end(); }
});

async function browse(name: PersonaName) {
  const person = sessions[name], root = `/v1/realms/${short(sessions.realm)}/modules/browse`;
  await recordFrameReads(recording, name, person, sessions.visitor, sessions.realm, sessions.zone,
    'space', short(sessions.zone), 'browse');
  await recordFollowHydration(name);
  await pageReads(name);
  const sample = recording.session(name, person), sampledCards = new Set<string>();
  const filters = [{}, { q: phrase }, { concept: manga }, { concept: oneShot }, { status: 'upcoming' },
    { publicationYear: '1995' }, { publicationYear: '1995-2001', concept: manga },
    { q: phrase, publicationYear: '1995', concept: manga, status: 'upcoming' }];
  const labels = ['browse-newest', 'search-newest', 'format-manga', 'format-one-shot', 'status-upcoming',
    'publication-year', 'publication-year-range-and-format', 'combined-filters'];
  for (const [index, filter] of filters.entries()) {
    const expected = works.filter(work => (!('concept' in filter) || work.concept === filter.concept)
      && (!('status' in filter) || work.status === filter.status)
      && (!('publicationYear' in filter) || work.year !== null && (filter.publicationYear === '1995-2001' || work.year === 1995)));
    const params = new URLSearchParams({ ...filter, sort: 'newest', limit: '3' });
    const seen: string[] = [], cursors = new Set<string>();
    let page: Page;
    do {
      page = await answer<Page>(seen.length === 0
        ? sample(labels[index]!, 'GET', `${root}?${params}`)
        : index === 0 && seen.length === 3
          ? sample('browse-newest-continuation', 'GET', `${root}?${params}`)
          : person.main('GET', `${root}?${params}`));
      if (seen.length === 0 || index === 0 && seen.length === 3) for (const item of page.items) sampledCards.add(item.id);
      for (const item of page.items) expect(item.primaryCredits).toContainEqual(expect.objectContaining({ agent: sessions.owner.actingSubject, role: 'author' }));
      seen.push(...page.items.map(item => item.id));
      if ('publicationYear' in filter) {
        expect(page.query.publicationYear).toBe(filter.publicationYear);
        const [min, max = min] = filter.publicationYear!.split('-');
        expect(page.query.filter.all).toContainEqual({ facet: 'publicationYear', range: { min, max } });
      }
      if (page.nextCursor) {
        expect(cursors.has(page.nextCursor)).toBe(false);
        cursors.add(page.nextCursor); params.set('cursor', page.nextCursor);
      }
    } while (page.nextCursor);
    expect(seen.length).toBe(expected.length);
    expect(new Set(seen).size).toBe(expected.length);
    expect(seen.sort()).toEqual(expected.map(work => work.work).sort());
    expect(seen).not.toContain(privateWork);
    expect(page.matches).toEqual({ value: expected.length, kind: 'exact' });
    expect(page.window.complete).toBe(true);
    if (expected.length > 3) expect(cursors.size).toBeGreaterThan(0);
  }
  const empty = await answer<Page>(sample('search-no-match', 'GET', `${root}?${new URLSearchParams({
    sort: 'newest', limit: '3', q: `${phrase}nomatch`,
  })}`));
  expect(empty.items).toEqual([]);
  expect(empty.nextCursor).toBeNull();
  await answer(sample('unsupported-query-shape', 'GET', `${root}?sort=relevance&limit=3`), 400);
  if (name === 'owner') await supportingReads(sample, person, sampledCards);
  if (name !== 'visitor' && name !== 'owner') {
    await answer(person.main('POST', '/v1/statement-decisions', { profile: 'statement-decision-v1',
      target: { kind: 'statement', statement }, acceptance: { kind: 'global' }, expectedDecisionHead: null,
      outcome: 'rejected', actingSubject: person.actingSubject }), 403);
    const work = works[0]!;
    await answer(person.main('POST', '/v1/publication-selections', { profile: 'realm-local-selection-v1',
      work: work.work, contribution: work.contribution, publicationDecision: work.publicationDecision,
      expectedSelectionHead: null, context: { kind: 'realm-local', id: sessions.realm }, mainVersion: work.mainVersion,
      selectionBasis: 'realm-manager-review', actingSubject: person.actingSubject }), 403);
  }
}
/** The header control refetches when the server follow has no following or no level. */
async function recordFollowHydration(name: PersonaName) {
  const person = sessions[name];
  const actingSubject = person.actingSubject;
  if (!actingSubject) return;
  const realmId = short(sessions.realm);
  const headerResponse = await sessions.visitor.main('GET', `/v1/realms/${realmId}`);
  if (!headerResponse.ok) throw new Error(`Realm header for follow state: HTTP ${headerResponse.status}: ${await headerResponse.text()}`);
  const header = await headerResponse.json() as { id?: string };
  if (!header.id) throw new Error('Realm header has no id for follow state');
  const followResponse = await person.main('GET', `/v1/follows/${realmId}?${new URLSearchParams({
    kind: 'realm', actingSubject,
  })}`);
  let refresh = true;
  if (followResponse.ok) {
    const follow = await followResponse.json() as { following?: boolean | null; level?: string | null };
    refresh = follow.following == null || follow.level == null;
  } else await followResponse.body?.cancel();
  if (!refresh) return;
  const params = new URLSearchParams({ actingSubject, target: header.id, kind: 'realm' });
  await answer(recording.session(name, person)('frame-follow-state', 'GET', `/v1/me/follow-state?${params}`));
}

async function pageReads(name: PersonaName) {
  const publicRead = recording.session(name, sessions.visitor);
  const realmRoot = `/v1/realms/${short(sessions.realm)}`;
  if (name !== 'visitor') {
    const personalRead = recording.session(name, sessions[name]);
    const header = await personalRead('frame-personal-realm-header', 'GET', realmRoot);
    await header.body?.cancel();
    const address = await personalRead('frame-personal-space-address', 'GET', `/v1/addresses/resolve?${new URLSearchParams({
      scope: 'space', key: short(sessions.space),
    })}`);
    await address.body?.cancel();
  }
  const addresses: [string, Record<string, string>][] = [
    ['page-browse-default', {}],
    ['page-browse-newest', { sort: 'newest' }],
    ['page-browse-updated', { sort: 'updated' }],
    ['page-search-default', { q: phrase }],
    ['page-search-relevance', { q: phrase, sort: 'relevance' }],
    ['page-search-newest', { q: phrase, sort: 'newest' }],
    ['page-search-updated', { q: phrase, sort: 'updated' }],
    ['page-search-no-match', { q: `${phrase}nomatch` }],
    ['page-search-no-match-relevance', { q: `${phrase}nomatch`, sort: 'relevance' }],
    ['page-publication-year', { year: '1995' }],
    ['page-publication-year-and-search', { q: phrase, year: '1995' }],
  ];
  for (const [label, address] of addresses) {
    let cursor: string | null = null;
    let continuation = 0;
    do {
      const year = catalogueYearParam(address.year);
      // Match catalogueBrowseQuery: the address's single year follows mainBrowseQuery.
      // A year range is dropped by catalogueYearParam and has no distinct page read.
      const query = { ...mainBrowseQuery(parseBrowseState({ ...address, ...(cursor ? { cursor } : {}) })),
        ...(year !== null ? { publicationYear: String(year) } : {}) };
      const params = new URLSearchParams(query as Record<string, string>);
      const path = `${realmRoot}/modules/browse${params.size ? `?${params}` : ''}`;
      const page = await answer<Page>(publicRead(continuation ? `${label}-continuation-${continuation}` : label, 'GET', path));
      if (label === 'page-browse-default' && continuation === 0) {
        await recordZoneBrowseContinuation(recording, name, sessions[name], sessions.zone, page.nextCursor);
      }
      cursor = page.nextCursor;
      continuation++;
    } while (cursor);
  }
}
// The Zone browse frame and catalogue-facts/year-directory reads used by the page.
async function supportingReads(sample: ReturnType<OutcomeRecorder['session']>, person: PersonaSession, cards: Set<string>) {
  const viewer = (path: string) => `${path}${path.includes('?') ? '&' : '?'}${acting(person)}`;
  const realmRoot = `/v1/realms/${short(sessions.realm)}`, zoneRoot = `/v1/zones/${short(sessions.zone)}`;
  await answer(sample('realm-context', 'GET', viewer(realmRoot)));
  await answer(sample('space-address', 'GET', viewer(`/v1/addresses/resolve?${new URLSearchParams({ scope: 'space', key: short(sessions.space) })}`)));
  await answer(sample('zone-presentation', 'GET', viewer(`${zoneRoot}/presentation`)));
  await answer(sample('browse-route-fallback', 'GET', viewer(`${zoneRoot}/routes?path=browse`)), 404);
  await answer(sample('facet-labels', 'GET', '/v1/facets'));
  await answer(sample('joining-context', 'GET', `${realmRoot}/joining?${acting(person)}`));
  await answer(sample('follow-context', 'GET', `/v1/follows/${short(sessions.realm)}?kind=realm&${acting(person)}`));
  const ban = await sample('member-ban-context', 'GET', `${realmRoot}/member-ban?${acting(person)}`);
  await ban.body?.cancel();
  const definition = await sample('volume-count-definition', 'GET', viewer('/v1/lexicon/definitions/volume-count?languages=en'));
  expect([200, 404]).toContain(definition.status);
  await definition.body?.cancel();
  for (const [index, work] of works.filter(work => cards.has(work.work)).entries()) {
    const id = short(work.work);
    const projection = await answer<{ sections: { id: string; href: string }[] }>(
      sample(`card-${index}-projection`, 'GET', viewer(`/v1/resources/${id}/page`)));
    await answer(sample(`card-${index}-classifications`, 'GET', viewer(`/v1/works/${id}/classifications?scope=global`)));
    const section = projection.sections.find(section => section.id === 'statements');
    expect(section).toBeDefined();
    await answer(sample(`card-${index}-statements`, 'GET', viewer(section!.href)));
  }
  await answer(recording.session('owner', sessions.visitor)('publication-year-directory', 'POST', '/v1/query', {
    profile: 'template-query-v1', query: 'https://rezics.com/query/work-publication-years', revision: 1,
    parameters: {}, limit: 20,
  }));
}

outcomeTest(catalogue, 'visitor', () => browse('visitor'), recording);
outcomeTest(catalogue, 'stranger', () => browse('stranger'), recording);
outcomeTest(catalogue, 'member', () => browse('member'), recording);
outcomeTest(catalogue, 'owner', () => browse('owner'), recording);
outcomeTest(catalogue, 'moderator', () => browse('moderator'), recording);
outcomeTest(catalogue, 'operator', () => browse('operator'), recording);

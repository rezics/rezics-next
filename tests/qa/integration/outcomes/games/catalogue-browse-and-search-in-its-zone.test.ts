import { afterAll, beforeAll, expect, setDefaultTimeout } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { fromPlainText } from '@rezics/document';
import declaration from '../../../../../scripts/qa/cases/outcomes/games/catalogue-browse-and-search-in-its-zone.ts';
import { OutcomeRecorder, outcomeTest } from '../../../support/outcome-test.ts';
import { recordCatalogueStoryReads } from '../../../support/catalogue-story-reads.ts';
import { personaSessions, type PersonaName, type PersonaSession, type PersonaSessions } from '../../../support/personas.ts';

setDefaultTimeout(60_000);
type Work = { work: string; mainVersion: string };
let sessions: PersonaSessions;
const recording = new OutcomeRecorder(declaration);
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
  finally { await sessions?.close(); }
});

type Selection = Awaited<ReturnType<typeof publish>>;
type Page = { items: { id: string }[]; nextCursor: string | null; matches: { value: number; kind: string };
  query: { appliedSort: string }; window: { complete: boolean };
  sourcePosition: { dataEpoch: string; sequence: string } };
const games: Work[] = [];
const phrase = `Gamegarden${randomUUID().replaceAll('-', '')}`;
let unadopted: Work;
let unadoptedSelection: Selection;
let unrelatedRealm: string;
const editorRole = randomUUID();
async function role(change: object) {
  const owner = sessions.owner;
  const root = `/v1/realms/${short(sessions.realm)}`;
  const current = await fixture<{ generation: string }>(owner.main('GET', `${root}/roles?${acting(owner)}`));
  const command = { actingSubject: owner.actingSubject, expectedGeneration: current.generation,
    reason: 'Curate an original game catalogue with explicit adoption authority', change };
  const preview = await fixture<{ digest: string }>(owner.main('POST', `${root}/role-impact`, command));
  await fixture(owner.main('POST', `${root}/role-changes`, { ...command, impactDigest: preview.digest }), 201);
}
function adoption(selection: Selection, person: PersonaSession) {
  return { ...selection, actingSubject: person.actingSubject ?? sessions.owner.actingSubject,
    profile: 'realm-local-selection-v1', context: { kind: 'realm-local', id: sessions.realm },
    mainVersion: selection.work === unadopted?.work ? unadopted.mainVersion
      : games.find(game => game.work === selection.work)?.mainVersion,
    selectionBasis: 'realm-manager-review' };
}
beforeAll(async () => {
  sessions = await personaSessions('public');
  await recording.prepare();
  const otherRealm = await fixture<{ realm: string }>(sessions.stranger.main('POST', '/v1/spaces', {
    profile: 'space-realm-v2', name: 'Unrelated synthetic catalogue Realm',
    handle: `unrelated-${randomUUID().slice(0, 12)}`, language: 'en', capabilities: ['realm'],
    actingSubject: sessions.stranger.actingSubject,
    initialSettings: { visibility: 'public', reviewRequired: false, reviewMode: 'open',
      whoMaySubmit: 'members', selfJoin: true, rules: [] },
  }), 201);
  unrelatedRealm = otherRealm.realm;
  await fixture(sessions.stranger.main('POST', `/v1/realms/${short(unrelatedRealm)}/management`, {
    actingSubject: sessions.stranger.actingSubject,
  }));
  const zonePath = `/v1/zones/${short(sessions.zone)}`;
  let editor = await fixture<{ revision: string; configuration: { homeDocument?: string };
    preview: { navigation: { revision: string } } }>(
    sessions.owner.main('GET', `${zonePath}/showcase-editor?${acting(sessions.owner)}`));
  if (!editor.configuration.homeDocument) {
    await fixture(sessions.owner.main('PUT', `${zonePath}/configuration`, {
      expectedHead: editor.revision, prepareHomeDocument: true,
      actingSubject: sessions.owner.actingSubject,
    }));
    editor = await fixture(sessions.owner.main('GET', `${zonePath}/showcase-editor?${acting(sessions.owner)}`));
  }
  const homeDocument = editor.configuration.homeDocument;
  if (!homeDocument) throw new Error('Zone editor must expose its prepared home document');
  const variantId = `urn:rezics:variant:${randomUUID()}`;
  const page = await fixture<{ revisionId: string; byteDigest: string; sourcePosition: { dataEpoch: string } }>(
    sessions.owner.main('POST', '/v1/content-drafts', {
      profile: 'content-text-v1', resourceId: homeDocument, variantId, expectedHead: null,
      document: fromPlainText('Original synthetic game catalogue by the fixture owner.', 'blocks'),
      language: { kind: 'tag', tag: 'en', originalTag: 'en' }, direction: 'ltr',
      actingSubject: sessions.owner.actingSubject,
    }), 201);
  await fixture(sessions.owner.main('POST', `${zonePath}/site-publications`, {
    expectedHead: editor.revision, routesRevision: editor.preview.navigation.revision,
    navigationRevision: editor.preview.navigation.revision,
    pages: [{ page: homeDocument, variantId, revisionId: page.revisionId,
      byteDigest: page.byteDigest, contentEpoch: page.sourcePosition.dataEpoch }],
    actingSubject: sessions.owner.actingSubject,
  }), 201);
  await role({ kind: 'role', roleId: editorRole, name: 'Game catalogue editors', permissions: ['publication.adopt'] });
  await role({ kind: 'assignment', roleId: editorRole, member: sessions.owner.actingSubject,
    assigned: true, validUntil: new Date(Date.now() + 3_600_000).toISOString() });
  for (let index = 0; index < 4; index++) {
    const game = await createGame(`${phrase} ${index}`, index === 3 ? 'Book' : 'VideoGame');
    const selection = await publish(game);
    await fixture(sessions.owner.main('POST', '/v1/publication-selections', {
      ...selection, profile: 'realm-local-selection-v1',
      context: { kind: 'realm-local', id: sessions.realm }, mainVersion: game.mainVersion,
      selectionBasis: 'realm-manager-review',
    }), 201);
    if (index !== 3) games.push(game);
  }
  unadopted = await createGame(`${phrase} published but not adopted`);
  unadoptedSelection = await publish(unadopted);
  await role({ kind: 'assignment', roleId: editorRole, member: sessions.owner.actingSubject, assigned: false,
    validUntil: new Date(Date.now() + 3_600_000).toISOString() });
}, 180_000);

async function catalogue(name: PersonaName) {
  const person = sessions[name];
  await recordCatalogueStoryReads(recording, name, person, sessions.realm, 'games');
  const sample = recording.session(name, person);
  const sampledCards = new Set<string>();
  const home = await answer<{ kind: string; realm: string }>(sample('zone-home-route', 'GET',
    `/v1/zones/${short(sessions.zone)}/routes?path=%2F&${acting(person)}`));
  expect(home).toMatchObject({ kind: 'home', realm: sessions.realm });
  const root = `/v1/realms/${short(home.realm)}/modules/browse`;
  expect(await answer<{ code: string }>(sample('unsupported-query-shape', 'GET',
    `${root}?sort=relevance&limit=10&type=https%3A%2F%2Fschema.org%2FVideoGame`), 400))
    .toMatchObject({ code: 'unsupported_query_shape' });
  for (const sort of ['newest', 'updated', 'relevance']) {
    for (const q of sort === 'relevance' ? [phrase] : ['', phrase]) {
      const params = new URLSearchParams({ sort, limit: '2', type: 'https://schema.org/VideoGame', ...(q ? { q } : {}) });
      const seen: string[] = [];
      let page: Page;
      let pageNumber = 0;
      do {
        page = await answer<Page>(sample(`${q ? 'search' : 'browse'}-${sort}-${pageNumber++}`, 'GET', `${root}?${params}`));
        for (const item of page.items) sampledCards.add(item.id);
        seen.push(...page.items.map(item => item.id));
        expect(seen.length).toBeLessThanOrEqual(games.length);
        if (page.nextCursor) params.set('cursor', page.nextCursor);
      } while (page.nextCursor);
      expect(new Set(seen).size).toBe(games.length);
      expect(seen.sort()).toEqual(games.map(game => game.work).sort());
      expect(page.matches).toEqual({ value: games.length, kind: 'exact' });
      expect(page.query.appliedSort).toBe(sort === 'relevance' ? 'newest' : sort);
    }
  }
  await credit(person, games[0]!, sample);
  const attempt = adoption(unadoptedSelection, person);
  // The primary Realm's creator already holds its initialized adoption mandate.
  // Owning this Work supplies no such mandate in the independently owned Realm.
  if (name === 'owner') attempt.context.id = unrelatedRealm;
  await answer(sample('adoption-refused', 'POST', '/v1/publication-selections', attempt),
    name === 'visitor' ? 401 : 403);
  if (name === 'moderator') {
    // Joined moderation alone was refused above; this independent role supplies curation.
    await role({ kind: 'assignment', roleId: editorRole, member: person.actingSubject,
      assigned: true, validUntil: new Date(Date.now() + 3_600_000).toISOString() });
    const adopted = await answer<{ sourcePosition: { dataEpoch: string; sequence: string } }>(
      sample('adoption-authorized', 'POST', '/v1/publication-selections',
      adoption(unadoptedSelection, person)), 201);
    expect(adopted).toMatchObject({ work: unadopted.work, realm: sessions.realm,
      publicationDecision: unadoptedSelection.publicationDecision });
    games.push(unadopted);
    const curated = await answer<Page>(sample('curated-search', 'GET',
      `${root}?${new URLSearchParams({ q: 'published but not adopted', type: 'https://schema.org/VideoGame' })}`));
    expect(curated.items.every(item => item.id === unadopted.work)).toBe(true);
    expect(curated.matches.value).toBe(curated.items.length);
    expect(curated.sourcePosition.dataEpoch).toBe(adopted.sourcePosition.dataEpoch);
    console.log(JSON.stringify({ row: declaration.rowId, persona: name,
      expectedWork: unadopted.work, expectedRealm: sessions.realm,
      adoptionRequest: { method: 'POST', path: '/v1/publication-selections',
        body: adoption(unadoptedSelection, person) }, adoptionAnswer: adopted,
      browseRequest: { method: 'GET', path: `${root}?${new URLSearchParams({
        q: 'published but not adopted', type: 'https://schema.org/VideoGame',
      })}` }, browseAnswer: curated,
      adoptionPosition: adopted.sourcePosition, browsePosition: curated.sourcePosition,
      matches: curated.matches, window: curated.window, items: curated.items.map(item => item.id) }));
    if (curated.window.complete) {
      expect(curated.matches.kind).toBe('exact');
      if (BigInt(curated.sourcePosition.sequence) >= BigInt(adopted.sourcePosition.sequence)) {
        expect(curated.items.map(item => item.id)).toEqual([unadopted.work]);
      }
    } else {
      // A successful adoption is not a promise of an immediately current projection.
      expect(curated.matches.kind).toBe('lower-bound');
    }
  }
  if (name === 'member') await supportingReads(person, sample, sampledCards);
}

async function supportingReads(person: PersonaSession, sample: ReturnType<typeof recording.session>, cards: Set<string>) {
  const viewer = (path: string) => `${path}${path.includes('?') ? '&' : '?'}${acting(person)}`;
  const realm = `/v1/realms/${short(sessions.realm)}`;
  const zone = `/v1/zones/${short(sessions.zone)}`;
  const empty = await answer<Page>(sample('search-no-match', 'GET', `${realm}/modules/browse?${new URLSearchParams({
    sort: 'relevance', limit: '10', type: 'https://schema.org/VideoGame', q: `${phrase}nomatch`,
  })}`));
  expect(empty.items).toEqual([]);
  for (const [label, path] of [
    ['realm-context', realm],
    ['space-address', `/v1/addresses/resolve?${new URLSearchParams({ scope: 'space', key: short(sessions.space) })}`],
    ['zone-presentation', `${zone}/presentation`],
    ['facet-labels', '/v1/facets'],
    ['joining-context', `${realm}/joining`],
    ['follow-context', `/v1/follows/${short(sessions.realm)}?kind=realm`],
  ] as const) await answer(sample(label, 'GET', viewer(path)));
  await answer(sample('browse-route-fallback', 'GET', viewer(`${zone}/routes?path=browse`)), 404);
  const states = new URLSearchParams({ works: [...cards].join(','), actingSubject: person.actingSubject! });
  await answer(sample('card-reader-states', 'GET', `/v1/me/work-states?${states}`));
  for (const [index, work] of games.entries()) {
    if (!cards.has(work.work)) continue;
    const id = short(work.work);
    const projection = await answer<{ sections: { id: string; href: string }[] }>(
      sample(`card-${index}-projection`, 'GET', viewer(`/v1/resources/${id}/page`)));
    await answer(sample(`card-${index}-classifications`, 'GET', viewer(`/v1/works/${id}/classifications?scope=global`)));
    const facts = projection.sections.find(section => section.id === 'statements');
    if (facts) await answer(sample(`card-${index}-statements`, 'GET', viewer(facts.href)));
  }
}

outcomeTest(declaration, 'visitor', () => catalogue('visitor'), recording);

outcomeTest(declaration, 'stranger', () => catalogue('stranger'), recording);

outcomeTest(declaration, 'member', () => catalogue('member'), recording);

outcomeTest(declaration, 'owner', () => catalogue('owner'), recording);

outcomeTest(declaration, 'operator', () => catalogue('operator'), recording);

outcomeTest(declaration, 'moderator', () => catalogue('moderator'), recording);


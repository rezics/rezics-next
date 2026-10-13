import { afterAll, beforeAll, expect, setDefaultTimeout } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { fromPlainText } from '@rezics/document';
import catalogue from '../../../../../scripts/qa/cases/outcomes/books/catalogue-browse-and-search-in-its-zone.ts';
import { OutcomeRecorder, outcomeTest } from '../../../support/outcome-test.ts';
import {
  personaSessions,
  type PersonaName,
  type PersonaSession,
  type PersonaSessions,
} from '../../../support/personas.ts';

type Work = { work: string; mainVersion: string };
type Page<T> = { items: T[]; nextCursor: string | null; matches: { value: number; kind: string } };
setDefaultTimeout(60_000);
let sessions: PersonaSessions;
const works: Work[] = [];
const phrase = `Bookgarden${randomUUID().replaceAll('-', '')}`;
const recording = new OutcomeRecorder(catalogue);
const short = (id: string) => id.slice(-36);
const acting = (person: PersonaSession) =>
  person.actingSubject ? `actingSubject=${encodeURIComponent(person.actingSubject)}` : '';

async function answer<T>(request: Promise<Response>, status = 200): Promise<T> {
  const response = await request;
  const raw = await response.text();
  expect(response.status, `${response.status}: ${raw}`).toBe(status);
  return JSON.parse(raw) as T;
}
// Setup exceptions stay in beforeAll: a failed fixture is never an expected product failure.
beforeAll(async () => {
  sessions = await personaSessions('public');
  await recording.prepare();
  const owner = sessions.owner,
    actor = owner.actingSubject;
  const root = `/v1/realms/${short(sessions.realm)}`;
  const roleId = randomUUID();
  for (const change of [
    { kind: 'role', roleId, name: 'Catalogue editors', permissions: ['publication.adopt'] },
    {
      kind: 'assignment',
      roleId,
      member: actor,
      assigned: true,
      validUntil: new Date(Date.now() + 3_600_000).toISOString(),
    },
  ]) {
    const roles = await answer<{ generation: string }>(
      owner.main('GET', `${root}/roles?${acting(owner)}`),
    );
    const command = {
      actingSubject: actor,
      expectedGeneration: roles.generation,
      reason: 'Publish the original Book fixture catalogue',
      change,
    };
    const preview = await answer<{ digest: string }>(
      owner.main('POST', `${root}/role-impact`, command),
    );
    await answer(
      owner.main('POST', `${root}/role-changes`, { ...command, impactDigest: preview.digest }),
      201,
    );
  }
  for (let index = 0; index < 21; index++) {
    const work = await answer<Work>(
      owner.main('POST', '/v1/works', {
        profile: 'metadata-only-v1',
        title: `${phrase} ${index}`,
        language: 'en',
        semanticTypes: ['https://schema.org/Book'],
        authoring: 'own-work',
        actingSubject: actor,
      }),
      201,
    );
    const draft = await answer<{ contribution: string; draftRevision: string }>(
      owner.main('POST', '/v1/contributions', {
        profile: 'text-contribution-v1',
        work: work.work,
        language: 'en',
        body: `An original fixture story: gardener ${index} plants a seed and watches it grow.`,
        actingSubject: actor,
      }),
      201,
    );
    const publication = await answer<{ publicationDecision: string }>(
      owner.main('POST', '/v1/contribution-publications', {
        profile: 'text-publication-v1',
        contribution: draft.contribution,
        expectedDraftHead: draft.draftRevision,
        expectedPublicationHead: null,
        rightsBasis: 'original-contribution',
        disclosure: 'public',
        actingSubject: actor,
      }),
      201,
    );
    const selection = {
      work: work.work,
      contribution: draft.contribution,
      publicationDecision: publication.publicationDecision,
      expectedSelectionHead: null,
      actingSubject: actor,
    };
    await answer(
      owner.main('POST', '/v1/publication-selections', {
        ...selection,
        profile: 'main-default-selection-v1',
        context: { kind: 'main-version-default', id: work.mainVersion },
        selectionBasis: 'main-maintainer',
      }),
      201,
    );
    await answer(
      owner.main('POST', '/v1/publication-selections', {
        ...selection,
        profile: 'realm-local-selection-v1',
        context: { kind: 'realm-local', id: sessions.realm },
        mainVersion: work.mainVersion,
        selectionBasis: 'realm-manager-review',
      }),
      201,
    );
    works.push(work);
  }
  // A real public site supplies the browse frame's presentation and route answers.
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
      variantId, expectedHead: null, document: fromPlainText('Original Book fixture catalogue', 'blocks'),
      language: { kind: 'tag', tag: 'en', originalTag: 'en' }, direction: 'ltr', actingSubject: actor }), 201);
  await answer(owner.main('POST', `${zoneRoot}/site-publications`, {
    routesRevision: navigation.revision, navigationRevision: navigation.revision,
    expectedHead: configuration.revision, actingSubject: actor,
    pages: [{ page: configuration.configuration.homeDocument, variantId, revisionId: draft.revisionId,
      byteDigest: draft.byteDigest, contentEpoch: draft.sourcePosition.dataEpoch }],
  }), 201);
  // The projection must catch up with fixture writes before a cursor pins its count precision.
  const readyPath = `${root}/modules/browse?${new URLSearchParams({ sort: 'newest', limit: '1',
    type: 'https://schema.org/Book', q: `${phrase}nomatch` })}`;
  const deadline = AbortSignal.timeout(45_000);
  let stable = 0;
  let position: string | undefined;
  for (;;) {
    const ready = await answer<Page<{ id: string }> & { sourcePosition: { dataEpoch: string; sequence: string } }>(
      owner.main('GET', readyPath));
    const nextPosition = JSON.stringify(ready.sourcePosition);
    stable = ready.matches.kind === 'exact' ? (nextPosition === position ? stable + 1 : 1) : 0;
    position = nextPosition;
    if (stable === 5) break;
    deadline.throwIfAborted();
    await Bun.sleep(500);
  }
}, 240_000);
afterAll(async () => {
  try { await recording.publish(); }
  finally { await sessions?.close(); }
});

async function browse(name: PersonaName) {
  const person = sessions[name];
  const sample = recording.session(name, person);
  const sampledCards = new Set<string>();
  const root = `/v1/realms/${short(sessions.realm)}/modules`;
  const refused = await answer<{ code: string }>(
    sample('unsupported-query-shape', 'GET', `${root}/browse?sort=relevance&limit=10&type=https%3A%2F%2Fschema.org%2FBook`),
    400,
  );
  expect(refused.code).toBe('unsupported_query_shape');
  for (const sort of ['newest', 'updated', 'relevance']) {
    for (const q of sort === 'relevance' ? [phrase] : ['', phrase]) {
      const params = new URLSearchParams({
        sort,
        limit: '10',
        type: 'https://schema.org/Book',
        ...(q ? { q } : {}),
      });
      const seen: string[] = [];
      let pageNumber = 0;
      let page: Page<{ id: string }>;
      do {
        const path = `${root}/browse?${params}`;
        page = await answer<Page<{ id: string }>>(pageNumber === 0
          ? sample(`${q ? 'search' : 'browse'}-${sort}-${pageNumber}`, 'GET', path)
          : person.main('GET', path));
        if (pageNumber === 0) {
          for (const item of page.items) sampledCards.add(item.id);
          if (sort === 'newest' && !q) {
            expect(page.nextCursor).not.toBeNull();
            const continuationQuery = new URLSearchParams(params);
            continuationQuery.set('limit', '1');
            continuationQuery.set('cursor', page.nextCursor!);
            const continuation = await answer<Page<{ id: string }>>(sample('browse-newest-continuation', 'GET',
              `${root}/browse?${continuationQuery}`));
            expect(continuation.items).toHaveLength(1);
            expect(works.some(work => work.work === continuation.items[0]!.id)).toBe(true);
            expect(page.items.some(item => item.id === continuation.items[0]!.id)).toBe(false);
            expect(continuation.nextCursor).not.toBeNull();
            sampledCards.add(continuation.items[0]!.id);
          }
        }
        pageNumber++;
        seen.push(...page.items.map((item) => item.id));
        if (page.nextCursor) params.set('cursor', page.nextCursor);
      } while (page.nextCursor);
      expect(seen.length).toBe(21);
      expect(new Set(seen).size).toBe(21);
      expect(seen.sort()).toEqual(works.map((work) => work.work).sort());
      expect(page.matches).toEqual({ value: 21, kind: 'exact' });
    }
  }
  const empty = await answer<Page<{ id: string }>>(sample('search-no-match', 'GET', `${root}/browse?${new URLSearchParams({
    sort: 'relevance', limit: '10', type: 'https://schema.org/Book', q: `${phrase}nomatch`,
  })}`));
  expect(empty.items).toEqual([]);
  expect(empty.nextCursor).toBeNull();
  expect(empty.matches).toEqual({ value: 0, kind: 'exact' });
  const first = await answer<Page<{ id: string }>>(
    sample('new-adoptions', 'GET', `${root}/new-adoptions?limit=20`),
  );
  expect(first.nextCursor).not.toBeNull();
  const second = await answer<Page<{ id: string }>>(
    sample('new-adoptions-continuation',
      'GET',
      `${root}/new-adoptions?limit=20&cursor=${encodeURIComponent(first.nextCursor!)}`,
    ),
  );
  expect([...first.items, ...second.items].map((item) => item.id).sort()).toEqual(
    works.map((work) => work.work).sort(),
  );
  expect(second.nextCursor).toBeNull();
  await supportingReads(name, sample, sampledCards);
}

async function supportingReads(name: PersonaName, sample: ReturnType<typeof recording.session>, sampledCards: Set<string>) {
  const person = sessions[name];
  const viewer = (path: string) => person.actingSubject ? `${path}${path.includes('?') ? '&' : '?'}${acting(person)}` : path;
  const realmRoot = `/v1/realms/${short(sessions.realm)}`;
  const zoneRoot = `/v1/zones/${short(sessions.zone)}`;
  const realm = await answer<{ id: string }>(sample('realm-context', 'GET', viewer(realmRoot)));
  expect(realm.id).toBe(sessions.realm);
  const address = await answer<{ capabilities: { realm: string } }>(sample('space-address', 'GET',
    viewer(`/v1/addresses/resolve?${new URLSearchParams({ scope: 'space', key: short(sessions.space) })}`)));
  expect(address.capabilities.realm).toBe(sessions.realm);
  const presentation = await answer<{ zone: string; realm: string }>(sample('zone-presentation', 'GET', viewer(`${zoneRoot}/presentation`)));
  expect(presentation.zone).toBe(sessions.zone);
  expect(presentation.realm).toBe(sessions.realm);
  const route = await answer<{ code: string }>(sample('browse-route-fallback', 'GET', viewer(`${zoneRoot}/routes?path=browse`)), 404);
  expect(route.code).toBe('route_missing');
  const facets = await answer<{ facets: unknown[] }>(sample('facet-labels', 'GET', '/v1/facets'));
  expect(Array.isArray(facets.facets)).toBe(true);
  // An absent count definition is the page's truthful no-count answer.
  const definition = await sample('volume-count-definition', 'GET', viewer('/v1/lexicon/definitions/volume-count?languages=en'));
  expect([200, 404]).toContain(definition.status);
  await definition.body?.cancel();
  if (person.actingSubject) {
    await answer(sample('joining-context', 'GET', `${realmRoot}/joining?${acting(person)}`));
    await answer(sample('follow-context', 'GET', `/v1/follows/${short(sessions.realm)}?kind=realm&${acting(person)}`));
  }
  const cardReads = async (work: Work, index: number) => {
    const id = short(work.work);
    const [projection, classifications] = await Promise.all([
      answer<{ sections: { id: string; href: string }[] }>(
        sample(`card-${index}-projection`, 'GET', viewer(`/v1/resources/${id}/page`))),
      answer<{ items: unknown[]; nextCursor: string | null }>(
        sample(`card-${index}-classifications`, 'GET', viewer(`/v1/works/${id}/classifications?scope=global`))),
    ]);
    expect(classifications.nextCursor).toBeNull();
    expect(Array.isArray(classifications.items)).toBe(true);
    const section = projection.sections.find(item => item.id === 'statements');
    expect(section).toBeDefined();
    const statements = await answer<{ groups: unknown[]; nextCursor: string | null }>(
      sample(`card-${index}-statements`, 'GET', viewer(section!.href)));
    expect(statements.nextCursor).toBeNull();
    expect(Array.isArray(statements.groups)).toBe(true);
  };
  // The populated browse samples and bounded continuation carry only cards whose facts are proved here.
  const cards = works.flatMap((work, index) => sampledCards.has(work.work) ? [{ work, index }] : []);
  for (let offset = 0; offset < cards.length; offset += 3) {
    const results = await Promise.allSettled(cards.slice(offset, offset + 3).map(({ work, index }) => cardReads(work, index)));
    for (const result of results) if (result.status === 'rejected') throw result.reason;
  }
}

outcomeTest(catalogue, 'visitor', () => browse('visitor'), recording);
outcomeTest(catalogue, 'stranger', () => browse('stranger'), recording);
outcomeTest(catalogue, 'member', () => browse('member'), recording);
outcomeTest(catalogue, 'owner', () => browse('owner'), recording);
outcomeTest(catalogue, 'moderator', () => browse('moderator'), recording);
outcomeTest(catalogue, 'operator', () => browse('operator'), recording);

import { readSearchReleaseFacts } from '../src/modules/release/read.ts';
import { checkedReleaseV2, resolvedReleaseV2 } from '../src/modules/release/schema.ts';
import type { WorkReadSession } from '../src/modules/work/read-session.ts';
import { searchText } from '../src/modules/search/text.ts';
import { matchingExcerpt } from '../src/modules/search/excerpts.ts';
import { disclosureViewer, withDisclosureViewer } from '../src/modules/disclosure/viewer.ts';
import { configureDisclosure } from '../src/modules/disclosure/read.ts';
import { configureFixtureDisclosureAncestry, fixtureDisclosureReader } from './support/disclosure-ancestry.ts';
import { expect, test } from 'bun:test';
import { Value } from 'typebox/value';
import type { Static } from 'typebox';
import { publicPhrasePageRequest, searchExcerpt, searchDisambiguation, phraseMatch } from '../src/api-contract.ts';
import { matchesSearchText } from '../src/modules/search/fields.ts';
import { pageCompletePublicRelation, SearchContinuationRestart } from '../src/modules/work/search-continuation.ts';
import { pageCompleteContentRelation } from '../src/modules/content-publication/search-continuation.ts';
import { enrichSearchCardPage } from '../src/modules/search/result-cards.ts';
import { SearchSnapshotMoved } from '../src/modules/work/search-readiness.ts';
import type { MainWorkDependencies } from '../src/routes/dependencies.ts';
import type { ExactContentReference } from '../../content/src/core.ts';

test('keywords require every literal token independently of order, adjacency and whitespace', () => {
  expect(matchesSearchText('The Left Hand of Darkness', 'darkness   left', false, 'keywords')).toBe(true);
  expect(matchesSearchText('The Left Hand of Darkness', 'left\t darkness', false, 'keywords')).toBe(true);
  expect(matchesSearchText('The Left Hand of Darkness', 'left missing', false, 'keywords')).toBe(false);
  expect(matchesSearchText('C++ and A+B: a guide', 'A+B C++', false, 'keywords')).toBe(true);
  expect(matchesSearchText('C++ and A+B: a guide', '* OR', false, 'keywords')).toBe(false);
});

test('keywords keep CJK, a single code point and NFC without changing legacy phrases', () => {
  expect(matchesSearchText('西游记', '记 西', false, 'keywords')).toBe(true);
  expect(matchesSearchText('西游记', '西', false, 'keywords')).toBe(true);
  expect(matchesSearchText('café on the coast', 'coast cafe\u0301', false, 'keywords')).toBe(true);
  expect(matchesSearchText('The Left Hand of Darkness', 'darkness left', false)).toBe(false);
  expect(matchesSearchText('The Left Hand of Darkness', 'darkness left', false, 'phrase')).toBe(false);
  expect(matchesSearchText('The Left Hand of Darkness', 'left hand', false)).toBe(true);
});

const request = { profile: 'public-main-phrase-page-v1' as const, phrase: 'left darkness',
  language: null, pageSize: 1, matchMode: 'keywords' as const };
const position = { dataEpoch: 'epoch', sequence: '9' };
const relation = { resultGrain: 'mainVersion' as const, context: 'main-version-default' as const,
  complete: true as const, population: 2, total: 2, results: [{ work: 'a' }, { work: 'b' }],
  sourcePosition: { datasetId: 'product' as const, ...position }, indexGeneration: 'index' };

test('page schemas admit explicit keyword and phrase modes with single-character text', () => {
  for (const profile of ['public-main-phrase-page-v1', 'public-content-phrase-page-v1']) {
    for (const matchMode of ['keywords', 'phrase']) {
      expect(Value.Check(publicPhrasePageRequest, { ...request, profile, matchMode, phrase: '西' })).toBe(true);
    }
  }
  expect(Value.Check(publicPhrasePageRequest, { ...request, matchMode: 'fuzzy' })).toBe(false);
});

test('Work continuations bind match mode as well as normalized text, filters and source', () => {
  const first = pageCompletePublicRelation(request, relation, 1000);
  expect(() => pageCompletePublicRelation({ ...request, matchMode: 'phrase', continuation: first.next! }, relation, 1001))
    .toThrow(SearchContinuationRestart);
  expect(() => pageCompletePublicRelation({ ...request, phrase: 'left   darkness', continuation: first.next! }, relation, 1001))
    .not.toThrow();
  expect(() => pageCompletePublicRelation({ ...request, phrase: 'right darkness', continuation: first.next! }, relation, 1001))
    .toThrow(SearchContinuationRestart);
  expect(() => pageCompletePublicRelation({ ...request, includeTypes: ['https://schema.org/Book'], continuation: first.next! }, relation, 1001))
    .toThrow(SearchContinuationRestart);
});

test('Content continuations also refuse a changed match mode', () => {
  const input = { ...request, profile: 'public-content-phrase-page-v1' as const };
  const contentRelation = { contractVersion: '1' as const, profile: 'public-content-phrase-v1' as const,
    resultGrain: 'content-variant' as const, complete: true as const, total: 2, population: 2,
    results: ['a', 'b'].map(id => ({ matchUnit: id, resource: id, variant: id, revision: id,
      publicationDecision: id, language: 'en', score: 1 })),
    graphPosition: position, contentPosition: { owner: 'content' as const, ...position }, indexGeneration: 'index' };
  const first = pageCompleteContentRelation(input, contentRelation, 1000);
  expect(() => pageCompleteContentRelation({ ...input, matchMode: 'phrase', continuation: first.next! }, contentRelation, 1001))
    .toThrow(SearchContinuationRestart);
});

const resource = 'https://rezics.com/id/11111111-1111-4111-8111-111111111111';
const revisionId = '22222222-2222-4222-8222-222222222222';
const revision = `urn:rezics:content:revision:${revisionId}`;
const variant = 'https://rezics.com/id/33333333-3333-4333-8333-333333333333';
const sample = { matchUnit: 'urn:rezics:match:one', resource, variant, revision,
  publicationDecision: 'urn:rezics:publication:one', language: 'en', score: 1 };
const contentPage = { resultGrain: 'content-variant', graphPosition: position,
  contentPosition: { owner: 'content', ...position }, results: [sample] };
const reference: ExactContentReference = { owner: 'content', resourceId: resource,
  variantId: variant, revisionId, format: 'rezics-content-json-v1', model: 'content-shape-v1',
  byteDigest: 'a'.repeat(64), byteLength: 60, direction: 'ltr', sourceRevision: null,
  predecessor: null, language: { kind: 'tag', tag: 'en', originalTag: 'en' },
  provenance: { kind: 'admitted-original-contribution-v1' } };

function excerptFixture(options: { hidden?: boolean; withdrawn?: boolean; erased?: boolean;
  language?: string; wrongRevision?: boolean; moveAfterRead?: boolean; revokeAfterRead?: boolean;
  policyHidden?: boolean; publicationMoves?: boolean; publicDomain?: boolean; body?: string } = {}) {
  let reads = 0, moved = false;
  const value = (text: string) => ({ type: 'literal', value: text });
  const content = { ownerPosition: async () => ({ owner: 'content', ...position, sequence: moved ? '10' : '9' }),
    readExactBatch: async (ids: string[], authorize: (ids: readonly string[]) => Promise<ReadonlySet<string>>) => {
      expect([...await authorize(ids)]).toEqual(ids);
      reads++;
      moved = options.moveAfterRead ?? false;
      return [{ revisionId, status: 'available', reference: { ...reference,
        revisionId: options.wrongRevision ? '44444444-4444-4444-8444-444444444444' : revisionId,
        language: { kind: 'tag', tag: options.language ?? 'en', originalTag: options.language ?? 'en' },
        provenance: options.publicDomain ? { kind: 'admitted-public-domain-v1', rightsAssessmentId: '55555555-5555-4555-8555-555555555555' } : reference.provenance },
        serializedJson: JSON.stringify({ body: options.body ?? 'A long opening. Darkness falls on the left bank. A quiet ending.' }),
        body: { body: options.body ?? 'A long opening. Darkness falls on the left bank. A quiet ending.' } }];
    }, readExactMetadataBatch: async () => new Map([[revisionId,
      { availability: options.erased ? 'erased' : 'available', byteDigest: reference.byteDigest }]]) };
  const deps = { content, contentProjection: { content, consumer: 'public-search',
    cursor: { read: async () => position } },
    environment: { lineage: { dataEpoch: 'epoch', routingEpoch: 'routing' },
      fuseki: { query: async (query: string) => {
        if (query.includes('SELECT ?resource ?head')) return { results: { bindings: [{ resource: value(resource), head: value('urn:rezics:head:one') }] } };
        if (query.includes('SELECT ?work ?head')) return { results: { bindings: [{ work: value(resource), head: value('urn:rezics:head:one') }] } };
        expect(query).toContain('rv:contentPublicationHead ?publicationDecision');
        expect(query).toContain('rv:publicSearchEligibilityHead ?eligibility');
        expect(query).toContain('rv:ErasedRevision');
        return { results: { bindings: options.hidden || options.withdrawn || options.publicationMoves && reads > 0 ? [] : [{
        epoch: value('epoch'), sequence: value('9'), matchUnit: value(sample.matchUnit), resource: value(resource),
        variant: value(variant), revision: value(revision), publicationDecision: value(sample.publicationDecision),
        eligibility: value('urn:rezics:eligibility:one'), projection: value('urn:rezics:projection:one'), language: value('en'),
        rightsBasis: value(`https://rezics.com/vocab/${options.publicDomain ? 'PublicDomain' : 'OriginalContribution'}`),
        ...(options.publicDomain ? { assessment: value('urn:rezics:rights:assessment:55555555-5555-4555-8555-555555555555') } : {}),
      }] } }; } } },
    rights: { store: { currentPublicDomainAssessments: async (requests: Array<{ work: string; assessmentId: string }>) =>
      new Set(options.revokeAfterRead && reads > 0 ? [] : requests.map(item => `${item.work}\0${item.assessmentId}`)) } },
  } as unknown as MainWorkDependencies;
  configureFixtureDisclosureAncestry(deps.environment, target => target.work ? {
    resource: target.work, head: 'urn:rezics:head:one', protectedRevision: target.workRevision } : undefined);
  configureDisclosure(deps.environment, fixtureDisclosureReader(async targets => targets.map(target =>
    target.component === 'body' && options.policyHidden ? 'hidden' : 'visible')));
  return { deps, reads: () => reads };
}

async function excerptResult(options: Parameters<typeof excerptFixture>[0] = {}) {
  const fixture = excerptFixture(options);
  const page = await enrichSearchCardPage(fixture.deps, new Request('http://test'), contentPage, null,
    { phrase: 'left darkness', matchMode: 'keywords' });
  return { fixture, result: page.results[0] as typeof sample & { excerpt?: {
    status: string; text?: string; language?: string; revision?: string; reason?: string } } };
}

test('Content cards return bounded matching exact body text with its actual revision and language', async () => {
  const { fixture, result } = await excerptResult();
  expect(fixture.reads()).toBe(1);
  expect(result.resource).toBe(resource);
  expect(result.variant).toBe(variant);
  expect(result.excerpt?.status).toBe('available');
  expect(result.excerpt?.text).toContain('Darkness falls on the left bank');
  expect([...(result.excerpt?.text ?? '')].length).toBeLessThanOrEqual(240);
  expect(result.excerpt?.revision).toBe(revision);
  expect(result.excerpt?.language).toBe('en');
});

test('hidden or withdrawn Content is never read for an excerpt and unavailability is explicit', async () => {
  for (const options of [{ hidden: true }, { withdrawn: true }]) {
    const { fixture, result } = await excerptResult(options);
    expect(fixture.reads()).toBe(0);
    expect(result.excerpt?.status).toBe('unavailable');
    expect(result.excerpt?.text).toBeUndefined();
  }
});

test('mismatched revision, language and erased delivery never yield excerpt bytes', async () => {
  for (const options of [{ wrongRevision: true }, { language: 'fr' }, { erased: true }]) {
    const { result } = await excerptResult(options);
    expect(result.excerpt?.status).toBe('unavailable');
    expect(result.excerpt?.text).toBeUndefined();
  }
});

test('Content owner movement after the body read restarts the search instead of returning stale excerpts', async () => {
  await expect(excerptResult({ moveAfterRead: true })).rejects.toBeInstanceOf(SearchSnapshotMoved);
});


test('public producers validate normalized Unicode points and escape literal Lucene operators', () => {
  expect(searchText('  cafe\u0301  西 ', 'keywords').text).toBe('café 西');
  expect(searchText('西', 'keywords').tokens).toEqual(['西']);
  expect(searchText('😀'.repeat(80), 'phrase').text).toBe('😀'.repeat(80));
  for (const phrase of ['', '  ', '😀'.repeat(81), 'a\u0000b', '\uD800']) expect(() => searchText(phrase)).toThrow();
  expect(searchText('C++ A+B: \"quote\" a\\b * OR', 'keywords').lucene)
    .toBe('"C++" AND "A+B:" AND "\\"quote\\"" AND "a\\\\b" AND "*" AND "OR"');
  expect(searchText('left hand').lucene).toBe('"left hand"');
  expect(searchText('hand left', 'keywords').lucene).toBe('"hand" AND "left"');
});

test('omitted mode preserves legacy two-point admission while explicit intent admits one point', () => {
  for (const text of ['x', '西', '😀']) {
    expect(() => searchText(text)).toThrow();
    for (const mode of ['phrase', 'keywords'] as const) expect(searchText(text, mode).text).toBe(text);
  }
  expect(searchText('  cafe\u0301  ').text).toBe('café');
  expect(searchText('left hand').matchMode).toBe('phrase');
});

test('consumer excerpt reasons, matched fields and release kinds retain their literal types and admission', () => {
  const reason: Extract<Static<typeof searchExcerpt>, { status: 'unavailable' }>['reason'] = 'not-matching';
  const field: NonNullable<Static<typeof phraseMatch>['matchedField']> = 'body';
  type Releases = Extract<Static<typeof searchDisambiguation>['releases'], { status: 'available' }>;
  const kind: Releases['values'][number]['kind'] = 'formal';
  expect(Value.Check(searchExcerpt, { status: 'unavailable', reason })).toBe(true);
  expect(Value.Check(searchExcerpt, { status: 'unavailable', reason: 'invented' })).toBe(false);
  expect(Value.Check(phraseMatch.properties.matchedField, field)).toBe(true);
  expect(Value.Check(phraseMatch.properties.matchedField, 'invented')).toBe(false);
  const facts = { context: null, contentFormat: { status: 'unavailable' },
    releases: { status: 'available', values: [{ release: resource, revision, kind,
      year: null, platform: null, sourceEvidence: [] }] } };
  expect(Value.Check(searchDisambiguation, facts)).toBe(true);
  expect(Value.Check(searchDisambiguation, { ...facts, releases: { status: 'available',
    values: [{ ...facts.releases.values[0], kind: 'invented' }] } })).toBe(false);
});

test('continuations refuse reader, context and source changes', () => {
  const viewer = disclosureViewer({ issuer: 'account', subject: 'reader-one' });
  const first = withDisclosureViewer(viewer, () => pageCompletePublicRelation(request, relation, 1000));
  expect(() => withDisclosureViewer(disclosureViewer({ issuer: 'account', subject: 'reader-two' }), () =>
    pageCompletePublicRelation({ ...request, continuation: first.next! }, relation, 1001))).toThrow(SearchContinuationRestart);
  const next = pageCompletePublicRelation(request, relation, 1000).next!;
  expect(() => pageCompletePublicRelation({ ...request, continuation: next },
    { ...relation, sourcePosition: { ...relation.sourcePosition, sequence: '10' } }, 1001)).toThrow(SearchContinuationRestart);
  expect(() => pageCompletePublicRelation({ ...request, profile: 'public-realm-phrase-page-v1',
    context: { kind: 'realm-local', id: resource }, continuation: next },
    { ...relation, context: { kind: 'realm-local', id: resource } }, 1001)).toThrow(SearchContinuationRestart);
});

test('the excerpt window comes from the matching body region with a Unicode bound', () => {
  const text = matchingExcerpt('😀'.repeat(500) + ' darkness left ' + '尾'.repeat(500), request)!;
  expect(text).toContain('darkness left');
  expect(text.startsWith('…')).toBe(true);
  expect([...text].length).toBeLessThanOrEqual(240);
  expect(matchingExcerpt('Only the left bank', request)).toBeNull();
});

test('current disclosure and public-domain rights gate exact reads and delivery', async () => {
  const hidden = await excerptResult({ policyHidden: true });
  expect(hidden.fixture.reads()).toBe(0);
  expect(hidden.result.excerpt?.status).toBe('unavailable');
  const revoked = await excerptResult({ publicDomain: true, revokeAfterRead: true });
  expect(revoked.fixture.reads()).toBe(1);
  expect(revoked.result.excerpt?.status).toBe('unavailable');
  expect(revoked.result.excerpt?.text).toBeUndefined();
});

test('a changed publication after exact reading restarts instead of delivering bytes', async () => {
  await expect(excerptResult({ publicationMoves: true })).rejects.toBeInstanceOf(SearchSnapshotMoved);
});

test('a body without every keyword has an explicit unavailable excerpt', async () => {
  const { result } = await excerptResult({ body: 'Only the left bank' });
  expect(result.excerpt).toEqual({ status: 'unavailable', reason: 'not-matching' });
});


function releaseFactsFixture(options: { hiddenRelease?: boolean; hiddenParent?: boolean; missing?: boolean; many?: boolean } = {}) {
  const id = (n: number) => `https://rezics.com/id/00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
  const record = resolvedReleaseV2(checkedReleaseV2({ profile: 'release-v2', expectedHead: null,
    actingSubject: id(1), id: id(2), kind: 'formal', status: 'official', titleLanguage: 'en', tracklistLanguage: null,
    title: { value: 'The left bank', language: 'en' }, editionStatement: null, publisher: null,
    publicationYear: options.missing ? null : 1969, isbn13: null, originalUrl: null, fixedRelease: null,
    evidence: null, identifiers: [], platform: options.missing ? null : 'PC', territory: null,
    coverage: [{ realization: id(3), revision: id(4), completeness: 'complete' }] }, resource),
    [{ realization: id(3), revision: id(4), work: resource, language: 'en', kind: 'original', status: 'official' }]);
  let hydrated = 0;
  const binding = (value: string) => ({ type: 'uri', value });
  const session = { options: {}, deps: {},
    selection: async (_: string, read: (session: WorkReadSession) => Promise<unknown>) => read(session as unknown as WorkReadSession),
    disclosure: async (targets: unknown[]) => targets.map(() => options.hiddenRelease ? 'hidden' : 'visible'),
    summaries: async (works: string[]) => works.map(reference => ({ reference,
      status: options.hiddenParent ? 'unavailable' : 'available', type: 'work' })),
    query: async (query: string) => {
      if (query.includes('SELECT DISTINCT ?release')) {
        if (query.includes('FILTER(STR(?release)')) return [];
        return Array.from({ length: options.many ? 21 : 1 }, (_, index) =>
          ({ release: binding(id(2 + index * 10)), revision: binding(id(5 + index * 10)) }));
      }
      if (query.includes('SELECT ?release ?revision ?state')) {
        hydrated++;
        return Array.from({ length: options.many ? 21 : 1 }, (_, index) =>
          ({ release: binding(id(2 + index * 10)), revision: binding(id(5 + index * 10)),
            state: binding(JSON.stringify({ ...record, id: id(2 + index * 10) })) }));
      }
      if (query.includes('SELECT ?work ?main')) return [{ work: binding(resource), main: binding(id(6)) }];
      throw new Error('unexpected release query');
    },
  };
  return { session: session as unknown as WorkReadSession, hydrated: () => hydrated, id };
}

test('card disambiguation uses admitted Release year/platform/kind and exact source identities', async () => {
  const fixture = releaseFactsFixture();
  expect((await readSearchReleaseFacts(fixture.session, [resource]))?.get(resource)).toEqual([
    { release: fixture.id(2), revision: fixture.id(5), kind: 'formal', year: 1969, platform: 'PC', sourceEvidence: [] }]);
  const missing = releaseFactsFixture({ missing: true });
  expect((await readSearchReleaseFacts(missing.session, [resource]))?.get(resource)?.[0])
    .toMatchObject({ year: null, platform: null });
});

test('release facts keep hidden release and unreadable omnibus coverage out of search cards', async () => {
  const hidden = releaseFactsFixture({ hiddenRelease: true });
  expect((await readSearchReleaseFacts(hidden.session, [resource]))?.get(resource)).toEqual([]);
  expect(hidden.hydrated()).toBe(0);
  const parent = releaseFactsFixture({ hiddenParent: true });
  expect((await readSearchReleaseFacts(parent.session, [resource]))?.get(resource)).toEqual([]);
});

test('release facts report unavailable when the bounded admitted preview has a lookahead', async () => {
  const fixture = releaseFactsFixture({ many: true });
  expect(await readSearchReleaseFacts(fixture.session, [resource])).toBeNull();
});

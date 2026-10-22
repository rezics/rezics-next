import { expect, test } from 'bun:test';
import { enrichSearchExcerptPage } from '../../services/main/src/modules/search/excerpts.ts';
import { rankedSearchMatches } from '../../services/main/src/modules/search/fields.ts';
import { configureDisclosure } from '../../services/main/src/modules/disclosure/read.ts';
import { configureFixtureDisclosureAncestry, fixtureDisclosureReader } from '../../services/main/tests/support/disclosure-ancestry.ts';
import type { MainWorkDependencies } from '../../services/main/src/routes/dependencies.ts';
import type { ExactContentReference } from '../../services/content/src/core.ts';

const id = (n: number) => `https://rezics.com/id/00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const revisionId = '22222222-2222-4222-8222-222222222222';
const revision = `urn:rezics:content:revision:${revisionId}`;
const position = { dataEpoch: 'epoch', sequence: '9' };
const body = { body: 'Darkness falls on the left bank.' };
const reference: ExactContentReference = { owner: 'content', resourceId: id(1), variantId: id(2), revisionId,
  format: 'rezics-content-json-v1', model: 'content-shape-v1', byteDigest: 'a'.repeat(64), byteLength: 45,
  direction: 'ltr', sourceRevision: null, predecessor: null,
  language: { kind: 'tag', tag: 'en', originalTag: 'en' }, provenance: { kind: 'admitted-original-contribution-v1' } };
const match = { matchUnit: 'urn:rezics:match:shared', resource: id(1), variant: id(2), revision,
  publicationDecision: 'urn:rezics:publication:one', language: 'en', score: 1 };
const query = { phrase: 'left darkness', matchMode: 'keywords' as const };

// The graph adapter preserves SPARQL VALUES multiplicity. It does not mock any
// REZICS module. The raw Content interface supplies one immutable exact revision.
function owners(policy = false) {
  const v = (value: string) => ({ type: 'literal', value });
  const admission = { epoch: v('epoch'), sequence: v('9'), matchUnit: v(match.matchUnit),
    resource: v(id(1)), variant: v(id(2)), revision: v(revision), publicationDecision: v(match.publicationDecision),
    eligibility: v('urn:rezics:eligibility:one'), projection: v('urn:rezics:projection:one'),
    language: v('en'), rightsBasis: v('https://rezics.com/vocab/OriginalContribution') };
  const bodyTargets: Array<{ resource: string; revision: string | null | undefined }> = [];
  const content = { ownerPosition: async () => ({ owner: 'content', ...position }),
    readExactBatch: async () => [{ revisionId, status: 'available', reference, body, serializedJson: JSON.stringify(body) }],
    readExactMetadataBatch: async () => new Map([[revisionId, { availability: 'available', byteDigest: reference.byteDigest }]]) };
  const environment = { lineage: { dataEpoch: 'epoch', routingEpoch: 'routing' },
    readCompositionTargets: async (_profile: string, resources: readonly string[]) => new Set(resources),
    fuseki: { query: async (sparql: string) => {
      if (sparql.includes('SELECT ?resource ?head')) {
        const values = /VALUES \?resource \{([^}]+)\}/u.exec(sparql)![1]!;
        return { results: { bindings: [...values.matchAll(/<([^>]+)>/gu)]
          .map(value => ({ resource: v(value[1]!), head: v('urn:rezics:head:one') })) } };
      }
      if (sparql.includes('SELECT ?work ?head')) {
        const values = /VALUES \?work \{([^}]+)\}/u.exec(sparql)![1]!;
        return { results: { bindings: [...values.matchAll(/<([^>]+)>/gu)]
          .map(value => ({ work: v(value[1]!), head: v('urn:rezics:head:one') })) } };
      }
      if (!sparql.includes('SELECT ?epoch ?sequence ?matchUnit')) throw new Error('Unexpected graph interface call');
      const values = /VALUES \(\?matchUnit \?revision\) \{([^}]+)\}/u.exec(sparql)![1]!;
      const pairs = [...values.matchAll(/\(<([^>]+)> <([^>]+)>\)/gu)];
      return { results: { bindings: pairs.filter(pair => pair[1] === match.matchUnit && pair[2] === revision).map(() => admission) } };
    } } };
  const deps = { environment, contentProjection: { content, consumer: 'public-search', cursor: { read: async () => position } } } as unknown as MainWorkDependencies;
  if (policy) {
    configureFixtureDisclosureAncestry(deps.environment, target => target.work ? {
      resource: target.work, head: 'urn:rezics:head:one', protectedRevision: target.workRevision } : undefined);
    configureDisclosure(deps.environment, fixtureDisclosureReader(async targets => targets.map(target => {
      if (target.owner === 'content' && target.component === 'body') bodyTargets.push({ resource: target.resource, revision: target.revision });
      return 'visible';
    })));
  }
  return { deps, bodyTargets };
}

test('control: a single admitted exact Content match reaches available excerpt delivery', async () => {
  const { deps } = owners();
  const result = await enrichSearchExcerptPage(deps, { graphPosition: position,
    contentPosition: position, results: [match] }, query);
  expect((result.results[0] as any).excerpt).toMatchObject({ status: 'available', revision, resource: id(1) });
});

test('one exact Content match shared by two placing Works hydrates both admitted hits', async () => {
  const { deps } = owners();
  const results = [id(10), id(11)].map((work, index) => ({ ...match, matchedPlacements: [{
    resource: id(1), work, occurrence: id(20 + index), profile: 'book-composition', title: 'Shared chapter' }] }));
  await expect(enrichSearchExcerptPage(deps, { graphPosition: position,
    contentPosition: position, results }, query)).resolves.toMatchObject({ results: [
      { excerpt: { status: 'available' } }, { excerpt: { status: 'available' } }] });
});

test('a strongest hit after an earlier locator checks disclosure of its selected exact body', async () => {
  const { deps, bodyTargets } = owners(true);
  const work = id(10), mainVersion = id(11), earlierRevision = 'urn:rezics:content:revision:33333333-3333-4333-8333-333333333333';
  const results = rankedSearchMatches([
    { work, mainVersion, matchUnit: 'urn:rezics:match:earlier', revision: earlierRevision, language: 'en', score: 1,
      matchedPlacements: [{ resource: id(3), work, occurrence: id(20), profile: 'book-composition', title: 'Opening', revision: earlierRevision }] },
    { work, mainVersion, matchUnit: match.matchUnit, revision, language: 'en', score: 10,
      matchedPlacements: [{ resource: id(1), work, occurrence: id(21), profile: 'book-composition', title: 'Closing', revision }] },
  ]);
  await enrichSearchExcerptPage(deps, { sourcePosition: position, results }, query);
  expect(new Set(bodyTargets.map(target => `${target.resource}\0${target.revision}`)))
    .toEqual(new Set([`${id(1)}\0${revisionId}`]));
});

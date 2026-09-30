import { expect, test } from 'bun:test';
import { uiLocales } from '../../apps/web/i18n/define.ts';
import { compileFacet, facetId, facetLocales, facetRef, renderFacetRegistry, type FacetDefinition }
  from '../compiler/facet.ts';
import { authoredFacets, authoredProfiles, buildArtifacts } from '../compiler/generate.ts';
import { ratingFacet } from '../definitions/facet-rating-v1.ts';
import { lengthFacet } from '../definitions/facet-length-v1.ts';
import { typeFacet } from '../definitions/facet-type-v1.ts';

const repo = new URL('../..', import.meta.url).pathname;
const compiled = new Map(authoredFacets.map(facet => [facet.name, compileFacet(facet)]));
const facet = (name: string) => compiled.get(name) as ReturnType<typeof compileFacet> & {
  path: Record<string, unknown>[]; values: Record<string, unknown>[]; operators: string[]; parameters: { key: string }[] };

// A reviewed Facet version keeps its meaning: a Filter or Saved Filter pinning its
// DefinitionRef must read the same path, values, operators and source forever. A new
// meaning is a new `facet-<name>-v<n+1>.ts`; labels and cost are refined in place.
const admittedMeanings: Record<string, string> = {
  'facet-release-v1': 'c833e9fe649158088fd0a678e2d08d4dbb232f896ec02d104c2837a2a1e93329',
  'facet-release-language-v1': '8961cd980c2d6831bac69fc275793b205f06aa298fc433d95b39ca2e865dd9dc',
  'facet-release-platform-v1': '0e2b4b9a2905aeefe6e5123a6c97528b076d95e8484981c072948db25c251c2f',
  'facet-release-territory-v1': 'ecfc69ba05556b2e65bf1cdc686e8bc7f9f682f01ff728ff369fa33d5e211971',
  'facet-release-completeness-v1': 'b09b7d2e0d9d84614814eaae0ee7f81beb6671690655399aaeee8ce79fafbbfe',
  'facet-release-status-v1': '541d9caf10ff71efcd74ebb9d71e4212142b586927f097f12fa9b9d9acc5f7b9',
  'facet-author-v1': '2c16a404d3c13f1161102c924763ef302e4695fca2f09965f96a2e4193d9b48b',
  'facet-concept-v1': '6a2438d45d2616af705374094389676616c09e0fbbc8eda2330754b4d325a5d5',
  'facet-contributor-v1': '93579a0f6b18f88af7560a8e0ca63bd8673cfcf0049690144b1d5e951564ea97',
  'facet-language-v1': '6fccc1a9beb900132c2a247a691b5fbef7df2572fc62e3000a87d6722f83a9f5',
  'facet-length-v1': 'e9e5794ed99df79c9599e318717da495e6ebcc14422137a67f88433a14055208',
  'facet-rating-v1': '22962ff8e656c18b6bc7e3b40de8a49bf42022b45161a27b45a730664e7aa074',
  'facet-realm-v1': '1eef10945c692bf3f4a15d74a6222ac454023f81831710de16b986f78a05ee65',
  'facet-relation-v1': '34681c142eb5ce28e53f81618a125bf66e26c49fa89739c1675d3ebf2a1dad89',
  'facet-role-v1': '50a1601af2fce441d8eb60d8f56b6a98b7492e64569836477536dbeec4c18229',
  'facet-statement-v1': '834feca0b51901b385dad5fd3e6a78195c048e391ad4ece66c87b64850ec2986',
  'facet-status-v1': '51275e8dc39d61531d594b5806b7e620d3bc8111bd366a85bb0759b188b12375',
  'facet-type-v1': '053c6b68d9822f3089323503b30c71269c0dd9a52cab3384ac8a35949e9405c5',
};

test('Facets: an admitted version never changes its meaning in place', () => {
  expect(Object.fromEntries(authoredFacets.map(item => [facetId(item), compileFacet(item).digest])))
    .toEqual(admittedMeanings);
  const relabelled = { ...typeFacet, labels: { ...typeFacet.labels, en: 'Kind of work' },
    cost: { ...typeFacet.cost, maxValues: 4 } };
  expect(compileFacet(relabelled).digest).toBe(admittedMeanings['facet-type-v1']!);
  expect(compileFacet({ ...typeFacet, operators: ['any'] }).digest).not.toBe(admittedMeanings['facet-type-v1']);
});

test('Facets: every Facet is a DefinitionRef labelled in each interface locale', () => {
  expect(facetLocales).toEqual(uiLocales);
  for (const item of authoredFacets) {
    const served = compileFacet(item);
    expect(served.id).toBe(`https://rezics.com/definition/facet-${item.name.replace(/[A-Z]/g, c => `-${c.toLowerCase()}`)}-v${item.version}`);
    expect(Object.keys(served.labels as object)).toEqual([...facetLocales]);
  }
  expect(() => compileFacet({ ...typeFacet, labels: { ...typeFacet.labels, ko: '' } })).toThrow('needs a ko label');
  const { ja: _, ...withoutJapanese } = typeFacet.labels;
  expect(() => compileFacet({ ...typeFacet, labels: withoutJapanese } as unknown as FacetDefinition))
    .toThrow('needs a ja label');
  const twin = { ...ratingFacet, labels: { ...ratingFacet.labels, 'zh-Hans': typeFacet.labels['zh-Hans'] } };
  expect(() => renderFacetRegistry([typeFacet, twin])).toThrow('share a zh-Hans label');
});

test('Facets: versions run 1..n and a name reads its latest version', () => {
  const second = { ...typeFacet, version: 2, operators: ['any', 'none'] } as const;
  const registry = renderFacetRegistry([typeFacet, second]);
  expect(registry).toContain(`"${facetRef(typeFacet)}"`);
  expect(registry).toMatch(/"id": "https:\/\/rezics\.com\/definition\/facet-type-v1",[\s\S]*?"current": false/);
  expect(registry).toMatch(/"id": "https:\/\/rezics\.com\/definition\/facet-type-v2",[\s\S]*?"current": true/);
  expect(() => renderFacetRegistry([typeFacet, { ...typeFacet, version: 3 }])).toThrow('versions must run 1..n');
});

test('Facets: the compiler refuses a Facet whose parts do not fit together', () => {
  expect(() => compileFacet({ ...typeFacet, operators: ['range'] })).toThrow('ranges over unordered values');
  expect(() => compileFacet({ ...ratingFacet, parameters: [] })).toThrow('exactly those its path binds: ratingContext');
  expect(() => compileFacet({ ...ratingFacet, values: [{ kind: 'datatype', datatype: 'xsd:decimal', min: '1', max: '5' }] }))
    .toThrow('values must span its rating scale');
  expect(() => compileFacet({ ...typeFacet, qualifiers: ['interpretation'] })).toThrow('qualifies no Statement');
  expect(() => compileFacet({ ...typeFacet, occurrence: true })).toThrow('occurrence');
  expect(() => compileFacet({ ...typeFacet, path: [{ kind: 'triple', predicate: 'nope:type' }] }))
    .toThrow('Cannot expand model term nope:type');
  expect(() => compileFacet({ ...typeFacet, source: 'realm' } as unknown as FacetDefinition)).toThrow('no Statement source');
  expect(() => compileFacet({ ...typeFacet, sense: true } as unknown as FacetDefinition))
    .toThrow('Unsupported Facet field sense');
});

test('Facets: the admitted set covers what readers filter by today', () => {
  expect([...compiled.keys()].sort()).toEqual(['author', 'concept', 'contributor', 'language', 'length', 'rating', 'realm',
    'relation', 'release', 'releaseCompleteness', 'releaseLanguage', 'releasePlatform', 'releaseStatus', 'releaseTerritory',
    'role', 'statement', 'status', 'type']);
  const rv = 'https://rezics.com/vocab/';
  expect(facet('type')).toMatchObject({ source: 'global', operators: ['any', 'all', 'none'],
    path: [{ kind: 'triple', predicate: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type' }],
    values: [{ kind: 'class', class: 'http://www.w3.org/2000/01/rdf-schema#Class' }] });
  expect(facet('concept')).toMatchObject({ source: 'context', qualifiers: ['interpretation'],
    path: [{ predicate: `${rv}mainVersion` }, { kind: 'statement', predicate: `${rv}classifiedAs`,
      relation: 'https://rezics.com/definition/classification-proposition-v1' }], values: [{ kind: 'concept' }] });
  expect(facet('author')).toMatchObject({ source: 'global', path: [{ kind: 'credit', role: 'author' }],
    values: [{ kind: 'class', class: `${rv}Agent` }, { kind: 'external', provider: 'open-library', namespace: 'author' }] });
  expect(facet('contributor').path.map(step => step.kind)).toEqual(['triple', 'selection', 'triple', 'triple']);
  expect(facet('language')).toMatchObject({ source: 'context',
    values: [{ kind: 'datatype', datatype: 'http://www.w3.org/2001/XMLSchema#string' }] });
  expect(facet('realm')).toMatchObject({ source: 'global', values: [{ kind: 'class', class: `${rv}Realm` }] });
  expect(facet('rating')).toMatchObject({ source: 'context', operators: ['range'],
    parameters: [{ key: 'ratingContext' }], values: [{ datatype: 'http://www.w3.org/2001/XMLSchema#decimal', min: '1', max: '10' }],
    path: [{}, { kind: 'rating', scale: { min: 1, max: 10 },
      population: 'https://rezics.com/definition/rating-account-principal-population-v1' }] });
  expect(facet('status')).toMatchObject({ source: 'global', operators: ['any', 'none'],
    path: [{ kind: 'triple', predicate: `${rv}completionStatus` }],
    values: [{ datatype: 'http://www.w3.org/2001/XMLSchema#string', pattern: '^(ongoing|completed|hiatus)$' }] });
  expect(facet('length')).toMatchObject({ source: 'global', operators: ['range'],
    path: [{ kind: 'units', unit: `${rv}Word` }],
    values: [{ datatype: 'http://www.w3.org/2001/XMLSchema#integer', min: '0' }] });
  expect(facet('relation')).toMatchObject({ occurrence: true, appliesTo: 'resource',
    parameters: [{ key: 'definition' }, { key: 'role' }] });
  expect(facet('role')).toMatchObject({ appliesTo: 'participation', values: [{ kind: 'role' }], operators: ['any', 'none'] });
  expect(facet('statement')).toMatchObject({ appliesTo: 'participant', source: 'context',
    qualifiers: ['interpretation', 'applicability'] });
});

test('Facets: Facets define queries and no stored data references them', () => {
  // No profile can store a Facet, Path or Sense-style wrapper pointing at a Facet.
  const terms = JSON.stringify(authoredProfiles);
  expect(terms).not.toMatch(/facet/i);
  const artifacts = buildArtifacts(repo);
  const registry = artifacts.get('packages/model/src/generated/facets.ts')!;
  for (const item of authoredFacets) expect(registry).toContain(`"${facetRef(item)}"`);
  // Main reads them; the Fuseki image's manifest, shapes, contexts and vocabulary never do.
  for (const [path, content] of artifacts) {
    if (path === 'packages/model/src/generated/facets.ts') continue;
    expect(`${path}\n${content}`).not.toMatch(/facet/i);
  }
});

test('Facets: units are generic, expanded and constrained to composition counts', () => {
  expect(compileFacet({ ...lengthFacet, path: [{ kind: 'units', unit: 'rv:Chapter' }] }).path)
    .toEqual([{ kind: 'units', unit: 'https://rezics.com/vocab/Chapter' }]);
  expect(() => compileFacet({ ...lengthFacet, path: [{ kind: 'units', unit: 'missing:Word' }] }))
    .toThrow('Cannot expand model term');
  expect(() => compileFacet({ ...lengthFacet, values: [{ kind: 'datatype', datatype: 'xsd:decimal' }] }))
    .toThrow('units must count nonnegative integers');
});

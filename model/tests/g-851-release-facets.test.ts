import { expect, test } from 'bun:test';
import { facetRegistry } from '../../packages/model/src/generated/facets.ts';
import { authoredFacets } from '../compiler/generate.ts';
import { compileFacet, facetId, facetLocales, renderFacetRegistry, type FacetDefinition } from '../compiler/facet.ts';
import { releaseFacet } from '../definitions/facet-release-v1.ts';
import { releaseLanguageFacet } from '../definitions/facet-release-language-v1.ts';

const releaseFacets = authoredFacets.filter(facet => facet.name.startsWith('release'));

test('G851: related-node release facets pin their path, child placement, meaning and eight labels', () => {
  expect(releaseFacets).toHaveLength(6);
  for (const facet of releaseFacets) {
    const compiled = compileFacet(facet);
    expect(facetRegistry[`https://rezics.com/definition/${facetId(facet)}` as keyof typeof facetRegistry].digest).toBe(compiled.digest);
    expect(Object.keys(compiled.labels as object)).toEqual([...facetLocales]);
    if (facet.name !== 'release') expect(compiled).toMatchObject({ appliesTo: 'participant',
      within: 'https://rezics.com/definition/facet-release-v1', subject: 'https://rezics.com/vocab/Release' });
  }
  expect(compileFacet(releaseFacet)).toMatchObject({ occurrence: true, cost: { graphReads: 2, nested: 8 },
    path: [{ kind: 'related', path: [{ predicate: 'https://rezics.com/vocab/coverageWork', inverse: true }],
      types: ['https://rezics.com/vocab/Release'] }] });
});

test('G851: related groups reuse occurrence bounds and require one final related path', () => {
  expect(() => compileFacet({ ...releaseFacet, cost: { maxValues: 8, graphReads: 2 } })).toThrow('invalid cost');
  expect(() => compileFacet({ ...releaseFacet, occurrence: undefined })).toThrow('occurrence');
  expect(() => compileFacet({ ...releaseFacet, path: [releaseFacet.path[0], releaseFacet.path[0]] })).toThrow('occurrence');
  expect(() => compileFacet({ ...releaseFacet, path: [{ ...releaseFacet.path[0], path: [] }] })).toThrow('related path');
  expect(() => compileFacet({ ...releaseLanguageFacet, appliesTo: 'resource' })).toThrow('within');
  expect(() => compileFacet({ ...releaseLanguageFacet, within: 'release' } as FacetDefinition)).toThrow('within');
  expect(() => renderFacetRegistry([releaseLanguageFacet])).toThrow('related group');
  expect(() => renderFacetRegistry([releaseFacet, { ...releaseLanguageFacet, subject: 'rv:Agent' }]))
    .toThrow('related group');
});

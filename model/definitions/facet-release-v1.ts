import type { FacetDefinition } from '../compiler/facet.ts';

/** One release covering the queried Work. Coverage child paths share one entry of that Work.
 * Legacy v2 has only aggregate triples and correlates at release level; v1 has unknown coverage. */
export const releaseFacet = {
  name: 'release', version: 1,
  labels: { en: 'Release', 'zh-Hant': '發行版本', 'zh-Hans': '发行版本', ja: 'リリース', ko: '발매판',
    de: 'Veröffentlichung', fr: 'Édition', es: 'Edición' },
  appliesTo: 'resource', subject: 'schema:CreativeWork',
  path: [{ kind: 'related', path: [{ predicate: 'rv:coverageWork', inverse: true }], types: ['rv:Release'],
    correlation: { predicate: 'rv:coverage', resource: 'rv:work', types: ['rv:ReleaseCoverage'] } }],
  values: [{ kind: 'class', class: 'rv:Release' }], operators: ['any', 'none'], source: 'global',
  occurrence: true,
  // Candidate matching and a bounded explanation read; children add no graph round trips.
  cost: { maxValues: 8, graphReads: 2, nested: 8 },
} as const satisfies FacetDefinition;

import type { FacetDefinition } from '../compiler/facet.ts';

/** One release covering the queried Work; every nested Condition describes that release. */
export const releaseFacet = {
  name: 'release', version: 1,
  labels: { en: 'Release', 'zh-Hant': '發行版本', 'zh-Hans': '发行版本', ja: 'リリース', ko: '발매판',
    de: 'Veröffentlichung', fr: 'Édition', es: 'Edición' },
  appliesTo: 'resource', subject: 'schema:CreativeWork',
  path: [{ kind: 'related', path: [{ predicate: 'rv:coverageWork', inverse: true }], types: ['rv:Release'] }],
  values: [{ kind: 'class', class: 'rv:Release' }], operators: ['any', 'none'], source: 'global',
  occurrence: true,
  // Candidate matching and a bounded explanation read; children add no graph round trips.
  cost: { maxValues: 8, graphReads: 2, nested: 8 },
} as const satisfies FacetDefinition;

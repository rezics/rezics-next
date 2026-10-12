import type { FacetDefinition } from '../compiler/facet.ts';

/** Calendar years of active date-published Statements accepted globally. */
export const publicationYearFacet = {
  name: 'publicationYear',
  version: 1,
  labels: {
    en: 'Publication year',
    'zh-Hant': '出版年份',
    'zh-Hans': '出版年份',
    ja: '公開年',
    ko: '발행 연도',
    de: 'Veröffentlichungsjahr',
    fr: 'Année de publication',
    es: 'Año de publicación',
  },
  appliesTo: 'resource',
  subject: 'schema:CreativeWork',
  path: [{ kind: 'publication-year' }],
  values: [{ kind: 'datatype', datatype: 'xsd:integer', min: '1', max: '9999' }],
  operators: ['range'],
  source: 'global',
  cost: { maxValues: 2, graphReads: 1 },
} as const satisfies FacetDefinition;

import type { FacetDefinition } from '../compiler/facet.ts';

/**
 * Who a Work credits as its author: a native Agent, or a human-confirmed Open Library author.
 * Writing a Contribution does not make its Agent the Work's author; that is `contributor`.
 */
export const authorFacet = {
  name: 'author',
  version: 1,
  labels: { en: 'Author', 'zh-Hant': '作者', 'zh-Hans': '作者', ja: '著者', ko: '저자', de: 'Autor',
    fr: 'Auteur', es: 'Autor' },
  appliesTo: 'resource',
  subject: 'schema:CreativeWork',
  path: [{ kind: 'credit', role: 'author' }],
  values: [{ kind: 'class', class: 'rv:Agent' }, { kind: 'external', provider: 'open-library', namespace: 'author' }],
  operators: ['any', 'all', 'none'],
  source: 'global',
  cost: { maxValues: 8, graphReads: 1 },
} as const satisfies FacetDefinition;

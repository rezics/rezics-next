import type { FacetDefinition } from '../compiler/facet.ts';

/**
 * Concepts (genre, form, trope, theme) a Work's Main Version is classified as, accepted in the
 * Query's Context: a Realm's own decision, else the Global one it inherits. A Concept Facet
 * limited to one scheme, such as genre, is another definition whose value names that scheme.
 */
export const conceptFacet = {
  name: 'concept',
  version: 1,
  labels: { en: 'Concept', 'zh-Hant': '概念', 'zh-Hans': '概念', ja: '概念', ko: '개념', de: 'Begriff',
    fr: 'Concept', es: 'Concepto' },
  appliesTo: 'resource',
  subject: 'schema:CreativeWork',
  path: [{ kind: 'triple', predicate: 'rv:mainVersion' }, { kind: 'statement', predicate: 'rv:classifiedAs',
    relation: '<https://rezics.com/definition/classification-proposition-v1>' }],
  values: [{ kind: 'concept' }],
  operators: ['any', 'all', 'none'],
  source: 'context',
  qualifiers: ['interpretation'],
  // Context scope, one decision batch and one support batch per Query.
  cost: { maxValues: 8, graphReads: 3 },
} as const satisfies FacetDefinition;

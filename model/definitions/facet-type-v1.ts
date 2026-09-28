import type { FacetDefinition } from '../compiler/facet.ts';

/** A Work's rdf:type: structure that selects its shapes and operations, never a grouping. */
export const typeFacet = {
  name: 'type',
  version: 1,
  labels: { en: 'Type', 'zh-Hant': '種類', 'zh-Hans': '种类', ja: '種類', ko: '유형', de: 'Typ', fr: 'Type',
    es: 'Tipo' },
  appliesTo: 'resource',
  subject: 'schema:CreativeWork',
  path: [{ kind: 'triple', predicate: 'rdf:type' }],
  values: [{ kind: 'class', class: 'rdfs:Class' }],
  operators: ['any', 'all', 'none'],
  source: 'global',
  // One batched head read; a Condition may name every admitted Work type.
  cost: { maxValues: 16, graphReads: 1 },
} as const satisfies FacetDefinition;

import type { FacetDefinition } from '../compiler/facet.ts';

/** A Work's completion status, independent of its reading Context. */
export const statusFacet = {
  name: 'status', version: 1,
  labels: { en: 'Status', 'zh-Hant': '狀態', 'zh-Hans': '状态', ja: '状態', ko: '상태', de: 'Status',
    fr: 'Statut', es: 'Estado' },
  appliesTo: 'resource', subject: 'schema:CreativeWork',
  path: [{ kind: 'triple', predicate: 'rv:completionStatus' }],
  values: [{ kind: 'datatype', datatype: 'xsd:string', pattern: '^(ongoing|completed|hiatus)$' }],
  operators: ['any', 'none'], source: 'global',
  cost: { maxValues: 3, graphReads: 1 },
} as const satisfies FacetDefinition;

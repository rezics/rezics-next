import type { FacetDefinition } from '../compiler/facet.ts';

/**
 * Completion status including upcoming and cancelled. Version 1 keeps its three-value
 * pattern; a saved filter that pins that version does not start matching the new values.
 */
export const statusFacet = {
  name: 'status', version: 2,
  labels: { en: 'Status', 'zh-Hant': '狀態', 'zh-Hans': '状态', ja: '状態', ko: '상태', de: 'Status',
    fr: 'Statut', es: 'Estado' },
  appliesTo: 'resource', subject: 'schema:CreativeWork',
  path: [{ kind: 'triple', predicate: 'rv:completionStatus' }],
  values: [{ kind: 'datatype', datatype: 'xsd:string',
    pattern: '^(ongoing|completed|hiatus|upcoming|cancelled)$' }],
  operators: ['any', 'none'], source: 'global',
  cost: { maxValues: 5, graphReads: 1 },
} as const satisfies FacetDefinition;

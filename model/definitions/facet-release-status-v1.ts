import type { FacetDefinition } from '../compiler/facet.ts';

/** Release status of the single release bound by the containing group. */
export const releaseStatusFacet = {
  name: 'releaseStatus', version: 1,
  labels: { en: "Release status", 'zh-Hant': "發行狀態", 'zh-Hans': "发行状态", ja: "リリース状態", ko: "발매 상태", de: "Veröffentlichungsstatus", fr: "Statut de l’édition", es: "Estado de la edición" },
  appliesTo: 'participant', subject: 'rv:Release',
  within: 'https://rezics.com/definition/facet-release-v1',
  path: [{ kind: 'triple', predicate: 'rv:releaseStatus' }],
  values: [{ kind: 'datatype', datatype: 'xsd:string', pattern: '^(official|unofficial|virtual|withdrawn|cancelled)$' }],
  operators: ['any', 'all', 'none'], source: 'global',
  cost: { maxValues: 8, graphReads: 0 },
} as const satisfies FacetDefinition;

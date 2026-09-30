import type { FacetDefinition } from '../compiler/facet.ts';

/** Release territory of the single release bound by the containing group. */
export const releaseTerritoryFacet = {
  name: 'releaseTerritory', version: 1,
  labels: { en: "Release territory", 'zh-Hant': "發行地區", 'zh-Hans': "发行地区", ja: "リリース地域", ko: "발매 지역", de: "Veröffentlichungsgebiet", fr: "Territoire de l’édition", es: "Territorio de la edición" },
  appliesTo: 'participant', subject: 'rv:Release',
  within: 'https://rezics.com/definition/facet-release-v1',
  path: [{ kind: 'triple', predicate: 'rv:territory' }],
  values: [{ kind: 'datatype', datatype: 'xsd:string', pattern: '^(?:[A-Z]{2}|[0-9]{3})$' }],
  operators: ['any', 'all', 'none'], source: 'global',
  cost: { maxValues: 8, graphReads: 0 },
} as const satisfies FacetDefinition;

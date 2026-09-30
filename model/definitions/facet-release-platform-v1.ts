import type { FacetDefinition } from '../compiler/facet.ts';

/** Platform or format of the single release bound by the containing group. */
export const releasePlatformFacet = {
  name: 'releasePlatform', version: 1,
  labels: { en: "Platform or format", 'zh-Hant': "平台或載體", 'zh-Hans': "平台或载体", ja: "プラットフォーム・形式", ko: "플랫폼 또는 형식", de: "Plattform oder Format", fr: "Plateforme ou format", es: "Plataforma o formato" },
  appliesTo: 'participant', subject: 'rv:Release',
  within: 'https://rezics.com/definition/facet-release-v1',
  path: [{ kind: 'triple', predicate: 'rv:platform' }],
  values: [{ kind: 'datatype', datatype: 'xsd:string', pattern: '^.{1,120}$' }],
  operators: ['any', 'all', 'none'], source: 'global',
  cost: { maxValues: 8, graphReads: 0 },
} as const satisfies FacetDefinition;

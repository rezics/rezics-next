import type { FacetDefinition } from '../compiler/facet.ts';

/** Words counted over the Work's published composition. */
export const lengthFacet = {
  name: 'length', version: 1,
  labels: { en: 'Length', 'zh-Hant': '篇幅', 'zh-Hans': '篇幅', ja: '長さ', ko: '분량', de: 'Länge',
    fr: 'Longueur', es: 'Extensión' },
  appliesTo: 'resource', subject: 'schema:CreativeWork',
  path: [{ kind: 'units', unit: 'rv:Word' }],
  values: [{ kind: 'datatype', datatype: 'xsd:integer', min: '0', max: '9007199254740991' }],
  operators: ['range'], source: 'global',
  cost: { maxValues: 2, graphReads: 0 },
} as const satisfies FacetDefinition;

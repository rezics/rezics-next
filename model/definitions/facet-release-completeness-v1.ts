import type { FacetDefinition } from '../compiler/facet.ts';

/** Completeness of the group's same coverage entry. Legacy v2 is release-level. */
export const releaseCompletenessFacet = {
  name: 'releaseCompleteness', version: 1,
  labels: { en: "Release completeness", 'zh-Hant': "發行完整度", 'zh-Hans': "发行完整度", ja: "リリースの完全性", ko: "발매판 완전성", de: "Vollständigkeit der Ausgabe", fr: "Complétude de l’édition", es: "Integridad de la edición" },
  appliesTo: 'participant', subject: 'rv:Release',
  within: 'https://rezics.com/definition/facet-release-v1',
  path: [{ kind: 'triple', predicate: 'rv:coverage' }, { kind: 'triple', predicate: 'rv:completeness' }],
  values: [{ kind: 'datatype', datatype: 'xsd:string', pattern: '^(complete|partial|trial|unknown)$' }],
  operators: ['any', 'all', 'none'], source: 'global',
  cost: { maxValues: 8, graphReads: 0 },
} as const satisfies FacetDefinition;

import type { FacetDefinition } from '../compiler/facet.ts';

/** Content language of the group's one coverage entry belonging to the queried Work.
 * Legacy v2 only supplies release-level language; it cannot recover entry correlation. */
export const releaseLanguageFacet = {
  name: 'releaseLanguage', version: 1,
  labels: { en: "Release language", 'zh-Hant': "發行內容語言", 'zh-Hans': "发行内容语言", ja: "リリース言語", ko: "발매판 언어", de: "Veröffentlichungssprache", fr: "Langue de l’édition", es: "Idioma de la edición" },
  appliesTo: 'participant', subject: 'rv:Release',
  within: 'https://rezics.com/definition/facet-release-v1',
  path: [{ kind: 'triple', predicate: 'rv:coverage' }, { kind: 'triple', predicate: 'rv:contentLanguage' }],
  values: [{ kind: 'datatype', datatype: 'xsd:string', pattern: '^[a-z]{2,3}(-[A-Za-z0-9]{1,8})*$' }],
  operators: ['any', 'all', 'none'], source: 'global',
  cost: { maxValues: 8, graphReads: 0 },
} as const satisfies FacetDefinition;

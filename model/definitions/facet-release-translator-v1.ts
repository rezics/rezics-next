import type { FacetDefinition } from '../compiler/facet.ts';

/** Translator of the same covered exact realization revision, never its current head.
 * The release query reads this revision property through the bounded native state accessor. */
export const releaseTranslatorFacet = {
  name: 'releaseTranslator', version: 1,
  labels: { en: 'Release translator', 'zh-Hant': '發行譯者', 'zh-Hans': '发行译者', ja: 'リリースの翻訳者',
    ko: '발매판 번역자', de: 'Übersetzer der Ausgabe', fr: 'Traducteur de l’édition', es: 'Traductor de la edición' },
  appliesTo: 'participant', subject: 'rv:Release',
  within: 'https://rezics.com/definition/facet-release-v1',
  path: [{ kind: 'triple', predicate: 'rv:coverage' }, { kind: 'triple', predicate: 'rv:revision' },
    { kind: 'triple', predicate: 'rv:translator' }],
  values: [{ kind: 'class', class: 'rv:Agent' }],
  operators: ['any', 'all', 'none'], source: 'global',
  cost: { maxValues: 8, graphReads: 0 },
} as const satisfies FacetDefinition;

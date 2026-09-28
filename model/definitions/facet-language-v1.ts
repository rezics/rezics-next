import type { FacetDefinition } from '../compiler/facet.ts';

/** Languages a Work's Main Version publishes text in, as selected in the Query's Context. */
export const languageFacet = {
  name: 'language',
  version: 1,
  labels: { en: 'Language', 'zh-Hant': '語言', 'zh-Hans': '语言', ja: '言語', ko: '언어', de: 'Sprache',
    fr: 'Langue', es: 'Idioma' },
  appliesTo: 'resource',
  subject: 'schema:CreativeWork',
  path: [{ kind: 'triple', predicate: 'rv:mainVersion' }, { kind: 'selection' },
    { kind: 'triple', predicate: 'rv:language', graph: 'revisions' }],
  values: [{ kind: 'datatype', datatype: 'xsd:string', pattern: '^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$' }],
  operators: ['any', 'all', 'none'],
  source: 'context',
  // Read with the candidate's selected text.
  cost: { maxValues: 8, graphReads: 0 },
} as const satisfies FacetDefinition;

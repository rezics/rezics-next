import type { FacetDefinition } from '../compiler/facet.ts';

/**
 * The Agent who wrote the Contribution a Work's Main Version publishes in the Query's Context:
 * a Realm's local selection, else Main's default. Today's search profiles call it `author`.
 */
export const contributorFacet = {
  name: 'contributor',
  version: 1,
  labels: { en: 'Contributor', 'zh-Hant': '貢獻者', 'zh-Hans': '贡献者', ja: '寄稿者', ko: '기고자',
    de: 'Beitragende', fr: 'Contributeur', es: 'Colaborador' },
  appliesTo: 'resource',
  subject: 'schema:CreativeWork',
  path: [{ kind: 'triple', predicate: 'rv:mainVersion' }, { kind: 'selection' },
    { kind: 'triple', predicate: 'rv:contribution', graph: 'revisions', types: ['rv:TextContribution'] },
    { kind: 'triple', predicate: 'rv:author' }],
  values: [{ kind: 'class', class: 'rv:Agent' }],
  // A Contribution has one author, so `all` of two could never hold.
  operators: ['any', 'none'],
  source: 'context',
  // Read with the candidate's selected text.
  cost: { maxValues: 8, graphReads: 0 },
} as const satisfies FacetDefinition;

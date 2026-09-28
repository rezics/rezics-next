import type { FacetDefinition } from '../compiler/facet.ts';

/**
 * Resources that share an active relation occurrence with a Work, such as the characters
 * appearing in it. Conditions under `where` describe one occurrence and its one co-participant.
 */
export const relationFacet = {
  name: 'relation',
  version: 1,
  labels: { en: 'Relation', 'zh-Hant': '關係', 'zh-Hans': '关系', ja: '関係', ko: '관계', de: 'Beziehung',
    fr: 'Relation', es: 'Relación' },
  appliesTo: 'resource',
  subject: 'schema:CreativeWork',
  path: [{ kind: 'occurrence' }],
  // `definition` is the exact relation revision; `role` is the Work's role in it.
  parameters: [{ key: 'definition', value: { kind: 'definition' } }, { key: 'role', value: { kind: 'role' } }],
  values: [{ kind: 'class', class: 'rdfs:Resource' }],
  operators: ['any', 'none'],
  source: 'global',
  occurrence: true,
  // Definition read and one occurrence batch; `where` holds a role and two Statement Conditions today.
  cost: { maxValues: 8, graphReads: 2, nested: 4 },
} as const satisfies FacetDefinition;

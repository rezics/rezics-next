import type { FacetDefinition } from '../compiler/facet.ts';

/**
 * Realms that publish their own selection of a Work: its Realm population. Reading a Query in a
 * Realm's Context is its scope, not this Condition; a Zone's scope is a Saved Filter over it.
 */
export const realmFacet = {
  name: 'realm',
  version: 1,
  labels: { en: 'Community', 'zh-Hant': '社群', 'zh-Hans': '社区', ja: 'コミュニティ', ko: '커뮤니티',
    de: 'Community', fr: 'Communauté', es: 'Comunidad' },
  appliesTo: 'resource',
  subject: 'schema:CreativeWork',
  path: [{ kind: 'triple', predicate: 'rv:work', inverse: true, types: ['rv:RealmPublicationSlot'] },
    { kind: 'triple', predicate: 'rv:realm' }],
  values: [{ kind: 'class', class: 'rv:Realm' }],
  operators: ['any', 'all', 'none'],
  source: 'global',
  cost: { maxValues: 8, graphReads: 1 },
} as const satisfies FacetDefinition;

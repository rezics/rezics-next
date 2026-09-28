import type { FacetDefinition } from '../compiler/facet.ts';

/** The role an occurrence's co-participant takes in it, such as a lead in an appearance. */
export const roleFacet = {
  name: 'role',
  version: 1,
  labels: { en: 'Role', 'zh-Hant': '角色', 'zh-Hans': '角色', ja: '役割', ko: '역할', de: 'Rolle', fr: 'Rôle',
    es: 'Rol' },
  appliesTo: 'participation',
  subject: 'rv:RelationParticipation',
  path: [{ kind: 'triple', predicate: 'rv:role', graph: 'revisions' }],
  values: [{ kind: 'role' }],
  // A participation has one role, so `all` of two could never hold.
  operators: ['any', 'none'],
  source: 'global',
  // Read with its occurrence.
  cost: { maxValues: 8, graphReads: 0 },
} as const satisfies FacetDefinition;

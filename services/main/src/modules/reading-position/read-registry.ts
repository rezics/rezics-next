/** Every read integrated by this owner has a fixture probe. Summary transports
 * also need this policy; their route owner currently has a separate claim. */
export const revelationReads = [
  { id: 'entity', method: 'GET', path: '/v1/resources/:resource/page' },
  { id: 'statements', method: 'GET', path: '/v1/resources/:resource/statements' },
  { id: 'relations', method: 'GET', path: '/v1/resources/:resource/relations' },
  { id: 'zone', method: 'GET', path: '/v1/zones/:id/routes' },
  { id: 'members', method: 'GET', path: '/v1/collections/:id' },
  { id: 'retained-members', method: 'GET', path: '/v1/collections/:id/revisions/:revision' },
  { id: 'semantic', method: 'GET', path: '/v1/semantic/resources/:id' },
  { id: 'retained-semantic', method: 'GET', path: '/v1/semantic/resources/:id/revisions/:revision' },
  { id: 'statement', method: 'GET', path: '/v1/statements/:id' },
  { id: 'relation', method: 'GET', path: '/v1/relations/:id' },
  { id: 'retained-relation', method: 'GET', path: '/v1/relations/:id/revisions/:revision' },
] as const;

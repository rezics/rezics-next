/** Search-owned Access capabilities used by native publication, discovery and scope execution. */

type AccessDiscoveryApi = Pick<
  typeof import('../access/account-discovery-source.ts'),
  | 'accountDiscoverySource'
  | 'readAccountDiscoveryBindings'
  | 'readAccountDiscoveryRepairObservation'
  | 'readAccountDiscoverySummaries'
  | 'readAccountDiscoveryWitness'
>;
type AccessErasureApi = Pick<
  typeof import('../access/erasure.ts'),
  'readErasureStatus' | 'recordLateErasureItem' | 'resolveLateErasureItem'
>;
type AccessAuthenticateApi = Pick<typeof import('../access/authenticate.ts'), 'deadlineClient'>;

export type SearchAccessSourcePort = Readonly<AccessDiscoveryApi & AccessErasureApi & AccessAuthenticateApi>;

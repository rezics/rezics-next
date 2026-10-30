import type { KernelClient } from '@rezics/client';
import type { RealmDiscoverySort, RealmDiscoveryState } from './index';

/** Temporary Content adapter boundary. The Content producer replaces this without changing consumers. */
export async function loadRealmDiscovery(
  _client: KernelClient,
  _input: Readonly<{ sort: RealmDiscoverySort; cursor?: string; limit?: number }>,
): Promise<Exclude<RealmDiscoveryState, { kind: 'loading' }>> {
  return { kind: 'unavailable' };
}

import type { WorkPool, WorkSdkClient } from '../contract/index.ts';

const selectedClientPools = new WeakMap<object, WorkPool>();

export function bindSelectedWorkClient(client: WorkSdkClient, pool: WorkPool): void {
  selectedClientPools.set(client, pool);
}

export function unbindSelectedWorkClient(client: WorkSdkClient): void {
  selectedClientPools.delete(client);
}

export function assertSelectedWorkClient(client: WorkSdkClient, pool: WorkPool): void {
  if (selectedClientPools.get(client) !== pool)
    throw new TypeError('Selected runtime requires the original shared WorkClient/Pool');
}

export function selectedWorkClientPool(client: WorkSdkClient): WorkPool | undefined {
  return selectedClientPools.get(client);
}

import type { QueryClient } from '@tanstack/react-query';

const versions = new WeakMap<QueryClient, Map<string, number>>();

/** One scalar version coordinates editor, Reading, shelf and notification writes. */
export function confirmAccountPreferenceVersion(client: QueryClient, accountId: string, version: number) {
  let values = versions.get(client);
  if (!values) {
    values = new Map();
    versions.set(client, values);
  }
  values.set(accountId, Math.max(values.get(accountId) ?? 0, version));
}

export function accountPreferenceVersion(client: QueryClient, accountId: string) {
  return versions.get(client)?.get(accountId) ?? 0;
}

import type { PoolClient } from 'pg';

/** Serialize an absent receipt as well as an existing one. The key must cover
 * the receipt's unique identity, not its scope: one retry key can cross scopes.
 * This object lock is independent of the shared authority fence. */
export async function lockAccessKey(client: PoolClient, key: string): Promise<void> {
  await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [key]);
}

export function lockAdmissionKey(client: PoolClient, principalId: string,
  action: string, key: string): Promise<void> {
  return lockAccessKey(client, `admission:${principalId}:${action}:${key}`);
}

const native = 'https://rezics\\.com/id/[0-9a-f-]{36}';
const target = new RegExp(`^(${[
  'work:edit', 'contribution:create', 'contribution:edit', 'contribution:publish',
  'translation:link', 'collection:edit', 'rating:observe', 'rating:context', 'rating:policy',
  'content:comment', 'content:draft', 'content:publish', 'content:search-eligibility',
  'statement:speak', 'publication:select', 'publication:adopt', 'publication:reject',
  'classification:context', 'classification:decide', 'reply:create', 'reply:place', 'review:decide',
  'submission:submit', 'media:owner', 'media:avatar', 'semantic:edit', 'zone:edit',
  'realm:attach',
].join('|')}):${native}$`);

/** Only installed scope families can be derived. A gate is a fence, not a
 * permission: the enclosing admission transaction must still prove authority.
 * Existing targets are backfilled one key at a time on first use (O(1) writes).
 * ON CONFLICT never changes an existing epoch or reopens a closed scope. */
export async function ensureBaselineScopeGate(client: PoolClient, scope: string): Promise<void> {
  if (scope !== 'work:create:root' && scope !== 'space:create:root' && !target.test(scope)) return;
  await client.query('INSERT INTO access.scope_gate (id) VALUES ($1) ON CONFLICT (id) DO NOTHING', [scope]);
}

import type { Pool } from 'pg';
import { noEffect, runCommand } from '../command/command.ts';
import { withConnection } from '../database/pool.ts';
import { readPartition } from '../partition/partition.ts';
import { partitionOf, routeOf } from '../route/route.ts';
import pageKeys from './account-erasure-revisions-page.sql';
import obligation from './account-erasure-revisions-obligation.sql';
import eraseRealm from './account-erasure-revisions-realm.sql';
import eraseSpace from './account-erasure-revisions-space.sql';
import remove from './account-erasure-revisions-delete.sql';

type Key = { kind: string; owner_route: number; owner_id: string; revision_id: string };
const zero = '00000000-0000-0000-0000-000000000000';
const basis = {
  actorAccountId: '00000000-0000-8000-8000-000000000001',
  clientId: 'internal-community-erasure',
  requestedBy: null,
};

function cursor(after: string | null): Key {
  if (after === null) return { kind: '', owner_route: 0, owner_id: zero, revision_id: zero };
  const key: Key = JSON.parse(after);
  if (
    !key ||
    Object.keys(key).sort().join(',') !== 'kind,owner_id,owner_route,revision_id' ||
    (key.kind !== 'realm' && key.kind !== 'space') ||
    !Number.isInteger(key.owner_route) ||
    routeOf(key.owner_id) !== key.owner_route ||
    routeOf(key.revision_id) !== key.owner_route
  )
    throw new TypeError('Invalid revision erasure cursor');
  return key;
}

/** Terminal erasure authority is immutable. Release the account checkout before entering any owner partition.
 * A retry repeats exact-key archive clears safely; locators disappear only after every owner command commits.
 */
export async function eraseAccountRevisionsPage(
  { pool }: { pool: Pool },
  accountId: string,
  after: string | null,
): Promise<{ next: string | null; found: number; pending: number }> {
  const route = routeOf(accountId);
  if (route === null) throw new TypeError('Invalid revision author identity');
  const position = cursor(after);
  const keys = await withConnection(pool, async (client) => {
    const anchor = await readPartition(client, partitionOf(route));
    if (!anchor || anchor.writeState === 'moved') throw new Error('Author partition is unavailable');
    if (!(await obligation.run(client, { route, account_id: accountId })))
      throw new Error('Revision erasure requires a committed account erasure obligation');
    return pageKeys.run(client, { route, account_id: accountId, ...position });
  });
  if (keys.length === 0) return { next: null, found: 0, pending: 0 };
  const partitions = new Map<number, Key[]>();
  for (const key of keys) {
    const partition = partitionOf(key.owner_route);
    const group = partitions.get(partition) ?? [];
    group.push(key);
    partitions.set(partition, group);
  }
  for (const [partition, group] of partitions) {
    await runCommand(pool, { partition, basis }, async (tx) => {
      // This transaction-local exception permits only empty archive text, never head or provenance changes.
      await tx.query("SELECT set_config('community.erasure_account', $1, true)", [accountId]);
      let changed = 0;
      for (const key of group) {
        const statement = key.kind === 'realm' ? eraseRealm : eraseSpace;
        const parameters = {
          route: key.owner_route,
          owner_id: key.owner_id,
          revision_id: key.revision_id,
          account_id: accountId,
        };
        const result = await tx.query(
          statement.sql,
          statement.params.map((name) => parameters[name as keyof typeof parameters]),
        );
        changed += result.rowCount ?? 0;
      }
      if (changed === 0) return noEffect(null);
      return {
        value: null,
        events: [
          {
            type: 'com.rezics.community.revisions.erased.v1',
            subject: accountId,
            data: { accountId, found: group.length },
          },
        ],
      };
    });
  }
  await runCommand(pool, { partition: partitionOf(route), basis }, async (tx) => {
    let changed = 0;
    for (const key of keys) {
      const parameters = { route, account_id: accountId, ...key };
      const result = await tx.query(
        remove.sql,
        remove.params.map((name) => parameters[name as keyof typeof parameters]),
      );
      changed += result.rowCount ?? 0;
    }
    if (changed === 0) return noEffect(null);
    return {
      value: null,
      events: [
        {
          type: 'com.rezics.community.revision-locators.removed.v1',
          subject: accountId,
          data: { accountId, found: changed },
        },
      ],
    };
  });
  return { next: keys.length === 50 ? JSON.stringify(keys.at(-1)) : null, found: keys.length, pending: 0 };
}

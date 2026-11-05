import type { AuthErasureBarrier } from '@rezics/auth-contract';
import type { Pool, PoolClient } from 'pg';
import { withConnection } from '../database/pool.ts';
import { partitionOf } from '../route/route.ts';
import {
  prepareCurrentAuthReceivingClosure,
  verifyCurrentAuthReceivingClosure,
  type CurrentAuthReceivingClosure,
} from './shared-history-auth.ts';
import type { NativeStoreBlocker } from './erasure-native-stores.ts';

const consumers = {
  workflow_approval: {
    key: ['route', 'approval_id'],
    reason: 'approval-consumer-proof-unavailable',
  },
  operator_opening_receipt: {
    key: ['route', 'operator_account_id', 'receipt_id'],
    reason: 'opening-consumer-proof-unavailable',
  },
  credential_floor_receipt: {
    key: ['route', 'account_id', 'opening_receipt_id'],
    reason: 'credential-consumer-proof-unavailable',
  },
} as const;
export function isAuthConsumerStore(store: string): store is keyof typeof consumers {
  return Object.hasOwn(consumers, store);
}
export type AuthConsumerRetirement = { barrier: AuthErasureBarrier; proof: CurrentAuthReceivingClosure };

/** Released preparation only at the erased account's actual native partition.
 * The opaque producer locator is never a boolean permit for the later DELETE. */
export async function prepareAuthConsumerRetirement(
  pool: Pool,
  store: string,
  accountId: string,
  route: number,
  partition: number,
): Promise<AuthConsumerRetirement | null> {
  if (!isAuthConsumerStore(store) || partitionOf(route) !== partition) return null;
  const barrier = await withConnection(
    pool,
    async (tx) =>
      (
        await tx.query<AuthErasureBarrier>(
          `SELECT account_id AS "accountId",version,at::text FROM access.erasure WHERE route=$1 AND account_id=$2`,
          [route, accountId],
        )
      ).rows[0],
  );
  if (!barrier) return null;
  const proof = await prepareCurrentAuthReceivingClosure({ pool }, barrier, { deadline: Date.now() + 5000 });
  return proof ? { barrier, proof } : null;
}

/** Locks each exact selected source before the page's first destructive write.
 * Missing keys clear stale locators; present unsupported or foreign consumers
 * retain the original precise reason and bytes. No Auth checkout occurs here. */
export async function authConsumerBlocker(
  tx: PoolClient,
  store: keyof typeof consumers,
  role: string,
  key: readonly string[],
  accountId: string,
  progressId: string,
  prepared: AuthConsumerRetirement | null,
): Promise<NativeStoreBlocker | null> {
  const consumer = consumers[store];
  const where = consumer.key.map((column, index) => `${column}=$${index + 1}`).join(' AND ');
  const selected = await tx.query<{ source: object }>(
    `SELECT to_jsonb(s) AS source FROM access.${store} s WHERE ${where} FOR UPDATE`,
    [...key],
  );
  const row = selected.rows[0];
  if (!row) return null;
  if (
    !prepared ||
    prepared.barrier.accountId !== accountId ||
    !(await verifyCurrentAuthReceivingClosure(tx, prepared.barrier, prepared.proof))
  )
    return consumer.reason;
  const ready = await tx.query<{ ready: boolean }>(
    'SELECT access.auth_consumer_retirement_ready($1,$2::jsonb,$3,$4,$5) AS ready',
    [store, JSON.stringify(row.source), accountId, role, progressId],
  );
  return ready.rows[0]?.ready ? null : consumer.reason;
}

/** Called again in the native DELETE, using its actual source row. The native
 * function independently locks current custody; neither a GUC nor preparation
 * can substitute for that predicate. Parameters follow the original raw key. */
export function authConsumerDeletePredicate(store: string, role: string, keyLength: number): string {
  return `access.auth_consumer_retirement_ready('${store}',to_jsonb(${store}),$${keyLength + 1}::uuid,'${role}',$${keyLength + 2}::uuid)`;
}

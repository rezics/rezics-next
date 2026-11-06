import { runCommand, authoritativeTimeValue, type CommandTransaction } from '../command/command.ts';
import type { OperationalTransaction } from '../command/operational.ts';
import type { Pool, PoolClient } from 'pg';
import { withReadTransaction } from '../semantic/read.ts';
import { runOperationalTransaction } from '../command/operational.ts';
import { withErasureOperationalClient } from './erasure-operational-client.ts';
import { readLiveCopyLineage } from './live-copy-lineage.ts';
import { routeOf, partitionOf } from '../route/route.ts';
import type { LiveCopyRole } from './live-copy.ts';
import { LiveCopyPendingError } from './live-copy.ts';

type Client = Pick<PoolClient, 'query'>;
/** The actual source effects-admission transaction enrolls its own disposable intents.
 * Original core outbox/receipt/record custody retains its independent History obligations. */
export async function enrollCommerceCopyIntents(
  tx: Client,
  input: { route: number; orderId: string; partition: number; position: string; eventSeq: number },
  roles: readonly LiveCopyRole[],
) {
  if (roles.length > 64 || Buffer.byteLength(JSON.stringify(roles)) > 8192)
    throw new RangeError('Live copy role inventory exceeds native bound');
  for (const [kind, locator] of [
    ['commerce-work', { orderId: input.orderId }],
    ['commerce-receipt', { partition: input.partition, position: input.position, eventSeq: input.eventSeq }],
  ] as const) {
    await tx.query(
      `INSERT INTO access.live_copy_business_inventory(route,account_id,kind,locator)
      SELECT $1,(r->>'accountId')::uuid,$2,$3 FROM jsonb_array_elements($4::jsonb) r ON CONFLICT DO NOTHING`,
      [input.route, kind, JSON.stringify(locator), JSON.stringify(roles)],
    );
  }
}
/** Native discovery seals each visited home under the same key as inventory admission.
 * Its caller has already checked the genuine original account erasure root. */
async function sealLiveCopyInventory(tx: Client, partition: number, accountId: string) {
  await tx.query(
    `INSERT INTO access.live_copy_seal(partition_no,account_id,sealed) VALUES($1,$2,true)
    ON CONFLICT(partition_no,account_id) DO UPDATE SET sealed=true WHERE NOT access.live_copy_seal.sealed`,
    [partition, accountId],
  );
}
async function terminalRoot(pool: Pool, accountId: string, progressId: string) {
  const route = routeOf(accountId);
  if (route === null) throw new TypeError('Invalid live copy erasure account');
  return withReadTransaction(pool, async (tx) => {
    const result = await tx.query(
      `SELECT 1 FROM access.erasure_native_progress p JOIN access.erasure e USING(route,account_id)
      JOIN access.account a USING(route,account_id) WHERE p.route=$1 AND p.account_id=$2 AND p.progress_id=$3
      AND a.state='deleted' AND a.authn_fenced`,
      [route, accountId, progressId],
    );
    if (result.rowCount !== 1) throw new Error('Live copy minimization requires original native terminal root');
  });
}
/** Seal a discovery home without holding the root checkout. A changed native
 * frontier is retried by discovery; no foreign write occurs in its checkpoint transaction. */
export async function prepareLiveCopyDiscovery(pool: Pool, store: string, accountId: string): Promise<number> {
  const route = routeOf(accountId);
  if (route === null) throw new TypeError('Invalid live copy erasure account');
  const frontier = await withReadTransaction(pool, async (tx) => {
    const row = (
      await tx.query<{ partition_no: number; progress_id: string | null }>(
        `SELECT COALESCE(p.partition_no,0) AS partition_no,n.progress_id
      FROM access.erasure e JOIN access.account a USING(route,account_id)
      LEFT JOIN access.erasure_progress p ON p.route=e.route AND p.account_id=e.account_id AND p.store=$3 AND p.role='account_id'
      LEFT JOIN access.erasure_native_progress n ON (n.route,n.account_id)=(e.route,e.account_id)
      WHERE e.route=$1 AND e.account_id=$2 AND a.state='deleted' AND a.authn_fenced`,
        [route, accountId, store],
      )
    ).rows[0];
    if (!row) throw new Error('Live copy discovery requires original native terminal root');
    return row;
  });
  const partition = frontier.partition_no;
  const sealed = await withErasureOperationalClient(pool, async (client) =>
    runOperationalTransaction(
      pool,
      { mode: 'work-step', partition, kind: 'access.liveCopy.seal', accounts: [], workClient: client },
      async (tx) => {
        await readLiveCopyLineage(tx, partition);
        const coverage = (
          await tx.query<{
            covered: boolean;
            sales_covered: boolean;
            work_covered: boolean;
            receipts_covered: boolean;
          }>(
            'SELECT covered,sales_covered,work_covered,receipts_covered FROM access.live_copy_bootstrap WHERE partition_no=$1',
            [partition],
          )
        ).rows[0];
        if (!coverage?.covered || !coverage.sales_covered || !coverage.work_covered || !coverage.receipts_covered)
          return false;
        await sealLiveCopyInventory(tx, partition, accountId);
        return true;
      },
    ),
  );
  if (sealed) return partition;
  // Coverage debt bars EOF/sealing, not minimization of already known copies.
  // Native inverse deletion is the maintained progress for this bounded pending
  // branch; no discovery cursor or closure result advances while coverage is unknown.
  if (frontier.progress_id) {
    const keys = await withReadTransaction(pool, async (tx) => {
      const columns =
        store === 'live_copy_inventory'
          ? 'item::text,source_domain::text,transition_id::text'
          : store === 'live_copy_business_inventory'
            ? 'kind::text,locator::text'
            : null;
      if (!columns) throw new TypeError('Invalid live copy discovery store');
      const order = store === 'live_copy_inventory' ? 'route,item,source_domain,transition_id' : 'route,kind,locator';
      const rows = (
        await tx.query<{ key: string[] }>(
          `SELECT ARRAY[route::text,account_id::text,${columns}] AS key
        FROM access.${store} WHERE account_id=$1 AND route BETWEEN $2 AND $3 ORDER BY ${order} LIMIT 101`,
          [accountId, partition * 16, partition * 16 + 15],
        )
      ).rows;
      if (
        rows.some((row) => Buffer.byteLength(JSON.stringify(row.key)) > 1024) ||
        Buffer.byteLength(JSON.stringify(rows)) > 65536
      )
        throw new RangeError('Live copy pending inventory page exceeds its byte bound');
      return rows.slice(0, 100).map((row) => row.key);
    });
    for (const key of keys) await minimizeLiveCopyInventory(pool, store, key, accountId, frontier.progress_id);
  }
  throw new LiveCopyPendingError('Live copy original projection role coverage pending');
}
/** One exact selected locator, one authoritative home. It is not a family/custody ACK.
 * Pending transitions retain their inverse until the ordinary recovery has cancelled/applied and consumed. */
export async function minimizeLiveCopyInventory(
  pool: Pool,
  store: string,
  key: readonly string[],
  accountId: string,
  progressId: string,
): Promise<boolean> {
  await terminalRoot(pool, accountId, progressId);
  const route = Number(key[0]);
  if (
    key[1] !== accountId ||
    !Number.isInteger(route) ||
    route < 0 ||
    route > 65535 ||
    Buffer.byteLength(JSON.stringify(key)) > 1024
  )
    throw new TypeError('Invalid live copy erasure locator');
  return withErasureOperationalClient(pool, async (client) => {
    let changedSubject: string | null = null;
    const body = async (
      tx: OperationalTransaction | CommandTransaction,
      write?: { time: string; transactionId: string },
    ): Promise<boolean> => {
      changedSubject = null;
      await tx.query("SELECT set_config('rezics.erasure_progress',$1,true)", [progressId]);
      if (store === 'live_copy_business_inventory') {
        const [, , kind, encoded] = key;
        if (!encoded || !['commerce-work', 'commerce-receipt'].includes(kind!))
          throw new TypeError('Invalid business-copy erasure locator');
        const locator = JSON.parse(encoded) as {
          orderId?: string;
          partition?: number;
          position?: string;
          eventSeq?: number;
        };
        const inverse = await tx.query(
          `SELECT 1 FROM access.live_copy_business_inventory WHERE route=$1 AND account_id=$2 AND kind=$3 AND locator=$4 FOR UPDATE`,
          [route, accountId, kind, encoded],
        );
        if (!inverse.rowCount) return true;
        if (kind === 'commerce-work') {
          if (!locator.orderId) throw new TypeError('Invalid order work erasure locator');
          const pending = await tx.query(
            `SELECT 1 FROM access.live_copy_transition WHERE route=$1 AND effect_key->>'orderId'=$2 AND module='commerce.creator-sale' AND state='pending' LIMIT 1`,
            [route, locator.orderId],
          );
          if (pending.rowCount) return false;
          await tx.query('DELETE FROM commerce.creator_sale_work WHERE route=$1 AND order_id=$2', [
            route,
            locator.orderId,
          ]);
        } else {
          if (locator.partition !== partitionOf(route) || !locator.position || !Number.isInteger(locator.eventSeq))
            throw new TypeError('Invalid order receipt erasure locator');
          await tx.query(
            `UPDATE commerce.creator_sale_receipt SET order_id=NULL,source_revision=NULL,state='minimized'
            WHERE partition_no=$1 AND position=$2 AND event_seq=$3 AND state<>'minimized'`,
            [locator.partition, locator.position, locator.eventSeq],
          );
        }
        await tx.query(
          `DELETE FROM access.live_copy_business_inventory WHERE route=$1 AND account_id=$2 AND kind=$3 AND locator=$4`,
          [route, accountId, kind, encoded],
        );
        return true;
      }
      const [, , item, sourceDomain, transitionId] = key;
      if (
        store !== 'live_copy_inventory' ||
        !['source', 'hold', 'receiver'].includes(item!) ||
        !sourceDomain ||
        !transitionId
      )
        throw new TypeError('Invalid native-copy erasure locator');
      const inverse = await tx.query(
        `SELECT 1 FROM access.live_copy_inventory WHERE route=$1 AND account_id=$2 AND item=$3 AND source_domain=$4 AND transition_id=$5 FOR UPDATE`,
        [route, accountId, item, sourceDomain, transitionId],
      );
      if (!inverse.rowCount) return true;
      if (item === 'hold') {
        const held = await tx.query(
          `SELECT 1 FROM access.live_copy_hold WHERE route=$1 AND account_id=$2 AND source_domain=$3 AND transition_id=$4 AND result_id IS NULL`,
          [route, accountId, sourceDomain, transitionId],
        );
        if (held.rowCount) return false;
        await tx.query(
          `DELETE FROM access.live_copy_hold WHERE route=$1 AND account_id=$2 AND source_domain=$3 AND transition_id=$4 AND result_id IS NOT NULL`,
          [route, accountId, sourceDomain, transitionId],
        );
      } else if (item === 'source') {
        const copy = (
          await tx.query<{ state: string }>(
            `SELECT state FROM access.live_copy_transition WHERE route=$1 AND transition_id=$2 AND source_domain=$3 FOR UPDATE`,
            [route, transitionId, sourceDomain],
          )
        ).rows[0];
        if (copy?.state === 'pending') return false;
        await tx.query(
          `UPDATE access.live_copy_transition SET state='retired',payload=NULL,roles=NULL,effect_key=jsonb_build_object('retired',transition_id)
          WHERE route=$1 AND transition_id=$2 AND source_domain=$3 AND state='complete'`,
          [route, transitionId, sourceDomain],
        );
      } else {
        const gate = (
          await tx.query<{
            module: string;
            payload: Record<string, unknown> | null;
            outcome: string;
            retired: boolean;
          }>(
            `SELECT module,payload,outcome,retired FROM access.live_copy_gate WHERE route=$1 AND source_domain=$2 AND transition_id=$3 FOR UPDATE`,
            [route, sourceDomain, transitionId],
          )
        ).rows[0];
        if (!gate || gate.outcome === 'applying') return false;
        if (!gate.retired && gate.payload) {
          if (gate.module === 'commerce.creator-sale') {
            const view = gate.payload.view as { orderId: string };
            const revision = gate.payload.revision as number;
            const creator = gate.payload.creatorAccountId as string;
            await tx.query(
              'DELETE FROM commerce.creator_sale WHERE route=$1 AND creator_account_id=$2 AND order_id=$3 AND source_revision<=$4',
              [route, creator, view.orderId, revision],
            );
          } else if (gate.module === 'library.subject-listing') {
            const subjectId = gate.payload.subjectId as string,
              collectionId = gate.payload.collectionId as string;
            const stamp = gate.payload.stamp as { epoch: number; position: string };
            // Never erase a later replacement whose retained personal roster differs.
            const removed = await tx.query(
              `WITH removed AS (DELETE FROM library.subject_collection
              WHERE route=$1 AND subject_id=$2 AND collection_id=$3 AND (source_epoch,source_position)<=($4,$5::bigint) RETURNING subject_id)
              UPDATE library.subject_listing SET public_collection_count=public_collection_count-1,revision=revision+1,
              updated_at=COALESCE($6::timestamptz,updated_at),transaction_id=COALESCE($7::uuid,transaction_id)
              WHERE route=$1 AND subject_id=$2 AND EXISTS(SELECT 1 FROM removed) RETURNING subject_id`,
              [
                route,
                subjectId,
                collectionId,
                stamp.epoch,
                stamp.position,
                write?.time ?? null,
                write?.transactionId ?? null,
              ],
            );
            if (removed.rowCount) changedSubject = subjectId;
            await tx.query(
              `DELETE FROM library.subject_collection_version WHERE route=$1 AND subject_id=$2 AND collection_id=$3
              AND (source_epoch,source_position)<=($4,$5::bigint)`,
              [route, subjectId, collectionId, stamp.epoch, stamp.position],
            );
          } else throw new TypeError('Unknown live-copy receiver owner');
          await tx.query(
            `UPDATE access.live_copy_gate SET effect_key=NULL,payload=NULL,roles=NULL,retired=true WHERE route=$1 AND source_domain=$2 AND transition_id=$3 AND NOT retired`,
            [route, sourceDomain, transitionId],
          );
        }
      }
      await tx.query(
        `DELETE FROM access.live_copy_inventory WHERE route=$1 AND account_id=$2 AND item=$3 AND source_domain=$4 AND transition_id=$5`,
        [route, accountId, item, sourceDomain, transitionId],
      );
      return true;
    };
    const metadata = () =>
      runOperationalTransaction(
        pool,
        {
          mode: 'work-step',
          partition: partitionOf(route),
          kind: 'access.liveCopy.minimize',
          accounts: [],
          workClient: client,
        },
        async (tx) => {
          await readLiveCopyLineage(tx, partitionOf(route));
          const done = await body(tx);
          if (changedSubject) throw new PublicChange();
          return done;
        },
      );
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      try {
        return await metadata();
      } catch (error) {
        if (!(error instanceof PublicChange)) throw error;
      }
      try {
        const result = await runCommand(pool, { partition: partitionOf(route), deadline }, async (tx, command) => {
          await readLiveCopyLineage(tx, partitionOf(route));
          const done = await body(tx, {
            time: authoritativeTimeValue(command.time),
            transactionId: command.transactionId,
          });
          if (!changedSubject) throw new MetadataOnly();
          return {
            value: done,
            events: [
              {
                type: 'com.rezics.library.subject.listed.v1',
                subject: changedSubject,
                data: { subjectId: changedSubject },
              },
            ],
          };
        });
        return result.value;
      } catch (error) {
        if (!(error instanceof MetadataOnly)) throw error;
      }
    }
    throw new Error('Live copy minimization deadline exceeded');
  });
}
class PublicChange extends Error {}
class MetadataOnly extends Error {}

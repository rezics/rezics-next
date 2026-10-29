import type { Pool, PoolClient } from 'pg';
import { Value } from 'typebox/value';
import { withConnection } from '../database/pool.ts';
import type { Effect } from '../events/effects.ts';
import { readPartition } from '../partition/partition.ts';
import { partitionOf, routeOf } from '../route/route.ts';
import { CONTENT_EVENTS } from './events.ts';

export function partyRoute(id: string): number {
  const route = routeOf(id);
  if (route === null) throw new TypeError('Invalid party locator identity');
  return route;
}

/** A bounded internal storage command. The partition lock excludes movement/fencing;
 * the caller releases this transaction before accessing another partition.
 */
export async function partyPartition<T>(
  pool: Pool,
  route: number,
  command: (client: PoolClient) => Promise<T>,
): Promise<T> {
  return withConnection(pool, async (client) => {
    await client.query('BEGIN');
    try {
      await client.query('SELECT partition_no FROM core.partition WHERE partition_no=$1 FOR SHARE', [
        partitionOf(route),
      ]);
      const anchor = await readPartition(client, partitionOf(route));
      if (!anchor || anchor.writeState !== 'active') throw new Error('Content party partition is unavailable');
      const value = await command(client);
      await client.query('COMMIT');
      return value;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    }
  });
}

const decisionType = 'com.rezics.content.moderation.takedown.v1';
const operationType = 'com.rezics.content.author-erasure.requested.v1';

/** Commit-event projection, like author_item: read the source, release it, then
 * write one exact locator in each distinct party's account partition. Redelivery
 * rereads the minimized source and cannot recreate an erased party link.
 */
export function createPartyLocatorEffect(pool: Pool): Effect {
  return {
    name: 'content_party_locator',
    types: [decisionType, operationType],
    async run(event) {
      if (
        (event.type !== decisionType && event.type !== operationType) ||
        !Value.Check(CONTENT_EVENTS[event.type], event.data)
      )
        throw new TypeError('Invalid party locator event');
      const data = event.data as Record<string, string>;
      const ownerRoute = partyRoute((event.type === decisionType ? data.targetId : data.operationId)!);
      const source = /^urn:rezics:log:(\d+)\.([1-9][0-9]*)$/.exec(event.source);
      if (
        !source ||
        Number(source[1]) !== partitionOf(ownerRoute) ||
        !/^\d{19}$/.test(event.sequence) ||
        BigInt(event.sequence) < 1n
      )
        throw new TypeError('Invalid party locator source');
      const kind = event.type === decisionType ? 'decision' : 'operation';
      const record = await partyPartition(pool, ownerRoute, async (client) => {
        const anchor = await readPartition(client, partitionOf(ownerRoute));
        if (
          Number(source[2]) > anchor!.epoch ||
          (Number(source[2]) === anchor!.epoch && BigInt(event.sequence) > anchor!.position)
        )
          throw new Error('Party locator source is unavailable');
        if (kind === 'decision') {
          const {
            rows: [row],
          } = await client.query<{ id: string; due: string; parties: (string | null)[] }>(
            `SELECT decision_id AS id,(decided_at+interval '183 days')::text AS due, ARRAY[decider_account_id] AS parties
             FROM content.moderation_decision WHERE route=$1 AND target_kind=$2 AND target_id=$3 AND security_revision=$4`,
            [ownerRoute, data.targetKind, data.targetId, data.securityRevision],
          );
          if (!row) throw new Error('Party locator decision source is missing');
          return row;
        }
        const {
          rows: [row],
        } = await client.query<{ id: string; due: string; parties: (string | null)[] }>(
          `SELECT operation_id AS id,requested_at::text AS due,
           ARRAY[initiator_account_id,author_account_id,actor_account_id,original_operator_account_id,
             split_part(actor_requested_by,':',4)::uuid] AS parties
           FROM content.operation WHERE route=$1 AND operation_id=$2`,
          [ownerRoute, data.operationId],
        );
        if (!row) throw new Error('Party locator operation source is missing');
        return row;
      });
      for (const accountId of new Set(record.parties.filter((id): id is string => id !== null))) {
        await partyPartition(pool, partyRoute(accountId), async (client) => {
          await client.query(
            `INSERT INTO content.party_locator(route,account_id,kind,due_at,owner_route,owner_id)
            VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING`,
            [partyRoute(accountId), accountId, kind, record.due, ownerRoute, record.id],
          );
        });
      }
    },
  };
}

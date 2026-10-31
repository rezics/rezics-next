import type {
  AuthErasureObligation,
  AuthErasureObligationCut,
  AuthErasureObligationPoint,
  AuthErasureObligationPorts,
} from '@rezics/auth-contract';
import type { Pool, PoolClient } from 'pg';
import { routeOf } from '../route/route.ts';
import { discardConnection, withConnection } from '../database/pool.ts';
import { deadlineClient, within } from './authenticate.ts';

const uuid = (value: string) => /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(value);
const ordinal = (value: string) => /^(0|[1-9][0-9]{0,18})$/.test(value) && BigInt(value) <= 9223372036854775807n;
function requireInput(value: unknown): asserts value {
  if (!value) throw new Error('Invalid trusted Auth erasure obligation request');
}
type Source = {
  generation: string;
  source_epoch: number;
  source_owner: string;
  head: string;
  initialized: boolean;
};
type Segment = { high_water: string };
export type NativeRow = {
  route: number;
  accountId: string;
  version: number;
  at: string;
  minimumAuthnEpoch: string | null;
  receiptId: string | null;
  ordinal: string | null;
  valid: boolean;
};
export const columns = `e.route,e.account_id::text AS "accountId",e.version,e.at::text AS at,
 o.minimum_authn_epoch::text AS "minimumAuthnEpoch",o.receipt_id::text AS "receiptId",o.ordinal::text,
 (a.state='deleted' AND a.authn_fenced AND o.version=e.version AND o.at=e.at
  AND a.minimum_authn_epoch>=o.minimum_authn_epoch) AS valid`;
export function point(row: NativeRow): AuthErasureObligationPoint {
  const { route, accountId, version, at } = row;
  if (!row.minimumAuthnEpoch || !row.receiptId || !row.ordinal)
    return { state: 'pending', route, accountId, version, at, reason: 'original-floor-unavailable' };
  if (!row.valid) return { state: 'pending', route, accountId, version, at, reason: 'source-unavailable' };
  const obligation: AuthErasureObligation = {
    route,
    accountId,
    version,
    at,
    minimumAuthnEpoch: row.minimumAuthnEpoch,
    receiptId: row.receiptId,
    ordinal: row.ordinal,
  };
  if (Buffer.byteLength(JSON.stringify(obligation)) > 1024) throw new Error('Auth erasure locator exceeds 1 KiB');
  return { state: 'ready', obligation };
}
async function header(client: PoolClient, cutId: string, lock = false): Promise<AuthErasureObligationCut> {
  const row = (
    await client.query<{ sealed_partitions: number }>(
      `SELECT sealed_partitions FROM access.auth_erasure_cut WHERE cut_id=$1${lock ? ' FOR UPDATE' : ''}`,
      [cutId],
    )
  ).rows[0];
  requireInput(row);
  return {
    cutId,
    participant: 'auth',
    inventoryVersion: 1,
    producerVersion: 1,
    partitions: 4096,
    sealedPartitions: row.sealed_partitions,
  };
}
export function authErasureTransaction<T>(pool: Pool, deadline: number, work: (client: PoolClient) => Promise<T>) {
  requireInput(Number.isSafeInteger(deadline));
  return within(deadline, () =>
    withConnection(pool, async (connection) => {
      const client = deadlineClient(connection, deadline) as PoolClient;
      try {
        await client.query('BEGIN');
        await client.query("SELECT set_config('statement_timeout',$1,true),set_config('lock_timeout',$1,true)", [
          String(Math.max(1, deadline - Date.now())),
        ]);
        const result = await work(client);
        requireInput(Buffer.byteLength(JSON.stringify(result)) <= 65536);
        await client.query('COMMIT');
        return result;
      } catch (error) {
        try {
          await connection.query('ROLLBACK');
        } catch (rollback) {
          discardConnection(connection, rollback as Error);
        }
        throw error;
      }
    }),
  );
}

/** Native, fixed Auth-only producer readers. No pool, actor proof, maintenance or
 * acknowledgement capability crosses this closure. Cut writes retain source metadata only.
 */
export function createAuthErasureObligationBindings(pool: Pool): AuthErasureObligationPorts {
  const transaction = <T>(deadline: number, work: (client: PoolClient) => Promise<T>) =>
    authErasureTransaction(pool, deadline, work);
  return {
    readAuthErasureObligation(input) {
      const route = routeOf(input.accountId);
      requireInput(route !== null);
      return transaction(input.deadline, async (client) => {
        const home = (
          await client.query(
            `SELECT p.partition_no FROM core.partition p JOIN access.auth_erasure_source s USING(partition_no)
           WHERE p.partition_no=$1 AND p.write_state='active' AND p.epoch=s.source_epoch AND p.node=s.source_owner
           FOR SHARE OF p,s`,
            [(route! / 16) | 0],
          )
        ).rows[0];
        const row = (
          await client.query<NativeRow>(
            `SELECT ${columns} FROM access.erasure e
           JOIN access.account a USING(route,account_id)
           LEFT JOIN access.auth_erasure_obligation o USING(route,account_id)
           WHERE e.route=$1 AND e.account_id=$2`,
            [route, input.accountId],
          )
        ).rows[0];
        if (!row) return { state: 'absent' };
        if (!home)
          return {
            state: 'pending',
            route: row.route,
            accountId: row.accountId,
            version: row.version,
            at: row.at,
            reason: 'source-unavailable',
          };
        return point(row);
      });
    },
    startAuthErasureObligationCut(input) {
      requireInput(uuid(input.cutId));
      return transaction(input.deadline, async (client) => {
        await client.query('INSERT INTO access.auth_erasure_cut(cut_id) VALUES($1) ON CONFLICT DO NOTHING', [
          input.cutId,
        ]);
        return header(client, input.cutId);
      });
    },
    pageAuthErasureObligations(input) {
      requireInput(
        uuid(input.cutId) &&
          Number.isInteger(input.cursor.partition) &&
          input.cursor.partition >= 0 &&
          input.cursor.partition < 4096 &&
          ordinal(input.cursor.afterOrdinal),
      );
      return transaction(input.deadline, async (client) => {
        const partition = input.cursor.partition;
        let cut = await header(client, input.cutId, true);
        requireInput(partition <= cut.sealedPartitions);
        const home = (
          await client.query<{ available: boolean }>(
            `SELECT (p.write_state='active' AND (s.partition_no IS NULL OR
             (s.source_epoch=p.epoch AND s.source_owner=p.node))) AS available
           FROM core.partition p LEFT JOIN access.auth_erasure_source s USING(partition_no)
           WHERE p.partition_no=$1 FOR UPDATE OF p`,
            [partition],
          )
        ).rows[0];
        if (!home?.available)
          return {
            cut,
            cursor: input.cursor,
            obligations: [],
            pending: [],
            next: input.cursor,
            state: 'pending',
            reason: 'source-unavailable',
          };
        const initialized = (
          await client.query<{ ready: boolean }>('SELECT access.initialize_auth_erasure_partition($1) AS ready', [
            partition,
          ])
        ).rows[0]!.ready;
        const source = (
          await client.query<Source>(
            'SELECT generation,source_epoch,source_owner,head::text,initialized FROM access.auth_erasure_source WHERE partition_no=$1',
            [partition],
          )
        ).rows[0]!;
        if (!initialized)
          return { cut, cursor: input.cursor, obligations: [], pending: [], next: input.cursor, state: 'initializing' };
        let segment = (
          await client.query<Segment>(
            `SELECT generation,source_epoch,source_owner,high_water::text,source_position::text
           FROM access.auth_erasure_cut_partition WHERE cut_id=$1 AND partition_no=$2`,
            [input.cutId, partition],
          )
        ).rows[0];
        if (!segment) {
          // Only genuine native floor evidence permits sealing, including zero data.
          const pending = (
            await client.query(
              `SELECT 1 FROM access.auth_erasure_obligation WHERE partition_no=$1 AND minimum_authn_epoch IS NULL LIMIT 1`,
              [partition],
            )
          ).rowCount;
          if (!pending) {
            await client.query(
              `INSERT INTO access.auth_erasure_cut_partition(cut_id,partition_no,generation,source_epoch,source_owner,source_position,high_water)
               SELECT $1,s.partition_no,s.generation,s.source_epoch,s.source_owner,p.position,s.head
               FROM access.auth_erasure_source s JOIN core.partition p USING(partition_no) WHERE s.partition_no=$2`,
              [input.cutId, partition],
            );
            await client.query(
              'UPDATE access.auth_erasure_cut SET sealed_partitions=sealed_partitions+1 WHERE cut_id=$1',
              [input.cutId],
            );
            cut = await header(client, input.cutId);
            segment = { high_water: source.head };
          }
        }
        const highWater = segment?.high_water ?? source.head;
        requireInput(BigInt(input.cursor.afterOrdinal) <= BigInt(highWater));
        const rows = (
          await client.query<NativeRow>(
            `SELECT ${columns} FROM (
             SELECT * FROM access.auth_erasure_obligation WHERE partition_no=$1 AND ordinal>$2::bigint AND ordinal<=$3::bigint
             ORDER BY ordinal LIMIT 48
           ) o JOIN access.erasure e USING(route,account_id) JOIN access.account a USING(route,account_id)
           ORDER BY o.ordinal`,
            [partition, input.cursor.afterOrdinal, highWater],
          )
        ).rows;
        const points = rows.map(point);
        const obligations = points.flatMap((p) => (p.state === 'ready' ? [p.obligation] : []));
        const pending = points.flatMap((p) => (p.state === 'pending' ? [p] : []));
        const afterOrdinal = rows.at(-1)?.ordinal ?? input.cursor.afterOrdinal;
        const end = afterOrdinal === highWater;
        const next =
          end && segment
            ? partition === 4095
              ? null
              : { partition: partition + 1, afterOrdinal: '0' }
            : { partition, afterOrdinal: afterOrdinal! };
        return {
          cut,
          cursor: input.cursor,
          obligations,
          pending,
          next,
          state: !segment || pending.length ? 'pending' : end ? 'partition-end' : 'page',
        };
      });
    },
    verifyAuthErasureObligationCut(input) {
      requireInput(
        uuid(input.cutId) && Number.isInteger(input.partition) && input.partition >= 0 && input.partition < 4096,
      );
      return transaction(input.deadline, async (client) => {
        const cut = await header(client, input.cutId);
        const row = (
          await client.query<{
            generation: string;
            source_epoch: number;
            source_owner: string;
            high_water: string;
            head: string;
            current: boolean;
          }>(
            `SELECT c.generation,c.source_epoch,c.source_owner,c.high_water::text,s.head::text,
             (p.write_state='active' AND p.node=c.source_owner AND p.epoch=c.source_epoch
              AND s.generation=c.generation AND s.source_epoch=c.source_epoch AND s.source_owner=c.source_owner
              AND s.initialized AND s.head=c.high_water AND p.position>=c.source_position) AS current
           FROM access.auth_erasure_cut_partition c JOIN access.auth_erasure_source s USING(partition_no)
           JOIN core.partition p USING(partition_no) WHERE c.cut_id=$1 AND c.partition_no=$2 FOR SHARE OF p,s`,
            [input.cutId, input.partition],
          )
        ).rows[0];
        return {
          cutId: input.cutId,
          partition: input.partition,
          state: row?.current && cut.sealedPartitions === 4096 ? 'current' : 'pending',
          sourceGeneration: row?.generation ?? null,
          sourceEpoch: row?.source_epoch ?? null,
          sourceOwner: row?.source_owner ?? null,
          highWater: row?.high_water ?? null,
          liveHighWater: row?.head ?? null,
        };
      });
    },
  };
}

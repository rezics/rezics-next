import type {
  AuthErasureLivePorts,
  AuthErasureLiveReceiver,
  AuthErasureLiveVerification,
  AuthErasureLivePendingReason,
} from '@rezics/auth-contract';
import type { Pool, PoolClient } from 'pg';
import { authErasureTransaction, columns, point, type NativeRow } from './auth-erasure-obligations.ts';

const ordinal = (v: string) => /^(0|[1-9][0-9]{0,18})$/.test(v) && BigInt(v) <= 9223372036854775807n;
function requireInput(value: unknown): asserts value {
  if (!value) throw new Error('Invalid trusted Auth erasure live request');
}
type Evidence = {
  generation: string;
  source_epoch: number;
  source_owner: string;
  high_water: string;
  head: string;
  source_current: boolean;
  floor_pending: boolean;
  enrolled_through: string | null;
  enrollment_current: boolean | null;
  arm_high_water: string | null;
  subscription_current: boolean | null;
};

/** Native Source capability; the pool remains inside Access. Receiver identity is
 * trusted composition data, never request JSON or a caller-ready certificate.
 * This factory implements the original auth-contract module's closed live ABI;
 * createAuthBindings mounts it only with a separately supplied receiver binding. */
export function createAuthErasureLiveBindings(pool: Pool, identity: AuthErasureLiveReceiver): AuthErasureLivePorts {
  requireInput(
    /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(identity.cutId) &&
      [identity.authGeneration, identity.databaseIdentity, identity.inventoryEntry, identity.inventoryVersion].every(
        (v) => typeof v === 'string' && Buffer.byteLength(v) > 0 && Buffer.byteLength(v) <= 1024,
      ),
  );
  // Capture values once. Mutating the composition object cannot switch a receiver.
  const receiver: AuthErasureLiveReceiver = Object.freeze({
    cutId: identity.cutId,
    authGeneration: identity.authGeneration,
    databaseIdentity: identity.databaseIdentity,
    inventoryEntry: identity.inventoryEntry,
    inventoryVersion: identity.inventoryVersion,
  });
  const binding = [
    receiver.cutId,
    receiver.authGeneration,
    receiver.databaseIdentity,
    receiver.inventoryEntry,
    receiver.inventoryVersion,
  ];
  async function native(client: PoolClient, partition: number) {
    requireInput(Number.isInteger(partition) && partition >= 0 && partition < 4096);
    // Exactly the original producer's lock order. No cut-header lock or global
    // writer mutex; all reads/arm work address this one native partition.
    await client.query('SELECT partition_no FROM core.partition WHERE partition_no=$1 FOR UPDATE', [partition]);
    const stored = (
      await client.query<{
        auth_generation: string;
        database_identity: string;
        inventory_entry: string;
        inventory_version: string;
      }>(
        'SELECT auth_generation,database_identity,inventory_entry,inventory_version FROM access.auth_erasure_live_receiver WHERE cut_id=$1',
        [receiver.cutId],
      )
    ).rows[0];
    if (
      stored &&
      (stored.auth_generation !== receiver.authGeneration ||
        stored.database_identity !== receiver.databaseIdentity ||
        stored.inventory_entry !== receiver.inventoryEntry ||
        stored.inventory_version !== receiver.inventoryVersion)
    )
      throw new Error('Auth erasure live receiver binding changed');
    const evidence = (
      await client.query<Evidence>(
        `SELECT c.generation,c.source_epoch,c.source_owner,c.high_water::text,s.head::text,
       (p.write_state='active' AND p.epoch=c.source_epoch AND p.node=c.source_owner
        AND p.position>=c.source_position AND s.initialized
        AND (s.generation,s.source_epoch,s.source_owner)=(c.generation,c.source_epoch,c.source_owner)) AS source_current,
       EXISTS(SELECT 1 FROM access.auth_erasure_obligation o
              WHERE o.partition_no=c.partition_no AND o.minimum_authn_epoch IS NULL) AS floor_pending,
       l.enrolled_through::text,
       (l.lineage_valid AND l.enrolled_through=s.head
        AND (l.generation,l.source_epoch,l.source_owner)=(c.generation,c.source_epoch,c.source_owner)) AS enrollment_current,
       u.arm_high_water::text,
       ((u.generation,u.source_epoch,u.source_owner,u.high_water)=
        (c.generation,c.source_epoch,c.source_owner,c.high_water)
        AND u.arm_high_water>=l.enrollment_floor AND u.arm_high_water<=s.head) AS subscription_current
      FROM access.auth_erasure_cut_partition c
      JOIN access.auth_erasure_cut h USING(cut_id)
      JOIN access.auth_erasure_source s USING(partition_no) JOIN core.partition p USING(partition_no)
      LEFT JOIN access.auth_erasure_live_partition l USING(partition_no)
      LEFT JOIN access.auth_erasure_live_subscription u ON u.cut_id=c.cut_id AND u.partition_no=c.partition_no
      WHERE c.cut_id=$1 AND c.partition_no=$2 AND h.participant='auth'
       AND h.inventory_version=1 AND h.producer_version=1`,
        [receiver.cutId, partition],
      )
    ).rows[0];
    return { stored, evidence };
  }
  function observation(
    partition: number,
    e: Evidence | undefined,
    reason: AuthErasureLivePendingReason,
  ): Extract<AuthErasureLiveVerification, { state: 'pending' }>;
  function observation(
    partition: number,
    e: Evidence | undefined,
    reason?: AuthErasureLivePendingReason,
  ): AuthErasureLiveVerification;
  function observation(
    partition: number,
    e: Evidence | undefined,
    reason?: AuthErasureLivePendingReason,
  ): AuthErasureLiveVerification {
    const fields = {
      receiver,
      partition,
      sourceGeneration: e?.generation ?? null,
      sourceEpoch: e?.source_epoch ?? null,
      sourceOwner: e?.source_owner ?? null,
      highWater: e?.high_water ?? null,
      armHighWater: e?.arm_high_water ?? null,
      enrolledThrough: e?.enrolled_through ?? null,
    };
    return reason ? { ...fields, state: 'pending', reason } : { ...fields, state: 'current' };
  }
  function sourceReason(e: Evidence | undefined): AuthErasureLivePendingReason | undefined {
    if (!e) return 'cut-unavailable';
    if (!e.source_current) return 'source-unavailable';
    if (e.floor_pending) return 'original-floor-unavailable';
  }
  function verification(partition: number, result: Awaited<ReturnType<typeof native>>) {
    const e = result.evidence;
    return observation(
      partition,
      e,
      sourceReason(e) ??
        (!result.stored
          ? 'receiver-unavailable'
          : !e?.enrollment_current || !e.subscription_current
            ? 'tail-unavailable'
            : undefined),
    );
  }
  return {
    armAuthErasureLivePartition(input) {
      input = { partition: input.partition, deadline: input.deadline };
      return authErasureTransaction(pool, input.deadline, async (client) => {
        let result = await native(client, input.partition);
        const reason = sourceReason(result.evidence);
        if (reason) return observation(input.partition, result.evidence, reason);
        await client.query(
          `INSERT INTO access.auth_erasure_live_partition(partition_no,generation,source_epoch,source_owner,enrollment_floor,enrolled_through)
           SELECT partition_no,generation,source_epoch,source_owner,head,head FROM access.auth_erasure_source
           WHERE partition_no=$1 ON CONFLICT DO NOTHING`,
          [input.partition],
        );
        result = await native(client, input.partition);
        if (!result.evidence?.enrollment_current)
          return observation(input.partition, result.evidence, 'tail-unavailable');
        await client.query(
          `INSERT INTO access.auth_erasure_live_receiver(cut_id,auth_generation,database_identity,inventory_entry,inventory_version)
           VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING`,
          binding,
        );
        // Recheck exact identity after an insertion racing another partition's arm.
        result = await native(client, input.partition);
        await client.query(
          `INSERT INTO access.auth_erasure_live_subscription(cut_id,partition_no,generation,source_epoch,source_owner,high_water,arm_high_water)
           SELECT c.cut_id,c.partition_no,c.generation,c.source_epoch,c.source_owner,c.high_water,s.head
           FROM access.auth_erasure_cut_partition c JOIN access.auth_erasure_source s USING(partition_no)
           WHERE c.cut_id=$1 AND c.partition_no=$2 ON CONFLICT DO NOTHING`,
          [receiver.cutId, input.partition],
        );
        const current = verification(input.partition, await native(client, input.partition));
        return current.state === 'current' ? { ...current, state: 'armed' as const } : current;
      });
    },
    verifyAuthErasureLivePartition(input) {
      input = { partition: input.partition, deadline: input.deadline };
      return authErasureTransaction(pool, input.deadline, async (client) =>
        verification(input.partition, await native(client, input.partition)),
      );
    },
    readAuthErasureLivePage(input) {
      input = {
        cursor: { partition: input.cursor.partition, afterOrdinal: input.cursor.afterOrdinal },
        deadline: input.deadline,
      };
      requireInput(ordinal(input.cursor.afterOrdinal));
      return authErasureTransaction(pool, input.deadline, async (client) => {
        const partition = verification(input.cursor.partition, await native(client, input.cursor.partition));
        const empty = {
          partition,
          cursor: input.cursor,
          obligations: [],
          pending: [],
          next: input.cursor,
          state: 'pending' as const,
        };
        if (partition.state === 'pending' && partition.reason !== 'original-floor-unavailable') return empty;
        // Unknown original floors remain readable as precise pending tuples, but
        // cannot be skipped by a continuation or turn into live continuity.
        if (partition.highWater === null || partition.enrolledThrough === null || partition.armHighWater === null)
          return empty;
        requireInput(
          BigInt(input.cursor.afterOrdinal) >= BigInt(partition.highWater) &&
            BigInt(input.cursor.afterOrdinal) <= BigInt(partition.enrolledThrough),
        );
        const rows = (
          await client.query<NativeRow>(
            `SELECT ${columns} FROM (
            SELECT * FROM access.auth_erasure_obligation
             WHERE partition_no=$1 AND ordinal>$2::bigint AND ordinal<=$3::bigint ORDER BY ordinal LIMIT 48
           ) o JOIN access.erasure e USING(route,account_id) JOIN access.account a USING(route,account_id)
           ORDER BY o.ordinal`,
            [input.cursor.partition, input.cursor.afterOrdinal, partition.enrolledThrough],
          )
        ).rows;
        const points = rows.map(point);
        const pending = points.flatMap((p) => (p.state === 'pending' ? [p] : []));
        const obligations = points.flatMap((p) => (p.state === 'ready' ? [p.obligation] : []));
        let afterOrdinal = input.cursor.afterOrdinal;
        for (let i = 0; i < rows.length && points[i]!.state === 'ready'; i++) afterOrdinal = rows[i]!.ordinal!;
        const state =
          pending.length || partition.state === 'pending'
            ? ('pending' as const)
            : afterOrdinal === partition.enrolledThrough
              ? ('tail-end' as const)
              : ('page' as const);
        return {
          partition,
          cursor: input.cursor,
          obligations,
          pending,
          next: { partition: input.cursor.partition, afterOrdinal },
          state,
        };
      });
    },
  };
}

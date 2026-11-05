import type { Pool, PoolClient } from 'pg';
import { withConnection, discardConnection } from '../database/pool.ts';
import { requireAccessDeadline, CommandUnavailableError } from '../access/unavailable.ts';

/** Internal domain key. It cannot be a public property, inferred hit or caller filter key. */
export const PUBLIC_FILTER_ACCOUNT_DOMAIN = '["domain","accounts"]';
type Pending = {
  partition_no: number;
  input_key: string;
  owner_epoch: number;
  captured_through: string | null;
  captured_revision: string | null;
  captured_epoch: number | null;
  fanout_frontier: string | null;
  captured_enrollment_generation: string | null;
  captured_native_revision: string | null;
  captured_native_claim_revision: string | null;
  native_captured_enqueue: string | null;
  native_captured_epoch: number | null;
};
type Enrollment = {
  enrollment_generation: string;
  registration_partition: number;
  registration: string;
  bootstrap: string;
  read_definition: string;
  owner_epoch: number;
  source_position: string;
  native_revision: string | null;
  native_claim_revision: string | null;
  complete: boolean;
  receipt: string | null;
};

async function transaction<T>(pool: Pool, deadline: number, body: (client: PoolClient) => Promise<T>): Promise<T> {
  requireAccessDeadline(deadline);
  return withConnection(pool, async (client) => {
    await client.query('BEGIN');
    try {
      await client.query(`SET LOCAL statement_timeout = '${Math.max(1, Math.floor(deadline - Date.now()))}ms'`);
      const result = await body(client);
      requireAccessDeadline(deadline);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      try {
        await client.query('ROLLBACK');
      } catch (rollbackError) {
        discardConnection(client, rollbackError as Error);
      }
      throw error;
    }
  });
}

function frontier(enrollment: Enrollment): string {
  return JSON.stringify([
    enrollment.enrollment_generation,
    enrollment.registration_partition,
    enrollment.registration,
    enrollment.bootstrap,
  ]);
}
function after(value: string | null): readonly [string, number, string, string] {
  if (value === null) return ['0', -1, '', '00000000-0000-0000-0000-000000000000'];
  const parsed: unknown = JSON.parse(value);
  // The migration freezes all pre-installation keys at generation zero while
  // excluding concurrent enrollment. Preserve their original traversal prefix.
  if (Array.isArray(parsed) && parsed.length === 3) parsed.unshift('0');
  if (
    !Array.isArray(parsed) ||
    parsed.length !== 4 ||
    typeof parsed[0] !== 'string' ||
    !/^(0|[1-9][0-9]*)$/.test(parsed[0]) ||
    !Number.isInteger(parsed[1]) ||
    parsed[1] < 0 ||
    parsed[1] > 4095 ||
    typeof parsed[2] !== 'string' ||
    typeof parsed[3] !== 'string'
  )
    throw new Error('Invalid retained Source enrollment frontier');
  return parsed as [string, number, string, string];
}

/** Receiver apply commits in the existing registration home. Its same-row native
 * positions are also the idempotent receipt. This function grants no ACK.
 */
async function apply(pool: Pool, pending: Pending, enrollment: Enrollment, deadline: number) {
  // A staged key is not a completed native enrollment receipt. In particular,
  // absence of its eventual baseline cannot make a captured interval empty.
  if (!enrollment.complete || enrollment.receipt === null) return false;
  return transaction(pool, deadline, async (client) => {
    // Take native owner custody before registration custody, matching domain commands.
    const owner = (
      await client.query<{ write_state: string }>(
        'SELECT write_state FROM core.partition WHERE partition_no=$1 FOR SHARE',
        [enrollment.registration_partition],
      )
    ).rows[0];
    if (!owner || owner.write_state !== 'active') return false;
    const registered = (
      await client.query<{ state: string; write_state: string }>(
        `SELECT r.state,p.write_state FROM search.public_filter_registration r
       JOIN core.partition p ON p.partition_no=r.partition_no
       WHERE (r.partition_no,r.id)=($1,$2) FOR UPDATE OF r`,
        [enrollment.registration_partition, enrollment.registration],
      )
    ).rows[0];
    // Missing is not retirement: physical copies and users may still exist.
    if (!registered || registered.write_state !== 'active') return false;
    if (registered.state !== 'active') return false;
    const current = (
      await client.query<{
        source_epoch: number;
        relevant_position: string;
        native_enqueue_revision: string;
        native_revision: string | null;
        native_claim_revision: string | null;
      }>(
        `SELECT source_epoch,relevant_position::text,native_enqueue_revision::text,
         native_revision::text,native_claim_revision::text
       FROM search.public_filter_coverage_home
       WHERE (partition_no,registration,source_home)=($1,$2,$3) FOR UPDATE`,
        [enrollment.registration_partition, enrollment.registration, pending.partition_no],
      )
    ).rows[0];
    const account = pending.input_key === PUBLIC_FILTER_ACCOUNT_DOMAIN;
    const queue = pending.native_captured_enqueue;
    const position = pending.captured_through;
    const epoch = account ? pending.native_captured_epoch : pending.captured_epoch;
    if (epoch !== enrollment.owner_epoch) return false;
    if (
      account
        ? queue === null || pending.captured_native_revision === null || pending.captured_native_claim_revision === null
        : position === null
    )
      return false;
    // Account sequence numbers are never ordered as Source log positions. Only
    // the original persistent key/home enqueue revision is a delivery high water.
    if (
      current?.source_epoch === epoch &&
      (account
        ? BigInt(current.native_enqueue_revision) >= BigInt(queue!)
        : BigInt(current.relevant_position) >= BigInt(position!))
    )
      return true;
    const generation = (
      await client.query<{ generation: string }>(
        `UPDATE search.public_filter_registration SET coverage_generation=coverage_generation+1
       WHERE (partition_no,id)=($1,$2) AND state='active'
       RETURNING coverage_generation::text AS generation`,
        [enrollment.registration_partition, enrollment.registration],
      )
    ).rows[0];
    if (!generation) return false;
    await client.query(
      `INSERT INTO search.public_filter_coverage_home
        (partition_no,registration,source_home,source_epoch,relevant_position,
         native_enqueue_revision,native_revision,native_claim_revision,last_change_generation,behind)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,true)
       ON CONFLICT (partition_no,registration,source_home) DO UPDATE SET
         source_epoch=EXCLUDED.source_epoch,
         relevant_position=CASE WHEN $10 THEN public_filter_coverage_home.relevant_position
           ELSE greatest(public_filter_coverage_home.relevant_position,EXCLUDED.relevant_position) END,
         native_enqueue_revision=CASE WHEN $10 THEN EXCLUDED.native_enqueue_revision
           ELSE public_filter_coverage_home.native_enqueue_revision END,
         native_revision=CASE WHEN $10 THEN EXCLUDED.native_revision
           ELSE public_filter_coverage_home.native_revision END,
         native_claim_revision=CASE WHEN $10 THEN EXCLUDED.native_claim_revision
           ELSE public_filter_coverage_home.native_claim_revision END,
         last_change_generation=EXCLUDED.last_change_generation,behind=true`,
      [
        enrollment.registration_partition,
        enrollment.registration,
        pending.partition_no,
        epoch,
        account ? enrollment.source_position : position,
        account ? queue : '0',
        account ? pending.captured_native_revision : enrollment.native_revision,
        account ? pending.captured_native_claim_revision : enrollment.native_claim_revision,
        generation.generation,
        account,
      ],
    );
    return true;
  });
}

/** One funded Source step, bounded by a single key and at most 100 enrollment
 * receipts. Release Source custody before every receiver phase and reacquire it
 * only after committed apply. Unknown state retains the original pending barrier.
 */
export async function maintainPublicFilterCoverageHome(
  pool: Pool,
  partition: number,
  context: Readonly<{ deadline: number }>,
  limit = 1,
): Promise<Readonly<{ applied: number; more: boolean }>> {
  if (
    !Number.isInteger(partition) ||
    partition < 0 ||
    partition > 4095 ||
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > 100
  )
    throw new RangeError('Coverage maintenance requires a native home and limit 1..100');
  const captured = await transaction(pool, context.deadline, async (client) => {
    // This is the same native Source home lock acquired by both writer families.
    const owner = (
      await client.query<{ epoch: number; write_state: string }>(
        'SELECT epoch,write_state FROM core.partition WHERE partition_no=$1 FOR SHARE',
        [partition],
      )
    ).rows[0];
    if (!owner || owner.write_state !== 'active') throw new CommandUnavailableError('fenced', partition);
    const head = await client.query<{ enrollment_generation: string }>(
      'SELECT enrollment_generation::text FROM semantic.public_filter_privacy_head WHERE partition_no=$1 FOR UPDATE',
      [partition],
    );
    if (head.rowCount !== 1) throw new CommandUnavailableError('fenced', partition);
    const pending = (
      await client.query<Pending>(
        `SELECT * FROM semantic.public_filter_privacy_pending
       WHERE partition_no=$1 AND live ORDER BY input_key LIMIT 1 FOR UPDATE`,
        [partition],
      )
    ).rows[0];
    if (!pending) return null;
    if (pending.owner_epoch !== owner.epoch) throw new CommandUnavailableError('fenced', partition);
    const account = pending.input_key === PUBLIC_FILTER_ACCOUNT_DOMAIN;
    if (account ? pending.native_captured_enqueue === null : pending.captured_revision === null) {
      const saved = (
        await client.query<Pending>(
          `UPDATE semantic.public_filter_privacy_pending SET
           captured_epoch=CASE WHEN $3 THEN NULL ELSE owner_epoch END,
           native_captured_epoch=CASE WHEN $3 THEN owner_epoch ELSE NULL END,
           captured_through=CASE WHEN $3 THEN NULL ELSE through_position END,
           captured_revision=CASE WHEN $3 THEN NULL ELSE enqueue_revision END,
           native_captured_enqueue=CASE WHEN $3 THEN enqueue_revision ELSE NULL END,
           captured_native_revision=native_revision,captured_native_claim_revision=native_claim_revision,
           fanout_frontier=NULL,next_first_position=NULL,captured_enrollment_generation=$4::bigint
         WHERE (partition_no,input_key)=($1,$2) RETURNING *`,
          [partition, pending.input_key, account, head.rows[0]!.enrollment_generation],
        )
      ).rows[0];
      if (!saved) throw new Error('Coverage capture lost its locked home key');
      return saved;
    }
    if (pending.captured_enrollment_generation === null) {
      // Existing intervals receive their installation cutoff in the migration,
      // under locks excluding enrollment. Missing authority is not a new cut.
      throw new Error('Retained Source interval has no enrollment cutoff');
    }
    return pending;
  });
  if (!captured) return { applied: 0, more: false };
  const keyset = after(captured.fanout_frontier);
  if (
    captured.captured_enrollment_generation === null ||
    BigInt(keyset[0]) > BigInt(captured.captured_enrollment_generation)
  )
    throw new Error('Retained Source enrollment frontier exceeds its captured window');
  const enrollments = await withConnection(
    pool,
    async (client) =>
      (
        await client.query<Enrollment>(
          `SELECT e.enrollment_generation::text,e.registration_partition,e.registration,e.bootstrap::text,h.read_definition::text,
       h.owner_epoch,h.source_position::text,h.native_revision::text,h.native_claim_revision::text,h.complete,h.receipt
     FROM semantic.public_filter_key_enrollment e
     JOIN semantic.public_filter_home_enrollment h USING(partition_no,bootstrap)
     WHERE e.partition_no=$1 AND e.input_key=$2
       AND e.enrollment_generation<=$3::bigint
       AND (e.enrollment_generation,e.registration_partition,e.registration,e.bootstrap)>($4::bigint,$5,$6,$7::uuid)
     ORDER BY e.enrollment_generation,e.registration_partition,e.registration,e.bootstrap LIMIT $8`,
          [partition, captured.input_key, captured.captured_enrollment_generation, ...keyset, limit],
        )
      ).rows,
  );
  let applied = 0;
  let next = captured.fanout_frontier;
  for (const enrollment of enrollments) {
    if (!(await apply(pool, captured, enrollment, context.deadline))) break;
    applied++;
    next = frontier(enrollment);
  }
  const all = applied === enrollments.length && enrollments.length < limit;
  await transaction(pool, context.deadline, async (client) => {
    const owner = (
      await client.query<{ epoch: number; write_state: string }>(
        'SELECT epoch,write_state FROM core.partition WHERE partition_no=$1 FOR SHARE',
        [partition],
      )
    ).rows[0];
    // A move never adopts an old owner's receipt or retires its pending interval.
    if (!owner || owner.write_state !== 'active' || owner.epoch !== captured.owner_epoch) return;
    const head = await client.query(
      'SELECT 1 FROM semantic.public_filter_privacy_head WHERE partition_no=$1 FOR UPDATE',
      [partition],
    );
    if (head.rowCount !== 1) return;
    const account = captured.input_key === PUBLIC_FILTER_ACCOUNT_DOMAIN;
    const settled = account ? captured.native_captured_enqueue : captured.captured_revision;
    const changed = await client.query(
      `UPDATE semantic.public_filter_privacy_pending SET fanout_frontier=$3,
        live=CASE WHEN $4 AND enqueue_revision=$5::bigint THEN false ELSE live END,
        first_position=CASE WHEN $4 AND NOT $6 AND enqueue_revision<>$5::bigint
          THEN next_first_position ELSE first_position END,
        captured_through=CASE WHEN $4 THEN NULL ELSE captured_through END,
        captured_revision=CASE WHEN $4 THEN NULL ELSE captured_revision END,
        captured_epoch=CASE WHEN $4 THEN NULL ELSE captured_epoch END,
        native_captured_epoch=CASE WHEN $4 THEN NULL ELSE native_captured_epoch END,
        native_captured_enqueue=CASE WHEN $4 THEN NULL ELSE native_captured_enqueue END,
        captured_native_revision=CASE WHEN $4 THEN NULL ELSE captured_native_revision END,
        captured_native_claim_revision=CASE WHEN $4 THEN NULL ELSE captured_native_claim_revision END,
        captured_enrollment_generation=CASE WHEN $4 THEN NULL ELSE captured_enrollment_generation END,
        next_first_position=CASE WHEN $4 THEN NULL ELSE next_first_position END
       WHERE (partition_no,input_key)=($1,$2) AND live
         AND coalesce(native_captured_enqueue,captured_revision)=$5::bigint
         AND fanout_frontier IS NOT DISTINCT FROM $7
         AND captured_enrollment_generation=$8::bigint`,
      [
        partition,
        captured.input_key,
        all ? null : next,
        all,
        settled,
        account,
        captured.fanout_frontier,
        captured.captured_enrollment_generation,
      ],
    );
    // A concurrent maintainer won the same retained interval. Its committed
    // frontier is authoritative; do not create another traversal or clear it.
    if (changed.rowCount !== 1) return;
  });
  return { applied, more: applied > 0 || all };
}

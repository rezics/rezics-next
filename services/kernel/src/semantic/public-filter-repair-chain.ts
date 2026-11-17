import { createHash } from 'node:crypto';
import type { Pool } from 'pg';
import { withConnection, discardConnection, withBoundedReadConnection } from '../database/pool.ts';
import { CommandUnavailableError, requireAccessDeadline } from '../access/unavailable.ts';

type Chain = Readonly<{ bootstrap: string; execution: string; binding: string }>;
type Page = Readonly<{
  step: string;
  predecessor: string | null;
  state: string;
  complete: boolean;
  inputLimit: number;
  digests: string;
  closedHome?: number;
  alreadyVerified?: boolean;
}>;
type Proof = {
  step: string;
  predecessor: string | null;
  binding: string | null;
  root: string | null;
  ordinal: string | null;
  next: string | null;
  complete: boolean;
};
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

/** Read the actual persisted verification prefix, not a caller's asserted root.
 * The partial unique index makes recovery one indexed point regardless of the
 * number of homes, raw keys, projections or creation events already examined.
 */
export async function readPublicFilterRepairVerificationTip(pool: Pool, chain: Chain) {
  const row = (
    await pool.query<Proof>(
      `/* semantic.native-keyed:1:3 */
     SELECT step::text,predecessor::text,verified_binding AS binding,verified_root AS root,
       verified_ordinal::text AS ordinal,verified_next::text AS next,complete
     FROM semantic.public_filter_repair_step
     WHERE (partition_no,bootstrap,execution)=(0,$1,$2)
       AND verified_root IS NOT NULL AND verified_next IS NULL`,
      [chain.bootstrap, chain.execution],
    )
  ).rows[0];
  if (row && row.binding !== chain.binding) throw new CommandUnavailableError('contention', 0);
  return row ?? null;
}

export async function readPublicFilterRepairVerification(pool: Pool, chain: Chain, step: string) {
  const row = (
    await pool.query<Proof>(
      `/* semantic.native-keyed:1:4 */
     SELECT step::text,predecessor::text,verified_binding AS binding,verified_root AS root,
       verified_ordinal::text AS ordinal,verified_next::text AS next,complete
     FROM semantic.public_filter_repair_step
     WHERE (partition_no,bootstrap,execution,step)=(0,$1,$2,$3)`,
      [chain.bootstrap, chain.execution, step],
    )
  ).rows[0];
  if (!row || row.binding !== chain.binding || row.root === null || row.ordinal === null) return null;
  return row;
}

function pageRoot(parentRoot: string, page: Page) {
  return hash([parentRoot, page.step, page.predecessor, page.state, page.complete, page.inputLimit, page.digests]);
}

/** Revalidate or retain the original page after independent Source verification
 * has released all foreign reads. New pages link into the original repair authority.
 */
export async function retainPublicFilterRepairVerification(
  pool: Pool,
  chain: Chain,
  page: Page,
  context: Readonly<{ deadline: number }>,
  chargeControls: (cost: Readonly<{ rows: number; keys: number; bytes: number; frontierWrites?: number }>) => void,
): Promise<boolean> {
  requireAccessDeadline(context.deadline);
  if (page.alreadyVerified) {
    // Revalidate the same owner, cut and immutable chain links in one current
    // snapshot. A durable page needs no new journal write or writer lock.
    const proof = await withBoundedReadConnection(
      pool,
      context.deadline,
      (client) =>
        client.query<{ root: string; parent_root: string | null }>(
          `/* semantic.native-keyed:4:11 */
         SELECT c.verified_root AS root,p.verified_root AS parent_root
         FROM semantic.public_filter_repair_step c
         JOIN semantic.public_filter_bootstrap b ON (b.partition_no,b.bootstrap)=(c.partition_no,c.bootstrap)
         JOIN core.partition o ON o.partition_no=b.partition_no
         LEFT JOIN semantic.public_filter_repair_step p
           ON (p.partition_no,p.bootstrap,p.execution,p.step)=(c.partition_no,c.bootstrap,c.execution,c.predecessor)
         WHERE (c.partition_no,c.bootstrap,c.execution,c.step)=(0,$1,$2,$3)
           AND b.state='adopted' AND b.owner_epoch=o.epoch AND o.write_state='active'
           AND c.predecessor IS NOT DISTINCT FROM $4::uuid
           AND c.state=$5 AND c.complete=$6 AND c.input_limit=$7 AND c.receipt_protocol=1
           AND c.repair_locator_digests=decode($8,'hex') AND c.verified_binding=$9
           AND c.verified_root IS NOT NULL AND ($10::integer IS NULL OR c.verified_home=$10)
           AND c.verified_ordinal=coalesce(p.verified_ordinal+1,1)
           AND (c.predecessor IS NULL OR
                (NOT p.complete AND p.verified_binding=$9 AND p.verified_root IS NOT NULL AND p.verified_next=c.step))`,
          [
            chain.bootstrap,
            chain.execution,
            page.step,
            page.predecessor,
            page.state,
            page.complete,
            page.inputLimit,
            page.digests,
            chain.binding,
            page.closedHome ?? null,
          ],
        ),
      { deadlineError: () => new CommandUnavailableError('deadline', 0) },
    );
    const retained = proof.rows[0];
    requireAccessDeadline(context.deadline);
    if (!retained || retained.root !== pageRoot(retained.parent_root ?? chain.binding, page))
      throw new CommandUnavailableError('contention', 0);
    return false;
  }
  return withConnection(pool, async (client) => {
    await client.query('BEGIN');
    try {
      await client.query(`SET LOCAL statement_timeout = '${Math.max(1, Math.floor(context.deadline - Date.now()))}ms'`);
      // Keep the lock order owner, bootstrap, predecessor, then current page.
      // Each CTE uses the previous lock's result before locking the next row.
      const proof = (
        await client.query<{
          admitted: boolean;
          parent_root: string | null;
          parent_ordinal: string | null;
          parent_next: string | null;
          step: string | null;
          binding: string | null;
          root: string | null;
          ordinal: string | null;
        }>(
          `/* semantic.native-keyed:4:11 */
           WITH owner AS MATERIALIZED (
             SELECT epoch FROM core.partition
             WHERE partition_no=0 AND write_state='active' FOR SHARE
           ), cut AS MATERIALIZED (
             SELECT b.bootstrap FROM owner o
             JOIN semantic.public_filter_bootstrap b ON (b.partition_no,b.bootstrap)=(0,$1)
             WHERE b.state='adopted' AND b.owner_epoch=o.epoch FOR SHARE OF b
           ), parent AS MATERIALIZED (
             SELECT p.step,p.verified_root,p.verified_ordinal,p.verified_next
             FROM cut b JOIN semantic.public_filter_repair_step p
               ON (p.partition_no,p.bootstrap,p.execution,p.step)=(0,b.bootstrap,$2,$4::uuid)
             WHERE NOT p.complete AND p.verified_binding=$9
               AND p.verified_root IS NOT NULL AND p.verified_ordinal IS NOT NULL
               AND (p.verified_next IS NULL OR p.verified_next=$3)
             FOR UPDATE OF p
           ), page AS MATERIALIZED (
             SELECT c.step,c.verified_binding,c.verified_root,c.verified_ordinal
             FROM cut b JOIN semantic.public_filter_repair_step c
               ON (c.partition_no,c.bootstrap,c.execution,c.step)=(0,b.bootstrap,$2,$3)
             WHERE ($4::uuid IS NULL OR EXISTS (SELECT 1 FROM parent))
               AND c.predecessor IS NOT DISTINCT FROM $4::uuid
               AND c.state=$5 AND c.complete=$6 AND c.input_limit=$7 AND c.receipt_protocol=1
               AND c.repair_locator_digests=decode($8,'hex')
             FOR UPDATE OF c
           )
           SELECT admission.admitted,p.verified_root AS parent_root,p.verified_ordinal::text AS parent_ordinal,
             p.verified_next::text AS parent_next,c.step::text,c.verified_binding AS binding,
             c.verified_root AS root,c.verified_ordinal::text AS ordinal
           FROM (SELECT EXISTS(SELECT 1 FROM cut) AS admitted) admission
           LEFT JOIN parent p ON true LEFT JOIN page c ON true`,
          [
            chain.bootstrap,
            chain.execution,
            page.step,
            page.predecessor,
            page.state,
            page.complete,
            page.inputLimit,
            page.digests,
            chain.binding,
          ],
        )
      ).rows[0];
      if (!proof?.admitted) throw new CommandUnavailableError('fenced', 0);
      if (proof.step === null) throw new CommandUnavailableError('contention', 0);
      const ordinal = proof.parent_ordinal === null ? 1n : BigInt(proof.parent_ordinal) + 1n;
      const root = pageRoot(proof.parent_root ?? chain.binding, page);
      if (proof.root !== null) {
        if (proof.binding !== chain.binding || proof.root !== root || BigInt(proof.ordinal!) !== ordinal)
          throw new CommandUnavailableError('contention', 0);
      } else {
        if (page.predecessor !== null && proof.parent_next === null) {
          // Admit the immutable-page trigger's child seek and successor FK
          // point before submission, including a submission that later fails.
          chargeControls({
            rows: 2,
            keys: 9,
            frontierWrites: 1,
            bytes:
              2 *
              Buffer.byteLength(
                JSON.stringify({
                  key: [0, chain.bootstrap, chain.execution, page.step],
                  predecessor: page.predecessor,
                }),
              ),
          });
          const linked = await client.query(
            `/* semantic.native-keyed:1:4 */
             UPDATE semantic.public_filter_repair_step SET verified_next=$4
             WHERE (partition_no,bootstrap,execution,step)=(0,$1,$2,$3) AND verified_next IS NULL
             RETURNING verified_next::text`,
            [chain.bootstrap, chain.execution, page.predecessor, page.step],
          );
          if (linked.rowCount !== 1) throw new CommandUnavailableError('contention', 0);
        }
        if (page.predecessor !== null) {
          // The new prefix member's trigger independently reads its parent.
          // These are design-visible keyed controls, not MVCC visibility work.
          chargeControls({
            rows: 1,
            keys: 4,
            bytes: Buffer.byteLength(
              JSON.stringify({
                key: [0, chain.bootstrap, chain.execution, page.predecessor],
                complete: false,
                root: proof.parent_root,
                binding: chain.binding,
                next: page.step,
                ordinal: proof.parent_ordinal,
              }),
            ),
          });
        }
        chargeControls({ rows: 0, keys: 0, bytes: 0, frontierWrites: 1 });
        const adopted = await client.query(
          `/* semantic.native-keyed:1:4 */
           UPDATE semantic.public_filter_repair_step
           SET verified_binding=$4,verified_root=$5,verified_ordinal=$6
           WHERE (partition_no,bootstrap,execution,step)=(0,$1,$2,$3) AND verified_root IS NULL
           RETURNING verified_binding,verified_root,verified_ordinal::text`,
          [chain.bootstrap, chain.execution, page.step, chain.binding, root, String(ordinal)],
        );
        if (adopted.rowCount !== 1) throw new CommandUnavailableError('contention', 0);
      }
      if (page.closedHome !== undefined) {
        chargeControls({ rows: 0, keys: 0, bytes: 0, frontierWrites: 1 });
        const closed = await client.query(
          `/* semantic.native-keyed:1:4 */
           UPDATE semantic.public_filter_repair_step SET verified_home=$4
           WHERE (partition_no,bootstrap,execution,step)=(0,$1,$2,$3)
             AND verified_root IS NOT NULL AND (verified_home IS NULL OR verified_home=$4)
           RETURNING verified_home`,
          [chain.bootstrap, chain.execution, page.step, page.closedHome],
        );
        if (closed.rowCount !== 1) throw new CommandUnavailableError('contention', 0);
      }
      requireAccessDeadline(context.deadline);
      await client.query('COMMIT');
      return proof.root === null;
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

/** One original home selected from the independently verified, non-branching
 * captured-window prefix. Batched empty windows retain their range in the step
 * state; no replacement page or producer complete bit supplies this lookup.
 */
export async function readPublicFilterRepairHomeSeal(pool: Pool, chain: Chain) {
  return (
    (
      await pool.query<{
        step: string;
        predecessor: string;
        state: string;
        home: number;
        terminal: string;
        after: number;
        root: string;
      }>(
        `/* semantic.native-keyed:2:7 */
       SELECT w.step::text,w.predecessor::text,w.state,t.ack_after AS home,
       t.step::text AS terminal,t.ack_after AS after,t.verified_root AS root
     FROM semantic.public_filter_repair_step t
     LEFT JOIN LATERAL (
       SELECT candidate.step,candidate.predecessor,candidate.state,candidate.verified_home,
         candidate.verified_binding,candidate.verified_root,candidate.verified_ordinal
       FROM semantic.public_filter_repair_step candidate
       WHERE candidate.partition_no=t.partition_no AND candidate.bootstrap=t.bootstrap
         AND candidate.execution=t.execution AND candidate.verified_home<=t.ack_after
         AND candidate.verified_binding=t.verified_binding AND candidate.verified_root IS NOT NULL
         AND candidate.verified_ordinal<t.verified_ordinal
       ORDER BY candidate.verified_home DESC LIMIT 1
     ) w ON TRUE
     WHERE (t.partition_no,t.bootstrap,t.execution)=(0,$1,$2)
       AND t.verified_binding=$3 AND t.verified_root IS NOT NULL
       AND t.verified_next IS NULL AND t.complete`,
        [chain.bootstrap, chain.execution, chain.binding],
      )
    ).rows[0] ?? null
  );
}

export const PUBLIC_FILTER_REPAIR_ACK_BATCH_LIMIT = 16;

/** Additional indexed ranges within this terminal's already verified chain. */
export async function readPublicFilterRepairHomeBatches(
  pool: Pool,
  chain: Chain,
  terminal: string,
  from: number,
  to: number,
) {
  const count = to - from;
  if (
    !Number.isInteger(from) ||
    !Number.isInteger(to) ||
    from < 0 ||
    to > 4096 ||
    count < 1 ||
    count >= PUBLIC_FILTER_REPAIR_ACK_BATCH_LIMIT
  )
    throw new TypeError('Expected a bounded range inside the current ACK page');
  const result = await pool.query<{ state: string; home: number }>(
    `/* semantic.native-keyed:${1 + count}:${4 + count} */
     SELECT w.state,w.verified_home AS home
     FROM semantic.public_filter_repair_step t
     JOIN semantic.public_filter_repair_step w ON
       (w.partition_no,w.bootstrap,w.execution)=(t.partition_no,t.bootstrap,t.execution)
     WHERE (t.partition_no,t.bootstrap,t.execution,t.step)=(0,$1,$2,$3)
       AND t.verified_binding=$4 AND t.verified_root IS NOT NULL AND t.complete AND t.verified_next IS NULL
       AND w.verified_binding=t.verified_binding AND w.verified_root IS NOT NULL
       AND w.verified_ordinal<t.verified_ordinal AND w.verified_home >= $5 AND w.verified_home < $6
     ORDER BY w.verified_home LIMIT $7`,
    [chain.bootstrap, chain.execution, terminal, chain.binding, from, to, count],
  );
  return result.rows;
}

/** Receiver ACK commits first. Advancing this original terminal's bounded home
 * frontier is a separate Source phase; replay repeats the same idempotent ACK.
 */
export async function advancePublicFilterRepairAckFrontier(
  pool: Pool,
  chain: Chain,
  terminal: string,
  home: number,
  homes: number,
): Promise<boolean> {
  if (
    !Number.isInteger(home) ||
    home < 0 ||
    !Number.isInteger(homes) ||
    homes < 1 ||
    homes > PUBLIC_FILTER_REPAIR_ACK_BATCH_LIMIT ||
    home + homes > 4096
  )
    throw new TypeError('Source ACK requires a bounded contiguous home range');
  // The terminal and its trigger read the original owner and three receiver
  // relations per home. Charge the whole attempted prefix, including a gap.
  try {
    const result = await pool.query(
      `/* semantic.native-keyed:${3 + 3 * homes}:${7 + 9 * homes} */
       UPDATE semantic.public_filter_repair_step SET ack_after=$6
       WHERE (partition_no,bootstrap,execution,step)=(0,$1,$2,$3)
         AND verified_binding=$4 AND complete AND verified_next IS NULL AND ack_after=$5
       RETURNING ack_after`,
      [chain.bootstrap, chain.execution, terminal, chain.binding, home, home + homes],
    );
    return result.rowCount === 1;
  } catch (error) {
    if (
      error instanceof Error &&
      'code' in error &&
      error.code === '23514' &&
      'constraint' in error &&
      error.constraint === 'public_filter_repair_ack_receiver_prefix'
    )
      return false;
    throw error;
  }
}

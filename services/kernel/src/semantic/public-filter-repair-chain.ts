import { createHash } from 'node:crypto';
import type { Pool } from 'pg';
import { withConnection, discardConnection } from '../database/pool.ts';
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

/** Called only after the independent Source verifier has checked this original
 * page against native owner facts. This transaction adopts that checked page in
 * the SAME repair authority. It neither settles Search nor acknowledges coverage.
 * Foreign reads have ended before this home-zero checkout begins.
 */
export async function retainPublicFilterRepairVerification(
  pool: Pool,
  chain: Chain,
  page: Page,
  context: Readonly<{ deadline: number }>,
  chargeControls: (cost: Readonly<{ rows: number; keys: number; bytes: number; frontierWrites?: number }>) => void,
): Promise<boolean> {
  requireAccessDeadline(context.deadline);
  return withConnection(pool, async (client) => {
    await client.query('BEGIN');
    try {
      await client.query(`SET LOCAL statement_timeout = '${Math.max(1, Math.floor(context.deadline - Date.now()))}ms'`);
      const owner = (
        await client.query<{ epoch: number; write_state: string }>(
          `/* semantic.native-keyed:1:1 */
           SELECT epoch,write_state FROM core.partition WHERE partition_no=0 FOR SHARE`,
        )
      ).rows[0];
      const bootstrap = (
        await client.query<{ owner_epoch: number; state: string }>(
          `/* semantic.native-keyed:1:2 */
           SELECT owner_epoch,state FROM semantic.public_filter_bootstrap
         WHERE (partition_no,bootstrap)=(0,$1) FOR SHARE`,
          [chain.bootstrap],
        )
      ).rows[0];
      if (
        !owner ||
        owner.write_state !== 'active' ||
        !bootstrap ||
        bootstrap.state !== 'adopted' ||
        bootstrap.owner_epoch !== owner.epoch
      )
        throw new CommandUnavailableError('fenced', 0);
      let parent: Proof | undefined;
      if (page.predecessor !== null) {
        parent = (
          await client.query<Proof>(
            `/* semantic.native-keyed:1:4 */
             SELECT step::text,predecessor::text,verified_binding AS binding,verified_root AS root,
             verified_ordinal::text AS ordinal,verified_next::text AS next,complete
           FROM semantic.public_filter_repair_step
           WHERE (partition_no,bootstrap,execution,step)=(0,$1,$2,$3) FOR UPDATE`,
            [chain.bootstrap, chain.execution, page.predecessor],
          )
        ).rows[0];
        if (
          !parent ||
          parent.complete ||
          parent.binding !== chain.binding ||
          !parent.root ||
          !parent.ordinal ||
          (parent.next !== null && parent.next !== page.step)
        )
          throw new CommandUnavailableError('contention', 0);
      }
      const current = (
        await client.query<Proof & { state: string; input_limit: number; receipt_protocol: number; digests: string }>(
          `/* semantic.native-keyed:1:4 */
           SELECT step::text,predecessor::text,state,complete,input_limit,receipt_protocol,
           encode(repair_locator_digests,'hex') AS digests,verified_binding AS binding,
           verified_root AS root,verified_ordinal::text AS ordinal,verified_next::text AS next
         FROM semantic.public_filter_repair_step
         WHERE (partition_no,bootstrap,execution,step)=(0,$1,$2,$3) FOR UPDATE`,
          [chain.bootstrap, chain.execution, page.step],
        )
      ).rows[0];
      if (
        !current ||
        current.state !== page.state ||
        current.complete !== page.complete ||
        current.predecessor !== page.predecessor ||
        current.input_limit !== page.inputLimit ||
        current.receipt_protocol !== 1 ||
        current.digests !== page.digests
      )
        throw new CommandUnavailableError('contention', 0);
      const ordinal = parent ? BigInt(parent.ordinal!) + 1n : 1n;
      const root = hash([
        parent?.root ?? chain.binding,
        page.step,
        page.predecessor,
        page.state,
        page.complete,
        page.inputLimit,
        page.digests,
      ]);
      if (current.root !== null) {
        if (current.binding !== chain.binding || current.root !== root || BigInt(current.ordinal!) !== ordinal)
          throw new CommandUnavailableError('contention', 0);
      } else {
        if (parent && parent.next === null) {
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
            [chain.bootstrap, chain.execution, parent.step, page.step],
          );
          if (linked.rowCount !== 1) throw new CommandUnavailableError('contention', 0);
        }
        if (parent) {
          // The new prefix member's trigger independently reads its parent.
          // These are design-visible keyed controls, not MVCC visibility work.
          chargeControls({
            rows: 1,
            keys: 4,
            bytes: Buffer.byteLength(
              JSON.stringify({
                key: [0, chain.bootstrap, chain.execution, page.predecessor],
                complete: parent.complete,
                root: parent.root,
                binding: parent.binding,
                next: page.step,
                ordinal: parent.ordinal,
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
      return current.root === null;
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

/** One original closed window in the independently verified, non-branching
 * prefix ending at the actual complete successor. No current replacement page
 * or producer complete bit can supply this point lookup.
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
     LEFT JOIN semantic.public_filter_repair_step w ON
       (w.partition_no,w.bootstrap,w.execution,w.verified_home)=
       (t.partition_no,t.bootstrap,t.execution,t.ack_after)
       AND w.verified_binding=t.verified_binding AND w.verified_root IS NOT NULL
       AND w.verified_ordinal<t.verified_ordinal
     WHERE (t.partition_no,t.bootstrap,t.execution)=(0,$1,$2)
       AND t.verified_binding=$3 AND t.verified_root IS NOT NULL
       AND t.verified_next IS NULL AND t.complete`,
        [chain.bootstrap, chain.execution, chain.binding],
      )
    ).rows[0] ?? null
  );
}

/** Receiver ACK commits first. Advancing this original terminal's bounded home
 * frontier is a separate Source phase; replay repeats the same idempotent ACK.
 */
export async function advancePublicFilterRepairAckFrontier(
  pool: Pool,
  chain: Chain,
  terminal: string,
  home: number,
): Promise<boolean> {
  const result = await pool.query(
    `/* semantic.native-keyed:6:16 */
     UPDATE semantic.public_filter_repair_step SET ack_after=ack_after+1
     WHERE (partition_no,bootstrap,execution,step)=(0,$1,$2,$3)
       AND verified_binding=$4 AND complete AND verified_next IS NULL AND ack_after=$5
       AND EXISTS (SELECT 1 FROM core.partition p
         JOIN semantic.public_filter_bootstrap b ON b.partition_no=p.partition_no
         WHERE (b.partition_no,b.bootstrap)=(0,$1) AND b.owner_epoch=p.epoch
           AND p.write_state='active' AND b.state='adopted')
       AND EXISTS (SELECT 1 FROM semantic.public_filter_home_enrollment e
         JOIN search.public_filter_coverage_home h ON
           (h.partition_no,h.registration,h.source_home)=(e.registration_partition,e.registration,e.partition_no)
         JOIN search.public_filter_coverage_baseline b ON
           (b.partition_no,b.registration,b.bootstrap,b.source_home)=
           (e.registration_partition,e.registration,e.bootstrap,e.partition_no)
         WHERE (e.partition_no,e.bootstrap)=($5,$1) AND e.complete AND b.receipt=e.receipt
           AND h.source_epoch=e.owner_epoch AND h.baseline_bootstrap=e.bootstrap
           AND h.acknowledged_baseline=e.bootstrap AND h.acknowledged_position>=b.source_position
           AND h.acknowledged_execution=$2 AND h.acknowledged_settlement IS NOT NULL
           AND h.acknowledged_native_enqueue>=b.native_enqueue_revision
           AND h.acknowledged_native_revision IS NOT DISTINCT FROM b.native_revision
           AND h.acknowledged_native_claim_revision IS NOT DISTINCT FROM b.native_claim_revision)
     RETURNING ack_after`,
    [chain.bootstrap, chain.execution, terminal, chain.binding, home],
  );
  return result.rowCount === 1;
}

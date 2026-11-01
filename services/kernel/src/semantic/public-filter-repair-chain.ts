import { createHash } from 'node:crypto';
import type { Pool } from 'pg';
import { withConnection, discardConnection } from '../database/pool.ts';
import { CommandUnavailableError, requireAccessDeadline } from '../access/unavailable.ts';

type Chain = Readonly<{ bootstrap: string; execution: string; binding: string }>;
type Page = Readonly<{
  step: string; predecessor: string | null; state: string; complete: boolean;
  inputLimit: number; digests: string;
}>;
type Proof = { step: string; predecessor: string | null; binding: string | null;
  root: string | null; ordinal: string | null; next: string | null; complete: boolean };
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

/** Read the actual persisted verification prefix, not a caller's asserted root.
 * The partial unique index makes recovery one indexed point regardless of the
 * number of homes, raw keys, projections or creation events already examined.
 */
export async function readPublicFilterRepairVerificationTip(pool: Pool, chain: Chain) {
  const row = (await pool.query<Proof>(
    `SELECT step::text,predecessor::text,verified_binding AS binding,verified_root AS root,
       verified_ordinal::text AS ordinal,verified_next::text AS next,complete
     FROM semantic.public_filter_repair_step
     WHERE (partition_no,bootstrap,execution)=(0,$1,$2)
       AND verified_root IS NOT NULL AND verified_next IS NULL`,
    [chain.bootstrap,chain.execution],
  )).rows[0];
  if (row && row.binding !== chain.binding) throw new CommandUnavailableError('contention',0);
  return row ?? null;
}

export async function readPublicFilterRepairVerification(pool: Pool, chain: Chain, step: string) {
  const row = (await pool.query<Proof>(
    `SELECT step::text,predecessor::text,verified_binding AS binding,verified_root AS root,
       verified_ordinal::text AS ordinal,verified_next::text AS next,complete
     FROM semantic.public_filter_repair_step
     WHERE (partition_no,bootstrap,execution,step)=(0,$1,$2,$3)`,
    [chain.bootstrap,chain.execution,step],
  )).rows[0];
  if (!row || row.binding !== chain.binding || row.root === null || row.ordinal === null)
    return null;
  return row;
}

/** Called only after the independent Source verifier has checked this original
 * page against native owner facts. This transaction adopts that checked page in
 * the SAME repair authority. It neither settles Search nor acknowledges coverage.
 * Foreign reads have ended before this home-zero checkout begins.
 */
export async function retainPublicFilterRepairVerification(
  pool: Pool, chain: Chain, page: Page, context: Readonly<{ deadline: number }>,
  chargeControls: (cost: Readonly<{ rows: number; keys: number; bytes: number }>) => void,
): Promise<boolean> {
  requireAccessDeadline(context.deadline);
  return withConnection(pool,async (client) => {
    await client.query('BEGIN');
    try {
      await client.query(`SET LOCAL statement_timeout = '${Math.max(1,Math.floor(context.deadline-Date.now()))}ms'`);
      const owner = (await client.query<{ epoch: number; write_state: string }>(
        'SELECT epoch,write_state FROM core.partition WHERE partition_no=0 FOR SHARE',
      )).rows[0];
      const bootstrap = (await client.query<{ owner_epoch: number; state: string }>(
        `SELECT owner_epoch,state FROM semantic.public_filter_bootstrap
         WHERE (partition_no,bootstrap)=(0,$1) FOR SHARE`,[chain.bootstrap],
      )).rows[0];
      if (!owner || owner.write_state !== 'active' || !bootstrap || bootstrap.state !== 'adopted' ||
        bootstrap.owner_epoch !== owner.epoch) throw new CommandUnavailableError('fenced',0);
      let parent: Proof | undefined;
      if (page.predecessor !== null) {
        parent = (await client.query<Proof>(
          `SELECT step::text,predecessor::text,verified_binding AS binding,verified_root AS root,
             verified_ordinal::text AS ordinal,verified_next::text AS next,complete
           FROM semantic.public_filter_repair_step
           WHERE (partition_no,bootstrap,execution,step)=(0,$1,$2,$3) FOR UPDATE`,
          [chain.bootstrap,chain.execution,page.predecessor],
        )).rows[0];
        if (!parent || parent.complete || parent.binding !== chain.binding || !parent.root || !parent.ordinal ||
          (parent.next !== null && parent.next !== page.step)) throw new CommandUnavailableError('contention',0);
      }
      const current = (await client.query<Proof & { state: string; input_limit: number;
        receipt_protocol: number; digests: string }>(
        `SELECT step::text,predecessor::text,state,complete,input_limit,receipt_protocol,
           encode(repair_locator_digests,'hex') AS digests,verified_binding AS binding,
           verified_root AS root,verified_ordinal::text AS ordinal,verified_next::text AS next
         FROM semantic.public_filter_repair_step
         WHERE (partition_no,bootstrap,execution,step)=(0,$1,$2,$3) FOR UPDATE`,
        [chain.bootstrap,chain.execution,page.step],
      )).rows[0];
      if (!current || current.state !== page.state || current.complete !== page.complete ||
        current.predecessor !== page.predecessor || current.input_limit !== page.inputLimit ||
        current.receipt_protocol !== 1 || current.digests !== page.digests)
        throw new CommandUnavailableError('contention',0);
      const ordinal = parent ? BigInt(parent.ordinal!)+1n : 1n;
      const root = hash([parent?.root ?? chain.binding,page.step,page.predecessor,page.state,
        page.complete,page.inputLimit,page.digests]);
      if (current.root !== null) {
        if (current.binding !== chain.binding || current.root !== root || BigInt(current.ordinal!) !== ordinal)
          throw new CommandUnavailableError('contention',0);
      } else {
        if (parent && parent.next === null) {
          // Admit the immutable-page trigger's child seek and successor FK
          // point before submission, including a submission that later fails.
          chargeControls({ rows: 2, keys: 9, bytes: 2 * Buffer.byteLength(JSON.stringify({
            key: [0,chain.bootstrap,chain.execution,page.step],predecessor: page.predecessor,
          })) });
          await client.query(
            `UPDATE semantic.public_filter_repair_step SET verified_next=$4
             WHERE (partition_no,bootstrap,execution,step)=(0,$1,$2,$3) AND verified_next IS NULL`,
            [chain.bootstrap,chain.execution,parent.step,page.step],
          );
        }
        if (parent) {
          // The new prefix member's trigger independently reads its parent.
          // These are design-visible keyed controls, not MVCC visibility work.
          chargeControls({ rows: 1, keys: 4, bytes: Buffer.byteLength(JSON.stringify({
            key: [0,chain.bootstrap,chain.execution,page.predecessor],
            complete: parent.complete,root: parent.root,binding: parent.binding,
            next: page.step,ordinal: parent.ordinal,
          })) });
        }
        await client.query(
          `UPDATE semantic.public_filter_repair_step
           SET verified_binding=$4,verified_root=$5,verified_ordinal=$6
           WHERE (partition_no,bootstrap,execution,step)=(0,$1,$2,$3) AND verified_root IS NULL`,
          [chain.bootstrap,chain.execution,page.step,chain.binding,root,String(ordinal)],
        );
      }
      requireAccessDeadline(context.deadline);
      await client.query('COMMIT');
      return current.root === null;
    } catch (error) {
      try { await client.query('ROLLBACK'); }
      catch (rollbackError) { discardConnection(client,rollbackError as Error); }
      throw error;
    }
  });
}

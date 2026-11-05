import type { Pool, PoolClient } from 'pg';
import { randomUUID } from 'node:crypto';
import {
  currentCommand,
  noEffect,
  registerCommandCallback,
  runCommand,
  type CommandTransaction,
} from '../command/command.ts';
import { withReadTransaction } from './read.ts';
import {
  IdentityEpochStoreError,
  identityJobPartition,
  recordIdentityEpochNativeCommit,
  serializeIdentityValue as json,
} from './identity-adapters/index.ts';
import { bindSemanticProducerRoles, identityErasureRoles } from './erasure-producer.ts';
import { IDENTITY_EPOCH_ADMITTED, IDENTITY_EPOCH_HOME_AVAILABLE } from './events.ts';
import { receiveIdentityScopePrearm, cancelIdentityScopePrearm } from './identity-scoped-prearm.ts';
import type { IdentityJobRef, IdentityNativeReceipt, NativeStepWork } from './identity-epoch-contract.ts';
import type { IdentityPrearmTicketData, IdentityPrearmTicketLocator } from './identity-epoch-prearm-contract.ts';
import ticketSQL from './identity-epoch-prearm-ticket.sql';
import exportSQL from './identity-epoch-prearm-export.sql';
import pageSQL from './identity-epoch-prearm-page.sql';

const stale = () => new IdentityEpochStoreError('identity_effect_stale', 'Native pre-arm custody changed');
const unavailable = () =>
  new IdentityEpochStoreError('identity_epoch_unavailable', 'Native pre-arm custody is unavailable');
const wake = (job: IdentityJobRef) => ({
  type: IDENTITY_EPOCH_ADMITTED,
  data: { partition: identityJobPartition(job), jobId: job.jobId, epoch: job.epoch.toString() },
});
type Work = { -readonly [K in keyof NativeStepWork]: NativeStepWork[K] };
/** Measured body work. Native framework and physical index/FK work must also be included in runtime Cost evidence. */
async function query(tx: Pick<PoolClient, 'query'>, sql: string, values: unknown[], work?: Work) {
  const result = await tx.query(sql, values);
  if (work) {
    work.statements++;
    work.points += result.rowCount ?? 0;
    work.rows += result.rows.length;
    work.bytes += Buffer.byteLength(json(result.rows)) + Buffer.byteLength(json(values));
  }
  return result;
}
function receipt(
  partition: number,
  transactionId: string,
  epoch: number,
  position: string | bigint,
): IdentityNativeReceipt {
  return { partition, transactionId, epoch, position: BigInt(position) };
}
function decodeReceipt(value: IdentityNativeReceipt): IdentityNativeReceipt {
  return { ...value, position: BigInt(value.position) };
}
function equalReceipt(a: IdentityNativeReceipt, b: IdentityNativeReceipt) {
  return (
    a.partition === b.partition &&
    a.epoch === b.epoch &&
    a.position === b.position &&
    a.transactionId === b.transactionId
  );
}

/** Caller data is only a locator. Resolve the pinned native export, attempt, bridge and current owner. */
export async function readNativeIdentityPrearmTicket(
  pool: Pool,
  locator: IdentityPrearmTicketLocator,
): Promise<IdentityPrearmTicketData | null> {
  if (
    locator.ordinal !== 0 ||
    !Number.isSafeInteger(locator.directory.partition) ||
    locator.directory.partition < 0 ||
    locator.directory.partition > 4095
  )
    return null;
  return withReadTransaction(pool, async (tx) => {
    const row = (
      await tx.query(ticketSQL.sql, [
        locator.directory.partition,
        locator.job.jobId,
        locator.job.epoch.toString(),
        locator.pageId,
        locator.directory.epoch,
        locator.directory.position.toString(),
        locator.directory.transactionId,
      ])
    ).rows[0];
    return row
      ? {
          locator,
          scope: row.scope,
          registration: row.registration,
          captureId: row.capture_id,
          attempt: receipt(
            locator.directory.partition,
            row.attempt_transaction_id,
            row.attempt_epoch,
            row.attempt_position,
          ),
        }
      : null;
  });
}

/** In the actual PREPARE command callback, after its executor-native admission receipt exists. */
export async function recordPreparedIdentityPrearm(
  tx: CommandTransaction,
  ref: IdentityJobRef,
  scope: string,
  transactionId: string,
): Promise<void> {
  const home = currentCommand(tx).partition;
  await tx.query(
    `INSERT INTO semantic.identity_epoch_prearm_directory
    (partition_no,job_id,job_epoch,generation,terminal,basis_version,owner_epoch,scope_digest,attempt_transaction_id)
    SELECT $1,$2,$3,i.generation,i.terminal,i.basis_version,i.owner_epoch,$4,$5
    FROM semantic.identity_epoch_admission_handoff h,
    LATERAL jsonb_to_recordset(h.inputs) i(terminal uuid,generation uuid,basis_version bigint,owner_epoch integer)
    WHERE h.partition_no=$1 AND h.job_id=$2 ON CONFLICT DO NOTHING`,
    [home, ref.jobId, ref.epoch.toString(), scope, transactionId],
  );
}

type Page = {
  partition_no: number;
  job_id: string;
  generation: string;
  sequence: string;
  page_id: string;
  transaction_id: string;
  export_epoch: number;
  export_position: string;
  original: string | null;
  scope_key: string | null;
  registration: string | null;
  source_partition: number | null;
  source_owner_epoch: number | null;
  source_receipt: IdentityNativeReceipt | null;
  disposition_transaction_id: string | null;
  disposition_epoch: number | null;
  disposition_position: string | null;
  job_epoch: string;
  scope_digest: string;
  attempt_transaction_id: string;
  released: boolean;
  owner_epoch: number;
  sealed_transaction_id: string | null;
};
function locator(ref: IdentityJobRef, page: Page): IdentityPrearmTicketLocator {
  return {
    job: ref,
    pageId: page.page_id,
    ordinal: 0,
    directory: receipt(page.partition_no, page.transaction_id, page.export_epoch, page.export_position),
  };
}
async function readPage(
  pool: Pool,
  ref: IdentityJobRef,
  home: number,
  generation: string,
  sequence: bigint,
  stage: 'unsafe' | 'cancelled',
  work: Work,
): Promise<Page | undefined> {
  return withReadTransaction(
    pool,
    async (tx) =>
      (await query(tx, pageSQL.sql, [home, ref.jobId, generation, sequence.toString(), stage], work)).rows[0] as
        | Page
        | undefined,
  );
}

/** Read the actual receiving native component after the Source producer resolved its scope record.
 * The selected Source export is the trusted native producer, never a caller-supplied receipt callback.
 */
async function verifySourceReceipt(pool: Pool, page: Page, native: IdentityNativeReceipt, work: Work) {
  if (native.partition !== page.source_partition || native.epoch !== page.source_owner_epoch) throw unavailable();
  const found = await withReadTransaction(
    pool,
    async (tx) =>
      (
        await query(
          tx,
          `SELECT c.transaction_id FROM semantic.identity_epoch_native_commit c
     JOIN core.partition p ON p.partition_no=c.partition_no AND p.epoch=c.epoch
      AND p.position>=c.position AND p.write_state='active'
     WHERE c.partition_no=$1 AND c.transaction_id=$2 AND c.epoch=$3 AND c.position=$4`,
          [native.partition, native.transactionId, native.epoch, native.position.toString()],
          work,
        )
      ).rows[0],
  );
  if (!found) throw unavailable();
}

function mergeRoles(...sets: readonly (readonly { account_id: string; role: string }[])[]) {
  const roles = [...new Map(sets.flat().map((r) => [`${r.account_id}:${r.role}`, r])).values()];
  if (roles.length > 8) throw unavailable();
  return roles;
}
async function pageRoles(pool: Pool, ref: IdentityJobRef, page: Page, work: Work) {
  const job = await identityErasureRoles(pool, ref.jobId);
  const source = await withReadTransaction(
    pool,
    async (tx) =>
      (
        await query(
          tx,
          `SELECT l.account_id::text,l.role FROM semantic.identity_epoch_prearm_page p
     JOIN semantic.erasure_locator l ON l.partition_no=p.partition_no
       AND l.store='identity_epoch_prearm_page' AND l.record_key=p.erasure_key
     WHERE p.partition_no=$1 AND p.page_id=$2 ORDER BY l.account_id,l.role LIMIT 9`,
          [page.partition_no, page.page_id],
          work,
        )
      ).rows,
  );
  return mergeRoles(job, source);
}

async function exportPage(pool: Pool, ref: IdentityJobRef, home: number, generation: string, work: Work) {
  const roles = await identityErasureRoles(pool, ref.jobId);
  await runCommand(pool, { partition: home }, async (tx) => {
    const d = (
      await query(
        tx,
        `SELECT d.* FROM semantic.identity_epoch_prearm_directory d
      JOIN semantic.identity_epoch_admission_attempt a USING(partition_no,job_id)
      JOIN core.partition p ON p.partition_no=d.partition_no AND p.epoch=d.owner_epoch AND p.write_state='active'
      WHERE d.partition_no=$1 AND d.job_id=$2 AND d.generation=$3 AND d.job_epoch=$4
       AND a.state='prepared' AND NOT d.released FOR UPDATE OF d,a`,
        [home, ref.jobId, generation, ref.epoch.toString()],
        work,
      )
    ).rows[0];
    if (!d || d.exhausted) throw stale();
    const prior = (
      await query(
        tx,
        `SELECT page_id FROM semantic.identity_epoch_prearm_page
      WHERE partition_no=$1 AND job_id=$2 AND generation=$3 AND sequence=$4`,
        [home, ref.jobId, generation, (BigInt(d.sequence) + 1n).toString()],
        work,
      )
    ).rows[0];
    if (prior) return noEffect(null);
    const item = (
      await query(tx, exportSQL.sql, [home, generation, d.after_original, d.after_scope, d.after_registration], work)
    ).rows[0];
    const pageId = randomUUID();
    const sourceRoles = item
      ? (
          await query(
            tx,
            `SELECT account_id::text,role FROM semantic.erasure_locator
       WHERE partition_no=$1 AND store='identity_epoch_prearm_inverse' AND record_key=$2
       ORDER BY account_id,role LIMIT 9`,
            [home, item.erasure_key],
            work,
          )
        ).rows
      : [];
    bindSemanticProducerRoles(tx, mergeRoles(roles, sourceRoles));
    recordIdentityEpochNativeCommit(tx, 'identity-prearm');
    registerCommandCallback(tx, async (id) => {
      await query(
        tx,
        `INSERT INTO semantic.identity_epoch_prearm_page
        (partition_no,job_id,generation,sequence,page_id,transaction_id,original,scope_key,registration,
         scope,capture_id,source_partition,source_owner_epoch)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
        [
          home,
          ref.jobId,
          generation,
          (BigInt(d.sequence) + 1n).toString(),
          pageId,
          id,
          item?.original ?? null,
          item?.scope_key ?? null,
          item?.registration ?? null,
          item ? json(item.scope) : null,
          item?.capture_id ?? null,
          item?.source_partition ?? null,
          item?.source_owner_epoch ?? null,
        ],
        work,
      );
    });
    return { value: null, events: [wake(ref)] };
  });
}

async function acceptPage(
  pool: Pool,
  ref: IdentityJobRef,
  page: Page,
  native: IdentityNativeReceipt | null,
  stage: 'unsafe' | 'cancelled',
  work: Work,
) {
  const roles = await pageRoles(pool, ref, page, work);
  await runCommand(pool, { partition: page.partition_no }, async (tx) => {
    const d = (
      await query(
        tx,
        `SELECT d.*,a.state FROM semantic.identity_epoch_prearm_directory d
      JOIN semantic.identity_epoch_admission_attempt a USING(partition_no,job_id)
      WHERE d.partition_no=$1 AND d.job_id=$2 AND d.generation=$3 AND d.job_epoch=$4 FOR UPDATE OF d,a`,
        [page.partition_no, ref.jobId, page.generation, ref.epoch.toString()],
        work,
      )
    ).rows[0];
    if (!d || d.released || (stage === 'unsafe' ? d.state !== 'prepared' : d.state !== 'closed')) throw stale();
    const prior = (
      await query(
        tx,
        `SELECT source_receipt FROM semantic.identity_epoch_prearm_disposition
      WHERE partition_no=$1 AND page_id=$2 AND stage=$3`,
        [page.partition_no, page.page_id, stage],
        work,
      )
    ).rows[0];
    if (prior) {
      if (native && (!prior.source_receipt || !equalReceipt(decodeReceipt(prior.source_receipt), native)))
        throw stale();
      return noEffect(null);
    }
    if (stage === 'unsafe' && BigInt(d.sequence) + 1n !== BigInt(page.sequence)) throw stale();
    bindSemanticProducerRoles(tx, roles);
    recordIdentityEpochNativeCommit(tx, 'identity-prearm');
    registerCommandCallback(tx, async (id) => {
      await query(
        tx,
        `INSERT INTO semantic.identity_epoch_prearm_disposition
        (partition_no,page_id,stage,transaction_id,source_receipt) VALUES($1,$2,$3,$4,$5)`,
        [page.partition_no, page.page_id, stage, id, native ? json(native) : null],
        work,
      );
      if (stage === 'unsafe')
        await query(
          tx,
          `UPDATE semantic.identity_epoch_prearm_directory
        SET sequence=$4,after_original=$5,after_scope=$6,after_registration=$7,
        exhausted=$8,sealed_transaction_id=CASE WHEN $8 THEN $9 ELSE NULL END
        WHERE partition_no=$1 AND job_id=$2 AND generation=$3`,
          [
            page.partition_no,
            ref.jobId,
            page.generation,
            page.sequence,
            page.original,
            page.scope_key,
            page.registration,
            page.original === null,
            id,
          ],
          work,
        );
    });
    return { value: null, events: [wake(ref)] };
  });
}

async function copyPage(pool: Pool, ref: IdentityJobRef, page: Page, work: Work) {
  if (!page.disposition_transaction_id || page.disposition_epoch === null || page.disposition_position === null)
    throw unavailable();
  const proof = receipt(
    page.partition_no,
    page.disposition_transaction_id,
    page.disposition_epoch,
    page.disposition_position,
  );
  const roles = await pageRoles(pool, ref, page, work);
  await runCommand(pool, { partition: identityJobPartition(ref) }, async (tx) => {
    const job = (
      await query(
        tx,
        `SELECT state,prearm_phase FROM semantic.identity_epoch_job
      WHERE partition_no=$1 AND job_id=$2 AND epoch=$3 FOR UPDATE`,
        [identityJobPartition(ref), ref.jobId, ref.epoch.toString()],
        work,
      )
    ).rows[0];
    if (!job || job.state !== 'preparing' || job.prearm_phase !== 'prearm-open') throw stale();
    const head = (
      await query(
        tx,
        `SELECT prearm_sequence FROM semantic.identity_epoch_input
      WHERE partition_no=$1 AND job_id=$2 AND generation=$3 AND control_partition=$4 FOR UPDATE`,
        [identityJobPartition(ref), ref.jobId, page.generation, page.partition_no],
        work,
      )
    ).rows[0];
    if (!head) throw stale();
    if (BigInt(head.prearm_sequence) >= BigInt(page.sequence)) return noEffect(null);
    if (BigInt(head.prearm_sequence) + 1n !== BigInt(page.sequence)) throw stale();
    if (page.original === null && page.sealed_transaction_id !== proof.transactionId) throw stale();
    bindSemanticProducerRoles(tx, roles);
    recordIdentityEpochNativeCommit(tx, 'identity-prearm');
    registerCommandCallback(tx, async (id) => {
      await query(
        tx,
        `INSERT INTO semantic.identity_epoch_prearm_custody
        (partition_no,job_id,generation,sequence,directory_partition,page_id,directory_receipt,source_receipt,empty,transaction_id)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [
          identityJobPartition(ref),
          ref.jobId,
          page.generation,
          page.sequence,
          page.partition_no,
          page.page_id,
          json(proof),
          page.source_receipt ? json(page.source_receipt) : null,
          page.original === null,
          id,
        ],
        work,
      );
      await query(
        tx,
        `UPDATE semantic.identity_epoch_input SET prearm_sequence=$4,
        prearm_transaction_id=CASE WHEN $5 THEN $6 ELSE NULL END,
        prearm_epoch=CASE WHEN $5 THEN $7 ELSE NULL END,prearm_position=CASE WHEN $5 THEN $8 ELSE NULL END
        WHERE partition_no=$1 AND job_id=$2 AND generation=$3`,
        [
          identityJobPartition(ref),
          ref.jobId,
          page.generation,
          page.sequence,
          page.original === null,
          proof.transactionId,
          proof.epoch,
          proof.position.toString(),
        ],
        work,
      );
    });
    return { value: null, events: [wake(ref)] };
  });
}

/** One retained unit per call; final root admission only reads its at-most-two maintained input heads. */
export async function stepIdentityEpochPrearm(pool: Pool, ref: IdentityJobRef, work: Work): Promise<'more' | 'sealed'> {
  const next = await withReadTransaction(
    pool,
    async (tx) =>
      (
        await query(
          tx,
          `SELECT generation,control_partition,prearm_sequence FROM semantic.identity_epoch_input
     WHERE partition_no=$1 AND job_id=$2 AND prearm_transaction_id IS NULL ORDER BY terminal LIMIT 1`,
          [identityJobPartition(ref), ref.jobId],
          work,
        )
      ).rows[0],
  );
  if (!next) {
    const roles = await identityErasureRoles(pool, ref.jobId);
    await runCommand(pool, { partition: identityJobPartition(ref) }, async (tx) => {
      const job = (
        await query(
          tx,
          `SELECT * FROM semantic.identity_epoch_job
        WHERE partition_no=$1 AND job_id=$2 AND epoch=$3 FOR UPDATE`,
          [identityJobPartition(ref), ref.jobId, ref.epoch.toString()],
          work,
        )
      ).rows[0];
      if (!job || job.state !== 'preparing') throw stale();
      if (job.prearm_phase !== 'prearm-open') return noEffect(null);
      const unresolved = (
        await query(
          tx,
          `SELECT terminal FROM semantic.identity_epoch_input
        WHERE partition_no=$1 AND job_id=$2 AND prearm_transaction_id IS NULL ORDER BY terminal LIMIT 1`,
          [identityJobPartition(ref), ref.jobId],
          work,
        )
      ).rows[0];
      if (unresolved) throw stale();
      const incomplete = (
        await query(
          tx,
          `SELECT 1 FROM semantic.identity_epoch_admission_plan
        WHERE partition_no=$1 AND job_id=$2 AND prepared_transaction_id IS NULL LIMIT 1`,
          [identityJobPartition(ref), ref.jobId],
          work,
        )
      ).rows[0];
      const unvalidated = (
        await query(
          tx,
          `SELECT s.original FROM semantic.identity_epoch_admission_source s
        LEFT JOIN semantic.identity_epoch_admission_validation v USING(partition_no,job_id,original)
        WHERE s.partition_no=$1 AND s.job_id=$2 AND v.original IS NULL ORDER BY s.original LIMIT 1`,
          [identityJobPartition(ref), ref.jobId],
          work,
        )
      ).rows[0];
      if (incomplete || unvalidated) throw unavailable();
      bindSemanticProducerRoles(tx, roles);
      recordIdentityEpochNativeCommit(tx, 'identity-prearm');
      registerCommandCallback(tx, async (id) => {
        await query(
          tx,
          `INSERT INTO semantic.identity_epoch_prearm_decision(partition_no,job_id,job_epoch,scope_digest,stage,transaction_id)
          SELECT partition_no,job_id,epoch,scope_digest,'sealed',$4 FROM semantic.identity_epoch_job
          WHERE partition_no=$1 AND job_id=$2 AND epoch=$3`,
          [identityJobPartition(ref), ref.jobId, ref.epoch.toString(), id],
          work,
        );
        await query(
          tx,
          `UPDATE semantic.identity_epoch_job SET prearm_phase='prearm-sealed',prearm_transaction_id=$4
          WHERE partition_no=$1 AND job_id=$2 AND epoch=$3 AND state='preparing' AND prearm_phase='prearm-open'`,
          [identityJobPartition(ref), ref.jobId, ref.epoch.toString(), id],
          work,
        );
      });
      return { value: null, events: [wake(ref)] };
    });
    return 'sealed';
  }
  const seq = BigInt(next.prearm_sequence) + 1n;
  const page = await readPage(pool, ref, next.control_partition, next.generation, seq, 'unsafe', work);
  if (!page) {
    await exportPage(pool, ref, next.control_partition, next.generation, work);
  } else if (!page.disposition_transaction_id) {
    let native: IdentityNativeReceipt | null = null;
    if (page.original !== null) {
      // The Source export verifies its actual capture/registration and retains its obligation.
      native = await receiveIdentityScopePrearm(pool, locator(ref, page));
      await verifySourceReceipt(pool, page, native, work);
    }
    await acceptPage(pool, ref, page, native, 'unsafe', work);
  } else {
    await copyPage(pool, ref, page, work);
  }
  return 'more';
}

/** Deliver only a real committed root seal, after releasing its producer home. */
export async function receiveIdentityPrearmClaim(pool: Pool, ref: IdentityJobRef, home: number, work?: Work) {
  const seal = await withReadTransaction(
    pool,
    async (tx) =>
      (
        await query(
          tx,
          `SELECT j.scope_digest,c.*
    FROM semantic.identity_epoch_job j
    JOIN semantic.identity_epoch_prearm_decision s ON s.partition_no=j.partition_no AND s.job_id=j.job_id
      AND s.job_epoch=j.epoch AND s.scope_digest=j.scope_digest AND s.stage='sealed'
    JOIN semantic.identity_epoch_native_commit c
      ON c.partition_no=s.partition_no AND c.transaction_id=s.transaction_id AND c.transaction_id=j.prearm_transaction_id
       AND c.purpose='identity-prearm' AND c.xmin=s.xmin
    JOIN core.partition p ON p.partition_no=c.partition_no AND p.epoch=c.epoch AND p.position>=c.position AND p.write_state='active'
    WHERE j.partition_no=$1 AND j.job_id=$2 AND j.epoch=$3 AND j.state='preparing'
      AND j.prearm_phase IN ('prearm-sealed','claiming')`,
          [identityJobPartition(ref), ref.jobId, ref.epoch.toString()],
          work,
        )
      ).rows[0],
  );
  if (!seal) throw unavailable();
  const native = receipt(identityJobPartition(ref), seal.transaction_id, seal.epoch, seal.position);
  const roles = await identityErasureRoles(pool, ref.jobId);
  await runCommand(pool, { partition: home }, async (tx) => {
    const a = (
      await query(
        tx,
        `SELECT state,scope_digest FROM semantic.identity_epoch_admission_attempt
      WHERE partition_no=$1 AND job_id=$2 AND job_epoch=$3 FOR UPDATE`,
        [home, ref.jobId, ref.epoch.toString()],
        work,
      )
    ).rows[0];
    if (!a || a.state === 'closed' || a.scope_digest !== seal.scope_digest) throw stale();
    const prior = (
      await query(
        tx,
        `SELECT seal FROM semantic.identity_epoch_prearm_claim WHERE partition_no=$1 AND job_id=$2`,
        [home, ref.jobId],
        work,
      )
    ).rows[0];
    if (prior) {
      if (!equalReceipt(decodeReceipt(prior.seal), native)) throw stale();
      return noEffect(null);
    }
    bindSemanticProducerRoles(tx, roles);
    recordIdentityEpochNativeCommit(tx, 'identity-prearm');
    registerCommandCallback(tx, async (id) => {
      await query(
        tx,
        `INSERT INTO semantic.identity_epoch_prearm_claim
        (partition_no,job_id,job_epoch,scope_digest,seal,transaction_id) VALUES($1,$2,$3,$4,$5,$6)`,
        [home, ref.jobId, ref.epoch.toString(), seal.scope_digest, json(native), id],
        work,
      );
    });
    return { value: null, events: [wake(ref)] };
  });
}

/** SAME native command, after closed-bridge prefix seeks prove a genuinely empty colocated directory.
 * No boolean from a caller can select this path. A nonempty prefix aborts the whole command.
 */
export async function sealColocatedEmptyIdentityPrearm(
  tx: CommandTransaction,
  ref: IdentityJobRef,
  transactionId: string,
) {
  const home = currentCommand(tx).partition;
  if (home !== identityJobPartition(ref)) throw stale();
  const inputs = (
    await tx.query(
      `SELECT * FROM semantic.identity_epoch_input
    WHERE partition_no=$1 AND job_id=$2 ORDER BY terminal LIMIT 2`,
      [home, ref.jobId],
    )
  ).rows;
  if (!inputs.length || inputs.some((i) => i.control_partition !== home)) throw unavailable();
  const nativeRow = (
    await tx.query(
      `SELECT epoch,position FROM semantic.identity_epoch_native_commit
    WHERE partition_no=$1 AND transaction_id=$2 AND purpose='admission'`,
      [home, transactionId],
    )
  ).rows[0];
  if (!nativeRow) throw stale();
  const native = receipt(home, transactionId, nativeRow.epoch, nativeRow.position);
  const bases = (
    await tx.query(
      `SELECT * FROM semantic.identity_epoch_admission_source
    WHERE partition_no=$1 AND job_id=$2 ORDER BY original LIMIT 2`,
      [home, ref.jobId],
    )
  ).rows;
  for (const base of bases) {
    if (base.route >> 4 !== home) throw unavailable();
    await tx.query(`SELECT original FROM semantic.identity_epoch_dirty WHERE route=$1 AND original=$2 FOR UPDATE`, [
      base.route,
      base.original,
    ]);
    await tx.query(
      `INSERT INTO semantic.identity_epoch_admission_source_hold
      (partition_no,job_id,job_epoch,original,route,scope_digest,basis,transaction_id)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,
      [
        home,
        ref.jobId,
        ref.epoch.toString(),
        base.original,
        base.route,
        base.scope_digest ??
          (
            await tx.query(`SELECT scope_digest FROM semantic.identity_epoch_job WHERE partition_no=$1 AND job_id=$2`, [
              home,
              ref.jobId,
            ])
          ).rows[0].scope_digest,
        json(base),
        transactionId,
      ],
    );
    await tx.query(
      `INSERT INTO semantic.identity_epoch_admission_validation
      (partition_no,job_id,original,source_home,transaction_id,native_epoch,native_position)
      VALUES($1,$2,$3,$1,$4,$5,$6)`,
      [home, ref.jobId, base.original, transactionId, native.epoch, native.position.toString()],
    );
  }
  for (const input of inputs) {
    const d = (
      await tx.query(
        `SELECT d.* FROM semantic.identity_epoch_prearm_directory d
      JOIN semantic.identity_epoch_prearm_bridge b USING(partition_no,generation)
      WHERE d.partition_no=$1 AND d.job_id=$2 AND d.generation=$3 AND b.job_id=d.job_id
        AND b.job_epoch=d.job_epoch AND NOT d.released FOR UPDATE OF d,b`,
        [home, ref.jobId, input.generation],
      )
    ).rows[0];
    if (!d || d.exhausted) throw stale();
    if ((await tx.query(exportSQL.sql, [home, input.generation, null, null, null])).rowCount) throw unavailable();
    const pageId = randomUUID();
    await tx.query(
      `INSERT INTO semantic.identity_epoch_prearm_page
      (partition_no,job_id,generation,sequence,page_id,transaction_id) VALUES($1,$2,$3,1,$4,$5)`,
      [home, ref.jobId, input.generation, pageId, transactionId],
    );
    await tx.query(
      `INSERT INTO semantic.identity_epoch_prearm_disposition(partition_no,page_id,stage,transaction_id)
      VALUES($1,$2,'unsafe',$3)`,
      [home, pageId, transactionId],
    );
    await tx.query(
      `INSERT INTO semantic.identity_epoch_prearm_custody
      (partition_no,job_id,generation,sequence,directory_partition,page_id,directory_receipt,empty,transaction_id)
      VALUES($1,$2,$3,1,$1,$4,$5,true,$6)`,
      [home, ref.jobId, input.generation, pageId, json(native), transactionId],
    );
    await tx.query(
      `UPDATE semantic.identity_epoch_prearm_directory
      SET sequence=1,exhausted=true,sealed_transaction_id=$4 WHERE partition_no=$1 AND job_id=$2 AND generation=$3`,
      [home, ref.jobId, input.generation, transactionId],
    );
    await tx.query(
      `UPDATE semantic.identity_epoch_input
      SET prearm_sequence=1,prearm_transaction_id=$4,prearm_epoch=$5,prearm_position=$6
      WHERE partition_no=$1 AND job_id=$2 AND generation=$3`,
      [home, ref.jobId, input.generation, transactionId, native.epoch, native.position.toString()],
    );
  }
  await tx.query(
    `INSERT INTO semantic.identity_epoch_prearm_decision(partition_no,job_id,job_epoch,scope_digest,stage,transaction_id)
    SELECT partition_no,job_id,epoch,scope_digest,'sealed',$3 FROM semantic.identity_epoch_job
    WHERE partition_no=$1 AND job_id=$2`,
    [home, ref.jobId, transactionId],
  );
  await tx.query(
    `UPDATE semantic.identity_epoch_job SET prearm_phase='prearm-sealed',prearm_transaction_id=$3
    WHERE partition_no=$1 AND job_id=$2 AND state='preparing'`,
    [home, ref.jobId, transactionId],
  );
  await tx.query(
    `INSERT INTO semantic.identity_epoch_prearm_claim
    (partition_no,job_id,job_epoch,scope_digest,seal,transaction_id)
    SELECT partition_no,job_id,epoch,scope_digest,$3,$4 FROM semantic.identity_epoch_job
    WHERE partition_no=$1 AND job_id=$2 AND epoch=$5`,
    [home, ref.jobId, json(native), transactionId, ref.epoch.toString()],
  );
}

/** Cancellation CAS has committed before any receiving attempt is closed. */
export function recordIdentityPrearmCancellation(tx: CommandTransaction, ref: IdentityJobRef) {
  recordIdentityEpochNativeCommit(tx, 'identity-prearm-cancel');
  registerCommandCallback(tx, async (id) => {
    await tx.query(
      `INSERT INTO semantic.identity_epoch_prearm_decision(partition_no,job_id,job_epoch,scope_digest,stage,transaction_id)
      SELECT partition_no,job_id,epoch,scope_digest,'cancelled',$4 FROM semantic.identity_epoch_job
      WHERE partition_no=$1 AND job_id=$2 AND epoch=$3`,
      [identityJobPartition(ref), ref.jobId, ref.epoch.toString(), id],
    );
    await tx.query(
      `UPDATE semantic.identity_epoch_job SET cancellation_transaction_id=$4
      WHERE partition_no=$1 AND job_id=$2 AND epoch=$3 AND state='cancelling'`,
      [identityJobPartition(ref), ref.jobId, ref.epoch.toString(), id],
    );
  });
}

/** Close one exported/possibly delivered Source ticket per turn, retaining every gate until all homes close. */
export async function stepIdentityPrearmCancellation(
  pool: Pool,
  ref: IdentityJobRef,
  work: Work,
): Promise<'more' | 'closed'> {
  const root = await withReadTransaction(pool, async (tx) => {
    const cancellation = (
      await query(
        tx,
        `SELECT c.* FROM semantic.identity_epoch_job j
      JOIN semantic.identity_epoch_prearm_decision s ON s.partition_no=j.partition_no AND s.job_id=j.job_id
       AND s.job_epoch=j.epoch AND s.scope_digest=j.scope_digest AND s.stage='cancelled'
      JOIN semantic.identity_epoch_native_commit c ON c.partition_no=s.partition_no AND c.transaction_id=s.transaction_id
       AND c.transaction_id=j.cancellation_transaction_id AND c.purpose='identity-prearm-cancel' AND c.xmin=s.xmin
      JOIN core.partition p ON p.partition_no=c.partition_no AND p.epoch=c.epoch AND p.position>=c.position AND p.write_state='active'
      WHERE j.partition_no=$1 AND j.job_id=$2 AND j.epoch=$3 AND j.state='cancelling'`,
        [identityJobPartition(ref), ref.jobId, ref.epoch.toString()],
        work,
      )
    ).rows[0];
    const input = (
      await query(
        tx,
        `SELECT generation,control_partition FROM semantic.identity_epoch_input
      WHERE partition_no=$1 AND job_id=$2 AND prearm_cancelled_transaction_id IS NULL ORDER BY terminal LIMIT 1`,
        [identityJobPartition(ref), ref.jobId],
        work,
      )
    ).rows[0];
    return { cancellation, input };
  });
  if (!root.cancellation) throw unavailable();
  if (!root.input) return 'closed';
  const home = root.input.control_partition as number;
  const generation = root.input.generation as string;
  const local = await withReadTransaction(pool, async (tx) => {
    const closed = (
      await query(
        tx,
        `SELECT r.transaction_id,c.epoch,c.position FROM semantic.identity_epoch_admission_receipt r
      JOIN semantic.identity_epoch_native_commit c ON c.partition_no=r.partition_no AND c.transaction_id=r.transaction_id
       AND c.epoch=r.native_epoch AND c.position=r.native_position AND c.xmin=r.xmin AND c.purpose='admission'
      JOIN core.partition p ON p.partition_no=c.partition_no AND p.epoch=c.epoch AND p.position>=c.position AND p.write_state='active'
      WHERE r.partition_no=$1 AND r.job_id=$2 AND r.job_epoch=$3 AND r.stage='closed'`,
        [home, ref.jobId, ref.epoch.toString()],
        work,
      )
    ).rows[0];
    const d = (
      await query(
        tx,
        `SELECT cancel_sequence,cancelled_transaction_id FROM semantic.identity_epoch_prearm_directory
      WHERE partition_no=$1 AND job_id=$2 AND generation=$3`,
        [home, ref.jobId, generation],
        work,
      )
    ).rows[0];
    return { closed, d };
  });
  if (!local.closed) throw unavailable();
  if (local.d && !local.d.cancelled_transaction_id) {
    const page = await readPage(pool, ref, home, generation, BigInt(local.d.cancel_sequence) + 1n, 'cancelled', work);
    if (page && !page.disposition_transaction_id) {
      let native: IdentityNativeReceipt | null = null;
      if (page.original !== null) {
        native = await cancelIdentityScopePrearm(pool, {
          locator: locator(ref, page),
          cancellation: receipt(
            identityJobPartition(ref),
            root.cancellation.transaction_id,
            root.cancellation.epoch,
            root.cancellation.position,
          ),
        });
        await verifySourceReceipt(pool, page, native, work);
      }
      await acceptPage(pool, ref, page, native, 'cancelled', work);
      return 'more';
    }
    const roles = await identityErasureRoles(pool, ref.jobId);
    await runCommand(pool, { partition: home }, async (tx) => {
      const d = (
        await query(
          tx,
          `SELECT d.* FROM semantic.identity_epoch_prearm_directory d
        JOIN semantic.identity_epoch_admission_attempt a USING(partition_no,job_id)
        WHERE d.partition_no=$1 AND d.job_id=$2 AND d.generation=$3 AND a.state='closed' FOR UPDATE OF d,a`,
          [home, ref.jobId, generation],
          work,
        )
      ).rows[0];
      if (!d || BigInt(d.cancel_sequence) !== BigInt(local.d.cancel_sequence)) return noEffect(null);
      if (page && (!page.disposition_transaction_id || page.disposition_epoch === null)) throw stale();
      bindSemanticProducerRoles(tx, roles);
      recordIdentityEpochNativeCommit(tx, 'identity-prearm');
      registerCommandCallback(tx, async (id) => {
        await query(
          tx,
          `UPDATE semantic.identity_epoch_prearm_directory
          SET cancel_sequence=$4,cancelled_transaction_id=CASE WHEN $5 THEN $6 ELSE NULL END
          WHERE partition_no=$1 AND job_id=$2 AND generation=$3`,
          [home, ref.jobId, generation, page ? page.sequence : d.cancel_sequence, !page, id],
          work,
        );
      });
      return { value: null, events: [wake(ref)] };
    });
    return 'more';
  }
  const proof = await withReadTransaction(pool, async (tx) => {
    if (!local.d) return receipt(home, local.closed.transaction_id, local.closed.epoch, local.closed.position);
    const c = (
      await query(
        tx,
        `SELECT c.* FROM semantic.identity_epoch_native_commit c
      JOIN core.partition p ON p.partition_no=c.partition_no AND p.epoch=c.epoch AND p.position>=c.position AND p.write_state='active'
      WHERE c.partition_no=$1 AND c.transaction_id=$2 AND c.purpose='identity-prearm'`,
        [home, local.d.cancelled_transaction_id],
        work,
      )
    ).rows[0];
    if (!c) throw unavailable();
    return receipt(home, c.transaction_id, c.epoch, c.position);
  });
  await runCommand(pool, { partition: identityJobPartition(ref) }, async (tx) => {
    const j = (
      await query(
        tx,
        `SELECT state FROM semantic.identity_epoch_job
      WHERE partition_no=$1 AND job_id=$2 AND epoch=$3 FOR UPDATE`,
        [identityJobPartition(ref), ref.jobId, ref.epoch.toString()],
        work,
      )
    ).rows[0];
    if (j?.state !== 'cancelling') throw stale();
    await query(
      tx,
      `UPDATE semantic.identity_epoch_input SET prearm_cancelled_transaction_id=$4
      WHERE partition_no=$1 AND job_id=$2 AND generation=$3 AND prearm_cancelled_transaction_id IS NULL`,
      [identityJobPartition(ref), ref.jobId, generation, proof.transactionId],
      work,
    );
    return { value: null, events: [wake(ref)] };
  });
  return 'more';
}

/** Called only after all cancellation custody, or native publication, is retained at job home. */
export async function releaseIdentityPrearmHome(pool: Pool, ref: IdentityJobRef, home: number, work: Work) {
  const terminal = await withReadTransaction(
    pool,
    async (tx) =>
      (
        await query(
          tx,
          `SELECT state,
    NOT EXISTS(SELECT 1 FROM semantic.identity_epoch_input i WHERE i.partition_no=j.partition_no
      AND i.job_id=j.job_id AND i.prearm_cancelled_transaction_id IS NULL) cancelled
    FROM semantic.identity_epoch_job j WHERE partition_no=$1 AND job_id=$2 AND epoch=$3`,
          [identityJobPartition(ref), ref.jobId, ref.epoch.toString()],
          work,
        )
      ).rows[0],
  );
  if (!terminal || !(terminal.state === 'published' || (terminal.state === 'cancelling' && terminal.cancelled)))
    throw stale();
  const roles = await identityErasureRoles(pool, ref.jobId);
  await runCommand(pool, { partition: home }, async (tx) => {
    bindSemanticProducerRoles(tx, roles);
    await query(
      tx,
      `SELECT partition_no FROM semantic.identity_epoch_control WHERE partition_no=$1 FOR UPDATE`,
      [home],
      work,
    );
    const releasing = await query(
      tx,
      `SELECT generation FROM semantic.identity_epoch_prearm_directory
      WHERE partition_no=$1 AND job_id=$2 AND job_epoch=$3 AND NOT released
      ORDER BY generation LIMIT 3 FOR UPDATE`,
      [home, ref.jobId, ref.epoch.toString()],
      work,
    );
    if (releasing.rows.length > 2) throw unavailable();
    if (releasing.rows.length) {
      // Only the actual original false -> true transition mints release provenance.
      // Old released rows and native retries retain their original locator (including NULL).
      recordIdentityEpochNativeCommit(tx, 'identity-prearm-release');
      registerCommandCallback(tx, async (id) => {
        await query(
          tx,
          `UPDATE semantic.identity_epoch_prearm_directory
          SET released=true,release_transaction_id=$4
          WHERE partition_no=$1 AND job_id=$2 AND job_epoch=$3 AND NOT released`,
          [home, ref.jobId, ref.epoch.toString(), id],
          work,
        );
      });
    }
    await query(
      tx,
      `UPDATE semantic.identity_epoch_prearm_bridge SET job_id=NULL,job_epoch=NULL,scope_digest=NULL,bridge_version=bridge_version+1
      WHERE partition_no=$1 AND job_id=$2 AND job_epoch=$3`,
      [home, ref.jobId, ref.epoch.toString()],
      work,
    );
    await query(
      tx,
      `UPDATE semantic.identity_epoch_group SET pending_job=NULL,pending_epoch=NULL
      WHERE partition_no=$1 AND pending_job=$2 AND pending_epoch=$3`,
      [home, ref.jobId, ref.epoch.toString()],
      work,
    );
    await query(
      tx,
      `UPDATE semantic.identity_epoch_control SET prepare_job=NULL,prepare_epoch=NULL,pending_job=NULL,pending_epoch=NULL
      WHERE partition_no=$1 AND prepare_job=$2 AND prepare_epoch=$3`,
      [home, ref.jobId, ref.epoch.toString()],
      work,
    );
    return {
      value: null,
      events: [
        wake(ref),
        {
          type: IDENTITY_EPOCH_HOME_AVAILABLE,
          data: { partition: home, after: '00000000-0000-0000-0000-000000000000' },
        },
      ],
    };
  });
  await runCommand(pool, { partition: identityJobPartition(ref) }, async (tx) => {
    await query(
      tx,
      `UPDATE semantic.identity_epoch_admission_plan SET released=true
      WHERE partition_no=$1 AND job_id=$2 AND resource_home=$3 AND NOT released`,
      [identityJobPartition(ref), ref.jobId, home],
      work,
    );
    return { value: null, events: [wake(ref)] };
  });
}

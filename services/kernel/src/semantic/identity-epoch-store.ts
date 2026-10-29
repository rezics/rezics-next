import type { Pool } from 'pg';
import { currentCommand, registerCommandCallback, type CommandTransaction } from '../command/command.ts';
import { withConnection } from '../database/pool.ts';
import { readPartition } from '../partition/partition.ts';
import { withReadTransaction } from './read.ts';
import { partitionOf, routeOf } from '../route/route.ts';
import { GLOBAL_CONTEXT } from './definitions.ts';
import { readIdentityEpochCutover } from './identity-epoch-bootstrap.ts';
import type {
  IdentityEpochStore,
  IdentityJob,
  IdentityJobRef,
  IdentityReceipt,
  IdentityStepProgress,
  IdentityStepReceipt,
} from './identity-epoch-contract.ts';

export const IDENTITY_EPOCH_CONTROL_PARTITION = 0;

export class IdentityEpochStoreError extends Error {
  constructor(
    public readonly code: string,
    detail: string,
  ) {
    super(detail);
  }
}
const unavailable = () =>
  new IdentityEpochStoreError(
    'identity_epoch_unavailable',
    'Identity bootstrap has no proven creation/structural writer cutover; observed cardinalities are incomplete',
  );
const invalidReceipt = () =>
  new IdentityEpochStoreError(
    'identity_step_receipt_invalid',
    'Missing, uncommitted, foreign-scope or conflicting native identity step receipt',
  );
const stale = () =>
  new IdentityEpochStoreError('identity_effect_stale', 'Identity effect does not match the current home gate');

function route(id: string): number {
  const value = routeOf(id);
  if (value === null) throw new TypeError('Identity original must be a native routed ID');
  return value;
}
function control(tx: CommandTransaction, platform = false) {
  const command = currentCommand(tx);
  if (command.partition !== IDENTITY_EPOCH_CONTROL_PARTITION) throw new TypeError('Wrong identity control home');
  if (platform && command.basis !== null)
    throw new TypeError('Identity maintenance requires native admitted platform work');
  return command;
}

/** Use the real executor-minted transaction ID and the component its event fence will commit.
 * The row and the outbox share the same database transaction. This is not a noEffect receipt producer.
 */
export function recordIdentityEpochNativeCommit(tx: CommandTransaction, purpose: string): void {
  const command = currentCommand(tx);
  registerCommandCallback(tx, async (transactionId) => {
    const result = await tx.query(
      `INSERT INTO semantic.identity_epoch_native_commit
      (partition_no,transaction_id,epoch,position,purpose)
      SELECT partition_no,$2,epoch,position+1,$3 FROM core.partition
      WHERE partition_no=$1 AND write_state='active' FOR UPDATE RETURNING transaction_id`,
      [command.partition, transactionId, purpose],
    );
    if (result.rowCount !== 1) throw unavailable();
  });
}

function json(value: unknown): string {
  return JSON.stringify(value, (_key, entry: unknown) => (typeof entry === 'bigint' ? entry.toString() : entry));
}
function receiptValue(receipt: IdentityReceipt) {
  return receipt.kind === 'subject.merge'
    ? {
        kind: receipt.kind,
        command: { ...receipt.command, digest: Buffer.from(receipt.command.digest).toString('base64') },
      }
    : receipt;
}
function receiptKey(receipt: IdentityReceipt): string {
  return receipt.kind === 'subject.merge'
    ? json([receipt.kind, receipt.command.actorAccountId, receipt.command.kind, receipt.command.key])
    : json([receipt.kind, receipt.account, receipt.receipt]);
}
function decodeReceipt(value: ReturnType<typeof receiptValue>): IdentityReceipt {
  return value.kind === 'subject.merge'
    ? { ...value, command: { ...value.command, digest: Buffer.from(value.command.digest, 'base64') } }
    : value;
}
function decodeProgress(value: IdentityStepProgress): IdentityStepProgress {
  return {
    ...value,
    job: { ...value.job, epoch: BigInt(value.job.epoch) },
    receipt: {
      ...value.receipt,
      job: { ...value.receipt.job, epoch: BigInt(value.receipt.job.epoch) },
      native: { ...value.receipt.native, position: BigInt(value.receipt.native.position) },
    },
  };
}

async function readJob(tx: CommandTransaction, job: IdentityJobRef): Promise<IdentityJob | null> {
  const owner = await readPartition(tx, IDENTITY_EPOCH_CONTROL_PARTITION);
  if (!owner || owner.writeState !== 'active') return null;
  const row = (
    await tx.query(
      `SELECT intent,receipt,state FROM semantic.identity_epoch_job
    WHERE partition_no=0 AND job_id=$1 AND epoch=$2`,
      [job.jobId, job.epoch.toString()],
    )
  ).rows[0];
  if (!row) return null;
  const acks = (
    await tx.query(`SELECT step,progress FROM semantic.identity_epoch_ack WHERE partition_no=0 AND job_id=$1`, [
      job.jobId,
    ])
  ).rows;
  const progress = (step: string) => {
    const ack = acks.find((ack) => ack.step === step);
    return ack ? decodeProgress(ack.progress) : null;
  };
  const intent =
    row.intent.kind === 'unmerge'
      ? { ...row.intent, undoJob: { ...row.intent.undoJob, epoch: BigInt(row.intent.undoJob.epoch) } }
      : row.intent;
  return {
    ref: job,
    intent,
    receipt: decodeReceipt(row.receipt),
    state: row.state,
    mapping: progress('mapping'),
    participants: {
      'search-canonical-index': progress('search-canonical-index'),
      'library-private-follow-counts': progress('library-private-follow-counts'),
    },
  };
}

/** Partial native producer: observations, exact creation and denial boundaries are executable.
 * Admission/publication deliberately remain unavailable until actual writer cutover exists.
 * In particular, neither bootstrap exhaustion nor a fixture can turn observed groups into complete groups.
 */
export const identityEpochStore: IdentityEpochStore = {
  controlPartition: IDENTITY_EPOCH_CONTROL_PARTITION,
  async readEpoch(tx) {
    const owner = await readPartition(tx, IDENTITY_EPOCH_CONTROL_PARTITION);
    if (!owner) return { state: 'unavailable', reason: 'missing-owner' };
    if (owner.writeState !== 'active')
      return { state: 'unavailable', reason: owner.writeState === 'moved' ? 'moved-owner' : 'bootstrap' };
    const cutover = await readIdentityEpochCutover(tx);
    if (cutover.state !== 'ready') return { state: 'unavailable', reason: 'bootstrap' };
    // There is currently no ready cutover producer. Keep pending and last published epoch distinct.
    const row = (await tx.query('SELECT * FROM semantic.identity_epoch_control WHERE partition_no=0')).rows[0];
    if (!row) return { state: 'unavailable', reason: 'bootstrap' };
    return row.pending_job
      ? {
          state: 'pending',
          publishedEpoch: BigInt(row.published_epoch),
          job: { jobId: row.pending_job, epoch: BigInt(row.pending_epoch) },
        }
      : { state: 'published', epoch: BigInt(row.published_epoch) };
  },
  readJob,
  async findJob(tx, receipt) {
    const owner = await readPartition(tx, IDENTITY_EPOCH_CONTROL_PARTITION);
    if (!owner || owner.writeState !== 'active') return null;
    const row = (
      await tx.query(
        `SELECT job_id,epoch FROM semantic.identity_epoch_job
      WHERE partition_no=0 AND receipt_key=$1 AND receipt=$2::jsonb`,
        [receiptKey(receipt), json(receiptValue(receipt))],
      )
    ).rows[0];
    return row ? readJob(tx, { jobId: row.job_id, epoch: BigInt(row.epoch) }) : null;
  },
  async readMapping(tx, original) {
    const originalRoute = route(original);
    const sourcePartition = partitionOf(originalRoute);
    const observeSource = async (client: CommandTransaction) => {
      const owner = await readPartition(client, sourcePartition);
      if (!owner) return { result: { state: 'unavailable', reason: 'missing-owner' } as const };
      if (owner.writeState !== 'active')
        return {
          result: {
            state: 'unavailable',
            reason: owner.writeState === 'moved' ? ('moved-owner' as const) : ('bootstrap' as const),
          } as const,
        };
      const row = (
        await client.query(
          `SELECT s.recorded_transaction_id AS source_transaction,m.terminal,m.epoch,m.origin,
            m.recorded_transaction_id AS mapping_transaction,g.pending_job,g.pending_epoch,
            r.target AS current_target,
            EXISTS(SELECT 1 FROM semantic.identity_epoch_dirty d
              WHERE (d.route,d.original)=(s.route,s.subject_id) AND d.revision>d.captured_revision) dirty,
            EXISTS(SELECT 1 FROM semantic.identity_epoch_member_dirty d
              WHERE d.original=s.subject_id AND d.revision>d.captured_revision) member_dirty
          FROM semantic.subject s
          LEFT JOIN semantic.identity_epoch_mapping m ON (m.route,m.original)=(s.route,s.subject_id)
          LEFT JOIN semantic.identity_epoch_home_gate g ON (g.route,g.destination,g.original)=(s.route,s.subject_id,s.subject_id)
          LEFT JOIN LATERAL (SELECT target FROM semantic.redirect
            WHERE route=s.route AND subject_id=s.subject_id ORDER BY sequence DESC LIMIT 1) r ON true
          WHERE s.route=$1 AND s.subject_id=$2`,
          [originalRoute, original],
        )
      ).rows[0];
      if (!row) return { owner, result: { state: 'absent' } as const };
      const basis = [
        owner.epoch,
        owner.position,
        owner.writeState,
        row.source_transaction,
        row.mapping_transaction,
        row.terminal,
        row.epoch,
        row.origin,
        row.pending_job,
        row.pending_epoch,
        row.current_target,
        row.dirty,
        row.member_dirty,
      ];
      if (row.pending_job)
        return {
          owner,
          basis,
          result: {
            state: 'pending',
            original,
            job: { jobId: row.pending_job, epoch: BigInt(row.pending_epoch) },
          } as const,
        };
      if (
        !row.terminal ||
        !row.mapping_transaction ||
        (row.origin === 'creation' && row.mapping_transaction !== row.source_transaction) ||
        (row.origin !== 'creation' && row.dirty) ||
        row.member_dirty ||
        (row.terminal === original ? row.current_target !== null : row.current_target !== row.terminal)
      )
        return { owner, basis, result: { state: 'unavailable', reason: 'bootstrap' } as const };
      return {
        owner,
        basis,
        result: { state: 'mapped', original, terminal: row.terminal, epoch: BigInt(row.epoch) } as const,
      };
    };

    // The source snapshot is released before touching control. Revisit the same source afterward so
    // an admission between snapshots, a moved owner, or a newer pending descriptor cannot look current.
    const source = await withReadTransaction(tx, observeSource);
    if (source.result.state === 'unavailable' || source.result.state === 'absent') return source.result;
    const controlObservation = await withReadTransaction(tx, async (client) => {
      const owner = await readPartition(client, IDENTITY_EPOCH_CONTROL_PARTITION);
      if (!owner) return { unavailable: 'missing-owner' as const };
      if (owner.writeState !== 'active')
        return { unavailable: owner.writeState === 'moved' ? ('moved-owner' as const) : ('bootstrap' as const) };
      const row = (
        await client.query(
          `SELECT c.pending_job,c.pending_epoch,j.state,
            EXISTS(SELECT 1 FROM semantic.identity_epoch_change x
              WHERE x.job_id=c.pending_job AND x.original=$1) affected
          FROM semantic.identity_epoch_control c
          LEFT JOIN semantic.identity_epoch_job j ON j.job_id=c.pending_job
          WHERE c.partition_no=0`,
          [original],
        )
      ).rows[0];
      if (!row) return { unavailable: 'bootstrap' as const };
      return {
        unavailable: null,
        pending: row.pending_job && row.state === 'pending' && row.affected,
        job: row.pending_job && row.state === 'pending' && row.affected
          ? { jobId: row.pending_job, epoch: BigInt(row.pending_epoch) }
          : null,
      };
    });
    if (controlObservation.unavailable)
      return { state: 'unavailable', reason: controlObservation.unavailable };
    const current = await withReadTransaction(tx, observeSource);
    if (current.result.state === 'unavailable' || current.result.state === 'absent') return current.result;
    if (current.basis?.map(String).join('\u0000') !== source.basis?.map(String).join('\u0000'))
      return current.result.state === 'pending' && controlObservation.job?.jobId === current.result.job.jobId
        ? current.result
        : { state: 'unavailable', reason: 'bootstrap' };
    if (source.result.state === 'pending')
      return controlObservation.job?.jobId === source.result.job.jobId ? source.result : { state: 'unavailable', reason: 'bootstrap' };
    if (controlObservation.pending) return { state: 'pending', original, job: controlObservation.job! };
    return current.result;
  },
  async admit(tx, { receipt }) {
    const command = control(tx);
    // This check precedes every receipt lookup, including during bootstrap and replay.
    if (receipt.kind === 'subject.merge') {
      const authorization = command.authorization;
      if (
        !command.basis ||
        command.basis.actorAccountId !== receipt.command.actorAccountId ||
        !authorization ||
        authorization.mode !== 'execute' ||
        authorization.action !== 'subject:merge' ||
        authorization.resource.route !== 0 ||
        authorization.resource.id !== GLOBAL_CONTEXT
      )
        throw new TypeError('Identity admission requires current native Global subject:merge authorization');
    } else {
      if (command.basis !== null) throw new TypeError('Accounts identity admission requires native platform intent');
      // The existing Accounts decision/receipt must be bound by its actual owner, never a made-up actor.
      throw new IdentityEpochStoreError(
        'identity_epoch_unavailable',
        'Missing Accounts persisted decision to identity intent owner hook',
      );
    }
    // No group cap or job can be inferred from observed bootstrap cardinality. No effect precedes this guard.
    throw unavailable();
  },
  async initializeSubject(tx, original) {
    const command = currentCommand(tx);
    const originalRoute = route(original);
    if (command.partition !== partitionOf(originalRoute)) throw new TypeError('Wrong subject creation home');
    if (
      command.basis !== null &&
      (!command.authorization ||
        command.authorization.action !== 'subject:create' ||
        command.authorization.mode !== 'execute')
    )
      throw new TypeError('Exact self requires native subject:create authorization');
    const source = (
      await tx.query(
        `SELECT s.recorded_transaction_id FROM semantic.subject s
      JOIN semantic.revision r ON (r.route,r.subject_id,r.revision)=(s.route,s.subject_id,1)
      WHERE s.route=$1 AND s.subject_id=$2 AND r.kind='create'
      AND s.recorded_transaction_id=r.recorded_transaction_id
      AND s.xmin::text=pg_current_xact_id()::text AND r.xmin::text=pg_current_xact_id()::text
      AND NOT EXISTS(SELECT 1 FROM semantic.revision later WHERE later.route=s.route AND later.subject_id=s.subject_id AND later.revision>1)
      AND NOT EXISTS(SELECT 1 FROM semantic.redirect d WHERE d.route=s.route AND d.subject_id=s.subject_id)`,
        [originalRoute, original],
      )
    ).rows[0];
    if (!source) throw new TypeError('initializeSubject requires the same native creation transaction');
    // A birth mapping is tied to the actual source-home fence that commits revision 1. Zero is
    // not a current epoch, and a process-local/default value would let a moved home look current.
    const owner = await readPartition(tx, command.partition);
    if (!owner || owner.writeState !== 'active') throw unavailable();
    const existing = (
      await tx.query(
        `SELECT m.terminal,m.epoch,m.origin,m.recorded_transaction_id,g.recorded_transaction_id AS gate_transaction_id,
          g.pending_job,g.pending_epoch
        FROM semantic.identity_epoch_mapping m
        LEFT JOIN semantic.identity_epoch_home_gate g
          ON (g.route,g.destination,g.original)=(m.route,m.original,m.original)
        WHERE (m.route,m.original)=($1,$2)`,
        [originalRoute, original],
      )
    ).rows[0];
    if (existing) {
      if (
        existing.terminal === original &&
        BigInt(existing.epoch) === BigInt(owner.epoch) &&
        existing.origin === 'creation' &&
        existing.recorded_transaction_id === source.recorded_transaction_id &&
        existing.gate_transaction_id === source.recorded_transaction_id &&
        !existing.pending_job &&
        existing.pending_epoch === null
      )
        return;
      throw new TypeError('Identity self mapping already exists outside this exact creation transaction');
    }
    await tx.query(
      `INSERT INTO semantic.identity_epoch_mapping(route,original,terminal,epoch,origin,recorded_transaction_id)
      VALUES ($1,$2,$2,$3,'creation',$4)`,
      [originalRoute, original, owner.epoch, source.recorded_transaction_id],
    );
    await tx.query(
      `INSERT INTO semantic.identity_epoch_home_gate(route,destination,original,terminal,epoch,recorded_transaction_id)
      VALUES ($1,$2,$2,$2,$3,$4)`,
      [originalRoute, original, owner.epoch, source.recorded_transaction_id],
    );
    registerCommandCallback(tx, async (transactionId) => {
      if (transactionId !== source.recorded_transaction_id)
        throw new TypeError('initializeSubject requires the executor native creation transaction');
    });
  },
  async pageChanges(tx, job, after) {
    const owner = await readPartition(tx, IDENTITY_EPOCH_CONTROL_PARTITION);
    if (!owner || owner.writeState !== 'active') throw unavailable();
    const exists = (
      await tx.query('SELECT 1 FROM semantic.identity_epoch_job WHERE job_id=$1 AND epoch=$2', [
        job.jobId,
        job.epoch.toString(),
      ])
    ).rowCount;
    if (!exists) throw new TypeError('Unknown native identity job');
    const changes = (
      await tx.query(
        `SELECT original::text,previous_terminal::text AS "previousTerminal",terminal::text
      FROM semantic.identity_epoch_change WHERE job_id=$1 AND original>coalesce($2::uuid,'00000000-0000-0000-0000-000000000000'::uuid)
      ORDER BY original LIMIT 100`,
        [job.jobId, after],
      )
    ).rows;
    return { changes, next: changes.length === 100 ? changes.at(-1)!.original : null };
  },
  async admitHomeEffect(tx, effect) {
    const command = currentCommand(tx);
    const destination = effect.kind === 'follow-count' ? effect.terminal : effect.original;
    const destinationRoute = route(destination);
    if (command.partition !== partitionOf(destinationRoute)) throw stale();
    const gate = (
      await tx.query(
        `SELECT * FROM semantic.identity_epoch_home_gate
      WHERE route=$1 AND destination=$2 AND original=$3 FOR UPDATE`,
        [destinationRoute, destination, effect.original],
      )
    ).rows[0];
    if (!gate) throw stale();
    if (effect.kind === 'follow-count') {
      if (gate.pending_job || gate.terminal !== effect.terminal || BigInt(gate.epoch) !== effect.epoch) throw stale();
      if (
        effect.original === destination &&
        (
          await tx.query(
            `SELECT 1 FROM semantic.redirect
        WHERE route=$1 AND subject_id=$2 LIMIT 1`,
            [destinationRoute, effect.original],
          )
        ).rowCount
      )
        throw stale();
    } else {
      if (
        command.basis !== null ||
        gate.pending_job !== effect.job.jobId ||
        BigInt(gate.pending_epoch ?? -1) !== effect.job.epoch
      )
        throw stale();
    }
    // Existing legacy structural writers do not acquire this gate yet. Even a matching local row cannot
    // authorize an effect until those actual writers participate in cutover; otherwise it could race a redirect.
    throw unavailable();
  },
  async reconcileStepReceipt(pool: Pool, receipt: IdentityStepReceipt) {
    if (
      receipt.version !== 1 ||
      !['mapping', 'search-canonical-index', 'library-private-follow-counts'].includes(receipt.step)
    )
      throw invalidReceipt();
    const saved = await withConnection(pool, async (tx) => {
      const owner = await readPartition(tx, receipt.native.partition);
      if (
        !owner ||
        owner.writeState !== 'active' ||
        owner.epoch !== receipt.native.epoch ||
        owner.position < receipt.native.position
      )
        throw invalidReceipt();
      const row = (
        await tx.query(
          `SELECT s.* FROM semantic.identity_epoch_step s
        JOIN semantic.identity_epoch_native_commit c ON (c.partition_no,c.transaction_id,c.epoch,c.position)=
          (s.partition_no,s.transaction_id,s.native_epoch,s.native_position)
        WHERE s.partition_no=$1 AND s.transaction_id=$2 AND s.native_epoch=$3 AND s.native_position=$4
        AND s.job_id=$5 AND s.job_epoch=$6 AND s.step=$7 AND s.version=1 AND c.purpose=s.step
        AND s.xmin=c.xmin`,
          [
            receipt.native.partition,
            receipt.native.transactionId,
            receipt.native.epoch,
            receipt.native.position.toString(),
            receipt.job.jobId,
            receipt.job.epoch.toString(),
            receipt.step,
          ],
        )
      ).rows[0];
      if (!row) throw invalidReceipt();
      return row;
    });
    // Source home is released. No caller-supplied completion or frontier enters the control transaction.
    const { runCommand } = await import('../command/command.ts');
    const result = await runCommand<IdentityStepProgress>(
      pool,
      { partition: IDENTITY_EPOCH_CONTROL_PARTITION },
      async (tx) => {
        control(tx, true);
        const job = (
          await tx.query(
            `SELECT scope_digest FROM semantic.identity_epoch_job
        WHERE job_id=$1 AND epoch=$2 AND state='pending' FOR UPDATE`,
            [receipt.job.jobId, receipt.job.epoch.toString()],
          )
        ).rows[0];
        if (!job || saved.scope_digest !== job.scope_digest) throw invalidReceipt();
        // Custody of every prior withdrawal, addition and fence must already exist. A locator is insufficient.
        const missing = (
          await tx.query(
            `SELECT 1 FROM semantic.identity_epoch_effect_receipt
        WHERE job_id=$1 AND step=$2 AND native_transaction_id IS NULL LIMIT 1`,
            [receipt.job.jobId, receipt.step],
          )
        ).rowCount;
        if (missing || saved.state !== 'complete') throw invalidReceipt();
        // The actual fixed producer/custody writer has not been installed in this slice.
        throw invalidReceipt();
      },
    );
    return result.value;
  },
  async publish(tx, job) {
    control(tx, true);
    const saved = await readJob(tx, job);
    if (
      !saved ||
      saved.mapping?.state !== 'complete' ||
      saved.participants['search-canonical-index']?.state !== 'complete' ||
      saved.participants['library-private-follow-counts']?.state !== 'complete'
    )
      throw new IdentityEpochStoreError(
        'identity_participants_incomplete',
        'Actual mapping, Search and Library ACK custody is incomplete',
      );
    throw unavailable();
  },
};

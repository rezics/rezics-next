import sql1 from './identity-epoch-store-insert-native-commit.sql';
import sql2 from './identity-epoch-store-select-job.sql';
import sql3 from './identity-epoch-store-select-ack.sql';
import sql4 from './identity-epoch-store-select-control.sql';
import sql5 from './identity-epoch-store-select-job-2.sql';
import sql6 from './identity-epoch-store-select-subject.sql';
import sql7 from './identity-epoch-store-select-redirect.sql';
import sql8 from './identity-epoch-store-select-job-3.sql';
import sql9 from './identity-epoch-store-select-mapping.sql';
import sql10 from './identity-epoch-store-select-bootstrap-home.sql';
import sql11 from './identity-epoch-store-select-mapping-2.sql';
import sql12 from './identity-epoch-store-select-group.sql';
import sql13 from './identity-epoch-store-select-control-2.sql';
import sql14 from './identity-epoch-store-insert-job.sql';
import sql15 from './identity-epoch-store-insert-input.sql';
import sql16 from './identity-epoch-store-update-control.sql';
import sql17 from './identity-epoch-store-update-group.sql';
import sql18 from './identity-epoch-store-select-subject-2.sql';
import sql19 from './identity-epoch-store-select-mapping-3.sql';
import sql20 from './identity-epoch-store-insert-mapping.sql';
import sql21 from './identity-epoch-store-insert-home-gate.sql';
import sql22 from './identity-epoch-store-insert-group.sql';
import sql23 from './identity-epoch-store-insert-original.sql';
import sql24 from './identity-epoch-store-update-dirty.sql';
import sql25 from './identity-epoch-store-select-job-4.sql';
import sql26 from './identity-epoch-store-select-input.sql';
import sql27 from './identity-epoch-store-select-original.sql';
import sql28 from './identity-epoch-store-select-home-gate.sql';
import sql29 from './identity-epoch-store-select-redirect-2.sql';
import sql30 from './identity-epoch-store-select-step.sql';
import sql31 from './identity-epoch-store-select-job-5.sql';
import sql32 from './identity-epoch-store-select-effect-receipt.sql';
import sql33 from './identity-epoch-store-select-ack-2.sql';
import sql34 from './identity-epoch-store-insert-ack.sql';
import sql35 from './identity-epoch-store-select-control-3.sql';
import sql36 from './identity-epoch-store-select-effect-receipt-2.sql';
import sql37 from './identity-epoch-store-update-job.sql';
import sql38 from './identity-epoch-store-update-control-2.sql';
import sql39 from './identity-epoch-store-update-group-2.sql';
import type { Pool } from 'pg';
import { createHash } from 'node:crypto';
import canonicalize from 'canonicalize';
import { currentCommand, registerCommandCallback, noEffect, IdempotencyConflictError, type CommandTransaction } from '../command/command.ts';
import { withConnection } from '../database/pool.ts';
import { readPartition } from '../partition/partition.ts';
import { withReadTransaction } from './read.ts';
import { newId, partitionOf, routeOf } from '../route/route.ts';
import { GLOBAL_CONTEXT } from './definitions.ts';
import { IDENTITY_EPOCH_ADMITTED } from './events.ts';
import { readIdentityEpochCutover } from './identity-epoch-bootstrap.ts';
import type {
  IdentityEpochStore,
  IdentityJob,
  IdentityJobRef,
  IdentityReceipt,
  IdentityStepProgress,
  IdentityStepReceipt,
  IdentityIntent,
  IdentityChange,
} from './identity-epoch-contract.ts';

export const IDENTITY_EPOCH_CONTROL_PARTITION = 0;
/** Fixed initial production capacity, charged once per native (home,job). */
export const IDENTITY_EPOCH_HOME_CAPACITY = 1;
export const identityJobPartition = (job: IdentityJobRef) => partitionOf(route(job.jobId));

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
      sql1.sql,
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
  const partition = identityJobPartition(job);
  const owner = await readPartition(tx, partition);
  if (!owner || owner.writeState !== 'active') return null;
  const row = (
    await tx.query(
      sql2.sql,
      [job.jobId, job.epoch.toString(), partition],
    )
  ).rows[0];
  if (!row) return null;
  const acks = (
    await tx.query(sql3.sql, [
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

/** Native source mappings and partition-scoped admission. Participant completion is never inferred. */
export const identityEpochStore: IdentityEpochStore = {
  // Compatibility for topology observations only; actual job homes are encoded by their native routed IDs.
  controlPartition: IDENTITY_EPOCH_CONTROL_PARTITION,
  async readEpoch(tx, partition = 0) {
    const owner = await readPartition(tx, partition);
    if (!owner) return { state: 'unavailable', reason: 'missing-owner' };
    if (owner.writeState !== 'active') return { state: 'unavailable', reason: owner.writeState === 'moved' ? 'moved-owner' : 'bootstrap' };
    if ((await readIdentityEpochCutover(tx)).state !== 'ready') return { state: 'unavailable', reason: 'bootstrap' };
    const row = (await tx.query(sql4.sql, [partition])).rows[0];
    if (!row) return { state: 'unavailable', reason: 'bootstrap' };
    return row.pending_job ? { state: 'pending', publishedEpoch: BigInt(row.published_epoch),
      job: { jobId: row.pending_job, epoch: BigInt(row.pending_epoch) } } : { state: 'published', epoch: BigInt(row.published_epoch) };
  },
  readJob,
  async findJob(tx, receipt) {
    const row = (await tx.query(sql5.sql, [receiptKey(receipt), json(receiptValue(receipt))])).rows[0];
    return row ? readJob(tx, { jobId: row.job_id, epoch: BigInt(row.epoch) }) : null;
  },
  async readMapping(pool, original) {
    const originalRoute = route(original);
    // This Pool represents one native backend. Source and its explicit current control route share ONE RR
    // snapshot and ONE connection. No partition join, released mixed cut, global marker or repair write.
    return withReadTransaction(pool, async (tx) => {
      const sourceOwner = await readPartition(tx, partitionOf(originalRoute));
      if (!sourceOwner) return { state: 'unavailable', reason: 'missing-owner' };
      if (sourceOwner.writeState !== 'active') return { state: 'unavailable', reason: sourceOwner.writeState === 'moved' ? 'moved-owner' : 'bootstrap' };
      const source = (await tx.query(sql6.sql, [originalRoute, original])).rows[0];
      if (!source) return { state: 'absent' };
      if (!source.original || source.control_partition === null || !source.control_group || BigInt(source.epoch) <= 0n ||
        source.owner_epoch !== sourceOwner.epoch || BigInt(source.dirty_revision) > BigInt(source.captured_revision) ||
        (source.terminal === original ? source.current_target !== null : source.current_target !== source.terminal))
        return { state: 'unavailable', reason: 'bootstrap' };
      const owner = source.control_partition === sourceOwner.partitionNo ? sourceOwner : await readPartition(tx, source.control_partition);
      if (!owner) return { state: 'unavailable', reason: 'missing-owner' };
      if (owner.writeState !== 'active') return { state: 'unavailable', reason: owner.writeState === 'moved' ? 'moved-owner' : 'bootstrap' };
      const group = (await tx.query(sql7.sql,
        [source.control_partition, route(source.control_group), source.control_group])).rows[0];
      if (!group || group.redirected) return { state: 'unavailable', reason: 'bootstrap' };
      if (group.pending_job) return { state: 'pending', original, job: { jobId: group.pending_job, epoch: BigInt(group.pending_epoch) } };
      return { state: 'mapped', original, terminal: source.terminal, epoch: BigInt(group.published_epoch) };
    });
  },
  async admit(tx, { intent, receipt }) {
    const command = control(tx);
    if (receipt.kind === 'subject.merge') {
      const authorization = command.authorization;
      if (!command.basis || command.basis.actorAccountId !== receipt.command.actorAccountId ||
        !authorization || authorization.mode !== 'execute' || authorization.action !== 'subject:merge' ||
        authorization.resource.route !== 0 || authorization.resource.id !== GLOBAL_CONTEXT)
        throw new TypeError('Identity admission requires current native Global subject:merge authorization');
    } else {
      if (command.basis !== null) throw new TypeError('Accounts identity admission requires native platform intent');
      throw new IdentityEpochStoreError('identity_epoch_unavailable', 'Missing Accounts persisted decision to identity intent owner hook');
    }
    const prior = (await tx.query(sql8.sql, [receiptKey(receipt)])).rows[0];
    if (prior) {
      if (canonicalize(prior.intent) !== canonicalize(JSON.parse(json(intent))) || canonicalize(prior.receipt) !== canonicalize(receiptValue(receipt)))
        throw new IdempotencyConflictError(command.partition);
      return noEffect({ jobId: prior.job_id, epoch: BigInt(prior.epoch) });
    }
    const ids = intent.kind === 'merge' ? [intent.redirected,intent.survivor] : intent.kind === 'repoint' ? [intent.original,intent.terminal] : [intent.original];
    const routes = ids.map(route);
    if (routes.some(r => partitionOf(r) !== command.partition)) throw new IdentityEpochStoreError('identity_epoch_unavailable', 'Identity inputs require released-home preparation');
    const inputs = (await tx.query(sql9.sql, [ids,routes,command.partition])).rows;
    const sourceClosure = (await tx.query(sql10.sql, [command.partition])).rows[0];
    if (!inputs.length || inputs.some(g=>!g.ready) && ((await readIdentityEpochCutover(tx)).state!=='ready' || !sourceClosure?.sealed_generation)) throw unavailable();
    const covered = (await tx.query(sql11.sql, [ids,routes,command.partition])).rows[0].n;
    if (covered !== new Set(ids).size) throw unavailable();
    const resulting = intent.kind === 'merge' ? inputs.reduce((n,g)=>n+BigInt(g.observed_count),0n) :
      intent.kind === 'repoint' ? BigInt(inputs.find(g=>g.terminal===intent.terminal)?.observed_count ?? 4096)+1n : 1n;
    if (resulting > 4096n) throw new IdentityEpochStoreError('identity_group_overflow', 'Resulting identity group exceeds 4096 complete originals');
    // Lock/revalidate every immutable input BEFORE reservation. The control row serializes local P=1 capacity.
    const state = (await tx.query(sql13.sql, [command.partition])).rows[0];
    const locked = (await tx.query(sql12.sql, [command.partition, inputs.map(g=>g.terminal)])).rows;
    if (locked.some((g,i)=> !inputs.some(v=>v.terminal===g.terminal && v.generation===g.generation && BigInt(v.version)===BigInt(g.version)))) throw unavailable();
    if (locked.some(g=>g.pending_job)) throw new IdentityEpochStoreError('identity_epoch_busy', 'An input group is already claimed');
    if (!state || state.pending_job) throw new IdentityEpochStoreError('identity_epoch_unavailable', 'Native identity home capacity is occupied');
    const job = { jobId: newId(command.partition*16), epoch: BigInt(state.allocated_epoch)+1n };
    const scope = createHash('sha256').update(json([intent,inputs.map(g=>[g.terminal,g.generation,g.version,g.observed_count])])).digest('hex');
    registerCommandCallback(tx, async transactionId => {
      await tx.query(sql14.sql, [command.partition,job.jobId,job.epoch.toString(),json(intent),receiptKey(receipt),json(receiptValue(receipt)),scope,transactionId]);
      await tx.query(sql15.sql, [command.partition,job.jobId,inputs.map(g=>g.terminal)]);
      await tx.query(sql16.sql, [command.partition,job.epoch.toString(),job.jobId]);
      await tx.query(sql17.sql, [command.partition,job.jobId,job.epoch.toString(),inputs.map(g=>g.terminal)]);
    });
    return { value: job, events: [{ type: IDENTITY_EPOCH_ADMITTED, data: { jobId: job.jobId, epoch: job.epoch.toString(), partition: command.partition } }] };
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
        sql18.sql,
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
        sql19.sql,
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
      sql20.sql,
      [originalRoute, original, owner.epoch, source.recorded_transaction_id, command.partition],
    );
    await tx.query(
      sql21.sql,
      [originalRoute, original, owner.epoch, source.recorded_transaction_id],
    );
    await tx.query(sql22.sql, [command.partition,original,source.recorded_transaction_id]);
    await tx.query(sql23.sql, [command.partition,source.recorded_transaction_id,original]);
    await tx.query(sql24.sql, [originalRoute,original]);
    registerCommandCallback(tx, async (transactionId) => {
      if (transactionId !== source.recorded_transaction_id)
        throw new TypeError('initializeSubject requires the executor native creation transaction');
    });
  },
  async pageChanges(tx, job, after) {
    const partition = identityJobPartition(job);
    const owner = await readPartition(tx, partition);
    if (!owner || owner.writeState !== 'active') throw unavailable();
    const saved = (await tx.query(sql25.sql, [partition,job.jobId,job.epoch.toString()])).rows[0];
    if (!saved) throw new TypeError('Unknown native identity job');
    const inputs = (await tx.query(sql26.sql, [partition,job.jobId])).rows;
    const pages: Array<{original:string;terminal:string}[]> = [];
    const allowance = inputs.length === 1 ? 100 : 50;
    for (const input of inputs) pages.push((await tx.query(sql27.sql, [input.generation,after,allowance])).rows);
    const fences = pages.filter(p=>p.length===allowance).map(p=>p.at(-1)!.original).sort();
    const frontier = fences[0];
    const intent = saved.intent as IdentityIntent;
    const changes: IdentityChange[] = pages.flat().filter(r=>!frontier || r.original<=frontier).sort((a,b)=>a.original.localeCompare(b.original)).map(r=>({
      original:r.original,previousTerminal:r.terminal,terminal:intent.kind==='merge'?intent.survivor:
        r.original===intent.original ? intent.kind==='unmerge'?intent.original:intent.terminal : r.terminal,
    }));
    return { changes, next: frontier ? changes.at(-1)!.original : null };
  },
  async admitHomeEffect(tx, effect) {
    const command = currentCommand(tx);
    const destination = effect.kind === 'follow-count' ? effect.terminal : effect.original;
    const destinationRoute = route(destination);
    if (command.partition !== partitionOf(destinationRoute)) throw stale();
    const gate = (
      await tx.query(
        sql28.sql,
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
            sql29.sql,
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
    return;
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
          sql30.sql,
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
      { partition: identityJobPartition(receipt.job) },
      async (tx) => {
        control(tx, true);
        const job = (
          await tx.query(
            sql31.sql,
            [receipt.job.jobId, receipt.job.epoch.toString()],
          )
        ).rows[0];
        if (!job || saved.scope_digest !== job.scope_digest) throw invalidReceipt();
        // Custody of every prior withdrawal, addition and fence must already exist. A locator is insufficient.
        const missing = (
          await tx.query(
            sql32.sql,
            [receipt.job.jobId, receipt.step],
          )
        ).rowCount;
        if (missing || saved.state !== 'complete') throw invalidReceipt();
        const progress: IdentityStepProgress = { job: receipt.job, frontier: saved.frontier, state: saved.state,
          work: saved.work, receipt };
        const previous = (await tx.query(sql33.sql, [receipt.job.jobId,receipt.step])).rows[0];
        if (previous) {
          if (canonicalize(previous.progress)!==canonicalize(JSON.parse(json(progress)))) throw invalidReceipt();
          return noEffect(decodeProgress(previous.progress));
        }
        await tx.query(sql34.sql, [identityJobPartition(receipt.job),receipt.job.jobId,receipt.step,job.scope_digest,json(progress),receipt.native.partition,
          receipt.native.epoch,receipt.native.position.toString(),receipt.native.transactionId]);
        return { value: progress, events: [{ type: IDENTITY_EPOCH_ADMITTED, data: { jobId: receipt.job.jobId, epoch: receipt.job.epoch.toString(), partition: identityJobPartition(receipt.job) } }] };
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
    if (saved.state === 'published') return noEffect(job);
    const partition = identityJobPartition(job);
    if (currentCommand(tx).partition !== partition) throw new TypeError('Wrong identity publication home');
    const state = (await tx.query(sql35.sql, [partition])).rows[0];
    if (state?.pending_job!==job.jobId || BigInt(state.pending_epoch)!==job.epoch) throw stale();
    const outstanding = (await tx.query(sql36.sql, [partition,job.jobId])).rowCount;
    if (outstanding) throw new IdentityEpochStoreError('identity_participants_incomplete','Prior effects lack receiving custody');
    await tx.query(sql37.sql, [partition,job.jobId]);
    await tx.query(sql38.sql, [partition,job.epoch.toString()]);
    await tx.query(sql39.sql, [partition,job.epoch.toString(),job.jobId]);
    return { value: job, events: [{ type: IDENTITY_EPOCH_ADMITTED, data: { jobId: job.jobId, epoch: job.epoch.toString(), partition } }] };
  },
};

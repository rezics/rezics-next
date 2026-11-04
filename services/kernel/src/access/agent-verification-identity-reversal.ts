/** Account-native settlement only. Semantic owns the independent consumer cut. */
import canonicalize from 'canonicalize';
import type { Pool } from 'pg';
import {
  currentCommand,
  currentCommandReceipt,
  currentCommandResources,
  hasLiveCommandTransaction,
  noEffect,
  registerCommandCallback,
  runCommand,
  type CommandTransaction,
} from '../command/command.ts';
import { partitionOf, routeOf } from '../route/route.ts';
import { deadlineFor, withRequestDeadline } from '../request/deadline.ts';
import {
  identityBindingData,
  readAcceptedAccountIdentityBinding,
  readAccountIdentityUndo,
} from '../semantic/identity-adapters/identity-epoch-binding.ts';
import { identityEpochStore, identityJobPartition } from '../semantic/identity-adapters/index.ts';
import type { IdentityNativeReceipt } from '../semantic/identity-epoch-contract.ts';
import type {
  IdentitySourceConsumerReference,
  IdentitySourceConsumerContext,
} from '../semantic/identity-source-consumer-custody.ts';
import {
  currentIdentitySourceConsumerMaintenance,
  isLiveIdentitySourceConsumerMaintenance,
  reserveIdentitySourceConsumerNativeWork,
} from '../semantic/identity-source-consumer-maintenance.ts';
import { classifyUnavailability } from './unavailable.ts';
import {
  accountIdentityUnavailable,
  readAccountIdentitySource,
  type AccountIdentitySource,
} from './agent-verification-identity.ts';
import { readAccountIdentityTechnicalSource } from './agent-verification-identity-retention.ts';
import type { AgentVerificationReversal } from './agent-verification.ts';
import insertTechnical from './agent-verification-identity-technical-insert.sql';
import readTechnical from './agent-verification-identity-technical-read.sql';
import obligations from './agent-verification-identity-reversal-obligations.sql';
import select from './agent-verification-identity-reversal-read.sql';
import insert from './agent-verification-identity-reversal-insert.sql';
import retainedReference from '../semantic/identity-source-consumer-custody-select.sql';

type Receipt = AccountIdentitySource['input']['receipt'];
const json = (value: unknown): string =>
  JSON.stringify(value, (_key, v: unknown) => (typeof v === 'bigint' ? v.toString() : v));
const normalized = (value: unknown): string => canonicalize(JSON.parse(json(value)))!;
const receiptKey = (r: Receipt): string => JSON.stringify([r.kind, r.account, r.receipt]);
const native = (source: AccountIdentitySource): IdentityNativeReceipt => ({
  partition: source.partition,
  epoch: source.epoch,
  position: source.position,
  transactionId: source.transactionId,
});
const sameNative = (a: IdentityNativeReceipt, b: IdentityNativeReceipt): boolean => normalized(a) === normalized(b);
const staged = new WeakSet<object>();

type Bound = Readonly<{
  source: AccountIdentitySource;
  binding: Readonly<{
    generation: string;
    transactionId: string;
    home: number;
    scope: string;
    sources: unknown;
    job: Readonly<{ jobId: string; epoch: bigint }>;
  }>;
  undoGeneration: string;
  restoreGeneration: string;
}>;
export type AccountIdentityReversalWrite = Readonly<{
  input: AgentVerificationReversal;
  deadline: number;
  verified: Bound;
  reversed: Bound;
}>;

/** The original accepted reader locks the real claim. Additional exact native points
 * bind its undo generation/commit, owner incarnation and restoration domain. */
async function bound(tx: CommandTransaction, source: AccountIdentitySource): Promise<Bound | null> {
  const accepted = await readAcceptedAccountIdentityBinding(tx, source.input);
  if (!accepted) return null;
  const data = identityBindingData(accepted);
  const generation = (
    await tx.query<{
      undo_generation: string;
      restore_generation: string;
    }>(obligations.sql, [
      source.partition,
      receiptKey(source.input.receipt),
      data.generation,
      data.transactionId,
      source.epoch,
    ])
  ).rows[0];
  if (
    !generation ||
    data.state !== 'accepted' ||
    data.digest !== source.digest ||
    data.key !== receiptKey(source.input.receipt) ||
    data.home !== identityJobPartition(data.job) ||
    normalized(data.receipt) !== normalized(source.input.receipt)
  )
    return null;
  return Object.freeze({
    source,
    binding: Object.freeze({
      generation: data.generation,
      transactionId: data.transactionId,
      home: data.home,
      scope: data.scope,
      sources: data.sources,
      job: data.job,
    }),
    undoGeneration: generation.undo_generation,
    restoreGeneration: generation.restore_generation,
  });
}
function snapshot(value: Bound) {
  return {
    receipt: value.source.input.receipt,
    source: native(value.source),
    digest: value.source.digest,
    binding: value.binding,
    undoGeneration: value.undoGeneration,
    restoreGeneration: value.restoreGeneration,
  };
}

/** Released probes only; no admission, bindReceipt, current release or invented job hint. */
export function prepareAccountIdentityReversalSettlement(
  pool: Pool,
  input: AgentVerificationReversal,
): Promise<AccountIdentityReversalWrite> {
  const deadline = Math.min(deadlineFor(5000), Date.now() + 5000);
  input = structuredClone(input);
  return withRequestDeadline(deadline, async () => {
    const prior = await readAccountIdentityUndo(pool, {
      kind: 'account-agent.verify',
      account: input.accountId,
      receipt: input.verificationReceiptId,
    });
    const pair = (
      await runCommand(pool, { partition: partitionOf(routeOf(input.accountId)!), deadline }, async (tx) => {
        // Read the actual original reversal, including its independently accepted own job.
        const reversed = await readAccountIdentitySource(tx, {
          kind: 'account-agent.unverify',
          account: input.accountId,
          receipt: input.receiptId,
        });
        const original = (
          await tx.query(
            `SELECT requested_by,disposition,reason,catalogue_id,verification_receipt_id
         FROM access.agent_identity_intent WHERE route=$1 AND account_id=$2
         AND direction='account-agent.unverify' AND receipt_id=$3 FOR SHARE`,
            [routeOf(input.accountId), input.accountId, input.receiptId],
          )
        ).rows[0];
        const intent = reversed.input.intent;
        if (
          !original ||
          original.requested_by !== input.requestedBy ||
          original.disposition !== input.kind ||
          original.reason !== input.reason ||
          original.catalogue_id !== input.catalogueSubjectId ||
          original.verification_receipt_id !== input.verificationReceiptId ||
          intent.kind !== 'unmerge' ||
          intent.undoJob.jobId !== prior.job.jobId ||
          intent.undoJob.epoch !== prior.job.epoch ||
          prior.source.input.intent.kind !== 'merge' ||
          prior.source.input.intent.survivor !== input.catalogueSubjectId ||
          prior.source.input.intent.release !== intent.release
        )
          throw accountIdentityUnavailable('reversal input mismatch');
        const verified = await bound(tx, prior.source);
        const reversal = await bound(tx, reversed);
        if (
          !verified ||
          !reversal ||
          normalized(verified.binding.job) !== normalized(prior.job) ||
          normalized(reversal.binding.job) === normalized(prior.job)
        )
          throw accountIdentityUnavailable('missing independent accepted reversal/verification binding');
        return noEffect({ verified, reversed: reversal });
      })
    ).value;
    for (const entry of [pair.verified, pair.reversed]) await published(pool, entry, deadline);
    const result = Object.freeze({ input: Object.freeze(input), deadline, ...pair });
    staged.add(result);
    return result;
  });
}

async function published(pool: Pool, entry: Bound, deadline: number): Promise<void> {
  const job = entry.binding.job;
  const read = async () =>
    (
      await runCommand(pool, { partition: entry.binding.home, deadline }, async (tx) => {
        const saved = await identityEpochStore.readJob(tx, job);
        // Native job/control ownership is checked at its own home, released before Source.
        const current = (
          await tx.query(
            `SELECT j.scope_digest FROM semantic.identity_epoch_job j
       JOIN semantic.identity_epoch_native_commit n ON n.partition_no=j.partition_no
        AND n.transaction_id=j.recorded_transaction_id AND n.purpose='admission'
       JOIN core.partition p ON p.partition_no=j.partition_no AND p.write_state='active'
        AND p.moved_to IS NULL AND p.epoch=n.epoch AND p.position>=n.position
       JOIN semantic.identity_epoch_control c ON c.partition_no=j.partition_no
       WHERE j.partition_no=$1 AND j.job_id=$2 AND j.epoch=$3 AND j.state='published'
        AND c.published_epoch>=j.epoch AND c.pending_job IS DISTINCT FROM j.job_id
       FOR SHARE OF j,n,p,c`,
            [entry.binding.home, job.jobId, job.epoch.toString()],
          )
        ).rows[0];
        return noEffect(
          saved &&
            current?.scope_digest === entry.binding.scope &&
            normalized(saved.receipt) === normalized(entry.source.input.receipt) &&
            normalized(saved.intent) === normalized(entry.source.input.intent)
            ? saved
            : null,
        );
      })
    ).value;
  const saved = await read();
  if (!saved || saved.state !== 'published') throw accountIdentityUnavailable('reversal publication pending');
  for (const [step, progress] of [
    ['mapping', saved.mapping],
    ['search-canonical-index', saved.participants['search-canonical-index']],
    ['library-private-follow-counts', saved.participants['library-private-follow-counts']],
  ] as const) {
    if (
      !progress ||
      progress.state !== 'complete' ||
      progress.receipt.step !== step ||
      normalized(progress.job) !== normalized(job) ||
      normalized(progress.receipt.job) !== normalized(job)
    )
      throw accountIdentityUnavailable('incomplete original native publication receipt');
    const reconciled = await identityEpochStore.reconcileStepReceipt(pool, progress.receipt);
    if (reconciled.state !== 'complete' || normalized(reconciled) !== normalized(progress))
      throw accountIdentityUnavailable('unreconciled original native publication receipt');
  }
  if ((await read())?.state !== 'published') throw accountIdentityUnavailable('original publication changed');
}

/** Transfer the two exact Account undo/replay inputs into the existing native receiver.
 * This original final writer is a second genuine receiving producer, not an erasure proof. */
async function receive(tx: CommandTransaction, entry: Bound): Promise<IdentityNativeReceipt> {
  const source = entry.source;
  const receipt = source.input.receipt;
  let row = (
    await tx.query(readTechnical.sql, [routeOf(receipt.account), receipt.account, receipt.kind, receipt.receipt])
  ).rows[0];
  if (!row) {
    row = (
      await tx.query(insertTechnical.sql, [
        routeOf(receipt.account),
        receipt.account,
        receipt.kind,
        receipt.receipt,
        json(source.input.intent),
        source.digest,
        source.partition,
        source.epoch,
        source.position.toString(),
        source.transactionId,
        entry.binding.job.jobId,
        entry.binding.job.epoch.toString(),
        entry.binding.generation,
        entry.binding.transactionId,
        source.workflowId,
        currentCommand(tx).transactionId,
      ])
    ).rows[0];
    if (!row) throw accountIdentityUnavailable('native reversal receiver inventory unavailable');
    await tx.query(
      `INSERT INTO access.agent_identity_technical_role
      (route,account_id,direction,receipt_id,role_account_id,roles) VALUES($1,$2,$3,$4,$2,32)`,
      [routeOf(receipt.account), receipt.account, receipt.kind, receipt.receipt],
    );
    registerCommandCallback(tx, async (id) => {
      await tx.query("SELECT set_config('access.identity_technical_transaction',$1,true)", [id]);
      const current = await readAccountIdentityTechnicalSource(tx, receipt);
      if (!current || !sameNative(current, source) || current.digest !== source.digest)
        throw accountIdentityUnavailable('reversal receiver finalization changed');
    });
  }
  const current = await readAccountIdentityTechnicalSource(tx, receipt);
  if (
    !current ||
    !sameNative(current, source) ||
    current.digest !== source.digest ||
    normalized(current.input) !== normalized(source.input)
  )
    throw accountIdentityUnavailable('reversal receiver mismatch');
  return {
    partition: source.partition,
    epoch: row.receiving_epoch,
    position: BigInt(row.receiving_position),
    transactionId: row.receiving_transaction_id,
  };
}

/** Called only inside the original reversed command, before its native receipt/event commit. */
export async function recordAccountIdentityReversalSettlement(
  tx: CommandTransaction,
  prepared: AccountIdentityReversalWrite,
): Promise<void> {
  const command = currentCommand(tx);
  const actual = currentCommandReceipt(tx);
  if (
    !staged.has(prepared) ||
    Date.now() >= prepared.deadline ||
    command.basis !== null ||
    command.partition !== prepared.reversed.source.partition ||
    actual.kind !== 'access.agent-verification.reversed' ||
    actual.key !== prepared.input.receiptId ||
    actual.principal.kind !== 'account' ||
    actual.principal.id !== prepared.input.requestedBy
  )
    throw accountIdentityUnavailable('original reversal writer required');
  const receivers: IdentityNativeReceipt[] = [];
  for (const entry of [prepared.verified, prepared.reversed]) {
    const currentSource = await readAccountIdentitySource(tx, entry.source.input.receipt, undefined, true);
    const current = await bound(tx, currentSource);
    if (!current || normalized(snapshot(current)) !== normalized(snapshot(entry)))
      throw accountIdentityUnavailable('original reversal obligations changed');
    receivers.push(await receive(tx, entry));
  }
  const inserted = (
    await tx.query(insert.sql, [
      routeOf(prepared.input.accountId),
      prepared.input.accountId,
      prepared.input.receiptId,
      prepared.input.verificationReceiptId,
      json(snapshot(prepared.verified)),
      json(snapshot(prepared.reversed)),
      json(receivers),
      command.transactionId,
      actual.storageKey,
    ])
  ).rows[0];
  if (!inserted) throw accountIdentityUnavailable('native reversal settlement unavailable');
  registerCommandCallback(tx, async (id) => {
    if (id !== command.transactionId) throw accountIdentityUnavailable('reversal terminal command changed');
    await tx.query("SELECT set_config('access.identity_reversal_transaction',$1,true)", [id]);
  });
}

const locator = Symbol('account-identity-reversal-settlement');
declare const settlement: unique symbol;
export type AccountIdentityReversalSettlement = Readonly<{ [settlement]: true }>;
type Proof = AccountIdentityReversalSettlement &
  Readonly<{
    [locator]: Readonly<{ reference: string; terminal: IdentityNativeReceipt; snapshot: string }>;
  }>;

function live(tx: CommandTransaction, reference: IdentitySourceConsumerReference): boolean {
  const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
  const route = routeOf(reference.receipt.account);
  return (
    hasLiveCommandTransaction(tx) &&
    currentCommand(tx).basis === null &&
    route !== null &&
    ['account-agent.verify', 'account-agent.unverify'].includes(reference.receipt.kind) &&
    uuid.test(reference.receipt.receipt) &&
    uuid.test(reference.source.transactionId) &&
    Number.isSafeInteger(reference.source.epoch) &&
    reference.source.epoch > 0 &&
    reference.source.epoch <= 2147483647 &&
    typeof reference.source.position === 'bigint' &&
    reference.source.position > 0n &&
    reference.source.position <= 9223372036854775807n &&
    /^[0-9a-f]{64}$/.test(reference.sourceDigest) &&
    uuid.test(reference.job.jobId) &&
    typeof reference.job.epoch === 'bigint' &&
    reference.job.epoch > 0n &&
    reference.job.epoch <= 9223372036854775807n &&
    uuid.test(reference.barrier.accountId) &&
    routeOf(reference.barrier.accountId) === reference.barrier.accountRoute &&
    Number.isSafeInteger(reference.barrier.version) &&
    reference.barrier.version > 0 &&
    reference.barrier.version <= 2147483647 &&
    typeof reference.barrier.at === 'string' &&
    Buffer.byteLength(reference.barrier.at) <= 64 &&
    Number.isFinite(Date.parse(reference.barrier.at)) &&
    ['subject', 'requester', 'decider'].includes(reference.erasedRole) &&
    (reference.erasedRole !== 'subject' || reference.barrier.accountId === reference.receipt.account) &&
    currentCommand(tx).partition === reference.source.partition &&
    reference.source.partition === partitionOf(route) &&
    currentCommandResources(tx).deadline > Date.now()
  );
}
async function settlementFor(tx: CommandTransaction, reference: IdentitySourceConsumerReference) {
  const r = reference.receipt;
  // The original exact verification receipt has one matching settlement per reversal;
  // the unique index refuses a second reversal of that original verification.
  const row = (
    await tx.query(select.sql, [
      routeOf(r.account),
      r.account,
      r.kind === 'account-agent.verify' ? r.receipt : null,
      r.kind === 'account-agent.unverify' ? r.receipt : null,
    ])
  ).rows[0];
  if (!row) return null;
  const entries = [row.verified, row.reversed] as ReturnType<typeof snapshot>[];
  const chosen = r.kind === 'account-agent.verify' ? entries[0]! : entries[1]!;
  if (
    normalized(chosen.receipt) !== normalized(r) ||
    chosen.digest !== reference.sourceDigest ||
    normalized(chosen.source) !== normalized(reference.source) ||
    normalized(chosen.binding.job) !== normalized(reference.job)
  )
    return null;
  // Source has already retained this exact reference at this home. This indexed
  // association binds barrier/role even after original personal attribution clears.
  // It is not root authority: Accounts/History independently verify the live root.
  const retained = (
    await tx.query(retainedReference.sql, [
      reference.source.partition,
      receiptKey(r),
      reference.sourceDigest,
      reference.source.epoch,
      reference.source.position.toString(),
      reference.source.transactionId,
      reference.job.jobId,
      reference.job.epoch.toString(),
      reference.barrier.accountId,
      reference.barrier.accountRoute,
      reference.barrier.version,
      reference.barrier.at,
      reference.erasedRole,
    ])
  ).rows[0];
  if (!retained) return null;
  for (let i = 0; i < 2; i++) {
    const expected = entries[i]!;
    const technical = await readAccountIdentityTechnicalSource(tx, expected.receipt);
    if (!technical) return null;
    const current = await bound(tx, technical);
    if (!current || normalized(snapshot(current)) !== normalized(expected)) return null;
    const receiver = (
      await tx.query(readTechnical.sql, [
        routeOf(r.account),
        r.account,
        expected.receipt.kind,
        expected.receipt.receipt,
      ])
    ).rows[0];
    const saved = row.receivers[i] as IdentityNativeReceipt;
    if (
      !receiver ||
      normalized({
        partition: technical.partition,
        epoch: receiver.receiving_epoch,
        position: String(receiver.receiving_position),
        transactionId: receiver.receiving_transaction_id,
      }) !== normalized(saved)
    )
      return null;
  }
  return {
    terminal: {
      partition: row.partition_no as number,
      epoch: row.owner_epoch as number,
      position: BigInt(row.position),
      transactionId: row.transaction_id as string,
    },
    snapshot: normalized([row.verified, row.reversed, row.receivers, row.domain_generation]),
  };
}

/** Exact current reference, one funded same-home read, no foreign-home I/O or minting. */
export async function readAccountIdentityReversalSettlement(
  pool: Pool,
  reference: IdentitySourceConsumerReference,
  context: IdentitySourceConsumerContext,
): Promise<AccountIdentityReversalSettlement | null> {
  if (
    !isLiveIdentitySourceConsumerMaintenance(pool, context.identityConsumerWork, context.deadline) ||
    !reserveIdentitySourceConsumerNativeWork(pool, context.identityConsumerWork, {
      rows: 64,
      points: 64,
      statements: 20,
      bytes: 65536,
      engineRequests: 0,
    })
  )
    return null;
  reference = structuredClone(reference);
  return withRequestDeadline(context.deadline, async () => {
    try {
      return (
        await runCommand(pool, { partition: reference.source.partition, deadline: context.deadline }, async (tx) => {
          if (!live(tx, reference)) return noEffect(null);
          const result = await settlementFor(tx, reference);
          return noEffect(
            result
              ? (Object.freeze({ [locator]: Object.freeze({ reference: normalized(reference), ...result }) }) as Proof)
              : null,
          );
        })
      ).value;
    } catch (error) {
      if (classifyUnavailability(error)) return null;
      throw error;
    }
  });
}

/** A brand/observation alone never proves currentness: lock the durable native rows again. */
export async function verifyAccountIdentityReversalSettlement(
  tx: CommandTransaction,
  reference: IdentitySourceConsumerReference,
  proof: AccountIdentityReversalSettlement,
): Promise<boolean> {
  if (!live(tx, reference)) return false;
  const resources = currentCommandResources(tx);
  const work = currentIdentitySourceConsumerMaintenance(resources.pool, resources.deadline);
  if (
    !work ||
    !reserveIdentitySourceConsumerNativeWork(resources.pool, work, {
      rows: 64,
      points: 64,
      statements: 15,
      bytes: 65536,
      engineRequests: 0,
    })
  )
    return false;
  const data = (proof as Proof | null)?.[locator];
  if (!data || data.reference !== normalized(reference)) return false;
  const result = await settlementFor(tx, reference);
  return !!result && sameNative(result.terminal, data.terminal) && result.snapshot === data.snapshot;
}

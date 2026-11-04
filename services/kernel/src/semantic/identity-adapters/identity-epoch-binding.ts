import { bindSemanticProducerRoles } from '../erasure-producer.ts';
import { classifyUnavailability } from '../../access/unavailable.ts';
import { readAccountIdentityTechnicalSource } from '../../access/agent-verification-identity-retention.ts';
import { withRequestDeadline } from '../../request/deadline.ts';
import {
  identitySourceConsumerNativeWork,
  isLiveIdentitySourceConsumerMaintenance,
  reserveIdentitySourceConsumerNativeWork,
} from '../identity-source-consumer-maintenance.ts';
import {
  readAccountIdentitySource,
  assertAccountIdentitySource,
  type AccountIdentitySource,
  type AccountIdentityReversalSettlement,
} from '../../access/agent-verification-identity.ts';
import { IDENTITY_EPOCH_PROGRESS } from '../events.ts';
import { createHash } from 'node:crypto';
import canonicalize from 'canonicalize';
import type { Pool } from 'pg';
import {
  currentCommand,
  currentCommandResources,
  IdempotencyConflictError,
  noEffect,
  registerCommandCallback,
  runCommand,
  type CommandTransaction,
} from '../../command/command.ts';
import { partitionOf, routeOf, newId } from '../../route/route.ts';
import { withReadTransaction } from '../read.ts';
import {
  authorizeIdentityAdmission,
  identityReceiptKey,
  identityReceiptValue,
  recordIdentityEpochNativeCommit,
  serializeIdentityValue as json,
  IdentityEpochStoreError,
} from './index.ts';
import type { IdentityAdmissionAuthority, IdentityAdmissionInput, IdentityJobRef } from './identity-epoch-contract.ts';
import selectClaim from '../identity-epoch-binding-select.sql';
import insertClaim from '../identity-epoch-binding-insert.sql';
import acceptClaim from '../identity-epoch-binding-accept.sql';
import committedJob from '../identity-epoch-binding-job.sql';
import acceptedAccountClaim from '../identity-epoch-binding-accepted-account.sql';
import consumerClaim from '../identity-epoch-binding-consumer.sql';
import consumerGuard from '../identity-epoch-binding-consumer-guard.sql';
import consumerUndo from '../identity-epoch-binding-consumer-undo.sql';
import consumerTerminal from '../identity-epoch-binding-consumer-terminal.sql';
import consumerWork from '../identity-epoch-binding-consumer-work.sql';
import consumerJob from '../identity-epoch-binding-consumer-job.sql';
import type {
  IdentitySourceConsumerReference,
  IdentitySourceConsumerGeneration,
  IdentitySourceConsumerDisposition,
  IdentitySourceConsumerWork,
  IdentitySourceConsumerContext,
} from '../identity-source-consumer-custody.ts';

/** A serializable locator is custody data. Only a released verified read mints an in-process proof. */
export type IdentityReceiptBinding = Readonly<{
  partition: number;
  generation: string;
  transactionId: string;
  jobHome: number;
  job: IdentityJobRef;
}>;
export type IdentityAdmissionSource = Readonly<{
  input_original: string;
  source_route: number;
  source_revision: string;
  source_transaction_id: string;
  source_owner_epoch: number;
  partition_no: number;
  terminal: string;
  generation: string;
  version: string;
  observed_count: string;
  owner_epoch: number;
  ready: boolean;
  pending_job: string | null;
  /** Captured only for terminal detachment, retained with its immutable generation basis. */
  remainder_terminal?: string | null;
}>;
export type IdentityBindingData = Readonly<{
  partition: number;
  key: string;
  digest: string;
  generation: string;
  transactionId: string;
  receipt: unknown;
  job: IdentityJobRef;
  home: number;
  scope: string;
  sources: readonly IdentityAdmissionSource[];
  state: 'pending' | 'accepted' | 'not-applied';
}>;
type BindingRow = {
  partition_no: number;
  receipt_key: string;
  intent_digest: string;
  generation: string;
  transaction_id: string;
  binding_transaction_id: string | null;
  job_id: string;
  job_epoch: string;
  job_home: number;
  scope_digest: string;
  sources: IdentityAdmissionSource[];
  receipt: unknown;
  state: IdentityBindingData['state'];
  imported: boolean;
};
const accountSources = new WeakMap<IdentityReceiptBinding, AccountIdentitySource>();
const transactionSources = new WeakMap<CommandTransaction, AccountIdentitySource>();
const rowSources = new WeakMap<object, AccountIdentitySource>();
const verified = new WeakMap<IdentityReceiptBinding, IdentityBindingData>();
export function identityBindingData(proof: IdentityReceiptBinding): IdentityBindingData {
  const value = verified.get(proof);
  if (!value) throw new TypeError('Identity binding requires released committed native custody');
  return value;
}
export function identityReceiptPartition(receipt: IdentityAdmissionInput['receipt']): number {
  const id = receipt.kind === 'subject.merge' ? receipt.command.actorAccountId : receipt.account;
  const route = routeOf(id);
  if (route === null) throw new TypeError('Identity receipt requires its actual routed actor/account');
  return partitionOf(route);
}
export function identityBindingDigest(input: IdentityAdmissionInput): string {
  return createHash('sha256')
    .update(canonicalize(JSON.parse(json([input.intent, identityReceiptValue(input.receipt)])))!)
    .digest('hex');
}
/** Only native source reads at the released binding home can attach Accounts custody. */
export function assertIdentityBindingSource(
  binding: IdentityReceiptBinding,
  receipt: IdentityAdmissionInput['receipt'],
): void {
  identityBindingData(binding);
  if (receipt.kind === 'subject.merge') return;
  const source = accountSources.get(binding);
  if (!source) throw new TypeError('Missing released Accounts source custody');
  assertAccountIdentitySource(source, receipt);
}
function proof(row: BindingRow): IdentityReceiptBinding {
  if (!row.binding_transaction_id) throw new TypeError('Receipt migration needs native released confirmation');
  const value = Object.freeze({
    partition: row.partition_no,
    generation: String(row.generation),
    transactionId: row.binding_transaction_id,
    jobHome: row.job_home,
    job: Object.freeze({ jobId: row.job_id, epoch: BigInt(row.job_epoch) }),
  });
  verified.set(
    value,
    Object.freeze({
      partition: row.partition_no,
      key: row.receipt_key,
      digest: row.intent_digest,
      generation: String(row.generation),
      transactionId: row.binding_transaction_id,
      receipt: row.receipt,
      job: Object.freeze({ jobId: row.job_id, epoch: BigInt(row.job_epoch) }),
      home: row.job_home,
      scope: row.scope_digest,
      sources: Object.freeze(row.sources.map((s) => Object.freeze(s))),
      state: row.state,
    }),
  );
  const source = rowSources.get(row);
  if (source) accountSources.set(value, source);
  return value;
}
async function read(tx: CommandTransaction, input: IdentityAdmissionInput) {
  const source = await authorizeIdentityAdmission(tx, input.receipt, undefined, input.intent);
  if (source) transactionSources.set(tx, source);
  const home = identityReceiptPartition(input.receipt);
  if (currentCommand(tx).partition !== home) throw new TypeError('Receipt lookup requires its native binding home');
  const row = (await tx.query<BindingRow>(selectClaim.sql, [home, identityReceiptKey(input.receipt)])).rows[0];
  if (input.receipt.kind !== 'subject.merge') {
    await assertOriginalConsumerOpen(tx, input.receipt);
    if (input.intent.kind === 'unmerge' && input.intent.verificationReceipt)
      await assertOriginalConsumerOpen(tx, {
        kind: 'account-agent.verify',
        account: input.receipt.account,
        receipt: input.intent.verificationReceipt,
      });
  }
  if (row && row.intent_digest !== identityBindingDigest(input)) throw new IdempotencyConflictError(home);
  if (row && source) rowSources.set(row, source);
  return row;
}
export async function readIdentityBinding(tx: CommandTransaction, input: IdentityAdmissionInput) {
  const row = await read(tx, input);
  return row ? proof(row) : null;
}
/** Accepted original input lookup for the same-home technical receiver. This does
 * not authorize admission or attach Accounts source custody to the returned binding.
 */
export async function readAcceptedAccountIdentityBinding(
  tx: CommandTransaction,
  input: IdentityAdmissionInput &
    Readonly<{
      receipt: Extract<IdentityAdmissionInput['receipt'], { kind: 'account-agent.verify' | 'account-agent.unverify' }>;
    }>,
): Promise<IdentityReceiptBinding | null> {
  if (input.receipt.kind !== 'account-agent.verify' && input.receipt.kind !== 'account-agent.unverify') return null;
  const partition = identityReceiptPartition(input.receipt);
  if (currentCommand(tx).partition !== partition) return null;
  const row = (
    await tx.query<BindingRow>(acceptedAccountClaim.sql, [
      partition,
      identityReceiptKey(input.receipt),
      identityBindingDigest(input),
      json(identityReceiptValue(input.receipt)),
      input.receipt.account,
    ])
  ).rows[0];
  return row ? proof(row) : null;
}
export async function identityBindingJob(pool: Pool, data: IdentityBindingData) {
  return withReadTransaction(
    pool,
    async (tx) =>
      (await tx.query(committedJob.sql, [data.home, data.job.jobId, data.job.epoch.toString(), data.scope])).rows[0] ??
      null,
  );
}
/** Current authorization and native T precede even the existing-key lookup. Every checkout is released. */
export async function lookupIdentityBinding(
  pool: Pool,
  authority: IdentityAdmissionAuthority,
  input: IdentityAdmissionInput,
) {
  let row = (
    await runCommand(pool, { ...authority, partition: identityReceiptPartition(input.receipt) }, async (tx) =>
      noEffect(await read(tx, input)),
    )
  ).value;
  if (!row) return null;
  if (!row.binding_transaction_id) {
    // Forward-migrated accepted receipts retain their original job/native transaction. Verify that
    // source at its actual home before the independent actor-home confirmation command.
    const saved = await withReadTransaction(
      pool,
      async (tx) =>
        (await tx.query(committedJob.sql, [row!.job_home, row!.job_id, row!.job_epoch, row!.scope_digest])).rows[0],
    );
    if (!saved)
      throw new IdentityEpochStoreError(
        'identity_epoch_unavailable',
        'Migrated receipt has no current native job proof',
      );
    await runCommand(pool, { ...authority, partition: row.partition_no }, async (tx) => {
      const current = await read(tx, input);
      if (!current) throw new TypeError('Missing migrated receipt');
      if (current.binding_transaction_id) return noEffect(null);
      recordIdentityEpochNativeCommit(tx, 'admission');
      registerCommandCallback(tx, async (id) => {
        await tx.query(
          `INSERT INTO semantic.identity_epoch_receipt_claim_commit VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING`,
          [current.partition_no, current.receipt_key, current.generation, id],
        );
      });
      return {
        value: null,
        events: [
          {
            type: IDENTITY_EPOCH_PROGRESS,
            data: { partition: currentCommand(tx).partition, generation: current.generation },
          },
        ],
      };
    });
    row = (
      await runCommand(pool, { ...authority, partition: row.partition_no }, async (tx) =>
        noEffect(await read(tx, input)),
      )
    ).value;
  }
  return row ? proof(row) : null;
}
/** Effects-free native cap/current-capacity collection must precede this claim. No P slot is added. */
export async function claimIdentityBinding(
  pool: Pool,
  authority: IdentityAdmissionAuthority,
  input: IdentityAdmissionInput,
  prepared: { home: number; epoch: bigint; scope: string; sources: readonly IdentityAdmissionSource[] },
) {
  const partition = identityReceiptPartition(input.receipt);
  await runCommand(pool, { ...authority, partition }, async (tx) => {
    const existing = await read(tx, input);
    if (existing && existing.state !== 'not-applied') return noEffect(null);
    const source = transactionSources.get(tx);
    if (source) bindSemanticProducerRoles(tx, source.roles);
    recordIdentityEpochNativeCommit(tx, 'admission');
    const id = newId(prepared.home * 16);
    registerCommandCallback(tx, async (transactionId) => {
      await tx.query(insertClaim.sql, [
        partition,
        identityReceiptKey(input.receipt),
        identityBindingDigest(input),
        json(identityReceiptValue(input.receipt)),
        json(input.intent),
        id,
        prepared.home,
        prepared.epoch.toString(),
        prepared.scope,
        json(prepared.sources),
        transactionId,
        input.receipt.kind === 'subject.merge' ? input.receipt.command.actorAccountId : input.receipt.account,
      ]);
      if (source && input.receipt.kind === 'account-agent.unverify' && source.input.intent.kind === 'unmerge') {
        const undo = source.input.intent;
        const changed = await tx.query(consumerUndo.sql, [
          partition,
          identityReceiptKey({
            kind: 'account-agent.verify',
            account: input.receipt.account,
            receipt: undo.verificationReceipt!,
          }),
          undo.undoJob.jobId,
          undo.undoJob.epoch.toString(),
          identityReceiptKey(input.receipt),
          transactionId,
        ]);
        if (changed.rowCount !== 1)
          throw new IdentityEpochStoreError(
            'identity_epoch_unavailable',
            'Original native undo generation is unavailable',
          );
      }
    });
    return {
      value: null,
      events: [
        {
          type: IDENTITY_EPOCH_PROGRESS,
          data: {
            partition: currentCommand(tx).partition,
            generation: (BigInt(existing?.generation ?? '0') + 1n).toString(),
          },
        },
      ],
    };
  });
  const committed = await lookupIdentityBinding(pool, authority, input);
  if (!committed) throw new IdentityEpochStoreError('identity_epoch_unavailable', 'Native receipt claim lost custody');
  return committed;
}
/** The first group reservation is independently durable before this immutable accepted pointer. */
export async function acceptIdentityBinding(
  pool: Pool,
  authority: IdentityAdmissionAuthority,
  input: IdentityAdmissionInput,
  binding: IdentityReceiptBinding,
) {
  const data = identityBindingData(binding);
  if (!(await identityBindingJob(pool, data)))
    throw new IdentityEpochStoreError(
      'identity_epoch_unavailable',
      'Binding acceptance requires the committed first reservation',
    );
  await runCommand(pool, { ...authority, partition: data.partition }, async (tx) => {
    const current = await readIdentityBinding(tx, input);
    if (!current || identityBindingData(current).generation !== data.generation)
      throw new TypeError('Obsolete binding generation');
    if (identityBindingData(current).state === 'accepted') return noEffect(null);
    const source = transactionSources.get(tx);
    if (source) bindSemanticProducerRoles(tx, source.roles);
    const changed = await tx.query(acceptClaim.sql, [
      data.partition,
      data.key,
      data.generation,
      data.job.jobId,
      data.job.epoch.toString(),
    ]);
    if (changed.rowCount !== 1) throw new TypeError('Binding publication did not match immutable job');
    return {
      value: null,
      events: [
        {
          type: IDENTITY_EPOCH_PROGRESS,
          data: { partition: currentCommand(tx).partition, generation: data.generation },
        },
      ],
    };
  });
}

/** Read-only original undo custody. This cannot mint a new binding or a source admission proof. */
export async function readAccountIdentityUndo(
  pool: Pool,
  receipt: Extract<IdentityAdmissionInput['receipt'], { kind: 'account-agent.verify' }>,
) {
  return (
    await runCommand(pool, { partition: identityReceiptPartition(receipt) }, async (tx) => {
      const guard = (
        await tx.query<{ consumer_terminal_custody: string | null }>(consumerGuard.sql, [
          identityReceiptPartition(receipt),
          identityReceiptKey(receipt),
        ])
      ).rows[0];
      const source =
        guard?.consumer_terminal_custody != null
          ? await readAccountIdentityTechnicalSource(tx, receipt)
          : await readAccountIdentitySource(tx, receipt, undefined, true);
      if (!source)
        throw new IdentityEpochStoreError(
          'identity_epoch_unavailable',
          'Original Source requires accepted technical undo custody',
        );
      const row = (
        await tx.query<BindingRow>(selectClaim.sql, [identityReceiptPartition(receipt), identityReceiptKey(receipt)])
      ).rows[0];
      if (!row || row.state !== 'accepted' || !row.binding_transaction_id || row.intent_digest !== source.digest)
        throw new IdentityEpochStoreError(
          'identity_epoch_unavailable',
          'Accounts source: prior verification has no accepted native undo custody',
        );
      return noEffect({ source, job: { jobId: row.job_id, epoch: BigInt(row.job_epoch) } });
    })
  ).value;
}

export function identityBindingAccountRoles(binding: IdentityReceiptBinding) {
  identityBindingData(binding);
  return accountSources.get(binding)?.roles ?? [];
}

/** All original-source replay/admission/undo paths share the original binding row lock.
 * A committed terminal pointer permits only the separate accepted-input receiver lookup.
 * Undo resolves Accounts' accepted technical source after transfer; an ordinary
 * old-source admission is rejected before it can escape this home.
 */
async function assertOriginalConsumerOpen(
  tx: CommandTransaction,
  receipt: Exclude<IdentityAdmissionInput['receipt'], { kind: 'subject.merge' }>,
): Promise<void> {
  const row = (
    await tx.query<{ consumer_terminal_custody: string | null }>(consumerGuard.sql, [
      identityReceiptPartition(receipt),
      identityReceiptKey(receipt),
    ])
  ).rows[0];
  if (row?.consumer_terminal_custody != null)
    throw new IdentityEpochStoreError(
      'identity_epoch_unavailable',
      'Original Source consumer requires accepted technical input',
    );
}

/** Resolve native generations with Source's live maintenance allocation. Each
 * released snapshot prepays its failed point, control and cleanup work. The
 * directory receives planning data and charges the same frame when it dispatches.
 */
export async function readIdentitySourceConsumerWork(
  pool: Pool,
  reference: IdentitySourceConsumerReference,
  context: IdentitySourceConsumerContext,
): Promise<IdentitySourceConsumerWork | null> {
  if (!isLiveIdentitySourceConsumerMaintenance(pool, context.identityConsumerWork, context.deadline)) return null;
  if (!validConsumerReference(reference)) return null;
  reference = structuredClone(reference);
  // Retained Source, its commit, binding/claim/commit, original/undo commits,
  // owner and installed-hook catalogue point: nine exact points, including misses.
  const reserve = (touches: number) =>
    reserveIdentitySourceConsumerNativeWork(pool, context.identityConsumerWork, {
      rows: touches,
      points: touches,
      statements: 5,
      bytes: 8192,
      engineRequests: 0,
    });
  return withRequestDeadline(context.deadline, async () => {
    try {
      if (!reserve(9)) return null;
      const row = await withReadTransaction(
        pool,
        async (tx) =>
          (
            await tx.query<{
              replay_generation: string;
              undo_generation: string;
              restore_generation: string;
              scope_digest: string;
              job_home: number;
            }>(consumerWork.sql, [
              reference.source.partition,
              identityReceiptKey(reference.receipt),
              reference.sourceDigest,
              reference.job.jobId,
              reference.job.epoch.toString(),
              json(identityReceiptValue(reference.receipt)),
              reference.source.epoch,
              reference.source.position.toString(),
              reference.source.transactionId,
              reference.barrier.accountId,
              reference.barrier.accountRoute,
              reference.barrier.version,
              reference.barrier.at,
              reference.erasedRole,
            ])
          ).rows[0] ?? null,
      );
      if (!row || !reserve(4)) return null;
      // Release Source before checking its exact accepted job/control/native owner.
      const job = await withReadTransaction(
        pool,
        async (tx) =>
          (
            await tx.query<{ scope_digest: string }>(consumerJob.sql, [
              row.job_home,
              reference.job.jobId,
              reference.job.epoch.toString(),
              row.scope_digest,
            ])
          ).rows[0],
      );
      if (!job || job.scope_digest !== row.scope_digest) return null;
      const balance = identitySourceConsumerNativeWork(pool, context.identityConsumerWork, context.deadline);
      if (!balance) return null;
      // Keep the final same-command verifier's existing four points/six statements/
      // 8 KiB available before directory planning. Source already prepaid its own
      // fixed local command footprint before calling this owner.
      if (balance.rows <= 4 || balance.points <= 4 || balance.statements <= 6 || balance.bytes <= 8192) return null;
      return Object.freeze({
        replayGeneration: row.replay_generation,
        undoGeneration: row.undo_generation,
        restoreGeneration: row.restore_generation,
        allowance: Object.freeze({
          rows: balance.rows - 4,
          points: balance.points - 4,
          statements: balance.statements - 6,
          bytes: balance.bytes - 8192,
          engineRequests: balance.engineRequests,
        }),
      });
    } catch (error) {
      if (classifyUnavailability(error)) return null;
      throw error;
    }
  });
}

type ConsumerClaim = BindingRow & {
  undo_generation: string;
  restore_generation: string;
  terminal_custody: string | null;
  terminal_sequence: string | null;
};
function validConsumerReference(reference: IdentitySourceConsumerReference): boolean {
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
  const maxNative = 9223372036854775807n;
  const { receipt, source, barrier } = reference;
  return (
    (receipt.kind === 'account-agent.verify' || receipt.kind === 'account-agent.unverify') &&
    uuid.test(receipt.account) &&
    uuid.test(receipt.receipt) &&
    uuid.test(source.transactionId) &&
    source.partition === identityReceiptPartition(receipt) &&
    Number.isSafeInteger(source.epoch) &&
    source.epoch > 0 &&
    source.epoch <= 2147483647 &&
    typeof source.position === 'bigint' &&
    source.position > 0n &&
    source.position <= maxNative &&
    /^[0-9a-f]{64}$/.test(reference.sourceDigest) &&
    uuid.test(reference.job.jobId) &&
    typeof reference.job.epoch === 'bigint' &&
    reference.job.epoch > 0n &&
    reference.job.epoch <= maxNative &&
    uuid.test(barrier.accountId) &&
    barrier.accountRoute === routeOf(barrier.accountId) &&
    Number.isSafeInteger(barrier.version) &&
    barrier.version > 0 &&
    barrier.version <= 2147483647 &&
    typeof barrier.at === 'string' &&
    Buffer.byteLength(barrier.at) <= 64 &&
    Number.isFinite(Date.parse(barrier.at)) &&
    ['subject', 'requester', 'decider'].includes(reference.erasedRole)
  );
}
async function currentConsumerClaim(
  tx: CommandTransaction,
  reference: IdentitySourceConsumerReference,
  expected: IdentitySourceConsumerGeneration,
): Promise<ConsumerClaim | null> {
  if (
    !validConsumerReference(reference) ||
    currentCommand(tx).partition !== reference.source.partition ||
    currentCommand(tx).basis !== null ||
    Date.now() >= currentCommandResources(tx).deadline ||
    !expected ||
    ![expected.replayGeneration, expected.undoGeneration, expected.restoreGeneration].every(
      (value) =>
        typeof value === 'string' && /^(0|[1-9][0-9]{0,18})$/.test(value) && BigInt(value) <= 9223372036854775807n,
    )
  )
    return null;
  reference = structuredClone(reference);
  expected = { ...expected };
  const row = (
    await tx.query<ConsumerClaim>(consumerClaim.sql, [
      reference.source.partition,
      identityReceiptKey(reference.receipt),
      reference.sourceDigest,
      reference.job.jobId,
      reference.job.epoch.toString(),
      json(identityReceiptValue(reference.receipt)),
      reference.source.epoch,
      reference.source.position.toString(),
      reference.source.transactionId,
      reference.barrier.accountId,
      reference.barrier.accountRoute,
      reference.barrier.version,
      reference.barrier.at,
      reference.erasedRole,
    ])
  ).rows[0];
  if (
    !row ||
    String(row.generation) !== expected.replayGeneration ||
    row.undo_generation !== expected.undoGeneration ||
    row.restore_generation !== expected.restoreGeneration
  )
    return null;
  const source = await readAccountIdentitySource(tx, reference.receipt, undefined, true);
  if (
    source.partition !== reference.source.partition ||
    source.epoch !== reference.source.epoch ||
    source.position !== reference.source.position ||
    source.transactionId !== reference.source.transactionId ||
    source.digest !== reference.sourceDigest ||
    identityBindingDigest(source.input) !== reference.sourceDigest
  )
    return null;
  return row;
}

/** Only the Source owner can append a terminal row. This hook locks its original
 * binding and checks native generations; immutable undo/replay input still requires
 * genuine Accounts acceptance. No publication or directory fact proves reversal.
 */
export async function lockIdentitySourceConsumerCut(
  tx: CommandTransaction,
  reference: IdentitySourceConsumerReference,
  expected: IdentitySourceConsumerGeneration,
  reversal?: AccountIdentityReversalSettlement,
): Promise<IdentitySourceConsumerDisposition | null> {
  const row = await currentConsumerClaim(tx, reference, expected);
  if (!row || row.terminal_custody !== null) return null;
  // This is a same-home candidate only. Source persists a subject discharge only after
  // verifyIdentitySourceConsumerCut revalidates this exact Accounts receipt in the same tx.
  if (reference.erasedRole === 'subject' && reversal) return 'discharged';
  return 'transferred';
}

export async function verifyIdentitySourceConsumerCut(
  tx: CommandTransaction,
  reference: IdentitySourceConsumerReference,
  expected: IdentitySourceConsumerGeneration,
  disposition: IdentitySourceConsumerDisposition,
  reversal?: AccountIdentityReversalSettlement,
): Promise<boolean> {
  if (disposition === 'discharged') {
    if (reference.erasedRole !== 'subject' || !reversal) return false;
    const account = await import('../../access/agent-verification-identity.ts');
    if (!(await account.verifyAccountIdentityReversalSettlement(tx, reference, reversal))) return false;
  } else if (disposition !== 'transferred' || reference.erasedRole === 'subject') return false;
  const row = await currentConsumerClaim(tx, reference, expected);
  if (!row) return false;
  if (row.terminal_custody === null) return true;
  return (
    (
      await tx.query<{ current: boolean }>(consumerTerminal.sql, [
        reference.source.partition,
        row.terminal_custody,
        row.terminal_sequence,
        json(reference),
        json(expected),
        currentCommand(tx).transactionId,
      ])
    ).rows[0]?.current === true
  );
}

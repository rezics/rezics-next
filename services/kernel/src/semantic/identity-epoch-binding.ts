import { IDENTITY_EPOCH_PROGRESS } from './events.ts';
import { createHash } from 'node:crypto';
import canonicalize from 'canonicalize';
import type { Pool } from 'pg';
import {
  currentCommand,
  IdempotencyConflictError,
  noEffect,
  registerCommandCallback,
  runCommand,
  type CommandTransaction,
} from '../command/command.ts';
import { partitionOf, routeOf, newId } from '../route/route.ts';
import { withReadTransaction } from './read.ts';
import {
  authorizeIdentityAdmission,
  identityReceiptKey,
  identityReceiptValue,
  recordIdentityEpochNativeCommit,
  serializeIdentityValue as json,
  IdentityEpochStoreError,
} from './identity-epoch-store.ts';
import type { IdentityAdmissionAuthority, IdentityAdmissionInput, IdentityJobRef } from './identity-epoch-contract.ts';
import selectClaim from './identity-epoch-binding-select.sql';
import insertClaim from './identity-epoch-binding-insert.sql';
import acceptClaim from './identity-epoch-binding-accept.sql';
import committedJob from './identity-epoch-binding-job.sql';

/** A serializable locator is custody data. Only a released verified read mints an in-process proof. */
export type IdentityReceiptBinding = Readonly<{ partition: number; generation: string; transactionId: string }>;
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
function proof(row: BindingRow): IdentityReceiptBinding {
  if (!row.binding_transaction_id) throw new TypeError('Receipt migration needs native released confirmation');
  const value = Object.freeze({
    partition: row.partition_no,
    generation: String(row.generation),
    transactionId: row.binding_transaction_id,
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
  return value;
}
async function read(tx: CommandTransaction, input: IdentityAdmissionInput) {
  authorizeIdentityAdmission(tx, input.receipt);
  const home = identityReceiptPartition(input.receipt);
  if (currentCommand(tx).partition !== home) throw new TypeError('Receipt lookup requires its native binding home');
  const row = (await tx.query<BindingRow>(selectClaim.sql, [home, identityReceiptKey(input.receipt)])).rows[0];
  if (row && row.intent_digest !== identityBindingDigest(input)) throw new IdempotencyConflictError(home);
  return row;
}
export async function readIdentityBinding(tx: CommandTransaction, input: IdentityAdmissionInput) {
  const row = await read(tx, input);
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
        events: [{ type: IDENTITY_EPOCH_PROGRESS, data: { partition: currentCommand(tx).partition } }],
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
    });
    return {
      value: null,
      events: [{ type: IDENTITY_EPOCH_PROGRESS, data: { partition: currentCommand(tx).partition } }],
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
      events: [{ type: IDENTITY_EPOCH_PROGRESS, data: { partition: currentCommand(tx).partition } }],
    };
  });
}

import { createHash } from 'node:crypto';
import canonicalize from 'canonicalize';
import type { Pool, PoolClient } from 'pg';
import { CommandUnavailableError } from '../access/unavailable.ts';
import {
  currentCommand,
  currentCommandResources,
  DEFAULT_REQUEST_DEADLINE_MS,
  noEffect,
  runCommand,
  type CommandTransaction,
} from '../command/command.ts';
import { partitionOf, routeOf } from '../route/route.ts';
import { deadlineFor, withRequestDeadline } from '../request/deadline.ts';
import { accountAgentId } from './agents.ts';
import {
  identityBindingDigest,
  type IdentityBindingData,
  type IdentityAdmissionSource,
} from './identity-adapters/identity-epoch-binding.ts';
import type {
  IdentityAdmissionInput,
  IdentityIntent,
  IdentityJobRef,
  IdentityNativeReceipt,
  IdentityReceipt,
  IdentityStepProgress,
} from './identity-epoch-contract.ts';
import { identityReceiptKey, serializeIdentityValue } from './identity-adapters/index.ts';
import { withReadTransaction } from './read.ts';
import sourceSql from './account-agent-identity-recovery-source.sql';
import jobSql from './account-agent-identity-recovery-job.sql';
import acksSql from './account-agent-identity-recovery-acks.sql';
import stepSql from './identity-epoch-store-select-step.sql';

export type OriginalAccountAgentIdentitySelection = Readonly<{
  account: string;
  direction: Exclude<IdentityReceipt, { kind: 'subject.merge' }>['kind'];
  receipt: string;
}>;

/** Original accepted claim custody, not an Accounts decision or a recovery command receipt. */
export type OriginalAccountAgentIdentitySource = Readonly<{
  input: IdentityAdmissionInput;
  digest: string;
  native: IdentityNativeReceipt;
  job: IdentityJobRef;
  claim: Pick<IdentityBindingData, 'partition' | 'key' | 'generation' | 'transactionId' | 'home' | 'scope' | 'sources'>;
}>;

export type OriginalAccountAgentIdentity = OriginalAccountAgentIdentitySource &
  Readonly<{
    priorVerification: (OriginalAccountAgentIdentitySource & Readonly<{ verificationReceipt: string }>) | null;
  }>;

type SourceRow = {
  partition_no: number;
  receipt_key: string;
  generation: string;
  intent_digest: string;
  intent: IdentityIntent;
  receipt: IdentityReceipt;
  transaction_id: string;
  job_id: string;
  job_home: number;
  job_epoch: string;
  scope_digest: string;
  sources: IdentityAdmissionSource[];
  native_epoch: number;
  native_position: string;
  owner_node: string;
};
type Candidate = { source: OriginalAccountAgentIdentitySource; signature: string };
type JobRow = {
  intent: IdentityIntent;
  receipt: IdentityReceipt;
  state: string;
  inputs_match: boolean;
  published_epoch: string;
  pending_job: string | null;
};
type AckRow = {
  step: IdentityStepProgress['receipt']['step'];
  version: number;
  scope_digest: string;
  progress: IdentityStepProgress;
  native_partition: number;
  native_epoch: number;
  native_position: string;
  native_transaction_id: string;
};
const steps = ['mapping', 'search-canonical-index', 'library-private-follow-counts'] as const;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const positive = (value: unknown): boolean => /^[1-9][0-9]*$/.test(String(value));
const normalized = (value: unknown): string => canonicalize(JSON.parse(serializeIdentityValue(value)))!;
const fingerprint = (value: unknown): string => createHash('sha256').update(normalized(value)).digest('hex');
const proofs = new WeakMap<
  OriginalAccountAgentIdentity,
  { selection: string; local: string; prior: string | null; deadline: number }
>();
function freeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
function receiptOf(selection: OriginalAccountAgentIdentitySelection) {
  if (
    routeOf(selection.account) === null ||
    !uuid.test(selection.receipt) ||
    !['account-agent.verify', 'account-agent.unverify'].includes(selection.direction)
  )
    return null;
  return { kind: selection.direction, account: selection.account, receipt: selection.receipt };
}
function decode(row: SourceRow, selection: OriginalAccountAgentIdentitySelection): Candidate | null {
  const receipt = receiptOf(selection);
  const intent = row.intent;
  if (
    !receipt ||
    !intent ||
    normalized(row.receipt) !== normalized(receipt) ||
    !/^sha256:[0-9a-f]{64}$/.test(intent.release) ||
    !positive(row.generation) ||
    !positive(row.job_epoch) ||
    !positive(row.native_position) ||
    row.native_epoch <= 0 ||
    row.partition_no !== partitionOf(routeOf(selection.account)!) ||
    row.receipt_key !== identityReceiptKey(receipt) ||
    routeOf(row.job_id) === null ||
    partitionOf(routeOf(row.job_id)!) !== row.job_home ||
    !uuid.test(row.transaction_id) ||
    !/^[0-9a-f]{64}$/.test(row.scope_digest) ||
    !Array.isArray(row.sources) ||
    row.sources.length < 1 ||
    row.sources.length > 2
  )
    return null;
  let nativeIntent: IdentityIntent;
  if (receipt.kind === 'account-agent.verify') {
    if (
      intent.kind !== 'merge' ||
      intent.redirected !== accountAgentId(selection.account) ||
      routeOf(intent.survivor) === null ||
      intent.survivor === intent.redirected ||
      Object.keys(intent).sort().join() !== 'kind,redirected,release,survivor'
    )
      return null;
    nativeIntent = { ...intent };
  } else {
    if (
      intent.kind !== 'unmerge' ||
      intent.original !== accountAgentId(selection.account) ||
      !intent.undoJob ||
      routeOf(intent.undoJob.jobId) === null ||
      !positive(intent.undoJob.epoch) ||
      typeof intent.verificationReceipt !== 'string' ||
      !uuid.test(intent.verificationReceipt) ||
      Object.keys(intent).sort().join() !== 'kind,original,release,undoJob,verificationReceipt' ||
      Object.keys(intent.undoJob).sort().join() !== 'epoch,jobId'
    )
      return null;
    nativeIntent = { ...intent, undoJob: { jobId: intent.undoJob.jobId, epoch: BigInt(intent.undoJob.epoch) } };
  }
  const input = { intent: nativeIntent, receipt };
  if (identityBindingDigest(input) !== row.intent_digest) return null;
  const originals =
    nativeIntent.kind === 'merge' ? [nativeIntent.redirected, nativeIntent.survivor] : [nativeIntent.original];
  if (
    row.sources.length !== originals.length ||
    new Set(row.sources.map((s) => s?.input_original)).size !== originals.length
  )
    return null;
  const sources: IdentityAdmissionSource[] = [];
  for (const s of row.sources) {
    if (
      !s ||
      !originals.includes(s.input_original) ||
      routeOf(s.input_original) !== s.source_route ||
      routeOf(s.terminal) === null ||
      !uuid.test(s.generation) ||
      !uuid.test(s.source_transaction_id) ||
      !Number.isInteger(s.partition_no) ||
      s.partition_no < 0 ||
      s.partition_no > 4095 ||
      !positive(s.version) ||
      !positive(s.observed_count) ||
      BigInt(s.observed_count) > 4096n ||
      !/^(0|[1-9][0-9]*)$/.test(String(s.source_revision)) ||
      !Number.isInteger(s.owner_epoch) ||
      s.owner_epoch <= 0 ||
      !Number.isInteger(s.source_owner_epoch) ||
      s.source_owner_epoch <= 0 ||
      typeof s.ready !== 'boolean' ||
      s.pending_job !== null
    )
      return null;
    // Only the existing closed source fields, never extra group columns or personal payloads.
    sources.push({
      input_original: s.input_original,
      source_route: s.source_route,
      source_revision: s.source_revision,
      source_transaction_id: s.source_transaction_id,
      source_owner_epoch: s.source_owner_epoch,
      partition_no: s.partition_no,
      terminal: s.terminal,
      generation: s.generation,
      version: s.version,
      observed_count: s.observed_count,
      owner_epoch: s.owner_epoch,
      ready: s.ready,
      pending_job: s.pending_job,
    });
  }
  return {
    signature: fingerprint(row),
    source: freeze({
      input,
      digest: row.intent_digest,
      native: {
        partition: row.partition_no,
        epoch: row.native_epoch,
        position: BigInt(row.native_position),
        transactionId: row.transaction_id,
      },
      job: { jobId: row.job_id, epoch: BigInt(row.job_epoch) },
      claim: {
        partition: row.partition_no,
        key: row.receipt_key,
        generation: String(row.generation),
        transactionId: row.transaction_id,
        home: row.job_home,
        scope: row.scope_digest,
        sources,
      },
    }),
  };
}

/** Local indexed evidence only. currentCommand rejects copied, released and foreign-home transactions. */
async function local(
  tx: CommandTransaction,
  selection: OriginalAccountAgentIdentitySelection,
): Promise<Candidate | null> {
  const receipt = receiptOf(selection);
  const command = currentCommand(tx);
  if (!receipt || command.basis !== null || command.partition !== partitionOf(routeOf(selection.account)!)) return null;
  const row = (
    await tx.query<SourceRow>(sourceSql.sql, [command.partition, identityReceiptKey(receipt), selection.account])
  ).rows[0];
  return row ? decode(row, selection) : null;
}
async function released(pool: Pool, selection: OriginalAccountAgentIdentitySelection) {
  const receipt = receiptOf(selection);
  if (!receipt) return null;
  return (
    await runCommand(pool, { partition: partitionOf(routeOf(selection.account)!) }, async (tx) =>
      noEffect(await local(tx, selection)),
    )
  ).value;
}
async function job(tx: PoolClient, source: OriginalAccountAgentIdentitySource) {
  const { claim, input } = source;
  const row = (
    await tx.query<JobRow>(jobSql.sql, [
      claim.home,
      source.job.jobId,
      source.job.epoch.toString(),
      claim.scope,
      serializeIdentityValue(claim.sources),
    ])
  ).rows[0];
  if (
    !row ||
    !row.inputs_match ||
    normalized(row.intent) !== normalized(input.intent) ||
    normalized(row.receipt) !== normalized(input.receipt)
  )
    return null;
  return row;
}
async function accepted(pool: Pool, source: OriginalAccountAgentIdentitySource): Promise<boolean> {
  return withReadTransaction(pool, async (tx) => !!(await job(tx, source)));
}

/** Validate the fixed three reconciled records at their real homes; ACK JSON alone is insufficient. */
async function published(pool: Pool, source: OriginalAccountAgentIdentitySource): Promise<boolean> {
  const capture = () =>
    withReadTransaction(pool, async (tx) => {
      const row = await job(tx, source);
      if (
        !row ||
        row.state !== 'published' ||
        BigInt(row.published_epoch) < source.job.epoch ||
        row.pending_job === source.job.jobId
      )
        return null;
      const acks = (await tx.query<AckRow>(acksSql.sql, [source.claim.home, source.job.jobId])).rows;
      return acks.length === steps.length ? { row, acks } : null;
    });
  const saved = await capture();
  if (!saved) return false;
  for (const step of steps) {
    const ack = saved.acks.find((a) => a.step === step);
    const p = ack?.progress;
    if (
      !ack ||
      !p ||
      ack.version !== 1 ||
      ack.scope_digest !== source.claim.scope ||
      p.state !== 'complete' ||
      normalized(p.job) !== normalized(source.job) ||
      !p.receipt ||
      p.receipt.step !== step ||
      p.receipt.version !== 1 ||
      normalized(p.receipt.job) !== normalized(source.job) ||
      !p.receipt.native ||
      normalized(p.receipt.native) !==
        normalized({
          partition: ack.native_partition,
          epoch: ack.native_epoch,
          position: ack.native_position,
          transactionId: ack.native_transaction_id,
        }) ||
      !p.frontier ||
      !Array.isArray(p.frontier.after) ||
      p.frontier.after.length > 8 ||
      Buffer.byteLength(serializeIdentityValue(p.frontier)) > 2048 ||
      !p.work ||
      Object.values(p.work).some((v) => !Number.isSafeInteger(v) || v < 0) ||
      p.work.rows > 100 ||
      !positive(ack.native_position) ||
      ack.native_epoch <= 0
    )
      return false;
    const valid = await withReadTransaction(pool, async (tx) => {
      // This statement reads one exact component at the participant's own home only.
      const owner = (
        await tx.query<{ valid: boolean }>(
          `SELECT true AS valid FROM core.partition WHERE partition_no=$1 AND epoch=$2 AND position>=$3 AND write_state='active'`,
          [ack.native_partition, ack.native_epoch, ack.native_position],
        )
      ).rows[0];
      if (!owner) return false;
      const native = (
        await tx.query<{ scope_digest: string; state: string; frontier: unknown; work: unknown }>(stepSql.sql, [
          ack.native_partition,
          ack.native_transaction_id,
          ack.native_epoch,
          ack.native_position,
          source.job.jobId,
          source.job.epoch.toString(),
          step,
        ])
      ).rows[0];
      return (
        !!native &&
        native.scope_digest === source.claim.scope &&
        native.state === 'complete' &&
        normalized(native.frontier) === normalized(p.frontier) &&
        normalized(native.work) === normalized(p.work)
      );
    });
    if (!valid) return false;
  }
  const final = await capture();
  return !!final && fingerprint(final) === fingerprint(saved);
}

/** No active account/release lookup, admission, repair write, or recursive Accounts source read. */
export async function readOriginalAccountAgentIdentity(
  pool: Pool,
  selection: OriginalAccountAgentIdentitySelection,
): Promise<OriginalAccountAgentIdentity | null> {
  selection = { ...selection };
  const deadline = deadlineFor(DEFAULT_REQUEST_DEADLINE_MS);
  return withRequestDeadline(deadline, async () => {
    try {
      const original = await released(pool, selection);
      if (!original || !(await accepted(pool, original.source))) return null;
      let prior: Candidate | null = null;
      let priorSelection: OriginalAccountAgentIdentitySelection | null = null;
      const intent = original.source.input.intent;
      if (intent.kind === 'unmerge') {
        priorSelection = {
          account: selection.account,
          direction: 'account-agent.verify',
          receipt: intent.verificationReceipt!,
        };
        prior = await released(pool, priorSelection);
        if (
          !prior ||
          prior.source.input.intent.kind !== 'merge' ||
          prior.source.input.intent.redirected !== intent.original ||
          prior.source.input.intent.release !== intent.release ||
          normalized(prior.source.job) !== normalized(intent.undoJob) ||
          !(await published(pool, prior.source))
        )
          return null;
      }
      // All foreign checkouts have ended. Revalidate both local originals before minting a read result.
      return (
        await runCommand(pool, { partition: original.source.native.partition }, async (tx) => {
          const final = await local(tx, selection);
          if (!final || final.signature !== original.signature) return noEffect(null);
          if (priorSelection && (await local(tx, priorSelection))?.signature !== prior!.signature)
            return noEffect(null);
          const result: OriginalAccountAgentIdentity = freeze({
            ...original.source,
            priorVerification: prior ? { ...prior.source, verificationReceipt: priorSelection!.receipt } : null,
          });
          proofs.set(result, {
            selection: identityReceiptKey(receiptOf(selection)!),
            local: original.signature,
            prior: prior?.signature ?? null,
            deadline,
          });
          return noEffect(result);
        })
      ).value;
    } catch (error) {
      if (error instanceof CommandUnavailableError && ['moved', 'fenced'].includes(error.reason)) return null;
      throw error;
    }
  });
}

/** The association rejects clones; native local revalidation supplies the actual same-tx authority. */
export async function verifyOriginalAccountAgentIdentity(
  tx: CommandTransaction,
  selection: OriginalAccountAgentIdentitySelection,
  result: OriginalAccountAgentIdentity,
): Promise<boolean> {
  const proof = proofs.get(result);
  const receipt = receiptOf(selection);
  if (!proof || !receipt || Date.now() >= proof.deadline || proof.selection !== identityReceiptKey(receipt))
    return false;
  const command = currentCommand(tx);
  if (
    command.basis !== null ||
    command.partition !== result.native.partition ||
    Date.now() >= currentCommandResources(tx).deadline
  )
    return false;
  const current = await local(tx, selection);
  if (!current || current.signature !== proof.local) return false;
  if (result.priorVerification) {
    const prior = await local(tx, {
      account: selection.account,
      direction: 'account-agent.verify',
      receipt: result.priorVerification.verificationReceipt,
    });
    if (!prior || prior.signature !== proof.prior) return false;
  }
  return true;
}

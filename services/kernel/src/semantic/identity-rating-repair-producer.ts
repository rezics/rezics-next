import { createHash } from 'node:crypto';
import { deadlineClient } from '../access/authenticate.ts';
import { requireAccessDeadline } from '../access/unavailable.ts';
import {
  currentCommand,
  currentCommandResources,
  registerCommandCallback,
  type CommandTransaction,
} from '../command/command.ts';
import { newId, partitionOf, routeOf } from '../route/route.ts';
import { classifyIdentityMappings } from './identity-core/index.ts';
import {
  IDENTITY_RATING_REPAIR_MAX_ORIGINALS,
  readIdentityRepairEvidenceInTransaction,
} from './identity-adapters/identity-epoch-read.ts';
import lockOwner from './identity-rating-commit-participant-lock-owner.sql';

export type IdentityRatingRepairVoteKey = Readonly<{ questionId: string; targetId: string }>;
export type IdentityRatingRepairVote = IdentityRatingRepairVoteKey &
  Readonly<{
    units: number | null;
    revision: number;
    countedTargetId: string | null;
    countedRevision: number;
    changedAt: string;
  }>;
export type IdentityRatingRepairPage = Readonly<{
  pageId: string;
  voterId: string;
  workId: string;
  generation: string;
  mode: 'repair' | 'withdrawal';
  after: IdentityRatingRepairVoteKey | null;
  through: IdentityRatingRepairVoteKey | null;
  next: IdentityRatingRepairVoteKey | null;
  terminal: boolean;
  votes: readonly IdentityRatingRepairVote[];
  digest: string;
}>;
export type IdentityRatingRepairMapping = Readonly<{
  originalId: string;
  terminalId: string;
  epoch: string;
}>;
export type IdentityRatingRepairAuthority =
  | Readonly<{ status: 'pending'; reason: string }>
  | Readonly<{ status: 'current'; obligationId: string; mappings: readonly IdentityRatingRepairMapping[] }>;

/** Structurally the Rating identity-repair producer. Rating retains vote/effect/receipt writes. */
export type IdentityRatingRepairProducer = Readonly<{
  hold(tx: CommandTransaction, page: IdentityRatingRepairPage): Promise<IdentityRatingRepairAuthority>;
  complete(
    tx: CommandTransaction,
    input: Readonly<{
      page: IdentityRatingRepairPage;
      obligationId: string;
      mappingDigest: string;
      transactionId: string;
    }>,
  ): Promise<boolean>;
}>;

type Held = Readonly<{
  obligationId: string;
  pageId: string;
  pageDigest: string;
  voterId: string;
  workId: string;
  generation: string;
  mappingDigest: string;
}>;

type ObligationRow = Readonly<{
  obligation_id: string;
  voter_id: string;
  work_id: string;
  generation: string;
  page_digest: string;
  mapping_digest: string;
  state: 'held' | 'bound';
  later_change: boolean;
  receipt_transaction_id: string | null;
}>;

const DIGEST = /^[0-9a-f]{64}$/;
const GENERATION = /^[1-9][0-9]{0,17}$/;
const held = new WeakMap<CommandTransaction, Held>();
const mutated = new WeakSet<CommandTransaction>();

function pending(reason: string): IdentityRatingRepairAuthority {
  return { status: 'pending', reason };
}

function routed(id: string): boolean {
  return routeOf(id) !== null;
}

function keyOf(value: IdentityRatingRepairVoteKey | null): boolean {
  return value === null || (routed(value.questionId) && routed(value.targetId));
}

function identityRatingRepairMappingDigest(mappings: readonly IdentityRatingRepairMapping[]): string {
  return createHash('sha256')
    .update(
      JSON.stringify(
        [...mappings]
          .sort((left, right) => left.originalId.localeCompare(right.originalId))
          .map((mapping) => [mapping.originalId, mapping.terminalId, mapping.epoch]),
      ),
    )
    .digest('hex');
}

function mutate(tx: CommandTransaction) {
  if (mutated.has(tx)) return;
  registerCommandCallback(tx, () => {});
  mutated.add(tx);
}

function originalsOf(page: IdentityRatingRepairPage): string[] | null {
  const originals: string[] = [];
  const seen = new Set<string>();
  for (const vote of page.votes) {
    if (!routed(vote.questionId) || !routed(vote.targetId) || seen.has(vote.targetId)) return null;
    seen.add(vote.targetId);
    originals.push(vote.targetId);
  }
  return originals;
}

function validPage(page: IdentityRatingRepairPage): boolean {
  return (
    routed(page.pageId) &&
    routed(page.voterId) &&
    routed(page.workId) &&
    GENERATION.test(page.generation) &&
    (page.mode === 'repair' || page.mode === 'withdrawal') &&
    DIGEST.test(page.digest) &&
    keyOf(page.after) &&
    keyOf(page.through) &&
    keyOf(page.next) &&
    page.votes.length <= IDENTITY_RATING_REPAIR_MAX_ORIGINALS &&
    (page.terminal ? page.votes.length === 0 : page.votes.length > 0)
  );
}

async function obligation(
  tx: CommandTransaction,
  partition: number,
  obligationId: string,
): Promise<ObligationRow | undefined> {
  return (
    await tx.query<ObligationRow>(
      `SELECT obligation_id,voter_id,work_id,generation,page_digest,mapping_digest,state,later_change,receipt_transaction_id
     FROM semantic.identity_rating_repair_obligation
     WHERE partition_no=$1 AND obligation_id=$2 FOR UPDATE`,
      [partition, obligationId],
    )
  ).rows[0];
}

/**
 * Exact original-to-visible-terminal mappings for a Rating identity-repair page.
 * Same-home voter commands lock core.partition through COMMIT. Foreign source or
 * control homes return pending so a later one-partition prepare/handoff can extend
 * this port; released Pool mapping reads never implement hold.
 */
export function createIdentityRatingRepairProducer(): IdentityRatingRepairProducer {
  return Object.freeze({
    async hold(tx, page) {
      if (!validPage(page) || originalsOf(page) === null) return pending('invalid-repair-page');
      if (page.mode === 'withdrawal') return pending('withdrawal-uses-local-counted-identities');
      const command = currentCommand(tx);
      const { deadline } = currentCommandResources(tx);
      requireAccessDeadline(deadline);
      const voterRoute = routeOf(page.voterId);
      if (voterRoute === null || command.partition !== partitionOf(voterRoute))
        return pending('voter-home-mismatch');
      const originals = originalsOf(page)!;
      const client = deadlineClient(tx, deadline);
      const owner = await lockOwner.run(client, { partition_no: command.partition });
      if (!owner || owner.writeState !== 'active')
        return pending(owner?.writeState === 'moved' ? 'moved-owner' : 'missing-owner');
      const native = await readIdentityRepairEvidenceInTransaction(client, {
        originals,
        commandHome: command.partition,
      });
      if (native.state === 'foreign-home') return pending('semantic-cross-home-repair-hold-required');
      const mappings: IdentityRatingRepairMapping[] = [];
      if (native.state === 'ready') {
        const classified = classifyIdentityMappings(native.requests, native.evidence);
        for (const [index, mapping] of classified.entries()) {
          if (mapping.state === 'pending') return pending('epoch-pending');
          if (mapping.state === 'absent') return pending('source-unavailable');
          if (mapping.state !== 'mapped')
            return pending(mapping.reason === 'moved-owner' ? 'moved-owner' : 'source-unavailable');
          mappings.push(
            Object.freeze({
              originalId: originals[index]!,
              terminalId: mapping.terminal,
              epoch: mapping.epoch.toString(),
            }),
          );
        }
      }
      requireAccessDeadline(deadline);
      const obligationId = newId(voterRoute);
      const mappingDigest = identityRatingRepairMappingDigest(mappings);
      mutate(tx);
      await tx.query(
        `INSERT INTO semantic.identity_rating_repair_obligation
           (partition_no,obligation_id,voter_id,work_id,generation,page_id,page_digest,mapping_digest,mappings,originals,
            through_question_id,through_target_id,owner_node,owner_epoch,state)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10::jsonb,$11,$12,$13,$14,'held')`,
        [
          command.partition,
          obligationId,
          page.voterId,
          page.workId,
          page.generation,
          page.pageId,
          page.digest,
          mappingDigest,
          JSON.stringify(mappings),
          JSON.stringify(originals),
          page.through?.questionId ?? null,
          page.through?.targetId ?? null,
          String(owner.ownerId),
          Number(owner.epoch),
        ],
      );
      const snapshot = Object.freeze({
        obligationId,
        pageId: page.pageId,
        pageDigest: page.digest,
        voterId: page.voterId,
        workId: page.workId,
        generation: page.generation,
        mappingDigest,
      });
      held.set(tx, snapshot);
      return { status: 'current', obligationId, mappings: Object.freeze(mappings) };
    },
    async complete(tx, input) {
      const command = currentCommand(tx);
      if (command.transactionId !== input.transactionId) return false;
      const snapshot = held.get(tx);
      if (
        !snapshot ||
        snapshot.obligationId !== input.obligationId ||
        snapshot.pageId !== input.page.pageId ||
        snapshot.pageDigest !== input.page.digest ||
        snapshot.voterId !== input.page.voterId ||
        snapshot.workId !== input.page.workId ||
        snapshot.generation !== input.page.generation ||
        snapshot.mappingDigest !== input.mappingDigest
      )
        return false;
      const row = await obligation(tx, command.partition, input.obligationId);
      if (!row) return false;
      if (row.later_change) return false;
      if (
        row.voter_id !== input.page.voterId ||
        row.work_id !== input.page.workId ||
        row.generation !== input.page.generation ||
        row.page_digest !== input.page.digest ||
        row.mapping_digest !== input.mappingDigest
      )
        return false;
      if (row.state === 'bound') return row.receipt_transaction_id === input.transactionId;
      mutate(tx);
      const updated = await tx.query(
        `UPDATE semantic.identity_rating_repair_obligation
         SET state='bound', receipt_transaction_id=$3
         WHERE partition_no=$1 AND obligation_id=$2 AND state='held' AND later_change=false AND receipt_transaction_id IS NULL`,
        [command.partition, input.obligationId, input.transactionId],
      );
      return updated.rowCount === 1;
    },
  });
}

export { identityRatingRepairMappingDigest };

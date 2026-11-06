import { createHash } from 'node:crypto';
import type { Pool } from 'pg';
import { deadlineClient } from '../access/authenticate.ts';
import { requireAccessDeadline } from '../access/unavailable.ts';
import {
  currentCommand,
  currentCommandResources,
  registerCommandCallback,
  runCommand,
  type CommandEvent,
  type CommandTransaction,
} from '../command/command.ts';
import { newId, partitionOf, routeOf } from '../route/route.ts';
import { classifyIdentityMappings, type IdentityMapping } from './identity-core/index.ts';
import {
  IDENTITY_RATING_REPAIR_MAX_ORIGINALS,
  readIdentityRepairEvidenceInTransaction,
  type IdentityRepairEvidence,
} from './identity-adapters/identity-epoch-read.ts';
import lockOwner from './identity-rating-commit-participant-lock-owner.sql';
import { IDENTITY_RATING_REPAIR_CONTINUATION } from './events.ts';

export const IDENTITY_RATING_REPAIR_MAX_CONTINUATION = 8;
export { IDENTITY_RATING_REPAIR_CONTINUATION };

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
  | Readonly<{
      status: 'pending';
      reason: string;
      obligationId?: string;
      events?: readonly CommandEvent[];
    }>
  | Readonly<{
      status: 'current';
      obligationId: string;
      mappings: readonly IdentityRatingRepairMapping[];
      extraHomes?: readonly number[];
    }>;

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
  prepare(
    tx: CommandTransaction,
    input: Readonly<{ obligationId: string; voterPartition: number; originals: readonly string[] }>,
  ): Promise<IdentityRatingRepairAuthority>;
  handoff(
    tx: CommandTransaction,
    input: Readonly<{
      obligationId: string;
      home: number;
      originals: readonly string[];
      mappings: readonly IdentityRatingRepairMapping[];
      extraHomes?: readonly number[];
    }>,
  ): Promise<IdentityRatingRepairAuthority>;
  drain(tx: CommandTransaction): Promise<IdentityRatingRepairDrain>;
}>;

export type IdentityRatingRepairDrain = Readonly<{
  drained: number;
  continuing: boolean;
  events: readonly CommandEvent[];
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
  mappings: IdentityRatingRepairMapping[] | string;
  originals: string[] | string;
  prepare_homes: number[] | string;
  state: 'preparing' | 'held' | 'bound';
  later_change: boolean;
  later_vote: boolean;
  receipt_transaction_id: string | null;
}>;

type HandoffRow = Readonly<{
  home: number;
  mappings: IdentityRatingRepairMapping[] | string;
  later_change: boolean;
}>;

type OwnerRow = Readonly<{ ownerId: string; epoch: number | string; writeState: string }>;

const DIGEST = /^[0-9a-f]{64}$/;
const GENERATION = /^[1-9][0-9]{0,17}$/;
const held = new WeakMap<CommandTransaction, Held>();
const mutated = new WeakSet<CommandTransaction>();

function pending(
  reason: string,
  extra: Readonly<{ obligationId?: string; events?: readonly CommandEvent[] }> = {},
): IdentityRatingRepairAuthority {
  return {
    status: 'pending',
    reason,
    ...(extra.obligationId ? { obligationId: extra.obligationId } : {}),
    ...(extra.events && extra.events.length ? { events: extra.events } : {}),
  };
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

function jsonArray<T>(value: T[] | string): T[] {
  return typeof value === 'string' ? (JSON.parse(value) as T[]) : value;
}

function uniqueHomes(homes: readonly number[]): number[] {
  return [...new Set(homes.filter((home) => Number.isInteger(home) && home >= 0 && home <= 4095))].sort(
    (left, right) => left - right,
  );
}

function continuation(
  partition: number,
  voterPartition: number,
  obligationId: string,
  kind: 'prepare' | 'drain',
  originals: readonly string[] = [],
): CommandEvent {
  return {
    type: IDENTITY_RATING_REPAIR_CONTINUATION,
    data: {
      partition,
      voterPartition,
      obligationId,
      kind,
      originals: originals.slice(0, IDENTITY_RATING_REPAIR_MAX_ORIGINALS),
    },
  };
}

function mappingsFrom(
  originals: readonly string[],
  classified: readonly IdentityMapping[],
): IdentityRatingRepairMapping[] | { pending: string } {
  const mappings: IdentityRatingRepairMapping[] = [];
  for (const [index, mapping] of classified.entries()) {
    if (mapping.state === 'pending') return { pending: 'epoch-pending' };
    if (mapping.state === 'absent') return { pending: 'source-unavailable' };
    if (mapping.state !== 'mapped')
      return { pending: mapping.reason === 'moved-owner' ? 'moved-owner' : 'source-unavailable' };
    mappings.push(
      Object.freeze({
        originalId: originals[index]!,
        terminalId: mapping.terminal,
        epoch: mapping.epoch.toString(),
      }),
    );
  }
  return mappings;
}

type ReadyEvidence =
  | Extract<IdentityRepairEvidence, { state: 'ready' }>
  | NonNullable<Extract<IdentityRepairEvidence, { state: 'split' }>['local']>;

function classifyReady(native: ReadyEvidence): IdentityRatingRepairMapping[] | { pending: string } {
  const originals = native.requests.map((request) => request.original);
  return mappingsFrom(originals, classifyIdentityMappings(native.requests, native.evidence));
}

async function lockPartition(
  tx: CommandTransaction,
  partition: number,
  deadline: number,
): Promise<OwnerRow | undefined> {
  requireAccessDeadline(deadline);
  return (await lockOwner.run(deadlineClient(tx, deadline), { partition_no: partition })) ?? undefined;
}

async function obligationByPage(
  tx: CommandTransaction,
  partition: number,
  voterId: string,
  pageId: string,
): Promise<ObligationRow | undefined> {
  return (
    await tx.query<ObligationRow>(
      `SELECT obligation_id,voter_id,work_id,generation,page_digest,mapping_digest,mappings,originals,prepare_homes,state,
              later_change,later_vote,receipt_transaction_id
         FROM semantic.identity_rating_repair_obligation
        WHERE partition_no=$1 AND voter_id=$2 AND page_id=$3 FOR UPDATE`,
      [partition, voterId, pageId],
    )
  ).rows[0];
}

async function obligationById(
  tx: CommandTransaction,
  partition: number,
  obligationId: string,
): Promise<ObligationRow | undefined> {
  return (
    await tx.query<ObligationRow>(
      `SELECT obligation_id,voter_id,work_id,generation,page_digest,mapping_digest,mappings,originals,prepare_homes,state,
              later_change,later_vote,receipt_transaction_id
         FROM semantic.identity_rating_repair_obligation
        WHERE partition_no=$1 AND obligation_id=$2 FOR UPDATE`,
      [partition, obligationId],
    )
  ).rows[0];
}

async function handoffsOf(tx: CommandTransaction, partition: number, obligationId: string): Promise<HandoffRow[]> {
  return (
    await tx.query<HandoffRow>(
      `SELECT home, mappings, later_change
         FROM semantic.identity_rating_repair_handoff
        WHERE partition_no=$1 AND obligation_id=$2
        ORDER BY home`,
      [partition, obligationId],
    )
  ).rows;
}

function remember(
  tx: CommandTransaction,
  page: IdentityRatingRepairPage,
  obligationId: string,
  mappingDigest: string,
): Held {
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
  return snapshot;
}

function currentOf(
  obligationId: string,
  mappings: readonly IdentityRatingRepairMapping[],
  extraHomes?: readonly number[],
): IdentityRatingRepairAuthority {
  return {
    status: 'current',
    obligationId,
    mappings: Object.freeze([...mappings]),
    ...(extraHomes && extraHomes.length ? { extraHomes: Object.freeze([...extraHomes]) } : {}),
  };
}

function prepareEvents(
  voterPartition: number,
  obligationId: string,
  homes: readonly number[],
  originalsByHome: ReadonlyMap<number, readonly string[]>,
): CommandEvent[] {
  return homes
    .slice(0, IDENTITY_RATING_REPAIR_MAX_CONTINUATION)
    .map((home) => continuation(home, voterPartition, obligationId, 'prepare', originalsByHome.get(home) ?? []));
}

function originalsByHomeOf(originals: readonly string[]): Map<number, string[]> {
  const grouped = new Map<number, string[]>();
  for (const original of originals) {
    const route = routeOf(original);
    if (route === null) continue;
    const home = partitionOf(route);
    const bucket = grouped.get(home) ?? [];
    bucket.push(original);
    grouped.set(home, bucket);
  }
  return grouped;
}

async function holdExisting(
  tx: CommandTransaction,
  page: IdentityRatingRepairPage,
  commandPartition: number,
  row: ObligationRow,
  grouped: ReadonlyMap<number, readonly string[]>,
): Promise<IdentityRatingRepairAuthority> {
  if (
    row.voter_id !== page.voterId ||
    row.work_id !== page.workId ||
    row.generation !== page.generation ||
    row.page_digest !== page.digest
  )
    return pending('stale-repair-page');
  if (row.later_vote) return pending('identity-repair-later-vote', { obligationId: row.obligation_id });
  if (row.later_change) return pending('identity-repair-later-change', { obligationId: row.obligation_id });
  if (row.state === 'preparing') {
    const received = await handoffsOf(tx, commandPartition, row.obligation_id);
    if (received.some((entry) => entry.later_change))
      return pending('identity-repair-later-change', { obligationId: row.obligation_id });
    const homes = uniqueHomes(jsonArray<number>(row.prepare_homes));
    const have = new Set(received.map((entry) => entry.home));
    const missing = homes.filter((home) => !have.has(home));
    if (missing.length) {
      mutate(tx);
      return pending('semantic-cross-home-repair-preparing', {
        obligationId: row.obligation_id,
        events: prepareEvents(commandPartition, row.obligation_id, missing, grouped),
      });
    }
    const mappings = received.flatMap((entry) => jsonArray<IdentityRatingRepairMapping>(entry.mappings));
    const mappingDigest = identityRatingRepairMappingDigest(mappings);
    mutate(tx);
    await tx.query(
      `UPDATE semantic.identity_rating_repair_obligation
          SET state='held', mapping_digest=$3, mappings=$4::jsonb
        WHERE partition_no=$1 AND obligation_id=$2 AND state='preparing'`,
      [commandPartition, row.obligation_id, mappingDigest, JSON.stringify(mappings)],
    );
    remember(tx, page, row.obligation_id, mappingDigest);
    return currentOf(row.obligation_id, mappings);
  }
  const mappings = jsonArray<IdentityRatingRepairMapping>(row.mappings);
  remember(tx, page, row.obligation_id, row.mapping_digest);
  return currentOf(row.obligation_id, mappings);
}

/**
 * Exact original-to-visible-terminal mappings for a Rating identity-repair page.
 * Same-home voter commands lock core.partition through COMMIT. Foreign source or
 * control homes persist a preparing obligation and one-partition prepare/handoff
 * receipts; later mapping and vote writes drain through bounded owner commands.
 */
export function createIdentityRatingRepairProducer(): IdentityRatingRepairProducer {
  return Object.freeze({
    async hold(tx, page) {
      if (!validPage(page) || originalsOf(page) === null) return pending('invalid-repair-page');
      if (page.mode === 'withdrawal') return pending('withdrawal-uses-local-counted-identities');
      const command = currentCommand(tx);
      const { deadline } = currentCommandResources(tx);
      const voterRoute = routeOf(page.voterId);
      if (voterRoute === null || command.partition !== partitionOf(voterRoute)) return pending('voter-home-mismatch');
      const originals = originalsOf(page)!;
      const owner = await lockPartition(tx, command.partition, deadline);
      if (!owner || owner.writeState !== 'active')
        return pending(owner?.writeState === 'moved' ? 'moved-owner' : 'missing-owner');
      const grouped = originalsByHomeOf(originals);
      const existing = await obligationByPage(tx, command.partition, page.voterId, page.pageId);
      if (existing) return holdExisting(tx, page, command.partition, existing, grouped);
      const client = deadlineClient(tx, deadline);
      const native = await readIdentityRepairEvidenceInTransaction(client, {
        originals,
        commandHome: command.partition,
      });
      if (native.state === 'split') {
        if (native.local) {
          const local = classifyReady(native.local);
          if ('pending' in local) return pending(local.pending);
        }
        const obligationId = newId(voterRoute);
        const homes = uniqueHomes(native.foreignHomes);
        mutate(tx);
        await tx.query(
          `INSERT INTO semantic.identity_rating_repair_obligation
             (partition_no,obligation_id,voter_id,work_id,generation,page_id,page_digest,mapping_digest,mappings,originals,
              through_question_id,through_target_id,prepare_homes,owner_node,owner_epoch,state)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10::jsonb,$11,$12,$13::jsonb,$14,$15,'preparing')`,
          [
            command.partition,
            obligationId,
            page.voterId,
            page.workId,
            page.generation,
            page.pageId,
            page.digest,
            identityRatingRepairMappingDigest([]),
            JSON.stringify([]),
            JSON.stringify(originals),
            page.through?.questionId ?? null,
            page.through?.targetId ?? null,
            JSON.stringify(homes),
            String(owner.ownerId),
            Number(owner.epoch),
          ],
        );
        if (homes.length > IDENTITY_RATING_REPAIR_MAX_CONTINUATION)
          await tx.query(
            `INSERT INTO semantic.identity_rating_repair_drain_head(partition_no, overflow)
             VALUES ($1, true)
             ON CONFLICT (partition_no) DO UPDATE SET overflow = true`,
            [command.partition],
          );
        return pending('semantic-cross-home-repair-preparing', {
          obligationId,
          events: prepareEvents(command.partition, obligationId, homes, grouped),
        });
      }
      const mappings: IdentityRatingRepairMapping[] = [];
      if (native.state === 'ready') {
        const classified = classifyReady(native);
        if ('pending' in classified) return pending(classified.pending);
        mappings.push(...classified);
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
      remember(tx, page, obligationId, mappingDigest);
      return currentOf(obligationId, mappings);
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
      const row = await obligationById(tx, command.partition, input.obligationId);
      if (!row || row.later_change || row.later_vote) return false;
      if (
        row.voter_id !== input.page.voterId ||
        row.work_id !== input.page.workId ||
        row.generation !== input.page.generation ||
        row.page_digest !== input.page.digest ||
        row.mapping_digest !== input.mappingDigest
      )
        return false;
      if (row.state === 'bound') return row.receipt_transaction_id === input.transactionId;
      if (row.state !== 'held') return false;
      mutate(tx);
      const updated = await tx.query(
        `UPDATE semantic.identity_rating_repair_obligation
         SET state='bound', receipt_transaction_id=$3
         WHERE partition_no=$1 AND obligation_id=$2 AND state='held' AND later_change=false AND later_vote=false
           AND receipt_transaction_id IS NULL`,
        [command.partition, input.obligationId, input.transactionId],
      );
      return updated.rowCount === 1;
    },
    async prepare(tx, input) {
      const originals = [...input.originals];
      if (!originals.length || originals.length > IDENTITY_RATING_REPAIR_MAX_ORIGINALS || !originals.every(routed))
        return pending('invalid-repair-page');
      const command = currentCommand(tx);
      const { deadline } = currentCommandResources(tx);
      if (originals.some((original) => partitionOf(routeOf(original)!) !== command.partition))
        return pending('semantic-cross-home-repair-hold-required');
      const owner = await lockPartition(tx, command.partition, deadline);
      if (!owner || owner.writeState !== 'active')
        return pending(owner?.writeState === 'moved' ? 'moved-owner' : 'missing-owner');
      const native = await readIdentityRepairEvidenceInTransaction(deadlineClient(tx, deadline), {
        originals,
        commandHome: command.partition,
      });
      const extraHomes = native.state === 'split' ? uniqueHomes(native.foreignHomes) : [];
      let mappings: IdentityRatingRepairMapping[] = [];
      if (native.state === 'ready') {
        const classified = classifyReady(native);
        if ('pending' in classified) return pending(classified.pending);
        mappings = classified;
      } else if (native.state === 'split' && native.local) {
        const classified = classifyReady(native.local);
        if ('pending' in classified) return pending(classified.pending);
        mappings = classified;
      } else if (native.state === 'split' && extraHomes.length === 0) {
        return pending('source-unavailable');
      }
      const prepareId = newId(routeOf(originals[0]!)!);
      mutate(tx);
      await tx.query(
        `INSERT INTO semantic.identity_rating_repair_prepare
           (partition_no,prepare_id,voter_partition,obligation_id,originals,mappings,extra_homes,owner_node,owner_epoch,receipt_transaction_id)
         VALUES ($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7::jsonb,$8,$9,$10)
         ON CONFLICT (partition_no, obligation_id) DO UPDATE
           SET mappings=EXCLUDED.mappings, extra_homes=EXCLUDED.extra_homes, later_change=false,
               receipt_transaction_id=EXCLUDED.receipt_transaction_id`,
        [
          command.partition,
          prepareId,
          input.voterPartition,
          input.obligationId,
          JSON.stringify(originals),
          JSON.stringify(mappings),
          JSON.stringify(extraHomes),
          String(owner.ownerId),
          Number(owner.epoch),
          command.transactionId,
        ],
      );
      return currentOf(input.obligationId, mappings, extraHomes);
    },
    async handoff(tx, input) {
      const command = currentCommand(tx);
      const { deadline } = currentCommandResources(tx);
      const owner = await lockPartition(tx, command.partition, deadline);
      if (!owner || owner.writeState !== 'active')
        return pending(owner?.writeState === 'moved' ? 'moved-owner' : 'missing-owner');
      const row = await obligationById(tx, command.partition, input.obligationId);
      if (!row || row.state === 'bound') return pending('stale-repair-page', { obligationId: input.obligationId });
      mutate(tx);
      await tx.query(
        `INSERT INTO semantic.identity_rating_repair_handoff
           (partition_no,obligation_id,home,originals,mappings,receipt_transaction_id)
         VALUES ($1,$2,$3,$4::jsonb,$5::jsonb,$6)
         ON CONFLICT (partition_no, obligation_id, home) DO UPDATE
           SET originals=EXCLUDED.originals, mappings=EXCLUDED.mappings, later_change=false,
               receipt_transaction_id=EXCLUDED.receipt_transaction_id`,
        [
          command.partition,
          input.obligationId,
          input.home,
          JSON.stringify(input.originals),
          JSON.stringify(input.mappings),
          command.transactionId,
        ],
      );
      const extra = uniqueHomes(input.extraHomes ?? []);
      const homes = uniqueHomes([...jsonArray<number>(row.prepare_homes), ...extra]);
      if (extra.length)
        await tx.query(
          `UPDATE semantic.identity_rating_repair_obligation SET prepare_homes=$3::jsonb
            WHERE partition_no=$1 AND obligation_id=$2`,
          [command.partition, input.obligationId, JSON.stringify(homes)],
        );
      const received = await handoffsOf(tx, command.partition, input.obligationId);
      const have = new Set(received.map((entry) => entry.home));
      const missing = homes.filter((home) => !have.has(home));
      const grouped = originalsByHomeOf(jsonArray<string>(row.originals));
      return pending('semantic-cross-home-repair-preparing', {
        obligationId: input.obligationId,
        events: missing.length ? prepareEvents(command.partition, input.obligationId, missing, grouped) : [],
      });
    },
    async drain(tx) {
      const command = currentCommand(tx);
      const { deadline } = currentCommandResources(tx);
      const owner = await lockPartition(tx, command.partition, deadline);
      if (!owner || owner.writeState !== 'active') return { drained: 0, continuing: false, events: [] };
      mutate(tx);
      const overflow = (
        await tx.query<{ overflow: boolean; overflow_original: string | null }>(
          `SELECT overflow, overflow_original FROM semantic.identity_rating_repair_drain_head
            WHERE partition_no=$1 FOR UPDATE`,
          [command.partition],
        )
      ).rows[0];
      let drained = 0;
      if (overflow?.overflow && overflow.overflow_original) {
        const marked = await tx.query(
          `WITH picked AS (
             SELECT obligation_id FROM semantic.identity_rating_repair_obligation
              WHERE partition_no=$1 AND later_change=false AND state IN ('preparing','held','bound')
                AND originals ? $2::text
              ORDER BY obligation_id LIMIT 64
           )
           UPDATE semantic.identity_rating_repair_obligation o
              SET later_change=true
             FROM picked
            WHERE o.partition_no=$1 AND o.obligation_id=picked.obligation_id`,
          [command.partition, overflow.overflow_original],
        );
        drained += marked.rowCount ?? 0;
        await tx.query(
          `UPDATE semantic.identity_rating_repair_drain_head SET overflow=$2
            WHERE partition_no=$1`,
          [command.partition, (marked.rowCount ?? 0) === 64],
        );
      }
      const votes = await tx.query(
        `WITH picked AS (
           SELECT obligation_id FROM semantic.identity_rating_repair_obligation o
            WHERE partition_no=$1 AND later_vote=false AND state IN ('preparing','held','bound')
              AND EXISTS (
                SELECT 1 FROM rating.vote v
                 WHERE v.route = ((get_byte(uuid_send(o.voter_id), 10) * 256) + get_byte(uuid_send(o.voter_id), 11))
                   AND v.voter_id = o.voter_id
                   AND (
                     o.through_question_id IS NULL
                     OR (v.question_id, v.target_id) > (o.through_question_id, o.through_target_id)
                   )
              )
            ORDER BY obligation_id LIMIT 64
         )
         UPDATE semantic.identity_rating_repair_obligation o
            SET later_vote=true
           FROM picked
          WHERE o.partition_no=$1 AND o.obligation_id=picked.obligation_id`,
        [command.partition],
      );
      drained += votes.rowCount ?? 0;
      const receipts = await tx.query(
        `WITH picked AS (
           SELECT obligation_id FROM semantic.identity_rating_repair_obligation
            WHERE partition_no=$1 AND drain_receipt_id IS NULL AND (later_change OR later_vote)
            ORDER BY obligation_id LIMIT 64
         )
         UPDATE semantic.identity_rating_repair_obligation o
            SET drain_receipt_id=$2
           FROM picked
          WHERE o.partition_no=$1 AND o.obligation_id=picked.obligation_id`,
        [command.partition, command.transactionId],
      );
      drained += receipts.rowCount ?? 0;
      const remaining = (
        await tx.query<{ n: number }>(
          `SELECT count(*)::int AS n FROM (
             SELECT 1 FROM semantic.identity_rating_repair_obligation
              WHERE partition_no=$1 AND drain_receipt_id IS NULL AND (later_change OR later_vote)
              LIMIT 1
           ) leftover`,
          [command.partition],
        )
      ).rows[0]?.n;
      const preparing = (
        await tx.query<{ obligation_id: string; prepare_homes: number[] | string; originals: string[] | string }>(
          `SELECT obligation_id, prepare_homes, originals
             FROM semantic.identity_rating_repair_obligation
            WHERE partition_no=$1 AND state='preparing'
            ORDER BY obligation_id LIMIT $2`,
          [command.partition, IDENTITY_RATING_REPAIR_MAX_CONTINUATION],
        )
      ).rows;
      const events: CommandEvent[] = [];
      for (const row of preparing) {
        const grouped = originalsByHomeOf(jsonArray<string>(row.originals));
        const received = await handoffsOf(tx, command.partition, row.obligation_id);
        const have = new Set(received.map((entry) => entry.home));
        const missing = uniqueHomes(jsonArray<number>(row.prepare_homes)).filter((home) => !have.has(home));
        events.push(...prepareEvents(command.partition, row.obligation_id, missing, grouped));
      }
      if (remaining) events.push(continuation(command.partition, command.partition, command.transactionId, 'drain'));
      return {
        drained,
        continuing: Boolean(remaining) || events.length > 0,
        events: Object.freeze(events.slice(0, IDENTITY_RATING_REPAIR_MAX_CONTINUATION)),
      };
    },
  });
}

export async function continueIdentityRatingRepair(
  pool: Pool,
  data: Readonly<{
    partition: number;
    voterPartition: number;
    obligationId: string;
    kind: 'prepare' | 'drain';
    originals: readonly string[];
  }>,
): Promise<void> {
  const producer = createIdentityRatingRepairProducer();
  if (data.kind === 'drain') {
    await runCommand(pool, { partition: data.partition }, async (tx) => {
      const drained = await producer.drain(tx);
      return { value: drained, events: drained.events };
    });
    return;
  }
  const prepared = await runCommand(pool, { partition: data.partition }, async (tx) => {
    const authority = await producer.prepare(tx, {
      obligationId: data.obligationId,
      voterPartition: data.voterPartition,
      originals: data.originals,
    });
    return {
      value: authority,
      events: [
        continuation(data.partition, data.voterPartition, data.obligationId, 'drain'),
        ...(authority.status === 'pending' ? (authority.events ?? []) : []),
      ],
    };
  });
  const current = prepared.value;
  if (current.status !== 'current') return;
  await runCommand(pool, { partition: data.voterPartition }, async (tx) => {
    const handed = await producer.handoff(tx, {
      obligationId: data.obligationId,
      home: data.partition,
      originals: data.originals,
      mappings: current.mappings,
      ...(current.extraHomes ? { extraHomes: current.extraHomes } : {}),
    });
    return {
      value: handed,
      events: [
        continuation(data.voterPartition, data.voterPartition, data.obligationId, 'drain'),
        ...(handed.status === 'pending' ? (handed.events ?? []) : []),
      ],
    };
  });
}

export { identityRatingRepairMappingDigest };

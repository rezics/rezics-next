import type { Pool } from 'pg';
import { partitionOf, routeOf } from '../route/route.ts';
import { identityRoute, type IdentityVoteKey } from './identity-work-frame.ts';
import type { RatingRepairReceipt } from './identity-repair.ts';
import readVotes from './identity-repair-read-votes.sql';
import readEffects from './identity-repair-read-effects.sql';
import readReceipts from './identity-repair-read-receipts.sql';
import readCheckpoint from './identity-repair-read-checkpoint.sql';
import readObligations from './identity-repair-read-obligations.sql';

export type IdentityRepairCountedVote = Readonly<{
  questionId: string;
  targetId: string;
  countedTargetId: string | null;
  units: number | null;
  revision: number;
  countedRevision: number;
  changedAt: string;
  transactionId: string;
}>;

export type IdentityRepairVoteChangeEffect = Readonly<{
  voterId: string;
  questionId: string;
  targetId: string;
  aggregateTargetId?: string;
  previous: number | null;
  units: number | null;
  revision: number;
  populations: readonly string[];
}>;

export type IdentityRepairPageEffect = Readonly<{
  voterId: string;
  workId: string;
  generation: string;
  pageId: string;
  digest: string;
  terminal: boolean;
  mode: 'repair' | 'withdrawal';
}>;

export type IdentityRepairWorkEffect = Readonly<{
  voterId: string;
  workId: string;
  generation: string;
  action: 'admit' | 'select' | 'cancel' | 'invalidate';
}>;

export type IdentityRepairOutboxEffect = Readonly<{
  position: string;
  eventSeq: string;
  id: string;
  type: string;
  subject: string;
  time: string;
  data: IdentityRepairVoteChangeEffect | IdentityRepairPageEffect | IdentityRepairWorkEffect | Record<string, unknown>;
}>;

export type IdentityRepairCheckpoint = Readonly<{
  generation: string;
  workId: string;
  state: 'active' | 'complete' | 'cancelled';
  mode: 'repair' | 'withdrawal';
  cursor: IdentityVoteKey | null;
  through: IdentityVoteKey | null;
  selectedPageId: string | null;
}>;

export type IdentityRepairObligationRecord = Readonly<{
  obligationId: string;
  workId: string;
  generation: string;
  pageId: string;
  pageDigest: string;
  mappingDigest: string;
  mappings: readonly Readonly<{ originalId: string; terminalId: string; epoch: string }>[];
  originals: readonly string[];
  throughQuestionId: string | null;
  throughTargetId: string | null;
  state: 'preparing' | 'held' | 'bound';
  laterChange: boolean;
  laterVote: boolean;
  receiptTransactionId: string | null;
  drainReceiptId: string | null;
}>;

export type IdentityRepairRead = Readonly<{
  countedVotes(voterId: string): Promise<readonly IdentityRepairCountedVote[]>;
  orderedEffects(voterId: string): Promise<readonly IdentityRepairOutboxEffect[]>;
  voteEffects(voterId: string): Promise<readonly IdentityRepairVoteChangeEffect[]>;
  pageEffects(voterId: string): Promise<readonly IdentityRepairPageEffect[]>;
  receipts(voterId: string): Promise<readonly RatingRepairReceipt[]>;
  receipt(voterId: string, pageId: string): Promise<RatingRepairReceipt | null>;
  checkpoint(voterId: string): Promise<IdentityRepairCheckpoint | null>;
  obligations(voterId: string): Promise<readonly IdentityRepairObligationRecord[]>;
  boundObligation(voterId: string, pageId: string): Promise<IdentityRepairObligationRecord | null>;
}>;

type VoteRow = {
  questionId: string;
  targetId: string;
  countedTargetId: string | null;
  units: string | number | null;
  revision: string | number;
  countedRevision: string | number;
  changedAt: string;
  transactionId: string;
};

type EffectRow = {
  position: string;
  eventSeq: string;
  id: string;
  type: string;
  subject: string;
  time: string;
  data: Record<string, unknown>;
};

type ReceiptRow = {
  pageId: string;
  workId: string;
  generation: string;
  digest: string;
  transactionId: string;
  checkpoint: IdentityVoteKey | null;
  terminal: boolean;
  mode: RatingRepairReceipt['mode'];
  obligationId: string | null;
  mappingDigest: string | null;
};

type CheckpointRow = {
  generation: string;
  workId: string;
  state: IdentityRepairCheckpoint['state'];
  mode: IdentityRepairCheckpoint['mode'];
  cursor: IdentityVoteKey | null;
  through: IdentityVoteKey | null;
  selectedPageId: string | null;
};

type ObligationRow = {
  obligationId: string;
  workId: string;
  generation: string;
  pageId: string;
  pageDigest: string;
  mappingDigest: string;
  mappings: IdentityRepairObligationRecord['mappings'] | string;
  originals: readonly string[] | string;
  throughQuestionId: string | null;
  throughTargetId: string | null;
  state: IdentityRepairObligationRecord['state'];
  laterChange: boolean;
  laterVote: boolean;
  receiptTransactionId: string | null;
  drainReceiptId: string | null;
};

function jsonArray<T>(value: T[] | readonly T[] | string): T[] {
  return typeof value === 'string' ? (JSON.parse(value) as T[]) : [...value];
}

function keyOf(value: IdentityVoteKey | null): IdentityVoteKey | null {
  if (value === null) return null;
  return Object.freeze({ questionId: value.questionId, targetId: value.targetId });
}

function numberOf(value: string | number | null): number | null {
  if (value === null) return null;
  return Number(value);
}

function voteChange(data: Record<string, unknown>): IdentityRepairVoteChangeEffect {
  return Object.freeze({
    voterId: String(data.voterId),
    questionId: String(data.questionId),
    targetId: String(data.targetId),
    ...(typeof data.aggregateTargetId === 'string' ? { aggregateTargetId: data.aggregateTargetId } : {}),
    previous: data.previous === null || data.previous === undefined ? null : Number(data.previous),
    units: data.units === null || data.units === undefined ? null : Number(data.units),
    revision: Number(data.revision),
    populations: Array.isArray(data.populations) ? Object.freeze(data.populations.map(String)) : Object.freeze([]),
  });
}

function pageEffect(data: Record<string, unknown>): IdentityRepairPageEffect {
  return Object.freeze({
    voterId: String(data.voterId),
    workId: String(data.workId),
    generation: String(data.generation),
    pageId: String(data.pageId),
    digest: String(data.digest),
    terminal: Boolean(data.terminal),
    mode: data.mode === 'withdrawal' ? 'withdrawal' : 'repair',
  });
}

function workEffect(data: Record<string, unknown>): IdentityRepairWorkEffect {
  const action = data.action;
  return Object.freeze({
    voterId: String(data.voterId),
    workId: String(data.workId),
    generation: String(data.generation),
    action:
      action === 'select' || action === 'cancel' || action === 'invalidate' || action === 'admit' ? action : 'admit',
  });
}

function effectData(type: string, data: Record<string, unknown>): IdentityRepairOutboxEffect['data'] {
  if (type === 'com.rezics.rating.vote.changed.v1') return voteChange(data);
  if (type === 'com.rezics.rating.identity-repair.page.v1') return pageEffect(data);
  if (type === 'com.rezics.rating.identity-work.changed.v1') return workEffect(data);
  return data;
}

function receiptOf(row: ReceiptRow): RatingRepairReceipt {
  return Object.freeze({
    pageId: row.pageId,
    workId: row.workId,
    generation: row.generation,
    digest: row.digest,
    transactionId: row.transactionId,
    checkpoint: keyOf(row.checkpoint),
    terminal: row.terminal,
    mode: row.mode,
    obligationId: row.obligationId,
    mappingDigest: row.mappingDigest,
  });
}

function obligationOf(row: ObligationRow): IdentityRepairObligationRecord {
  return Object.freeze({
    obligationId: row.obligationId,
    workId: row.workId,
    generation: row.generation,
    pageId: row.pageId,
    pageDigest: row.pageDigest,
    mappingDigest: row.mappingDigest,
    mappings: Object.freeze(
      jsonArray(row.mappings).map((mapping) =>
        Object.freeze({
          originalId: mapping.originalId,
          terminalId: mapping.terminalId,
          epoch: String(mapping.epoch),
        }),
      ),
    ),
    originals: Object.freeze(jsonArray(row.originals).map(String)),
    throughQuestionId: row.throughQuestionId,
    throughTargetId: row.throughTargetId,
    state: row.state,
    laterChange: row.laterChange,
    laterVote: row.laterVote,
    receiptTransactionId: row.receiptTransactionId,
    drainReceiptId: row.drainReceiptId,
  });
}

/** Released Pool observations of Rating identity-repair pages. They never hold mappings. */
export function createIdentityRepairRead(pool: Pool): IdentityRepairRead {
  async function countedVotes(voterId: string): Promise<readonly IdentityRepairCountedVote[]> {
    const route = identityRoute(voterId);
    const rows = (await pool.query<VoteRow>(readVotes.sql, [route, voterId])).rows;
    return Object.freeze(
      rows.map((row) =>
        Object.freeze({
          questionId: row.questionId,
          targetId: row.targetId,
          countedTargetId: row.countedTargetId,
          units: numberOf(row.units),
          revision: Number(row.revision),
          countedRevision: Number(row.countedRevision),
          changedAt: row.changedAt,
          transactionId: row.transactionId,
        }),
      ),
    );
  }

  async function orderedEffects(voterId: string): Promise<readonly IdentityRepairOutboxEffect[]> {
    identityRoute(voterId);
    const rows = (await pool.query<EffectRow>(readEffects.sql, [voterId])).rows;
    return Object.freeze(
      rows.map((row) =>
        Object.freeze({
          position: row.position,
          eventSeq: row.eventSeq,
          id: row.id,
          type: row.type,
          subject: row.subject,
          time: row.time,
          data: effectData(row.type, row.data),
        }),
      ),
    );
  }

  async function voteEffects(voterId: string): Promise<readonly IdentityRepairVoteChangeEffect[]> {
    return Object.freeze(
      (await orderedEffects(voterId))
        .filter((effect) => effect.type === 'com.rezics.rating.vote.changed.v1')
        .map((effect) => effect.data as IdentityRepairVoteChangeEffect),
    );
  }

  async function pageEffects(voterId: string): Promise<readonly IdentityRepairPageEffect[]> {
    return Object.freeze(
      (await orderedEffects(voterId))
        .filter((effect) => effect.type === 'com.rezics.rating.identity-repair.page.v1')
        .map((effect) => effect.data as IdentityRepairPageEffect),
    );
  }

  async function receipts(voterId: string): Promise<readonly RatingRepairReceipt[]> {
    const route = identityRoute(voterId);
    const rows = (await pool.query<ReceiptRow>(readReceipts.sql, [route, voterId])).rows;
    return Object.freeze(rows.map(receiptOf));
  }

  async function receipt(voterId: string, pageId: string): Promise<RatingRepairReceipt | null> {
    if (routeOf(pageId) === null) throw new TypeError('Invalid Rating identity page');
    return (await receipts(voterId)).find((row) => row.pageId === pageId) ?? null;
  }

  async function checkpoint(voterId: string): Promise<IdentityRepairCheckpoint | null> {
    const route = identityRoute(voterId);
    const row = (await pool.query<CheckpointRow>(readCheckpoint.sql, [route, voterId])).rows[0];
    if (!row) return null;
    return Object.freeze({
      generation: row.generation,
      workId: row.workId,
      state: row.state,
      mode: row.mode,
      cursor: keyOf(row.cursor),
      through: keyOf(row.through),
      selectedPageId: row.selectedPageId,
    });
  }

  async function obligations(voterId: string): Promise<readonly IdentityRepairObligationRecord[]> {
    const home = partitionOf(identityRoute(voterId));
    const rows = (await pool.query<ObligationRow>(readObligations.sql, [home, voterId])).rows;
    return Object.freeze(rows.map(obligationOf));
  }

  async function boundObligation(voterId: string, pageId: string): Promise<IdentityRepairObligationRecord | null> {
    if (routeOf(pageId) === null) throw new TypeError('Invalid Rating identity page');
    return (await obligations(voterId)).find((row) => row.pageId === pageId && row.state === 'bound') ?? null;
  }

  return Object.freeze({
    countedVotes,
    orderedEffects,
    voteEffects,
    pageEffects,
    receipts,
    receipt,
    checkpoint,
    obligations,
    boundObligation,
  });
}

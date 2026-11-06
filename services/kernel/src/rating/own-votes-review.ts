import { partitionOf, routeOf, PARTITIONS } from '../route/route.ts';
import type { CommandTransaction } from '../command/command.ts';
import type { IdentityRatingReviewOperand } from '../semantic/identity-core/index.ts';
import reviewSlots from './own-votes-review.sql';

export const VOTE_SCOPE = 'rating:vote';

export class VoteInvalidError extends Error {
  constructor(readonly field: string) {
    super(`Invalid rating vote field: ${field}`);
    this.name = 'VoteInvalidError';
  }
}

export type VoteReviewEpoch = Readonly<{ partition: number; epoch: string }>;
export type VoteReviewGuard = Readonly<{
  version: 1;
  question: Readonly<{ revision: number; lifecycleRevision: number }>;
  subject: Readonly<{
    canonicalId: string;
    epochs: readonly VoteReviewEpoch[];
    /** Absent on historical reviews, which can replay but cannot admit a fresh effect. */
    identity?: IdentityRatingReviewOperand;
  }>;
  ownVote: Readonly<{ state: 'absent' | 'present'; observation: string }>;
}>;

export class VoteReviewStaleError extends Error {
  readonly code = 'vote_review_stale';
  constructor(readonly reason: 'question_changed' | 'subject_changed' | 'identity_epoch_changed' | 'own_vote_changed') {
    super(`Rating vote review is stale: ${reason}`);
    this.name = 'VoteReviewStaleError';
  }
}

export class VoteReviewUnavailableError extends Error {
  readonly code = 'vote_review_unavailable';
  constructor(
    readonly reason:
      | 'question_observation_unavailable'
      | 'identity_pending'
      | 'identity_observation_unavailable'
      | 'own_vote_observation_unavailable'
      | 'atomic_guard_unavailable',
  ) {
    super(`Rating vote review is unavailable: ${reason}`);
    this.name = 'VoteReviewUnavailableError';
  }
}

export type VoteReviewRow = Readonly<{
  targetId: string;
  units: number | null;
  revision: number;
  countedRevision: number;
  countedTarget: string | null;
  changedAt: string;
  transactionId: string;
}>;

export type VoteReviewSlot = Readonly<{ targetId: string; vote: VoteReviewRow | null }>;

/** Explicit null rows prove absence in this native account snapshot, including cleared/raw slots. */
export async function readVoteReviewSlots(
  client: CommandTransaction,
  input: Readonly<{
    ownerId: string;
    questionId: string;
    targetIds: readonly string[];
  }>,
): Promise<VoteReviewSlot[]> {
  const ids = [...new Set(input.targetIds)].sort();
  if (ids.length > 200) throw new RangeError('Too many vote review slots');
  if (!ids.length) return [];
  const rows = await reviewSlots.run(client, {
    route: routeOf(input.ownerId)!,
    voter_id: input.ownerId,
    question_id: input.questionId,
    target_ids: ids,
  });
  const slots = rows.map((row): VoteReviewSlot => ({
    targetId: row.targetId,
    vote:
      row.revision === null
        ? null
        : {
            targetId: row.targetId,
            units: row.units === null ? null : Number(row.units),
            revision: Number(row.revision),
            countedRevision: Number(row.countedRevision),
            countedTarget: row.countedTarget,
            changedAt: row.changedAt!,
            transactionId: row.transactionId!,
          },
  }));
  if (
    slots.length !== ids.length ||
    new Set(slots.map((slot) => slot.targetId)).size !== ids.length ||
    slots.some((slot) => !ids.includes(slot.targetId) || !validRow(rowValue(slot.vote)))
  )
    throw new VoteReviewUnavailableError('own_vote_observation_unavailable');
  return slots.sort((left, right) => left.targetId.localeCompare(right.targetId));
}

function rowValue(row: VoteReviewRow | null) {
  return row === null
    ? null
    : [row.targetId, row.units, row.revision, row.countedRevision, row.countedTarget, row.changedAt, row.transactionId];
}

/** A bounded observation, never an authorization capability or an atomic fence. */
export function ownVoteReviewWitness(
  input: Readonly<{
    ownerId: string;
    questionId: string;
    requestedTargetId: string;
    canonicalId: string;
    original: VoteReviewRow | null;
    canonical: VoteReviewRow | null;
    effective: VoteReviewRow | null;
  }>,
): VoteReviewGuard['ownVote'] {
  return {
    state: input.original || input.canonical || input.effective ? 'present' : 'absent',
    observation: JSON.stringify([
      1,
      input.ownerId,
      input.questionId,
      input.requestedTargetId,
      input.canonicalId,
      rowValue(input.original),
      rowValue(input.canonical),
      rowValue(input.effective),
    ]),
  };
}

function object(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.keys(value).length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key))
  );
}
function revision(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1;
}
function id(value: unknown): value is string {
  return typeof value === 'string' && routeOf(value) !== null;
}
function validRow(value: unknown): boolean {
  if (value === null) return true;
  return (
    Array.isArray(value) &&
    value.length === 7 &&
    id(value[0]) &&
    (value[1] === null || Number.isSafeInteger(value[1])) &&
    revision(value[2]) &&
    Number.isSafeInteger(value[3]) &&
    value[3] >= 0 &&
    (value[4] === null || id(value[4])) &&
    typeof value[5] === 'string' &&
    value[5].length <= 32 &&
    Number.isFinite(Date.parse(value[5])) &&
    id(value[6])
  );
}

/** Closed, copied normalization also prevents mutation across an uncertain native retry. */
export function normalizeVoteReviewGuard(value: unknown, requestedTargetId: string): VoteReviewGuard {
  const invalid = () => {
    throw new TypeError('Invalid vote review guard');
  };
  if (!object(value, ['version', 'question', 'subject', 'ownVote']) || value.version !== 1) return invalid();
  const { question, subject, ownVote } = value;
  if (
    !object(question, ['revision', 'lifecycleRevision']) ||
    !revision(question.revision) ||
    !revision(question.lifecycleRevision)
  )
    return invalid();
  if (
    !(object(subject, ['canonicalId', 'epochs']) || object(subject, ['canonicalId', 'epochs', 'identity'])) ||
    !id(subject.canonicalId) ||
    !Array.isArray(subject.epochs) ||
    !id(requestedTargetId)
  )
    return invalid();
  const homes = [...new Set([requestedTargetId, subject.canonicalId].map((key) => partitionOf(routeOf(key)!)))].sort(
    (a, b) => a - b,
  );
  if (subject.epochs.length !== homes.length) return invalid();
  const epochs: VoteReviewEpoch[] = subject.epochs.map((entry: unknown, index: number) => {
    if (
      !object(entry, ['partition', 'epoch']) ||
      entry.partition !== homes[index] ||
      typeof entry.partition !== 'number' ||
      entry.partition < 0 ||
      entry.partition >= PARTITIONS ||
      typeof entry.epoch !== 'string' ||
      !/^(0|[1-9][0-9]{0,19})$/.test(entry.epoch) ||
      BigInt(entry.epoch) > 18_446_744_073_709_551_615n
    )
      return invalid();
    return { partition: entry.partition, epoch: entry.epoch };
  });
  if (
    !object(ownVote, ['state', 'observation']) ||
    (ownVote.state !== 'absent' && ownVote.state !== 'present') ||
    typeof ownVote.observation !== 'string' ||
    Buffer.byteLength(ownVote.observation) > 4096
  )
    return invalid();
  let witness: unknown;
  try {
    witness = JSON.parse(ownVote.observation);
  } catch {
    return invalid();
  }
  if (
    !Array.isArray(witness) ||
    witness.length !== 8 ||
    witness[0] !== 1 ||
    !witness.slice(1, 5).every(id) ||
    !witness.slice(5).every(validRow) ||
    JSON.stringify(witness) !== ownVote.observation ||
    ownVote.state !== (witness.slice(5).some((row) => row !== null) ? 'present' : 'absent')
  )
    return invalid();
  return Object.freeze({
    version: 1,
    question: Object.freeze({ revision: question.revision, lifecycleRevision: question.lifecycleRevision }),
    subject: Object.freeze({
      canonicalId: subject.canonicalId,
      epochs: Object.freeze(epochs.map((epoch) => Object.freeze(epoch))),
      // Semantic owns operand validation at the command boundary. Internal producers
      // already supply its reviewed type; retain every byte without resampling.
      ...(subject.identity === undefined
        ? {}
        : { identity: freezeIdentityOperand(subject.identity as IdentityRatingReviewOperand) }),
    }),
    ownVote: Object.freeze({ state: ownVote.state, observation: ownVote.observation }),
  });
}

function freezeIdentityOperand(operand: IdentityRatingReviewOperand): IdentityRatingReviewOperand {
  const {
    version,
    requestedOriginalId,
    canonicalTerminalId,
    sourceIdentities,
    sourceHomes,
    controlLocators,
    evidence,
    ...extra
  } = operand;
  return Object.freeze({
    version,
    requestedOriginalId,
    canonicalTerminalId,
    sourceIdentities: Object.freeze([...sourceIdentities]),
    sourceHomes: Object.freeze([...sourceHomes]),
    controlLocators: Object.freeze(
      controlLocators.map(({ partition, group, ...extra }) => Object.freeze({ partition, group, ...extra })),
    ),
    evidence,
    // Preserve unknown fields for Semantic's closed validation rather than dropping them.
    ...extra,
  });
}

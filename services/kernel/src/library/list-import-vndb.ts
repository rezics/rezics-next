import { randomUUID } from 'node:crypto';
import type { SessionComponent } from '../tokens/session.ts';
import { readAccount } from '../access/account-data.ts';
import { GrantDeniedError } from '../access/resource-access-errors.ts';
import { mintReadTime, type AuthoritativeTime, type CommandOutcome } from '../command/command.ts';
import { tupleRoute } from '../content/imported-contract.ts';
import { ProblemError } from '../http/problem-error.ts';
import { readPartition } from '../partition/partition.ts';
import { accessCheck } from '../request/access-check.ts';
import { type AccountActor, type Actor } from '../request/access.ts';
import { deadlineFor } from '../request/deadline.ts';
import { partitionOf } from '../route/route.ts';
import {
  createVoteCommands,
  STANDARD_QUESTION_ID,
  RatingQuestionNotFoundError,
  VoteReviewStaleError,
  VoteReviewUnavailableError,
  type RatingQuestion,
  type Vote,
  type VoteReview,
  type VoteReviewGuard,
  type VoteCommandAdmission,
  type PreparedPutVote,
} from '../rating/votes.ts';
import { withReadTransaction } from '../semantic/read.ts';
import { createLibraryCommandRunner } from './command-support.ts';
import { LibraryNotFoundError, requireRoute } from './collection-command-work.ts';
import { createEntryCommands } from './entries.ts';
import { LibraryEntryInvalidError } from './entry-lifecycle-errors.ts';
import { LibraryConflictError } from './entry-errors.ts';
import { createEntryPersonalCommands } from './entry-personal.ts';
import type { LabelCommandAdmission } from './label-command-admission.ts';
import {
  createSessionCommands,
  ProgressConflictError,
  ProgressInvalidError,
  type ProgressSessionJournalAdmission,
} from './sessions.ts';
import type { Entry } from './entry-model.ts';
import { readLibraryProfileSourceObservation } from './profile-source.ts';
import {
  executeProgressAdoption,
  progressResults,
  reviewProgressAdoption,
  type ProgressAdoptionCheckpoint,
  type ProgressAdoptionInput,
  type ProgressAdoptionPlan,
  type ProgressSourceValue,
} from './list-import-progress-adoption.ts';
import { vndbSourceFingerprint, type VndbEntryReview } from './list-import-vndb-admission.ts';
import { parseVndb, VNDB_LIMITS, type SourceValue, type VndbRow } from './list-import-vndb-parser.ts';
import {
  IMPORT_CONSUMPTION_LIMITS,
  applyImportConsumptionDateRows,
  executeImportConsumptionDateIntent,
  publicImportConsumptionDateReview,
  reviewImportConsumptionDates,
  vndbDateSource,
  type ImportConsumptionDateIntent,
  type ImportConsumptionDateReview,
  type ImportDateAction,
  type ImportDateField,
  type ImportDateSessionIdentity,
} from './import-consumption.ts';
import {
  ENTRY_IMPORT_METADATA_LIMITS,
  assertEntryImportMetadataHistorySize,
  entryImportMetadataDigest,
  entryPersonalMetadataDigest,
  type EntryImportMetadataProposal,
  type EntryImportMetadataProposals,
  type EntryImportMetadataReview,
  type EntryImportMetadataView,
} from './list-import-entry-metadata.ts';
import {
  appendListImportMetadataReview,
  assertListImportMetadataReviewAvailable,
  createListImportMetadataCoordinator,
  type ListImportMetadataExpiredRecovery,
} from './list-import-metadata-coordinator.ts';
import {
  confirmListImportMetadata,
  listImportMetadataFenceFacts,
  listImportMetadataOrConflict,
  persistListImportMetadata,
} from './list-import-metadata-core.ts';

type Config = Parameters<typeof createEntryCommands>[0] & { routeKey: Uint8Array };
const VNDB_DECISIONS_BYTES = 8_388_608;
export type VndbScoreSelection = { kind: 'vote'; units: number } | { kind: 'clear' };
export type VndbChoice =
  | { ordinal: number; action: 'skip' | 'retain'; targetId?: string }
  | {
      ordinal: number;
      action: 'state';
      targetId?: string;
      state: string;
      replace?: boolean;
      progress?: ProgressAdoptionInput;
    }
  | { ordinal: number; action: 'progress'; targetId?: string; progress: ProgressAdoptionInput }
  | {
      ordinal: number;
      action: 'score';
      targetId?: string;
      questionId: string;
      questionRevision: number;
      selection: VndbScoreSelection;
      consent: 'adopt-native-vote' | 'clear-native-vote';
    };
type NativeQuestion = {
  id: string;
  revision: number;
  meaning: string | null;
  label: string;
  grain: RatingQuestion['grain'];
  scale: { min: number; max: number; step: number };
  aggregateEffect: 'public-standard-aggregate';
};
type NativeVoteObservation =
  | { state: 'unavailable' }
  | { state: 'absent' }
  | { state: 'cleared'; revision: number; at: string }
  | { state: 'set'; units: number; revision: number; at: string };
type ScoreDecision = {
  reviewId: string;
  status: 'reviewed' | 'applying' | 'unavailable' | 'applied' | 'skipped' | 'stale' | 'failed';
  targetId: string;
  action: 'vote' | 'clear';
  units: number | null;
  question: NativeQuestion;
  currentVote: NativeVoteObservation;
  consent: 'adopt-native-vote' | 'clear-native-vote';
  sourceScore: SourceValue;
  sourceReason: string;
  targetFingerprint: string;
  commandKey: string;
  guard: VndbEntryReview;
  nativeAdmission: 'conditional';
  nativeGuard: VoteReview['guard'];
  sourceDigest: string;
  matchDigest: string;
  commandActor?: AccountActor;
  command?: PreparedPutVote;
};
export type VndbDateReviewInput = {
  ordinal: number;
  sourceReviewToken: string;
  occurrenceId: string;
  startAction?: ImportDateAction;
  finishAction?: ImportDateAction;
};
export type VndbDateApplyInput = {
  confirm: true;
  rows: { ordinal: number; version: string; fields: ImportDateField[] }[];
};
type Decision = {
  reviewId: string;
  status: 'reviewed' | 'applying' | 'applied' | 'skipped' | 'unsupported' | 'stale' | 'failed';
  stateAction?: 'state' | 'skip' | 'retain' | 'progress' | null;
  targetId: string | null;
  state: string | null;
  baseline: { state: string; revision: number; incarnationId: string | null } | null;
  replace: boolean;
  commandKey: string;
  guard: VndbEntryReview | null;
  receipt?: { partition: number; epoch: number; position: string; transactionId: string };
  matchDigest?: string;
  metadata?: EntryImportMetadataReview[];
  progress?: {
    plan: ProgressAdoptionPlan;
    checkpoint?: ProgressAdoptionCheckpoint;
    sourceFingerprint: string;
  };
  score?: ScoreDecision;
  consumptionDateReview?: ImportConsumptionDateReview;
  consumptionDateIntent?: ImportConsumptionDateIntent;
};
type VndbDateAdmissionIdentity = {
  provider: 'vndb';
  uploadId: string;
  ordinal: number;
  sourceReviewToken: string;
  dateReviewVersion: string;
  sourceFingerprint: string;
  matchFingerprint: string;
  subjectId: string;
  profileDigest: string;
  occurrence: ImportDateSessionIdentity;
  occurrenceProfileBinding: unknown;
  clientId: string;
  requestedBy: string | null;
};
type VndbProgressReadback = {
  sessionId: string;
  startedAt: string;
  transactionId: string;
  revision: number;
  state: string;
  mode: string;
  unit: string;
  amount: string | null;
  measures: { unit: string; amount: string | null }[];
};

type NativeScoreReviewResult =
  | {
      reviewId: string;
      status: ScoreDecision['status'];
      targetId: string;
      action: ScoreDecision['action'];
      units: number | null;
      question: NativeQuestion;
      currentVote: NativeVoteObservation;
      consent: ScoreDecision['consent'];
      sourceReason: string;
      nativeAdmission: 'conditional';
    }
  | { status: 'unavailable'; reason: 'native-question-unavailable' | 'native-current-vote-unavailable' };
type NativeScorePreview = {
  question: NativeQuestion | null;
  currentVote: NativeVoteObservation;
  sourceReason: string;
  exactUnits: number | null;
  admission: {
    status: 'conditional' | 'unavailable';
    reason: null | 'native-question-unavailable' | 'native-current-vote-unavailable' | 'source-not-vn-score';
  };
};

function nativeQuestionView(question: RatingQuestion): NativeQuestion {
  return {
    id: question.id,
    revision: question.revision,
    meaning: question.meaning ?? question.label,
    label: question.label,
    grain: question.grain,
    scale: { min: question.minimumUnits, max: question.maximumUnits, step: question.stepUnits },
    aggregateEffect: 'public-standard-aggregate',
  };
}

function nativeVoteView(vote: Pick<Vote, 'units' | 'revision' | 'changedAt'> | null): NativeVoteObservation {
  if (!vote) return { state: 'absent' };
  return vote.units === null
    ? { state: 'cleared', revision: vote.revision, at: vote.changedAt }
    : { state: 'set', units: vote.units, revision: vote.revision, at: vote.changedAt };
}

/** Counted zero stays a set vote; explicit clear stays cleared; proven absence stays absent. */
function nativeVoteFromReview(vote: VoteReview['currentVote']): NativeVoteObservation {
  if (vote.state === 'absent') return { state: 'absent' };
  if (vote.state === 'clear') return { state: 'cleared', revision: vote.revision, at: vote.changedAt };
  return { state: 'set', units: vote.units, revision: vote.revision, at: vote.changedAt };
}

function sourceScoreReason(source: SourceValue): { reason: string; exactUnits: number | null } {
  if (source.kind === 'missing')
    return { reason: 'No source score was supplied; absence never clears a native vote.', exactUnits: null };
  if (source.kind === 'unknown')
    return { reason: 'The source score is unknown; no native vote is proposed.', exactUnits: null };
  if (source.kind === 'invalid')
    return {
      reason:
        source.raw === '0'
          ? 'Zero is invalid on VNDB’s 1–10 source scale.'
          : 'The source score is invalid on VNDB’s 1–10 scale.',
      exactUnits: null,
    };
  if (
    typeof source.value !== 'number' ||
    source.scale?.min !== 1 ||
    source.scale.max !== 10 ||
    source.scale.step !== 0.1
  )
    return { reason: 'The retained source value does not match the supported VNDB score scale.', exactUnits: null };
  const doubled = source.value * 2;
  return Number.isInteger(doubled)
    ? {
        reason: `VNDB ${source.raw} has an exact native-unit candidate of ${doubled}; explicitly choose it before adoption.`,
        exactUnits: doubled,
      }
    : {
        reason: `VNDB ${source.raw} is valid on the 1–10, 0.1-step scale but has no exact standard half-point value. Choose native units explicitly; no rounding is applied.`,
        exactUnits: null,
      };
}

function vndbProgressSources(row: VndbRow): ProgressSourceValue[] {
  // VNDB's exporter declares play time with length-votes/vn/minutes. Arbitrary
  // progress/unit extensions remain evidence and cannot establish provider meaning.
  const progress = row.fields.minutes ?? row.fields.progress ?? { kind: 'missing' as const, raw: null };
  const unit = row.fields.minutes ? 'minute' : null;
  const raw = progress.raw ?? (typeof progress.value === 'string' ? progress.value : null);
  const lexeme = raw?.trim() ?? '';
  let state: ProgressSourceValue['state'];
  if (progress.kind === 'missing') state = 'missing';
  else if (progress.kind === 'unknown' || (progress.kind === 'value' && (lexeme === '' || lexeme === 'unknown')))
    state = 'unknown';
  else if (progress.kind === 'invalid' || !/^\d+(?:\.\d+)?$/.test(lexeme) || !Number.isFinite(Number(lexeme)))
    state = 'invalid';
  else state = Number(lexeme) === 0 ? 'zero' : 'value';
  return [
    {
      field: row.fields.minutes ? 'minutes' : 'progress',
      unit,
      state,
      ...(state === 'zero' || state === 'value' ? { amount: lexeme } : {}),
    },
  ];
}

function progressView(
  plan: ProgressAdoptionPlan,
  checkpoint: ProgressAdoptionCheckpoint | null | undefined,
  readback: VndbProgressReadback | null = null,
) {
  const occurrence =
    checkpoint?.occurrence ??
    (plan.occurrence.kind === 'existing'
      ? {
          sessionId: plan.occurrence.sessionId,
          startedAt: plan.occurrence.startedAt,
          transactionId: plan.occurrence.transactionId,
          revision: plan.occurrence.revision,
        }
      : null);
  return {
    occurrence,
    complete: checkpoint?.complete ?? false,
    measures: progressResults(plan, checkpoint),
    readback,
  };
}

function stateActionOf(decision: Decision): 'state' | 'skip' | 'retain' | 'progress' | null {
  if (decision.stateAction !== undefined) return decision.stateAction;
  if (decision.state !== null) return 'state';
  if (decision.status === 'skipped') return 'skip';
  if (decision.status === 'unsupported') return 'retain';
  return null;
}
export function vndbMetadataProposals(row: VndbRow): EntryImportMetadataProposals {
  const noteField = row.fields.notes ?? row.fields.note;
  let note: EntryImportMetadataProposal;
  if (!noteField || noteField.kind === 'missing') note = { state: 'absent', sourceField: noteField ? 'notes' : null };
  else if (noteField.kind === 'unknown')
    note = { state: noteField.raw === '' ? 'empty' : 'unknown', sourceField: 'notes', sourceValue: noteField.raw };
  else if (noteField.kind !== 'value' || typeof noteField.value !== 'string')
    note = {
      state: 'invalid',
      sourceField: 'notes',
      sourceValue: noteField.raw,
      reason: 'The retained note is not valid text.',
    };
  else if (
    noteField.value.length === 0 ||
    !noteField.value.isWellFormed() ||
    noteField.value.includes('\u0000') ||
    Buffer.byteLength(noteField.value) > ENTRY_IMPORT_METADATA_LIMITS().noteBytes
  )
    note = {
      state: noteField.value.length === 0 ? 'empty' : 'unsupported',
      sourceField: 'notes',
      reason: 'The retained note is empty or exceeds the native 4,096-byte text limit.',
    };
  else note = { state: 'value', sourceField: 'notes', value: noteField.value };

  const privacyField = row.fields.privacy;
  let privacy: EntryImportMetadataProposal;
  if (!privacyField || privacyField.kind === 'missing')
    privacy = { state: 'absent', sourceField: privacyField ? 'private' : null, value: { status: 'absent' } };
  else if (privacyField.raw === '')
    privacy = {
      state: 'empty',
      sourceField: 'private',
      sourceValue: '',
      reason: 'An empty privacy token is not an absence.',
    };
  else if (privacyField.kind === 'invalid')
    privacy = {
      state: 'invalid',
      sourceField: 'private',
      sourceValue: privacyField.raw,
      reason: 'The retained privacy token is invalid.',
    };
  else {
    const raw = privacyField.raw ?? String(privacyField.value ?? ''),
      token = raw.trim().toLowerCase();
    const meaning = ['1', 'true', 'yes', 'private'].includes(token)
      ? 'private'
      : ['0', 'false', 'no', 'public', 'visible'].includes(token)
        ? 'source_visible'
        : null;
    privacy = meaning
      ? { state: 'value', sourceField: 'private', sourceValue: raw, value: { status: 'known', meaning } }
      : token.length <= ENTRY_IMPORT_METADATA_LIMITS().privacyValueBytes && !/[\u0000-\u001f\u007f]/.test(raw)
        ? { state: 'unknown', sourceField: 'private', sourceValue: raw, value: { status: 'unknown', sourceValue: raw } }
        : {
            state: 'unsupported',
            sourceField: 'private',
            reason: 'The privacy token cannot fit the native provenance bound.',
          };
  }
  const unsupported = (field: string): EntryImportMetadataProposal => ({
    state: 'unsupported',
    sourceField: null,
    reason: `VNDB does not retain ${field} as an original entry field.`,
  });
  return {
    note,
    priority: unsupported('personal priority'),
    privacy,
    sourceCreated: unsupported('source-created timestamps'),
    sourceUpdated: unsupported('source-updated timestamps'),
  };
}
type Upload = {
  upload_id: string;
  state: 'active' | 'cancelled';
  expires_at: Date;
  rows: VndbRow[];
  decisions: Record<string, Decision>;
  xml: string;
};

function vndbMetadataFence(record: EntryImportMetadataReview, upload: Upload, ordinal: number) {
  const decision = upload.decisions[ordinal],
    row = upload.rows[ordinal];
  return listImportMetadataFenceFacts({
    cancelled: upload.state !== 'active',
    expired: upload.expires_at.getTime() <= Date.now(),
    currentSourceReviewToken: decision?.reviewId,
    boundSourceReviewToken: record.sourceReviewToken,
    currentSourceDigest: row ? entryImportMetadataDigest(row) : null,
    boundSourceDigest: record.sourceDigest,
    currentProfileDigest:
      decision?.targetId && decision.guard
        ? entryImportMetadataDigest({
            targetId: decision.targetId,
            source: decision.guard.source,
            incarnationId: decision.baseline?.incarnationId ?? null,
          })
        : null,
    boundProfileDigest: record.profileDigest,
    currentIncarnationId: decision?.baseline?.incarnationId ?? null,
    boundIncarnationId: record.incarnationId,
  });
}
// Once dispatch can have happened, only the original command may settle this review.
const pendingState = (decision: Decision | undefined) =>
  decision !== undefined && ['applying', 'failed'].includes(decision.status);
const pendingAdoption = (decision: Decision | undefined) =>
  !!(
    decision?.metadata?.some((item) => item.confirmation && !item.confirmation.outcome) ||
    (decision?.progress?.checkpoint &&
      !decision.progress.checkpoint.complete &&
      (decision.progress.checkpoint.startAttempted ||
        Object.values(decision.progress.checkpoint.steps).some((step) => step.attempted))) ||
    (decision?.consumptionDateIntent?.patch &&
      (!decision.consumptionDateIntent.outcome || decision.consumptionDateIntent.outcome.status === 'failed'))
  );
const updated = (accountId: string) => [
  { type: 'com.rezics.library.personal-import.changed.v1', subject: accountId, data: {} },
];

/** Upload-local composition of existing native Library entry commands. No provider fetch or public output. */
export function createVndbImport(config: Config) {
  const { pool, access } = config;
  const runner = createLibraryCommandRunner(config),
    entries = createEntryCommands(config),
    votes = createVoteCommands(config),
    sessions = createSessionCommands(config);
  const personalEntries = createEntryPersonalCommands(config);
  function owner(actor: Actor): AccountActor {
    if (actor.kind !== 'account' || !actor.scopes.includes('library_entry:update')) throw new GrantDeniedError();
    requireRoute(actor.accountId);
    return actor;
  }
  async function authorized(actor: Actor) {
    const account = owner(actor),
      route = requireRoute(account.accountId),
      deadline = deadlineFor(5000);
    const check = await accessCheck(
      access,
      account,
      'library_entry:update',
      { route, id: account.accountId },
      { pool, deadline },
    );
    return withReadTransaction(
      pool,
      async (client) => {
        const time = await mintReadTime(client, config.clock);
        const current = await readAccount(client, route, account.accountId);
        const partition = await readPartition(client, partitionOf(route));
        if (
          !current ||
          current.kind !== 'actor' ||
          current.state !== 'active' ||
          current.fenced ||
          !Number.isSafeInteger(account.authnEpoch) ||
          account.authnEpoch < 1 ||
          current.minimumAuthnEpoch > BigInt(account.authnEpoch) ||
          partition?.writeState !== 'active' ||
          !(await check(client, time))
        )
          throw new GrantDeniedError();
        return time;
      },
      deadline,
    );
  }
  async function load(actor: Actor, id: string, reconcile = false): Promise<Upload> {
    await authorized(actor);
    const account = owner(actor);
    const result = await withReadTransaction(pool, (client) =>
      client.query<Upload>('SELECT * FROM library.vndb_import WHERE route=$1 AND account_id=$2 AND upload_id=$3', [
        requireRoute(account.accountId),
        account.accountId,
        id,
      ]),
    );
    const upload = result.rows[0];
    if (!upload || (!reconcile && upload.expires_at.getTime() <= Date.now())) throw new LibraryNotFoundError();
    await authorized(actor);
    if (!reconcile) await retainedSource(actor, id);
    return upload;
  }
  // A receipt grants no authority to disclose a deleted or expired source. Recheck
  // after asynchronous matching/serialization as well as before reading evidence.
  async function retainedSource(actor: Actor, id: string) {
    const account = owner(actor);
    const result = await withReadTransaction(pool, (client) =>
      client.query(
        `SELECT upload_id FROM library.vndb_import
         WHERE route=$1 AND account_id=$2 AND upload_id=$3 AND expires_at>clock_timestamp()`,
        [requireRoute(account.accountId), account.accountId, id],
      ),
    );
    if (!result.rows[0]) throw new LibraryNotFoundError();
  }
  function mutation<T>(
    actor: Actor,
    kind: string,
    key: string,
    input: unknown,
    body: (tx: import('../command/command.ts').CommandTransaction, account: AccountActor) => Promise<T>,
  ) {
    const account = owner(actor);
    return runner.ownAccount(
      actor,
      { action: 'library_entry:update', kind: `library.vndb.${kind}`, requestKey: key, input },
      async (tx) => ({ value: await body(tx, account), events: updated(account.accountId) }),
    );
  }
  async function save(
    tx: import('../command/command.ts').CommandTransaction,
    account: AccountActor,
    id: string,
    ordinal: number,
    decision: Decision,
  ) {
    const route = requireRoute(account.accountId);
    const stored = await tx.query<{ decisions: Record<string, Decision> }>(
      'SELECT decisions FROM library.vndb_import WHERE route=$1 AND account_id=$2 AND upload_id=$3 FOR UPDATE',
      [route, account.accountId, id],
    );
    const current = stored.rows[0];
    if (!current) throw new LibraryConflictError();
    const decisions = { ...current.decisions, [String(ordinal)]: decision };
    if (Buffer.byteLength(JSON.stringify(decisions)) > VNDB_DECISIONS_BYTES)
      throw new ProblemError('content_too_large');
    const updatedRow = await tx.query(
      'UPDATE library.vndb_import SET decisions=$4::jsonb WHERE route=$1 AND account_id=$2 AND upload_id=$3',
      [route, account.accountId, id, JSON.stringify(decisions)],
    );
    if (updatedRow.rowCount !== 1) throw new LibraryConflictError();
  }
  async function current(actor: Actor, targetId: string, at?: AuthoritativeTime) {
    const observedAt = at ?? (await authorized(actor));
    const source = await readLibraryProfileSourceObservation(
      { pool, access, actor, at: observedAt, deadline: deadlineFor(5000) },
      targetId,
    );
    if (!source) return null;
    let entry: Entry | null = null;
    try {
      entry = await entries.readEntry(actor, source.source.subjectId);
    } catch (error) {
      if (!(error instanceof LibraryNotFoundError)) throw error;
    }
    return {
      targetId: source.source.subjectId,
      source: vndbSourceFingerprint(source),
      states: source.source.kind === 'supported' ? (source.source.profile.entryStateSet?.states ?? []) : [],
      profileSupported: source.source.kind === 'supported',
      profile: source.source.kind === 'supported' ? source.source.profile : null,
      profileBinding:
        source.source.kind === 'supported'
          ? {
              pin: source.source.pin,
              epoch: source.anchor.identityEpoch.toString(),
              acceptingType: source.anchor.acceptingType,
            }
          : null,
      baseline: entry
        ? { state: entry.state, revision: entry.revision, incarnationId: entry.incarnationId ?? null }
        : null,
    };
  }
  async function nativeQuestion(actor: Actor): Promise<NativeQuestion | null> {
    try {
      const question = await votes.readRatingQuestion(actor, STANDARD_QUESTION_ID);
      if (question.id !== STANDARD_QUESTION_ID) return null;
      const view = nativeQuestionView(question);
      return Buffer.byteLength(JSON.stringify(view)) <= 12_288 ? view : null;
    } catch (error) {
      if (error instanceof RatingQuestionNotFoundError || error instanceof GrantDeniedError) return null;
      throw error;
    }
  }
  async function nativeScorePreview(
    actor: Actor,
    source: SourceValue | undefined,
    targetId: string | undefined,
    question?: NativeQuestion | null,
    reviewed?: VoteReview,
  ): Promise<NativeScorePreview> {
    let selectedQuestion = question === undefined ? await nativeQuestion(actor) : question;
    let currentVote: NativeVoteObservation = { state: 'unavailable' };
    if (selectedQuestion && targetId) {
      try {
        const review = reviewed ?? (await votes.readVoteReview(actor, selectedQuestion.id, targetId));
        selectedQuestion = nativeQuestionView(review.question);
        currentVote = nativeVoteFromReview(review.currentVote);
      } catch (error) {
        if (!(error instanceof VoteReviewUnavailableError || error instanceof GrantDeniedError)) throw error;
        currentVote = { state: 'unavailable' };
      }
    }
    const score = source ?? { kind: 'missing' as const, raw: null };
    const treatment = sourceScoreReason(score);
    const reason = !selectedQuestion
      ? 'native-question-unavailable'
      : targetId && currentVote.state === 'unavailable'
        ? 'native-current-vote-unavailable'
        : null;
    return {
      question: selectedQuestion,
      currentVote,
      sourceReason: treatment.reason,
      exactUnits: treatment.exactUnits,
      admission: { status: reason === null ? 'conditional' : 'unavailable', reason },
    };
  }
  async function metadataProfile(actor: Actor, decision: Decision) {
    if (!decision.targetId || !decision.guard) return null;
    const live = await current(actor, decision.targetId);
    if (
      !live ||
      live.source !== decision.guard.source ||
      (live.baseline?.incarnationId ?? null) !== (decision.baseline?.incarnationId ?? null)
    )
      return null;
    return {
      incarnationId: live.baseline?.incarnationId ?? null,
      digest: entryImportMetadataDigest({
        targetId: live.targetId,
        source: live.source,
        incarnationId: live.baseline?.incarnationId ?? null,
      }),
    };
  }
  async function match(actor: Actor, row: VndbRow) {
    if (!row.identifier) return { status: 'unsupported' as const, candidates: [] as string[] };
    const route = tupleRoute(config.routeKey, 'vndb', row.identifier.value);
    const claims = await withReadTransaction(pool, async (client) => {
      const home = await readPartition(client, partitionOf(route));
      if (home?.writeState !== 'active') return null;
      return client.query<{ subject_id: string }>(
        'SELECT subject_id::text FROM semantic.external_claim WHERE route=$1 AND source=$2 AND external_id=$3 LIMIT 2',
        [route, 'vndb', row.identifier!.value],
      );
    });
    if (!claims) return { status: 'unavailable' as const, candidates: [] as string[] };
    const candidates: string[] = [];
    for (const claim of claims.rows) {
      const readable = await current(actor, claim.subject_id);
      if (readable && !candidates.includes(readable.targetId)) candidates.push(readable.targetId);
    }
    return {
      status:
        candidates.length > 1
          ? ('ambiguous' as const)
          : candidates.length === 1
            ? ('matched' as const)
            : claims.rows.length
              ? ('unavailable' as const)
              : ('unmatched' as const),
      candidates,
    };
  }
  async function preview(actor: Actor, xml: string, key: string) {
    const rows = parseVndb(xml);
    return mutation(actor, 'upload', key, { xml }, async (tx, account) => {
      const route = requireRoute(account.accountId);
      await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`library.vndb:${account.accountId}`]);
      await tx.query(
        'DELETE FROM library.vndb_import WHERE route=$1 AND account_id=$2 AND expires_at<=clock_timestamp()',
        [route, account.accountId],
      );
      const count = await tx.query<{ count: string }>(
        'SELECT count(*) FROM library.vndb_import WHERE route=$1 AND account_id=$2',
        [route, account.accountId],
      );
      if (Number(count.rows[0]!.count) >= VNDB_LIMITS.uploads) throw new ProblemError('conflict');
      const uploadId = randomUUID();
      await tx.query(
        `INSERT INTO library.vndb_import(route,account_id,upload_id,expires_at,xml,rows)
        VALUES($1,$2,$3,clock_timestamp()+interval '24 hours',$4,$5::jsonb)`,
        [route, account.accountId, uploadId, xml, JSON.stringify(rows)],
      );
      return { uploadId, rows: rows.length, limits: VNDB_LIMITS };
    });
  }
  async function page(actor: Actor, id: string, offset: number) {
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > VNDB_LIMITS.rows)
      throw new ProblemError('invalid_request');
    const upload = await load(actor, id);
    const pageRows = upload.rows.slice(offset, offset + VNDB_LIMITS.page);
    const question = pageRows.some((row) => row.kind === 'vn') ? await nativeQuestion(actor) : null;
    const rows = [];
    for (const row of pageRows) {
      const matching = await match(actor, row),
        decision = upload.decisions[row.ordinal];
      const targetId = decision?.targetId ?? (matching.candidates.length === 1 ? matching.candidates[0] : undefined);
      const target = targetId ? await current(actor, targetId) : null;
      const nativeScore =
        row.kind === 'vn'
          ? await nativeScorePreview(actor, row.fields.score, target?.targetId, question)
          : {
              question: null,
              currentVote: { state: 'unavailable' as const },
              sourceReason: 'Retained releases, reviews, and length votes are never Subject enjoyment votes.',
              exactUnits: null,
              admission: { status: 'unavailable' as const, reason: 'source-not-vn-score' as const },
            };
      rows.push({
        ...row,
        match: matching,
        target: target ? { targetId: target.targetId, states: target.states, baseline: target.baseline } : null,
        decision:
          decision && stateActionOf(decision) !== null
            ? {
                ...publicDecision(decision),
                progress: decision.progress ? await progressResponse(actor, decision.progress) : null,
              }
            : null,
        scoreDecision: decision?.score ? publicScoreDecision(decision.score) : null,
        nativeScore,
        consumptionDateReview: decision?.consumptionDateReview
          ? publicImportConsumptionDateReview(decision.consumptionDateReview)
          : null,
        consumptionDateOutcome: decision?.consumptionDateIntent?.outcome ?? null,
        fieldsTreatment: {
          state: decision?.state ? 'proposed native entry state' : 'retained; explicit state required',
          score: nativeScore.sourceReason,
          other: row.retainedReason,
        },
      });
    }
    await authorized(actor);
    await retainedSource(actor, id);
    return {
      uploadId: id,
      state: upload.state,
      expiresAt: upload.expires_at.toISOString(),
      total: upload.rows.length,
      next: offset + rows.length < upload.rows.length ? offset + rows.length : null,
      rows,
    };
  }
  function publicDecision(decision: Decision) {
    const { reviewId, status, targetId, state, baseline, replace } = decision;
    return {
      reviewId,
      status,
      targetId,
      state,
      baseline,
      replace,
      action: stateActionOf(decision),
      progress: decision.progress ? progressView(decision.progress.plan, decision.progress.checkpoint) : null,
    };
  }
  async function progressResponse(actor: Actor, progress: NonNullable<Decision['progress']>) {
    const plan = progress.plan,
      checkpoint = progress.checkpoint,
      view = progressView(plan, checkpoint);
    if (!view.occurrence) return view;
    let readback: VndbProgressReadback | null = null;
    try {
      readback = await sessions.readPresentedSession(actor, view.occurrence.sessionId, async (session) => ({
        sessionId: session.id,
        startedAt: session.startedAt,
        transactionId: session.transactionId,
        revision: session.revision,
        state: session.state,
        mode: session.mode,
        unit: session.unit,
        amount: session.amount,
        measures: (session.measures ?? []).map((measure) => ({ unit: measure.unit, amount: measure.amount ?? null })),
      }));
    } catch (error) {
      if (
        !(error instanceof LibraryNotFoundError) &&
        !(error instanceof ProgressConflictError) &&
        !(
          error instanceof ProblemError && ['not_found', 'conflict', 'unsupported_library_profile'].includes(error.code)
        )
      )
        throw error;
    }
    const result = progressView(plan, checkpoint, readback);
    return readback
      ? {
          ...result,
          occurrence: {
            sessionId: readback.sessionId,
            startedAt: readback.startedAt,
            transactionId: readback.transactionId,
            revision: readback.revision,
          },
        }
      : result;
  }
  function publicScoreDecision({
    reviewId,
    status,
    targetId,
    action,
    units,
    question,
    currentVote,
    consent,
    sourceReason,
    nativeAdmission,
  }: ScoreDecision): NativeScoreReviewResult {
    return { reviewId, status, targetId, action, units, question, currentVote, consent, sourceReason, nativeAdmission };
  }
  async function reviewScore(actor: Actor, id: string, choice: Extract<VndbChoice, { action: 'score' }>, key: string) {
    const upload = await load(actor, id),
      row = upload.rows[choice.ordinal];
    if (!row || row.kind !== 'vn') throw new ProblemError('invalid_request');
    const matching = await match(actor, row);
    const targetId = choice.targetId ?? (matching.candidates.length === 1 ? matching.candidates[0] : undefined);
    const target = targetId ? await current(actor, targetId) : null;
    if (!target) throw new ProblemError('invalid_request');
    let reviewed: VoteReview;
    try {
      reviewed = await votes.readVoteReview(actor, STANDARD_QUESTION_ID, target.targetId);
    } catch (error) {
      if (!(error instanceof VoteReviewUnavailableError)) throw error;
      return mutation(actor, 'review-score', key, { id, choice }, async () => ({
        status: 'unavailable' as const,
        reason: 'native-current-vote-unavailable' as const,
      }));
    }
    const preview = await nativeScorePreview(
      actor,
      row.fields.score,
      target.targetId,
      nativeQuestionView(reviewed.question),
      reviewed,
    );
    if (!preview.question || preview.question.meaning === null || preview.currentVote.state === 'unavailable')
      return mutation(actor, 'review-score', key, { id, choice }, async () => ({
        status: 'unavailable' as const,
        reason: preview.question
          ? ('native-current-vote-unavailable' as const)
          : ('native-question-unavailable' as const),
      }));
    if (
      preview.question.id !== STANDARD_QUESTION_ID ||
      preview.question.revision !== 1 ||
      preview.question.scale.min !== 0 ||
      preview.question.scale.max !== 20 ||
      preview.question.scale.step !== 1
    )
      throw new ProblemError('conflict');
    if (choice.questionId !== preview.question.id || choice.questionRevision !== preview.question.revision)
      throw new ProblemError('conflict');
    if (
      (choice.selection.kind === 'vote' && choice.consent !== 'adopt-native-vote') ||
      (choice.selection.kind === 'clear' && choice.consent !== 'clear-native-vote')
    )
      throw new ProblemError('invalid_request');
    if (choice.selection.kind === 'vote') {
      const source = row.fields.score;
      if (
        !source ||
        source.kind !== 'value' ||
        typeof source.value !== 'number' ||
        source.scale?.min !== 1 ||
        source.scale.max !== 10 ||
        source.scale.step !== 0.1 ||
        !Number.isSafeInteger(choice.selection.units) ||
        choice.selection.units < preview.question.scale.min ||
        choice.selection.units > preview.question.scale.max ||
        (choice.selection.units - preview.question.scale.min) % preview.question.scale.step !== 0
      )
        throw new ProblemError('invalid_request');
    }
    const scoreReviewId = randomUUID(),
      matchDigest = entryImportMetadataDigest(matching),
      sourceScore = row.fields.score ?? { kind: 'missing' as const, raw: null },
      treatment = sourceScoreReason(sourceScore),
      scoreDecision: ScoreDecision = {
        reviewId: scoreReviewId,
        status: 'reviewed',
        targetId: target.targetId,
        action: choice.selection.kind === 'vote' ? 'vote' : 'clear',
        units: choice.selection.kind === 'vote' ? choice.selection.units : null,
        question: preview.question,
        currentVote: preview.currentVote,
        consent: choice.consent,
        sourceScore,
        sourceReason: treatment.reason,
        targetFingerprint: target.source,
        commandKey: `vndb:${id}:score:${scoreReviewId}`,
        guard: { uploadId: id, ordinal: choice.ordinal, reviewId: scoreReviewId, source: target.source },
        nativeAdmission: 'conditional',
        nativeGuard: reviewed.guard,
        sourceDigest: entryImportMetadataDigest(row),
        matchDigest,
      };
    return mutation(actor, 'review-score', key, { id, choice }, async (tx, account) => {
      const stored = await tx.query<Upload>(
        `SELECT * FROM library.vndb_import
        WHERE route=$1 AND account_id=$2 AND upload_id=$3 AND state='active' AND expires_at>clock_timestamp() FOR UPDATE`,
        [requireRoute(account.accountId), account.accountId, id],
      );
      if (!stored.rows[0]) throw new ProblemError('conflict');
      const before = stored.rows[0].decisions[choice.ordinal];
      if (
        pendingState(before) ||
        pendingAdoption(before) ||
        ['applying', 'applied', 'failed'].includes(before?.score?.status ?? '')
      )
        throw new ProblemError('conflict');
      const compatible =
        before?.targetId === target.targetId &&
        before.matchDigest === matchDigest &&
        before.guard?.source === target.source;
      if (!compatible && before?.status === 'applied') throw new ProblemError('conflict');
      const parentReviewId = compatible && before ? before.reviewId : randomUUID();
      const plan: Decision =
        compatible && before
          ? { ...before }
          : {
              reviewId: parentReviewId,
              status: 'reviewed',
              stateAction: null,
              targetId: target.targetId,
              state: null,
              baseline: null,
              replace: false,
              commandKey: `vndb:${id}:${parentReviewId}`,
              guard: { uploadId: id, ordinal: choice.ordinal, reviewId: parentReviewId, source: target.source },
              matchDigest,
              metadata: [],
            };
      plan.score = scoreDecision;
      await save(tx, account, id, choice.ordinal, plan);
      return publicScoreDecision(scoreDecision);
    });
  }
  async function review(actor: Actor, id: string, choice: VndbChoice, key: string) {
    if (choice.action === 'score') return reviewScore(actor, id, choice, key);
    const upload = await load(actor, id),
      row = upload.rows[choice.ordinal];
    if (!row) throw new ProblemError('invalid_request');
    const matching = await match(actor, row);
    const targetId = choice.targetId ?? (matching.candidates.length === 1 ? matching.candidates[0] : undefined);
    const target = targetId ? await current(actor, targetId) : null;
    if (
      choice.action === 'state' &&
      (row.kind !== 'vn' || !target || !choice.state || !target.states.some((s) => s.id === choice.state))
    )
      throw new ProblemError('invalid_request');
    if ((choice.action === 'state' || choice.action === 'progress') && (!target || !row.identifier))
      throw new ProblemError('invalid_request');
    const progressInput = choice.action === 'progress' || choice.action === 'state' ? choice.progress : undefined;
    if (progressInput && (!target?.profile || !target.profileBinding))
      throw new ProblemError('unsupported_library_profile');
    const reviewId = randomUUID();
    const progressPlan =
      progressInput && target?.profile && target.profileBinding
        ? await reviewProgressAdoption(
            sessions,
            actor,
            target.targetId,
            target.profile,
            target.profileBinding,
            vndbProgressSources(row),
            progressInput,
            `vndb-progress-start:${entryImportMetadataDigest({ id, ordinal: choice.ordinal, reviewId })}`,
          )
        : undefined;
    return mutation(actor, 'review', key, { id, choice }, async (tx, account) => {
      const stored = await tx.query<Upload>(
        `SELECT * FROM library.vndb_import
        WHERE route=$1 AND account_id=$2 AND upload_id=$3 AND state='active' AND expires_at>clock_timestamp() FOR UPDATE`,
        [requireRoute(account.accountId), account.accountId, id],
      );
      if (!stored.rows[0]) throw new ProblemError('conflict');
      const before = stored.rows[0].decisions[choice.ordinal];
      if (before && ['applying', 'applied', 'failed'].includes(before.status)) throw new ProblemError('conflict');
      if (pendingAdoption(before)) throw new ProblemError('conflict');
      if (before?.score?.commandActor && ['applying', 'failed', 'unavailable'].includes(before.score.status))
        throw new ProblemError('conflict');
      const matchDigest = entryImportMetadataDigest(matching);
      const scoreCompatible =
        before?.score !== undefined &&
        before.targetId === (target?.targetId ?? null) &&
        before.matchDigest === matchDigest &&
        before.guard?.source === target?.source &&
        before.score.targetId === target?.targetId &&
        before.score.targetFingerprint === target?.source;
      const decision: Decision = {
        reviewId,
        status: choice.action === 'skip' ? 'skipped' : choice.action === 'retain' ? 'unsupported' : 'reviewed',
        stateAction: choice.action === 'state' ? 'state' : choice.action,
        targetId: target?.targetId ?? null,
        state: choice.action === 'state' ? choice.state! : null,
        baseline: target?.baseline ?? null,
        replace: choice.action === 'state' && choice.replace === true,
        commandKey: `vndb:${id}:${reviewId}`,
        guard: target ? { uploadId: id, ordinal: choice.ordinal, reviewId, source: target.source } : null,
        matchDigest,
        ...(scoreCompatible ? { score: before!.score } : {}),
        ...(progressPlan
          ? { progress: { plan: progressPlan, sourceFingerprint: entryImportMetadataDigest(row) } }
          : {}),
        // A refreshed source review has its own consent, even on the same target.
        // Old metadata tokens must not be transplanted into a corrected match.
        metadata: [],
      };
      await save(tx, account, id, choice.ordinal, decision);
      return publicDecision(decision);
    });
  }
  const dateProfileDigest = (target: Awaited<ReturnType<typeof current>>) =>
    target
      ? entryImportMetadataDigest({
          targetId: target.targetId,
          source: target.source,
          incarnationId: target.baseline?.incarnationId ?? null,
        })
      : null;
  async function dateAdmission(
    actor: Actor,
    identity: VndbDateAdmissionIdentity,
  ): Promise<ProgressSessionJournalAdmission> {
    let prepared:
      | { matching: Awaited<ReturnType<typeof match>>; target: Awaited<ReturnType<typeof current>> }
      | undefined;
    return {
      identity,
      async prepare() {
        const stored = await retainedRow(actor, identity.uploadId, identity.ordinal, true);
        prepared = { matching: stored.matching, target: stored.target };
      },
      assert: async (tx) => {
        const account = owner(actor),
          route = requireRoute(account.accountId),
          stored = await tx.query<{ row: VndbRow | null; decision: Decision | null; active: boolean }>(
            `SELECT rows->$4::integer AS row,decisions->$4::text AS decision,
              state='active' AND expires_at>clock_timestamp() AS active
             FROM library.vndb_import WHERE route=$1 AND account_id=$2 AND upload_id=$3 FOR UPDATE`,
            [route, account.accountId, identity.uploadId, identity.ordinal],
          ),
          { row, decision, active } = stored.rows[0] ?? {};
        if (
          !active ||
          !row ||
          !decision ||
          decision.reviewId !== identity.sourceReviewToken ||
          !['reviewed', 'applied', 'unsupported'].includes(decision.status) ||
          decision.targetId !== identity.subjectId ||
          entryImportMetadataDigest(row) !== identity.sourceFingerprint ||
          decision.matchDigest !== identity.matchFingerprint ||
          decision.consumptionDateReview?.version !== identity.dateReviewVersion ||
          decision.consumptionDateReview.sourceReviewToken !== identity.sourceReviewToken ||
          decision.consumptionDateReview.profileDigest !== identity.profileDigest
        )
          throw new LibraryConflictError();
        if (account.clientId !== identity.clientId || (account.requestedBy ?? null) !== identity.requestedBy)
          throw new LibraryConflictError();
        const matching = prepared?.matching,
          target = prepared?.target;
        if (
          !matching ||
          entryImportMetadataDigest(matching) !== identity.matchFingerprint ||
          !target ||
          target.source !== decision.guard?.source ||
          dateProfileDigest(target) !== identity.profileDigest
        )
          throw new LibraryConflictError();
        const occurrenceResult = await tx.query<{
          subject_id: string;
          version_subject_id: string | null;
          started_at: Date | string;
          transaction_id: string;
          state: string;
          library_profile_pin: unknown;
        }>(
          `SELECT subject_id::text,version_subject_id::text,started_at,transaction_id,state,library_profile_pin
           FROM library.progress_session WHERE route=$1 AND account_id=$2 AND session_id=$3`,
          [route, account.accountId, identity.occurrence.sessionId],
        );
        const occurrence = occurrenceResult.rows[0];
        if (
          !occurrence ||
          occurrence.state === 'retired' ||
          occurrence.subject_id !== identity.occurrence.subjectId ||
          occurrence.version_subject_id !== identity.occurrence.versionSubjectId ||
          new Date(occurrence.started_at).toISOString() !== identity.occurrence.startedAt ||
          occurrence.transaction_id !== identity.occurrence.transactionId ||
          entryImportMetadataDigest(occurrence.library_profile_pin) !==
            entryImportMetadataDigest(identity.occurrenceProfileBinding)
        )
          throw new LibraryConflictError();
      },
    };
  }
  async function reviewConsumptionDates(actor: Actor, id: string, input: VndbDateReviewInput, key: string) {
    const stored = await retainedRow(actor, id, input.ordinal),
      row = stored.row,
      decision = stored.decision,
      target = stored.target,
      matchingFingerprint = entryImportMetadataDigest(stored.matching),
      sourceFingerprint = entryImportMetadataDigest(row);
    if (
      !decision ||
      decision.reviewId !== input.sourceReviewToken ||
      !decision.targetId ||
      !decision.guard ||
      !target ||
      !['reviewed', 'applied', 'unsupported'].includes(decision.status) ||
      decision.matchDigest !== matchingFingerprint ||
      target.targetId !== decision.targetId ||
      target.source !== decision.guard.source
    )
      throw new LibraryConflictError();
    const session = await sessions.readPresentedSession(actor, input.occurrenceId, async (value) => value),
      occurrenceFact = await sessions.inspectSession(actor, input.occurrenceId);
    if (session.subjectId !== decision.targetId || session.state === 'retired') throw new LibraryNotFoundError();
    if (
      occurrenceFact.session.id !== session.id ||
      occurrenceFact.session.startedAt !== session.startedAt ||
      occurrenceFact.session.transactionId !== session.transactionId ||
      occurrenceFact.session.versionSubjectId !== session.versionSubjectId
    )
      throw new LibraryConflictError();
    const journal = await sessions.readSessionJournal(actor, input.occurrenceId),
      version = randomUUID(),
      profileBinding = { source: target.source, incarnationId: target.baseline?.incarnationId ?? null },
      profileDigest = dateProfileDigest(target);
    if (!profileDigest) throw new LibraryConflictError();
    const reviewed = reviewImportConsumptionDates({
      version,
      sourceReviewToken: decision.reviewId,
      sourceFingerprint,
      matchFingerprint: matchingFingerprint,
      subjectId: decision.targetId,
      profileDigest,
      profileBinding,
      occurrenceProfileBinding: occurrenceFact.pin,
      occurrence: {
        sessionId: session.id,
        subjectId: session.subjectId,
        versionSubjectId: session.versionSubjectId,
        startedAt: session.startedAt,
        transactionId: session.transactionId,
      },
      journal,
      start: vndbDateSource(row.fields.started),
      finish: vndbDateSource(row.fields.finished),
      actions: {
        ...(input.startAction === undefined ? {} : { startDate: input.startAction }),
        ...(input.finishAction === undefined ? {} : { finishDate: input.finishAction }),
      },
      profileCurrent: target.profileSupported,
    });
    const result = publicImportConsumptionDateReview(reviewed);
    if (Buffer.byteLength(JSON.stringify(result)) > IMPORT_CONSUMPTION_LIMITS.resultBytes)
      throw new ProblemError('content_too_large');
    const saved = await mutation(actor, 'consumption-dates-review', key, { id, input }, async (tx, account) => {
      const locked = await tx.query<{ row: VndbRow | null; decision: Decision | null }>(
        `SELECT rows->$4::integer AS row,decisions->$4::text AS decision FROM library.vndb_import
         WHERE route=$1 AND account_id=$2 AND upload_id=$3 AND state='active'
           AND expires_at>clock_timestamp() FOR UPDATE`,
        [requireRoute(account.accountId), account.accountId, id, input.ordinal],
      );
      const currentRow = locked.rows[0]?.row,
        current = locked.rows[0]?.decision,
        pending = current?.consumptionDateIntent;
      if (
        !currentRow ||
        !current ||
        current.reviewId !== decision.reviewId ||
        current.matchDigest !== matchingFingerprint ||
        entryImportMetadataDigest(currentRow) !== sourceFingerprint ||
        (pending?.patch && (!pending.outcome || pending.outcome.status === 'failed'))
      )
        throw new ProblemError('conflict');
      const next = { ...current, consumptionDateReview: reviewed };
      delete next.consumptionDateIntent;
      await save(tx, account, id, input.ordinal, next);
      return publicImportConsumptionDateReview(reviewed);
    });
    return saved;
  }
  async function currentConsumptionDates(
    actor: Actor,
    id: string,
    ordinal: number,
    reviewed: ImportConsumptionDateReview,
  ) {
    const retained = await retainedRow(actor, id, ordinal),
      decision = retained.decision,
      target = retained.target;
    if (
      retained.state !== 'active' ||
      retained.expires_at.getTime() <= Date.now() ||
      !decision ||
      decision.reviewId !== reviewed.sourceReviewToken ||
      decision.targetId !== reviewed.subjectId ||
      !decision.guard ||
      decision.guard.source !== target?.source ||
      decision.matchDigest !== reviewed.matchFingerprint ||
      entryImportMetadataDigest(retained.row) !== reviewed.sourceFingerprint ||
      entryImportMetadataDigest(retained.matching) !== reviewed.matchFingerprint ||
      decision.consumptionDateReview?.version !== reviewed.version ||
      dateProfileDigest(target) !== reviewed.profileDigest
    )
      return false;
    const session = await sessions.readPresentedSession(actor, reviewed.occurrence.sessionId, async (value) => value),
      occurrenceFact = await sessions.inspectSession(actor, reviewed.occurrence.sessionId),
      journal = await sessions.readSessionJournal(actor, reviewed.occurrence.sessionId);
    return (
      session.id === reviewed.occurrence.sessionId &&
      session.subjectId === reviewed.occurrence.subjectId &&
      session.versionSubjectId === reviewed.occurrence.versionSubjectId &&
      session.startedAt === reviewed.occurrence.startedAt &&
      session.transactionId === reviewed.occurrence.transactionId &&
      session.state !== 'retired' &&
      entryImportMetadataDigest(occurrenceFact.pin) === entryImportMetadataDigest(reviewed.occurrenceProfileBinding) &&
      journal.revision === reviewed.journalRevision
    );
  }
  async function applyConsumptionDates(
    actor: Actor,
    id: string,
    input: VndbDateApplyInput,
    record: (outcome: CommandOutcome<unknown>) => void,
    signal?: AbortSignal,
  ) {
    if (
      !input.confirm ||
      input.rows.length > Math.min(IMPORT_CONSUMPTION_LIMITS.rows, VNDB_LIMITS.page) ||
      new Set(input.rows.map((item) => item.ordinal)).size !== input.rows.length
    )
      throw new ProblemError('invalid_request');
    const deadline = Date.now() + VNDB_LIMITS.applyMs,
      result = await applyImportConsumptionDateRows(
        input.rows,
        signal,
        async (item) => {
          const retained = await retainedRow(actor, id, item.ordinal, true),
            decision = retained.decision,
            reviewed = decision?.consumptionDateReview;
          if (
            !decision ||
            !reviewed ||
            reviewed.version !== item.version ||
            decision.reviewId !== reviewed.sourceReviewToken
          )
            return {
              version: item.version,
              status: 'stale' as const,
              fields: item.fields.map((field) => ({ field, status: 'stale' as const })),
              receipt: null,
            };
          const previous = decision.consumptionDateIntent;
          if ((retained.state !== 'active' || retained.expires_at.getTime() <= Date.now()) && !previous?.patch)
            return {
              version: item.version,
              status: 'stale' as const,
              fields: item.fields.map((field) => ({ field, status: 'stale' as const })),
              receipt: null,
            };
          if (previous && (previous.version !== item.version || previous.fields.join(',') !== item.fields.join(',')))
            throw new ProblemError('conflict');
          const account = owner(actor),
            nativeRequestKey = previous?.nativeRequestKey ?? `vndb:${id}:${item.ordinal}:dates:${item.version}:journal`,
            identity: VndbDateAdmissionIdentity = (previous?.admissionIdentity as
              | VndbDateAdmissionIdentity
              | undefined) ?? {
              provider: 'vndb',
              uploadId: id,
              ordinal: item.ordinal,
              sourceReviewToken: reviewed.sourceReviewToken,
              dateReviewVersion: reviewed.version,
              sourceFingerprint: reviewed.sourceFingerprint,
              matchFingerprint: reviewed.matchFingerprint,
              subjectId: reviewed.subjectId,
              profileDigest: reviewed.profileDigest,
              occurrence: reviewed.occurrence,
              occurrenceProfileBinding: reviewed.occurrenceProfileBinding,
              clientId: account.clientId,
              requestedBy: account.requestedBy ?? null,
            },
            nativeAdmission = await dateAdmission(actor, identity),
            intent = await executeImportConsumptionDateIntent<Awaited<ReturnType<typeof sessions.patchSessionJournal>>>(
              {
                review: reviewed,
                fields: item.fields,
                ...(previous ? { existing: previous } : {}),
                nativeRequestKey,
                admissionIdentity: identity,
                admission: nativeAdmission,
                isCurrent: () => currentConsumptionDates(actor, id, item.ordinal, reviewed),
                async persist(next) {
                  try {
                    const saved = await mutation(
                      actor,
                      'consumption-dates-intent',
                      `vndb:${id}:${item.ordinal}:dates:${item.version}:${entryImportMetadataDigest(next)}`,
                      {
                        id,
                        ordinal: item.ordinal,
                        version: item.version,
                        fields: item.fields,
                        digest: entryImportMetadataDigest(next),
                      },
                      async (tx, account) => {
                        const locked = await tx.query<{
                          row: VndbRow | null;
                          decision: Decision | null;
                          active: boolean;
                        }>(
                          `SELECT rows->$4::integer AS row,decisions->$4::text AS decision,
                           state='active' AND expires_at>clock_timestamp() AS active
                         FROM library.vndb_import WHERE route=$1 AND account_id=$2 AND upload_id=$3 FOR UPDATE`,
                          [requireRoute(account.accountId), account.accountId, id, item.ordinal],
                        );
                        const row = locked.rows[0]?.row,
                          current = locked.rows[0]?.decision,
                          original = current?.consumptionDateIntent;
                        if (
                          !row ||
                          !current ||
                          current.reviewId !== reviewed.sourceReviewToken ||
                          current.consumptionDateReview?.version !== reviewed.version ||
                          entryImportMetadataDigest(row) !== reviewed.sourceFingerprint ||
                          (!locked.rows[0]?.active && !original?.patch) ||
                          (original !== undefined &&
                            (original.nativeRequestKey !== next.nativeRequestKey ||
                              original.version !== next.version ||
                              original.fields.join(',') !== next.fields.join(',') ||
                              entryImportMetadataDigest(original.patch) !== entryImportMetadataDigest(next.patch) ||
                              entryImportMetadataDigest(original.admissionIdentity) !==
                                entryImportMetadataDigest(next.admissionIdentity)))
                        )
                          throw new LibraryConflictError();
                        await save(tx, account, id, item.ordinal, { ...current, consumptionDateIntent: next });
                        return { version: reviewed.version };
                      },
                    );
                    record(saved);
                    return true;
                  } catch (error) {
                    if (error instanceof LibraryConflictError) return false;
                    throw error;
                  }
                },
                patch: (sessionId, patch, requestKey, admission) =>
                  sessions.patchSessionJournal(actor, sessionId, patch, requestKey, admission),
                record: (outcome) => record(outcome as CommandOutcome<unknown>),
                ...(signal ? { signal } : {}),
                isStaleError: (error) =>
                  error instanceof ProgressConflictError ||
                  error instanceof LibraryConflictError ||
                  error instanceof LibraryNotFoundError ||
                  (error instanceof ProblemError &&
                    ['conflict', 'not_found', 'unsupported_library_profile'].includes(error.code)),
                rethrowError: (error) =>
                  !(
                    error instanceof ProblemError ||
                    error instanceof ProgressInvalidError ||
                    error instanceof ProgressConflictError ||
                    error instanceof LibraryConflictError ||
                    error instanceof LibraryNotFoundError
                  ),
              },
            );
          return (
            intent.outcome ?? {
              version: item.version,
              status: 'unattempted' as const,
              fields: item.fields.map((field) => ({ field, status: 'unattempted' as const })),
              receipt: null,
            }
          );
        },
        (item) => ({
          version: item.version,
          status: 'unattempted',
          fields: item.fields.map((field) => ({ field, status: 'unattempted' })),
          receipt: null,
        }),
        () => Date.now() >= deadline,
      ),
      outcomes = result.outcomes.map((outcome, index) => ({ ordinal: input.rows[index]!.ordinal, ...outcome }));
    if (Buffer.byteLength(JSON.stringify(outcomes)) > IMPORT_CONSUMPTION_LIMITS.resultBytes)
      throw new ProblemError('content_too_large');
    return {
      uploadId: id,
      outcomes,
      complete: result.complete,
      stopped: signal?.aborted ? 'cancelled' : Date.now() >= deadline ? 'deadline' : null,
    };
  }
  // Fresh effects still use VNDB's parent/source fence inside the native write transaction.
  function metadataAdmission(
    actor: Actor,
    id: string,
    ordinal: number,
    reviewed: EntryImportMetadataReview,
  ): LabelCommandAdmission {
    const input = {
      provider: 'vndb',
      uploadId: id,
      ordinal,
      reviewToken: reviewed.token,
      sourceReviewToken: reviewed.sourceReviewToken,
      subjectId: reviewed.subjectId,
      sourceDigest: reviewed.sourceDigest,
      profileDigest: reviewed.profileDigest,
      incarnationId: reviewed.incarnationId,
      clientId: reviewed.clientId,
      requestedBy: reviewed.requestedBy,
      selectionDigest: reviewed.confirmation!.selectionDigest,
    };
    return {
      input: reviewed.confirmation?.nativeAdmission === 'vndb-source-v1' ? input : undefined,
      async prepare(at) {
        const retained = await retainedRow(actor, id, ordinal),
          target = await current(actor, reviewed.subjectId, at),
          decision = retained.decision;
        if (
          !decision ||
          decision.reviewId !== reviewed.sourceReviewToken ||
          decision.targetId !== reviewed.subjectId ||
          !target ||
          target.targetId !== reviewed.subjectId ||
          target.source !== decision.guard?.source ||
          dateProfileDigest(target) !== reviewed.profileDigest ||
          entryImportMetadataDigest(retained.matching) !== decision.matchDigest
        )
          throw new LibraryConflictError();
        return async (tx) => {
          const account = owner(actor);
          if (account.clientId !== reviewed.clientId || (account.requestedBy ?? null) !== reviewed.requestedBy)
            throw new LibraryConflictError();
          const locked = await tx.query<{ row: VndbRow; decision: Decision; active: boolean }>(
            `SELECT rows->$4::integer AS row,decisions->$5::text AS decision,
               state='active' AND expires_at>clock_timestamp() AS active
             FROM library.vndb_import WHERE route=$1 AND account_id=$2 AND upload_id=$3 FOR SHARE`,
            [requireRoute(account.accountId), account.accountId, id, ordinal, String(ordinal)],
          );
          const stored = locked.rows[0],
            record = stored?.decision?.metadata?.find((item) => item.token === reviewed.token);
          if (
            !stored?.active ||
            stored.decision.reviewId !== reviewed.sourceReviewToken ||
            stored.decision.targetId !== reviewed.subjectId ||
            stored.decision.guard?.source !== target.source ||
            stored.decision.matchDigest !== decision.matchDigest ||
            entryImportMetadataDigest(stored.row) !== reviewed.sourceDigest ||
            !record?.confirmation ||
            record.sourceReviewToken !== reviewed.sourceReviewToken ||
            record.subjectId !== reviewed.subjectId ||
            record.profileDigest !== reviewed.profileDigest ||
            record.confirmation.selectionDigest !== input.selectionDigest ||
            (!record.confirmation.annotationStarted && !record.confirmation.provenanceStarted)
          )
            throw new LibraryConflictError();
        };
      },
    };
  }

  async function metadataReceipt(
    { actor, id, ordinal }: { actor: Actor; id: string; ordinal: number },
    recovery: ListImportMetadataExpiredRecovery & {
      confirmation: NonNullable<ListImportMetadataExpiredRecovery['confirmation']>;
    },
    phase: 'annotation' | 'provenance',
    expiredOnly: boolean,
  ) {
    const account = owner(actor),
      confirmation = recovery.confirmation,
      annotation = phase === 'annotation',
      key = annotation ? confirmation.annotationKey : confirmation.provenanceKey,
      digest = annotation ? confirmation.annotationReceiptDigest : confirmation.provenanceReceiptDigest,
      started = annotation ? confirmation.annotationStarted : confirmation.provenanceStarted,
      kind = annotation
        ? 'library.entry.annotations.put'
        : confirmation.provenanceKind === 'admit'
          ? 'library.entry.source-observation.admit'
          : 'library.entry.source-observation.correct';
    if (!started || !digest) return false;
    const receipt = await personalEntries.readCommandReceipt(actor, {
      kind,
      requestKey: key,
      digest,
      async authorize(tx) {
        const linked = await tx.query(
          `SELECT 1 FROM library.vndb_import u
           CROSS JOIN LATERAL jsonb_array_elements(COALESCE(u.decisions->$4::text->'metadata','[]'::jsonb)) m
           WHERE u.route=$1 AND u.account_id=$2 AND u.upload_id=$3
             AND u.decisions->$4::text->>'reviewId'=$6
             AND m->>'token'=$5 AND m->>'sourceReviewToken'=$6
             AND m->>'subjectId'=$7 AND m->>'clientId'=$8
             AND m->>'requestedBy' IS NOT DISTINCT FROM $9::text
             AND m->'confirmation'->>$10='true'
             AND m->'confirmation'->>$11=$12
             AND m->'confirmation'->>$13=$14
             AND m->'confirmation'->>'selectionDigest'=$15
             AND ($16::text IS NULL OR m->'confirmation'->>'provenanceKind'=$16)
             AND ${
               expiredOnly
                 ? "u.expires_at<=clock_timestamp() AND u.expires_at+interval '24 hours'>clock_timestamp()"
                 : "(u.expires_at>clock_timestamp() OR u.expires_at+interval '24 hours'>clock_timestamp())"
             }
           FOR UPDATE OF u`,
          [
            requireRoute(account.accountId),
            account.accountId,
            id,
            String(ordinal),
            recovery.token,
            recovery.sourceReviewToken,
            recovery.subjectId,
            account.clientId,
            account.requestedBy ?? null,
            annotation ? 'annotationStarted' : 'provenanceStarted',
            annotation ? 'annotationKey' : 'provenanceKey',
            key,
            annotation ? 'annotationReceiptDigest' : 'provenanceReceiptDigest',
            digest,
            confirmation.selectionDigest,
            annotation ? null : (confirmation.provenanceKind ?? null),
          ],
        );
        if (!linked.rowCount) throw new LibraryNotFoundError();
      },
    });
    return receipt !== null;
  }

  const metadataCoordinator = createListImportMetadataCoordinator({
    provider: 'vndb',
    nativeAdmission: 'vndb-source-v1',
    native: personalEntries,
    async prepareReview({ actor, id, ordinal, sourceReviewToken }) {
      const upload = await load(actor, id),
        row = upload.rows[ordinal],
        decision = upload.decisions[ordinal];
      if (
        !row ||
        !decision ||
        row.kind !== 'vn' ||
        decision.reviewId !== sourceReviewToken ||
        !decision.targetId ||
        !decision.guard
      )
        throw new ProblemError('conflict');
      const history = decision.metadata ?? [];
      assertListImportMetadataReviewAvailable(history);
      const matching = await match(actor, row),
        profile = await metadataProfile(actor, decision);
      if (!profile || entryImportMetadataDigest(matching) !== decision.matchDigest) throw new ProblemError('conflict');
      const account = owner(actor),
        personal = await personalEntries.readPersonalEntry(actor, decision.targetId);
      return {
        history,
        identity: {
          sourceReviewToken,
          subjectId: decision.targetId,
          clientId: account.clientId,
          requestedBy: account.requestedBy ?? null,
          annotationRevision: personal.annotationRevision,
          personalDigest: entryPersonalMetadataDigest(personal),
          sourceDigest: entryImportMetadataDigest(row),
          profileDigest: profile.digest,
          incarnationId: profile.incarnationId,
        },
      };
    },
    async persistReview({ actor, id, ordinal, sourceReviewToken, key }, next) {
      return mutation(actor, 'metadata-review', key, { id, ordinal, sourceReviewToken }, async (tx, a) => {
        const locked = await tx.query<Upload>(
          `SELECT * FROM library.vndb_import WHERE route=$1 AND account_id=$2 AND upload_id=$3
            AND state='active' AND expires_at>clock_timestamp() FOR UPDATE`,
          [requireRoute(a.accountId), a.accountId, id],
        );
        const found = locked.rows[0],
          current = found?.decisions[ordinal];
        if (!found || !current || current.reviewId !== sourceReviewToken) throw new ProblemError('conflict');
        const appended = appendListImportMetadataReview(current.metadata ?? [], next);
        if (!appended.added) return { ordinal, reviewToken: appended.reviewToken };
        current.metadata = appended.history;
        await save(tx, a, id, ordinal, current);
        return { ordinal, reviewToken: appended.reviewToken };
      });
    },
    async loadReview({ actor, id, ordinal }, reviewToken, reconcile) {
      const upload = await load(actor, id, reconcile);
      if (upload.expires_at.getTime() <= Date.now()) throw new LibraryNotFoundError();
      return upload.decisions[ordinal]?.metadata?.find((item) => item.token === reviewToken) ?? null;
    },
    async loadExpiredRecovery({ actor, id, ordinal }, reviewToken) {
      const account = owner(actor);
      await authorized(actor);
      const found = await withReadTransaction(pool, (client) =>
        client.query<{ recovery: ListImportMetadataExpiredRecovery | null }>(
          `SELECT (
             SELECT jsonb_build_object(
               'token', m->>'token', 'sourceReviewToken', m->>'sourceReviewToken',
               'subjectId', m->>'subjectId', 'clientId', m->>'clientId',
               'requestedBy', m->'requestedBy',
               'confirmation', CASE WHEN m ? 'confirmation' THEN jsonb_build_object(
                 'fields', m->'confirmation'->'fields',
                 'selectionDigest', m->'confirmation'->'selectionDigest',
                 'annotationKey', m->'confirmation'->'annotationKey',
                 'provenanceKey', m->'confirmation'->'provenanceKey',
                 'annotationStarted', m->'confirmation'->'annotationStarted',
                 'provenanceStarted', m->'confirmation'->'provenanceStarted',
                 'annotationStatus', m->'confirmation'->'annotationStatus',
                 'provenanceStatus', m->'confirmation'->'provenanceStatus',
                 'annotationReceiptDigest', m->'confirmation'->'annotationReceiptDigest',
                 'provenanceReceiptDigest', m->'confirmation'->'provenanceReceiptDigest',
                 'provenanceKind', m->'confirmation'->'provenanceKind',
                 'fieldOutcomes', m->'confirmation'->'fieldOutcomes',
                 'outcome', CASE WHEN m->'confirmation' ? 'outcome' THEN jsonb_build_object(
                   'reviewToken', m->'confirmation'->'outcome'->'reviewToken',
                   'fields', COALESCE((SELECT jsonb_agg(jsonb_build_object(
                     'field', f->'field', 'status', f->'status'
                   ) ORDER BY f->>'field') FROM jsonb_array_elements(m->'confirmation'->'outcome'->'fields') f), '[]'::jsonb)
                 ) END
               ) END
             )
             FROM jsonb_array_elements(COALESCE(u.decisions->$4::text->'metadata','[]'::jsonb)) m
             WHERE m->>'token'=$5 AND m->>'sourceReviewToken'=u.decisions->$4::text->>'reviewId'
               AND m->>'clientId'=$6
               AND m->>'requestedBy' IS NOT DISTINCT FROM $7::text
           ) AS recovery
           FROM library.vndb_import u
           WHERE u.route=$1 AND u.account_id=$2 AND u.upload_id=$3
             AND u.expires_at<=clock_timestamp()
             AND u.expires_at+interval '24 hours'>clock_timestamp()`,
          [
            requireRoute(account.accountId),
            account.accountId,
            id,
            String(ordinal),
            reviewToken,
            account.clientId,
            account.requestedBy ?? null,
          ],
        ),
      );
      await authorized(actor);
      return found.rows[0]?.recovery ?? null;
    },
    async recoverReceipt({ actor, id, ordinal }, recovery, phase) {
      return metadataReceipt({ actor, id, ordinal }, recovery, phase, true);
    },
    async readReceipt({ actor, id, ordinal }, review, phase) {
      if (!review.confirmation) return false;
      return metadataReceipt(
        { actor, id, ordinal },
        review as typeof review & { confirmation: NonNullable<typeof review.confirmation> },
        phase,
        false,
      );
    },
    async readView({ actor, id, ordinal, reconcile }, reviewToken) {
      const upload = await load(actor, id, reconcile),
        row = upload.rows[ordinal],
        decision = upload.decisions[ordinal];
      if (!row || !decision) throw new ProblemError('not_found');
      const review = decision.metadata?.find((item) => item.token === reviewToken);
      if (!review) throw new ProblemError('conflict');
      const account = owner(actor),
        personal = await personalEntries.readPersonalEntry(actor, review.subjectId),
        profile = await metadataProfile(actor, decision),
        matching = await match(actor, row);
      if (!reconcile) {
        await authorized(actor);
        await retainedSource(actor, id);
      }
      return {
        review,
        observation: {
          sourceReviewToken: decision.reviewId,
          subjectId: decision.targetId,
          clientId: account.clientId,
          requestedBy: account.requestedBy ?? null,
          sourceDigest: entryImportMetadataDigest(row),
          profileDigest: profile?.digest ?? null,
          incarnationId: profile?.incarnationId ?? null,
          personal,
          proposals: vndbMetadataProposals(row),
          recordId: row.identifier!.value,
          providerCurrent:
            upload.state === 'active' &&
            upload.expires_at.getTime() > Date.now() &&
            decision.reviewId === review.sourceReviewToken &&
            decision.targetId === review.subjectId &&
            entryImportMetadataDigest(matching) === decision.matchDigest,
        },
      };
    },
    async confirm({ actor, id, ordinal }, reviewToken, proposed) {
      await mutation(
        actor,
        'metadata-confirm',
        `${id}:${ordinal}:${reviewToken}`,
        { id, ordinal, reviewToken, fields: proposed.fields },
        async (tx, a) => {
          const locked = await tx.query<Upload>(
            'SELECT * FROM library.vndb_import WHERE route=$1 AND account_id=$2 AND upload_id=$3 FOR UPDATE',
            [requireRoute(a.accountId), a.accountId, id],
          );
          const found = locked.rows[0],
            decision = found?.decisions[ordinal],
            record = decision?.metadata?.find((item) => item.token === reviewToken);
          if (!found || !record) throw new ProblemError('conflict');
          record.confirmation = listImportMetadataOrConflict(
            confirmListImportMetadata(record.confirmation, proposed, vndbMetadataFence(record, found, ordinal)),
            () => {
              throw new ProblemError('conflict');
            },
          );
          assertEntryImportMetadataHistorySize(decision!.metadata ?? []);
          await save(tx, a, id, ordinal, decision!);
          return { ordinal, reviewToken };
        },
      );
    },
    async persist({ actor, id, ordinal }, reviewToken, confirmation) {
      const stateDigest = entryImportMetadataDigest(confirmation);
      await mutation(
        actor,
        'metadata-progress',
        `${id}:${ordinal}:${reviewToken}:progress:${stateDigest}`,
        { id, ordinal, reviewToken, stateDigest },
        async (tx, a) => {
          const locked = await tx.query<Upload>(
            'SELECT * FROM library.vndb_import WHERE route=$1 AND account_id=$2 AND upload_id=$3 FOR UPDATE',
            [requireRoute(a.accountId), a.accountId, id],
          );
          const found = locked.rows[0],
            decision = found?.decisions[ordinal],
            record = decision?.metadata?.find((item) => item.token === reviewToken);
          if (!found || !record) throw new ProblemError('conflict');
          record.confirmation = listImportMetadataOrConflict(
            persistListImportMetadata(record.confirmation, confirmation, vndbMetadataFence(record, found, ordinal)),
            () => {
              throw new ProblemError('conflict');
            },
          );
          await save(tx, a, id, ordinal, decision!);
          return { ordinal, reviewToken };
        },
      );
    },
    async isCurrent({ actor, id, ordinal }, reviewed) {
      const latest = await load(actor, id, true),
        currentDecision = latest.decisions[ordinal],
        currentRow = latest.rows[ordinal];
      if (
        latest.state !== 'active' ||
        latest.expires_at.getTime() <= Date.now() ||
        !currentDecision ||
        !currentRow ||
        currentDecision.reviewId !== reviewed.sourceReviewToken ||
        entryImportMetadataDigest(currentRow) !== reviewed.sourceDigest
      )
        return false;
      const profile = await metadataProfile(actor, currentDecision),
        matching = await match(actor, currentRow);
      return (
        entryImportMetadataDigest(matching) === currentDecision.matchDigest &&
        profile?.digest === reviewed.profileDigest &&
        profile.incarnationId === reviewed.incarnationId
      );
    },
    async isCancelled({ actor, id }) {
      try {
        const latest = await load(actor, id, true);
        return latest.state !== 'active' || latest.expires_at.getTime() <= Date.now();
      } catch (error) {
        if (error instanceof LibraryNotFoundError) return true;
        throw error;
      }
    },
    admission: ({ actor, id, ordinal }, reviewed) => metadataAdmission(actor, id, ordinal, reviewed),
  });

  async function metadataView(
    actor: Actor,
    id: string,
    ordinal: number,
    token: string,
    reconcile = false,
  ): Promise<EntryImportMetadataView> {
    return metadataCoordinator.view({ actor, id, ordinal, reviewToken: token, reconcile });
  }

  async function reviewMetadata(actor: Actor, id: string, ordinal: number, sourceReviewToken: string, key: string) {
    return metadataCoordinator.review({ actor, id, ordinal, sourceReviewToken, key });
  }

  async function applyMetadata(
    actor: Actor,
    id: string,
    ordinal: number,
    reviewToken: string,
    fields: unknown,
    recordCommand?: (outcome: CommandOutcome<unknown>) => void,
    signal?: AbortSignal,
  ) {
    return metadataCoordinator.apply({
      actor,
      id,
      ordinal,
      reviewToken,
      fields,
      ...(recordCommand === undefined ? {} : { record: recordCommand }),
      ...(signal === undefined ? {} : { signal }),
    });
  }

  async function applyEntry(
    actor: Actor,
    id: string,
    choice: { ordinal: number; reviewId: string },
    initial: Decision | undefined,
    record: (outcome: CommandOutcome<unknown>) => void,
  ) {
    const staleOutcome = { ordinal: choice.ordinal, reviewId: choice.reviewId, status: 'stale' };
    if (!initial || initial.reviewId !== choice.reviewId || stateActionOf(initial) === null) return staleOutcome;
    let decision = initial;
    const action = stateActionOf(decision)!;
    let status = decision.status;
    const pendingEntry = decision.status === 'applying' || decision.status === 'failed';

    if (action === 'skip') status = 'skipped';
    else if (action === 'retain') status = 'unsupported';
    else if (action === 'state' && decision.status !== 'applied' && !pendingEntry) {
      const retained = await load(actor, id, true);
      const row = retained.rows[choice.ordinal];
      const matching = row ? await match(actor, row) : null;
      const target = decision.targetId ? await current(actor, decision.targetId) : null;
      if (
        !row ||
        entryImportMetadataDigest(row) !== (decision.progress?.sourceFingerprint ?? entryImportMetadataDigest(row)) ||
        !target ||
        !decision.guard ||
        decision.guard.uploadId !== id ||
        decision.guard.ordinal !== choice.ordinal ||
        decision.guard.reviewId !== decision.reviewId ||
        target.source !== decision.guard.source ||
        !matching ||
        entryImportMetadataDigest(matching) !== decision.matchDigest ||
        !decision.state ||
        !target.states.some((candidate) => candidate.id === decision.state) ||
        (decision.baseline?.revision ?? null) !== (target.baseline?.revision ?? null) ||
        (decision.baseline?.incarnationId ?? null) !== (target.baseline?.incarnationId ?? null)
      ) {
        status = 'stale';
      } else if (target.baseline && !decision.replace) {
        status = 'skipped';
      } else {
        const startKey = `vndb:${id}:${choice.ordinal}:${choice.reviewId}:entry:start`;
        const started = await mutation(
          actor,
          'apply-entry-start',
          startKey,
          { id, ordinal: choice.ordinal, reviewId: choice.reviewId },
          async (tx, account) => {
            const locked = await tx.query<{ decision: Decision | null; active: boolean }>(
              `SELECT decisions->$4::text AS decision,state='active' AND expires_at>clock_timestamp() AS active
             FROM library.vndb_import WHERE route=$1 AND account_id=$2 AND upload_id=$3 FOR UPDATE`,
              [requireRoute(account.accountId), account.accountId, id, String(choice.ordinal)],
            );
            const currentDecision = locked.rows[0]?.decision;
            if (
              !currentDecision ||
              currentDecision.reviewId !== choice.reviewId ||
              (!locked.rows[0]?.active && !pendingState(currentDecision))
            )
              throw new LibraryConflictError();
            await save(tx, account, id, choice.ordinal, { ...currentDecision, status: 'applying' });
            return { ordinal: choice.ordinal, reviewId: choice.reviewId };
          },
        );
        decision = { ...decision, status: 'applying' };
        record(started);
        try {
          const result = await entries.putEntry(
            actor,
            decision.targetId!,
            {
              state: decision.state,
              ...(decision.baseline
                ? { revision: decision.baseline.revision, incarnationId: decision.baseline.incarnationId }
                : {}),
            },
            decision.commandKey,
            decision.guard!,
          );
          decision.receipt = {
            partition: result.partition,
            epoch: result.epoch,
            position: result.position.toString(),
            transactionId: result.transactionId,
          };
          record(result);
          status = 'applied';
        } catch (error) {
          if (error instanceof GrantDeniedError) throw new ProblemError('forbidden');
          if (
            error instanceof LibraryConflictError ||
            error instanceof LibraryNotFoundError ||
            error instanceof LibraryEntryInvalidError ||
            (error instanceof ProblemError &&
              ['conflict', 'not_found', 'unsupported_library_profile'].includes(error.code))
          )
            status = 'stale';
          else throw error;
        }
      }
    } else if (action === 'state' && pendingEntry) {
      try {
        const result = await entries.putEntry(
          actor,
          decision.targetId!,
          {
            state: decision.state!,
            ...(decision.baseline
              ? { revision: decision.baseline.revision, incarnationId: decision.baseline.incarnationId }
              : {}),
          },
          decision.commandKey,
          decision.guard!,
        );
        decision.receipt = {
          partition: result.partition,
          epoch: result.epoch,
          position: result.position.toString(),
          transactionId: result.transactionId,
        };
        record(result);
        status = 'applied';
      } catch (error) {
        if (error instanceof GrantDeniedError) throw new ProblemError('forbidden');
        if (
          error instanceof LibraryConflictError ||
          error instanceof LibraryNotFoundError ||
          error instanceof LibraryEntryInvalidError ||
          (error instanceof ProblemError &&
            ['conflict', 'not_found', 'unsupported_library_profile'].includes(error.code))
        )
          status = 'stale';
        else throw error;
      }
    }

    let progress: ReturnType<typeof progressView> | null = null;
    if (
      decision.progress &&
      decision.progress.sourceFingerprint ===
        entryImportMetadataDigest((await load(actor, id, true)).rows[choice.ordinal])
    ) {
      const reviewedProgress = decision.progress;
      const checkpoint = await executeProgressAdoption(
        actor,
        sessions,
        reviewedProgress.plan,
        reviewedProgress.checkpoint,
        {
          async canceled() {
            try {
              const upload = await load(actor, id, true);
              return upload.state !== 'active' || upload.expires_at.getTime() <= Date.now();
            } catch (error) {
              if (error instanceof LibraryNotFoundError) return true;
              throw error;
            }
          },
          async binding() {
            const upload = await load(actor, id, true);
            const row = upload.rows[choice.ordinal];
            const currentDecision = upload.decisions[choice.ordinal];
            if (
              upload.state !== 'active' ||
              upload.expires_at.getTime() <= Date.now() ||
              !row ||
              entryImportMetadataDigest(row) !== reviewedProgress.sourceFingerprint ||
              !currentDecision ||
              currentDecision.reviewId !== choice.reviewId ||
              currentDecision.matchDigest !== decision.matchDigest
            )
              return null;
            const matching = await match(actor, row);
            const target = await current(actor, reviewedProgress.plan.subjectId);
            if (
              entryImportMetadataDigest(matching) !== currentDecision.matchDigest ||
              !target ||
              target.source !== currentDecision.guard?.source ||
              !target.profileBinding
            )
              return null;
            return target.profileBinding;
          },
          async save(next, admission = false) {
            const digest = entryImportMetadataDigest(next);
            try {
              const saved = await mutation(
                actor,
                admission ? 'progress-admission' : 'progress-checkpoint',
                `vndb:${id}:${choice.ordinal}:${choice.reviewId}:progress:${admission ? 'admission' : 'checkpoint'}:${digest}`,
                { id, ordinal: choice.ordinal, reviewId: choice.reviewId, admission, digest },
                async (tx, account) => {
                  const locked = await tx.query<{ decision: Decision | null; active: boolean }>(
                    `SELECT decisions->$4::text AS decision,state='active' AND expires_at>clock_timestamp() AS active
                   FROM library.vndb_import WHERE route=$1 AND account_id=$2 AND upload_id=$3 FOR UPDATE`,
                    [requireRoute(account.accountId), account.accountId, id, String(choice.ordinal)],
                  );
                  const currentDecision = locked.rows[0]?.decision;
                  if (
                    !currentDecision ||
                    currentDecision.reviewId !== choice.reviewId ||
                    currentDecision.matchDigest !== decision.matchDigest ||
                    currentDecision.progress?.sourceFingerprint !== reviewedProgress.sourceFingerprint ||
                    entryImportMetadataDigest(currentDecision.progress.plan) !==
                      entryImportMetadataDigest(reviewedProgress.plan)
                  )
                    throw new LibraryConflictError();
                  const hadAttempt =
                    currentDecision.progress.checkpoint?.startAttempted === true ||
                    Object.values(currentDecision.progress.checkpoint?.steps ?? {}).some((step) => step.attempted);
                  if (admission && !locked.rows[0]?.active) return { admitted: false };
                  if (!locked.rows[0]?.active && !hadAttempt && admission) return { admitted: false };
                  currentDecision.progress.checkpoint = next;
                  if (admission) currentDecision.status = 'applying';
                  await save(tx, account, id, choice.ordinal, currentDecision);
                  return { admitted: true };
                },
              );
              return saved.value.admitted;
            } catch (error) {
              if (
                admission &&
                (error instanceof LibraryConflictError ||
                  error instanceof LibraryNotFoundError ||
                  (error instanceof ProblemError && ['conflict', 'not_found'].includes(error.code)))
              )
                return false;
              throw error;
            }
          },
        },
      );
      decision = { ...decision, progress: { ...reviewedProgress, checkpoint } };
      const statuses = progressResults(reviewedProgress.plan, checkpoint).map((measure) => measure.status);
      if (statuses.includes('stale')) status = 'stale';
      else if (statuses.includes('failed')) status = 'failed';
      else if (statuses.includes('applied') || statuses.includes('cleared')) status = 'applied';
      else if (
        action === 'progress' &&
        statuses.every(
          (value) => value === 'unsupported' || value === 'invalid' || value === 'missing' || value === 'unknown',
        )
      )
        status = 'unsupported';
      else if (action === 'progress' && status === 'reviewed') status = 'skipped';
      progress = await progressResponse(actor, decision.progress!);
    }

    const nextDecision = { ...decision, status };
    await mutation(
      actor,
      'apply-entry-result',
      `vndb:${id}:${choice.ordinal}:${choice.reviewId}:result:${entryImportMetadataDigest({
        status,
        progress: nextDecision.progress?.checkpoint ?? null,
      })}`,
      {
        id,
        ordinal: choice.ordinal,
        reviewId: choice.reviewId,
        status,
        progress: nextDecision.progress?.checkpoint ?? null,
      },
      async (tx, account) => {
        const locked = await tx.query<{ decision: Decision | null }>(
          'SELECT decisions->$4::text AS decision FROM library.vndb_import WHERE route=$1 AND account_id=$2 AND upload_id=$3 FOR UPDATE',
          [requireRoute(account.accountId), account.accountId, id, String(choice.ordinal)],
        );
        const currentDecision = locked.rows[0]?.decision;
        if (!currentDecision || currentDecision.reviewId !== choice.reviewId) throw new LibraryConflictError();
        await save(tx, account, id, choice.ordinal, { ...currentDecision, ...nextDecision });
        return { ordinal: choice.ordinal, reviewId: choice.reviewId, status };
      },
    );
    return { ordinal: choice.ordinal, reviewId: choice.reviewId, status, progress };
  }

  /** The source owner contributes admission to the existing native vote command. */
  function scoreAdmission(actor: Actor, score: ScoreDecision): VoteCommandAdmission {
    const input = {
      provider: 'vndb',
      ...score.guard,
      targetId: score.targetId,
      sourceDigest: score.sourceDigest,
      matchDigest: score.matchDigest,
    };
    return {
      input,
      async prepare() {
        // Defer known source changes until after native receipt lookup. An exact
        // replay must not require live evidence or refresh any reviewed operand.
        let sourceChanged = false;
        try {
          const retained = await retainedRow(actor, score.guard.uploadId, score.guard.ordinal, true);
          const target = await current(actor, score.targetId);
          sourceChanged =
            !target ||
            target.source !== score.targetFingerprint ||
            entryImportMetadataDigest(retained.matching) !== score.matchDigest;
        } catch (error) {
          if (!(error instanceof LibraryNotFoundError)) throw error;
          sourceChanged = true;
        }
        return async (tx) => {
          if (sourceChanged) throw new LibraryConflictError();
          const account = owner(actor);
          const result = await tx.query<{ row: VndbRow; decision: Decision; active: boolean }>(
            `SELECT rows->$4::integer AS row, decisions->$5::text AS decision,
               state='active' AND expires_at>clock_timestamp() AS active
             FROM library.vndb_import WHERE route=$1 AND account_id=$2 AND upload_id=$3 FOR UPDATE`,
            [
              requireRoute(account.accountId),
              account.accountId,
              score.guard.uploadId,
              score.guard.ordinal,
              String(score.guard.ordinal),
            ],
          );
          const stored = result.rows[0];
          if (
            !stored?.active ||
            stored.decision.score?.reviewId !== score.reviewId ||
            entryImportMetadataDigest(stored.row) !== score.sourceDigest
          )
            throw new LibraryConflictError();
        };
      },
    };
  }

  /** Rebuild the closed vote operand after JSONB: key order and numeric coercions cannot fail participant.prepare. */
  function closedVoteIdentity(identity: NonNullable<ScoreDecision['nativeGuard']['subject']['identity']>) {
    return {
      version: 1 as const,
      requestedOriginalId: identity.requestedOriginalId,
      canonicalTerminalId: identity.canonicalTerminalId,
      sourceIdentities: [...identity.sourceIdentities],
      sourceHomes: identity.sourceHomes.map((home) => Number(home)),
      controlLocators: identity.controlLocators.map((locator) => ({
        partition: Number(locator.partition),
        group: locator.group,
      })),
      evidence: identity.evidence,
    };
  }

  function closedVoteGuard(score: ScoreDecision): VoteReviewGuard {
    const identity = score.nativeGuard.subject.identity;
    const observation =
      typeof score.nativeGuard.ownVote.observation === 'string'
        ? score.nativeGuard.ownVote.observation
        : JSON.stringify(score.nativeGuard.ownVote.observation);
    return {
      version: 1,
      question: {
        revision: Number(score.nativeGuard.question.revision),
        lifecycleRevision: Number(score.nativeGuard.question.lifecycleRevision),
      },
      subject: {
        canonicalId: score.nativeGuard.subject.canonicalId,
        epochs: score.nativeGuard.subject.epochs.map((entry) => ({
          partition: Number(entry.partition),
          epoch: String(entry.epoch),
        })),
        ...(identity === undefined ? {} : { identity: closedVoteIdentity(identity) }),
      },
      ownVote: {
        state: score.nativeGuard.ownVote.state,
        observation,
      },
    };
  }

  function scoreCommandInput(score: ScoreDecision): PreparedPutVote['input'] {
    return {
      questionId: score.question.id,
      targetId: score.targetId,
      units: score.units === null ? null : Number(score.units),
      guard: closedVoteGuard(score),
      observation: {
        subjectId: score.nativeGuard.subject.canonicalId,
        question: {
          id: score.question.id,
          revision: Number(score.question.revision),
          grain: score.question.grain,
          meaning: score.question.meaning ?? score.question.label,
          scale: {
            min: Number(score.question.scale.min),
            max: Number(score.question.scale.max),
            displayStep: Number(score.question.scale.step),
          },
        },
      },
    };
  }

  async function applyScore(
    actor: Actor,
    id: string,
    choice: { ordinal: number; scoreReviewId: string },
    decision: Decision | undefined,
    record: (component: SessionComponent) => void,
  ) {
    let score = decision?.score;
    const outcome = (status: string, currentVote?: NativeVoteObservation) => ({
      ordinal: choice.ordinal,
      scoreReviewId: choice.scoreReviewId,
      status,
      ...(currentVote ? { currentVote } : {}),
    });
    if (!score || score.reviewId !== choice.scoreReviewId || !score.nativeGuard) return outcome('stale');
    if (['applied', 'skipped', 'stale'].includes(score.status)) {
      const review =
        score.status === 'applied' ? await votes.readVoteReview(actor, score.question.id, score.targetId) : null;
      return outcome(score.status, review ? nativeVoteFromReview(review.currentVote) : undefined);
    }
    const retry = !!score.commandActor;
    if (!score.commandActor) {
      const commandActor = structuredClone(owner(actor));
      const command = votes.preparePutVote(
        commandActor,
        scoreCommandInput(score),
        score.commandKey,
        scoreAdmission(commandActor, score),
      );
      const frozen = { ...score, status: 'applying' as const, commandActor, command };
      const started = await mutation(
        actor,
        'score-start',
        `${score.commandKey}:start`,
        { id, choice },
        async (tx, account) => {
          const result = await tx.query<{ decision: Decision; active: boolean }>(
            `SELECT decisions->$4::text AS decision, state='active' AND expires_at>clock_timestamp() AS active
           FROM library.vndb_import WHERE route=$1 AND account_id=$2 AND upload_id=$3 FOR UPDATE`,
            [requireRoute(account.accountId), account.accountId, id, String(choice.ordinal)],
          );
          const stored = result.rows[0];
          if (!stored?.active || stored.decision.score?.reviewId !== choice.scoreReviewId)
            throw new LibraryConflictError();
          // Concurrent starts use the same stored credential, regardless of caller.
          const original = stored.decision.score.commandActor ? stored.decision.score : frozen;
          await save(tx, account, id, choice.ordinal, { ...stored.decision, score: original });
          return original;
        },
      );
      score = started.value;
      record(started);
    }
    let status = 'applied';
    try {
      // Pending dispatches may settle their exact receipt without re-admitting a fresh effect.
      // Historical dispatches predate producer-prepared receipt retention.
      const reconciled =
        retry && score.command ? await votes.reconcilePutVote(score.commandActor!, score.command.receipt) : null;
      const result =
        reconciled ??
        (await votes.putVoteOutcome(
          score.commandActor!,
          scoreCommandInput(score),
          score.commandKey,
          scoreAdmission(score.commandActor!, score),
        ));
      if (result.component) record(result.component);
    } catch (error) {
      if (error instanceof VoteReviewUnavailableError) return outcome('unavailable');
      if (error instanceof VoteReviewStaleError || error instanceof LibraryConflictError) status = 'stale';
      else throw error;
    }
    const reviewed = status === 'applied' ? await votes.readVoteReview(actor, score.question.id, score.targetId) : null;
    const settled = await mutation(
      actor,
      'score-finish',
      `${score.commandKey}:finish:${status}`,
      { id, choice, status },
      async (tx, account) => {
        const result = await tx.query<{ decision: Decision }>(
          `SELECT decisions->$4::text AS decision FROM library.vndb_import
         WHERE route=$1 AND account_id=$2 AND upload_id=$3 FOR UPDATE`,
          [requireRoute(account.accountId), account.accountId, id, String(choice.ordinal)],
        );
        const stored = result.rows[0]?.decision;
        if (!stored || stored.score?.reviewId !== choice.scoreReviewId) throw new LibraryConflictError();
        await save(tx, account, id, choice.ordinal, {
          ...stored,
          score: { ...stored.score, status: status as 'applied' | 'stale' },
        });
        return outcome(status);
      },
    );
    record(settled);
    return outcome(status, reviewed ? nativeVoteFromReview(reviewed.currentVote) : undefined);
  }

  async function apply(
    actor: Actor,
    id: string,
    selected: { ordinal: number; reviewId?: string; scoreReviewId?: string }[],
    record: (outcome: SessionComponent) => void,
    signal?: AbortSignal,
  ) {
    const deadline = Date.now() + VNDB_LIMITS.applyMs,
      outcomes: Array<{
        ordinal: number;
        reviewId?: string;
        scoreReviewId?: string;
        status: string;
        currentVote?: NativeVoteObservation;
      }> = [];
    if (
      !selected.length ||
      selected.length > VNDB_LIMITS.page ||
      new Set(selected.map((item) => item.ordinal)).size !== selected.length ||
      selected.some(
        (item) => (!item.reviewId && !item.scoreReviewId) || (item.reviewId && item.reviewId === item.scoreReviewId),
      ) ||
      selected.reduce((total, item) => total + Number(!!item.reviewId) + Number(!!item.scoreReviewId), 0) >
        VNDB_LIMITS.page
    )
      throw new ProblemError('invalid_request');
    let stopped: 'deadline' | 'cancelled' | null = null;
    for (const item of selected) {
      if (signal?.aborted || Date.now() >= deadline) {
        stopped = signal?.aborted ? 'cancelled' : 'deadline';
        break;
      }
      const upload = await load(actor, id, true);
      const decision = upload.decisions[item.ordinal];
      const inactive = upload.state !== 'active' || upload.expires_at.getTime() <= Date.now();
      if (
        inactive &&
        !(item.reviewId === decision?.reviewId && pendingState(decision)) &&
        !(
          item.scoreReviewId === decision?.score?.reviewId &&
          decision?.score?.commandActor &&
          ['applying', 'failed', 'unavailable'].includes(decision.score.status)
        )
      ) {
        stopped = 'cancelled';
        break;
      }
      if (item.reviewId)
        outcomes.push(
          await applyEntry(actor, id, { ordinal: item.ordinal, reviewId: item.reviewId }, decision, record),
        );
      if (inactive) {
        if (item.scoreReviewId && decision?.score?.commandActor)
          outcomes.push(
            await applyScore(actor, id, { ordinal: item.ordinal, scoreReviewId: item.scoreReviewId }, decision, record),
          );
        // Native receipt lookup can reconcile an earlier dispatch; its source fence
        // still refuses every fresh effect. Never continue into another action.
        stopped = 'cancelled';
        break;
      }
      if (!item.scoreReviewId) continue;
      if (signal?.aborted || Date.now() >= deadline) {
        stopped = signal?.aborted ? 'cancelled' : 'deadline';
        break;
      }
      outcomes.push(
        await applyScore(actor, id, { ordinal: item.ordinal, scoreReviewId: item.scoreReviewId }, decision, record),
      );
    }
    await authorized(actor);
    return { uploadId: id, outcomes, stopped };
  }
  async function remove(actor: Actor, id: string, key: string, cancel: boolean) {
    return mutation(actor, cancel ? 'cancel' : 'delete', key, { id }, async (tx, account) => {
      const query = cancel
        ? `UPDATE library.vndb_import SET state='cancelled' WHERE route=$1 AND account_id=$2 AND upload_id=$3`
        : 'DELETE FROM library.vndb_import WHERE route=$1 AND account_id=$2 AND upload_id=$3';
      await tx.query(query, [requireRoute(account.accountId), account.accountId, id]);
      return { uploadId: id, state: cancel ? 'cancelled' : 'deleted' };
    });
  }
  /** Addressed retained evidence for the separate, explicitly consented label journey.
   * Keep matching and private read authority with this source owner. */
  async function retainedRow(actor: Actor, id: string, ordinal: number, reconcile = false) {
    await authorized(actor);
    const account = owner(actor);
    const result = await withReadTransaction(pool, (client) =>
      client.query<{ row: VndbRow; decision: Decision | null; state: Upload['state']; expires_at: Date }>(
        `SELECT rows->$4::integer AS row,decisions->$5::text AS decision,state,expires_at
         FROM library.vndb_import WHERE route=$1 AND account_id=$2 AND upload_id=$3`,
        [requireRoute(account.accountId), account.accountId, id, ordinal, String(ordinal)],
      ),
    );
    const retained = result.rows[0];
    if (!retained?.row || (!reconcile && retained.expires_at.getTime() <= Date.now())) throw new LibraryNotFoundError();
    const matching = await match(actor, retained.row);
    const target = retained.decision?.targetId ? await current(actor, retained.decision.targetId) : null;
    await authorized(actor);
    if (!reconcile) await retainedSource(actor, id);
    return { ...retained, matching, target };
  }
  return {
    preview,
    page,
    review,
    reviewConsumptionDates,
    applyConsumptionDates,
    reviewMetadata,
    metadata: (actor: Actor, id: string, ordinal: number, token: string) => metadataView(actor, id, ordinal, token),
    applyMetadata,
    apply,
    remove,
    retainedRow: (actor: Actor, id: string, ordinal: number) => retainedRow(actor, id, ordinal),
    authorized,
    source: async (actor: Actor, id: string) => ({ xml: (await load(actor, id)).xml }),
  };
}

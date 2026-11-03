import { randomUUID } from 'node:crypto';
import { readAccount } from '../access/account-data.ts';
import { GrantDeniedError } from '../access/grant-commands.ts';
import { mintReadTime, type CommandOutcome } from '../command/command.ts';
import { tupleRoute } from '../content/imported-contract.ts';
import { ProblemError } from '../http/problem.ts';
import { readPartition } from '../partition/partition.ts';
import { accessCheck, type AccountActor, type Actor } from '../request/access.ts';
import { deadlineFor } from '../request/deadline.ts';
import { partitionOf } from '../route/route.ts';
import { createVoteCommands, STANDARD_QUESTION_ID, type RatingQuestion, type Vote } from '../rating/votes.ts';
import { withReadTransaction } from '../semantic/read.ts';
import { createLibraryCommandRunner, LibraryNotFoundError, requireRoute } from './command-support.ts';
import { createEntryCommands, LibraryConflictError, LibraryEntryInvalidError } from './entries.ts';
import { createEntryPersonalCommands } from './entry-personal.ts';
import type { Entry } from './entry-model.ts';
import { readLibraryProfileSourceObservation } from './profile-source.ts';
import { vndbSourceFingerprint, type VndbEntryReview } from './list-import-vndb-admission.ts';
import { parseVndb, VNDB_LIMITS, type SourceValue, type VndbRow } from './list-import-vndb-parser.ts';
import {
  applyEntryImportMetadataCommands,
  ENTRY_IMPORT_METADATA_LIMITS,
  assertEntryImportMetadataHistorySize,
  entryImportMetadataDigest,
  entryPersonalMetadataDigest,
  metadataObservation,
  parseEntryImportMetadataSelections,
  type EntryImportMetadataOutcome,
  type EntryImportMetadataProposal,
  type EntryImportMetadataProposals,
  type EntryImportMetadataReview,
  type EntryImportMetadataView,
} from './list-import-entry-metadata.ts';

type Config = Parameters<typeof createEntryCommands>[0] & { routeKey: Uint8Array };
const VNDB_DECISIONS_BYTES = 8_388_608;
export type VndbScoreSelection = { kind: 'vote'; units: number } | { kind: 'clear' };
export type VndbChoice =
  | { ordinal: number; action: 'skip' | 'retain'; targetId?: string }
  | { ordinal: number; action: 'state'; targetId?: string; state: string; replace?: boolean }
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
  status: 'reviewed' | 'unavailable' | 'applied' | 'skipped' | 'stale' | 'failed';
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
  nativeAdmission: 'unavailable';
};
type Decision = {
  reviewId: string;
  status: 'reviewed' | 'applying' | 'applied' | 'skipped' | 'unsupported' | 'stale' | 'failed';
  stateAction?: 'state' | 'skip' | 'retain' | null;
  targetId: string | null;
  state: string | null;
  baseline: { state: string; revision: number; incarnationId: string | null } | null;
  replace: boolean;
  commandKey: string;
  guard: VndbEntryReview | null;
  matchDigest?: string;
  metadata?: EntryImportMetadataReview[];
  score?: ScoreDecision;
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
      nativeAdmission: 'unavailable';
    }
  | { status: 'unavailable'; reason: 'native-question-unavailable' | 'native-current-vote-unavailable' };
type NativeScorePreview = {
  question: NativeQuestion | null;
  currentVote: NativeVoteObservation;
  sourceReason: string;
  exactUnits: number | null;
  admission: {
    status: 'unavailable';
    reason:
      | 'conditional-admission-unavailable'
      | 'native-question-unavailable'
      | 'native-current-vote-unavailable'
      | 'source-not-vn-score';
  };
};

function nativeQuestionView(question: RatingQuestion): NativeQuestion {
  return {
    id: question.id,
    revision: question.revision,
    meaning: question.meaning,
    label: question.label,
    grain: question.grain,
    scale: { min: question.minimumUnits, max: question.maximumUnits, step: question.stepUnits },
    aggregateEffect: 'public-standard-aggregate',
  };
}

function nativeVoteView(vote: Vote | null): NativeVoteObservation {
  if (!vote) return { state: 'absent' };
  return vote.units === null
    ? { state: 'cleared', revision: vote.revision, at: vote.changedAt }
    : { state: 'set', units: vote.units, revision: vote.revision, at: vote.changedAt };
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

function stateActionOf(decision: Decision): 'state' | 'skip' | 'retain' | null {
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
    Buffer.byteLength(noteField.value) > ENTRY_IMPORT_METADATA_LIMITS.noteBytes
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
      : token.length <= ENTRY_IMPORT_METADATA_LIMITS.privacyValueBytes && !/[\u0000-\u001f\u007f]/.test(raw)
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
const updated = (accountId: string) => [
  { type: 'com.rezics.library.personal-import.changed.v1', subject: accountId, data: {} },
];

/** Upload-local composition of existing native Library entry commands. No provider fetch or public output. */
export function createVndbImport(config: Config) {
  const { pool, access } = config;
  const runner = createLibraryCommandRunner(config),
    entries = createEntryCommands(config);
  const votes = createVoteCommands(config);
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
  async function load(actor: Actor, id: string): Promise<Upload> {
    await authorized(actor);
    const account = owner(actor);
    const result = await withReadTransaction(pool, (client) =>
      client.query<Upload>('SELECT * FROM library.vndb_import WHERE route=$1 AND account_id=$2 AND upload_id=$3', [
        requireRoute(account.accountId),
        account.accountId,
        id,
      ]),
    );
    if (!result.rows[0]) throw new LibraryNotFoundError();
    await authorized(actor);
    return result.rows[0];
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
  async function current(actor: Actor, targetId: string) {
    const at = await authorized(actor);
    const source = await readLibraryProfileSourceObservation(
      { pool, access, actor, at, deadline: deadlineFor(5000) },
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
    } catch {
      return null;
    }
  }
  async function nativeScorePreview(
    actor: Actor,
    source: SourceValue | undefined,
    targetId: string | undefined,
    question?: NativeQuestion | null,
  ): Promise<NativeScorePreview> {
    const selectedQuestion = question === undefined ? await nativeQuestion(actor) : question;
    let currentVote: NativeVoteObservation = { state: 'unavailable' };
    if (selectedQuestion && targetId) {
      try {
        currentVote = nativeVoteView(await votes.readOwnVote(actor, selectedQuestion.id, targetId));
      } catch {
        currentVote = { state: 'unavailable' };
      }
    }
    const score = source ?? { kind: 'missing' as const, raw: null };
    const treatment = sourceScoreReason(score);
    const reason = !selectedQuestion
      ? 'native-question-unavailable'
      : targetId && currentVote.state === 'unavailable'
        ? 'native-current-vote-unavailable'
        : 'conditional-admission-unavailable';
    return {
      question: selectedQuestion,
      currentVote,
      sourceReason: treatment.reason,
      exactUnits: treatment.exactUnits,
      admission: { status: 'unavailable', reason },
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
        decision: decision && stateActionOf(decision) !== null ? publicDecision(decision) : null,
        scoreDecision: decision?.score ? publicScoreDecision(decision.score) : null,
        nativeScore,
        fieldsTreatment: {
          state: decision?.state ? 'proposed native entry state' : 'retained; explicit state required',
          score: nativeScore.sourceReason,
          other: row.retainedReason,
        },
      });
    }
    await authorized(actor);
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
    return { reviewId, status, targetId, state, baseline, replace, action: stateActionOf(decision) };
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
    const preview = await nativeScorePreview(actor, row.fields.score, target.targetId);
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
        nativeAdmission: 'unavailable',
      };
    return mutation(actor, 'review-score', key, { id, choice }, async (tx, account) => {
      const stored = await tx.query<Upload>(
        `SELECT * FROM library.vndb_import
        WHERE route=$1 AND account_id=$2 AND upload_id=$3 AND state='active' AND expires_at>clock_timestamp() FOR UPDATE`,
        [requireRoute(account.accountId), account.accountId, id],
      );
      if (!stored.rows[0]) throw new ProblemError('conflict');
      const before = stored.rows[0].decisions[choice.ordinal];
      if (before?.status === 'applying' || ['applying', 'applied', 'failed'].includes(before?.score?.status ?? ''))
        throw new ProblemError('conflict');
      const compatible =
        before?.targetId === target.targetId &&
        before.matchDigest === matchDigest &&
        before.guard?.source === target.source;
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
    return mutation(actor, 'review', key, { id, choice }, async (tx, account) => {
      const stored = await tx.query<Upload>(
        `SELECT * FROM library.vndb_import
        WHERE route=$1 AND account_id=$2 AND upload_id=$3 AND state='active' AND expires_at>clock_timestamp() FOR UPDATE`,
        [requireRoute(account.accountId), account.accountId, id],
      );
      if (!stored.rows[0]) throw new ProblemError('conflict');
      const before = stored.rows[0].decisions[choice.ordinal];
      if (before && ['applying', 'applied', 'failed'].includes(before.status)) throw new ProblemError('conflict');
      if (before?.metadata?.some((item) => item.confirmation && !item.confirmation.outcome))
        throw new ProblemError('conflict');
      const reviewId = randomUUID();
      const decision: Decision = {
        reviewId,
        status: choice.action === 'skip' ? 'skipped' : choice.action === 'retain' ? 'unsupported' : 'reviewed',
        stateAction: choice.action === 'state' ? 'state' : choice.action,
        targetId: target?.targetId ?? null,
        state: choice.action === 'state' ? choice.state! : null,
        baseline: target?.baseline ?? null,
        replace: choice.replace === true,
        commandKey: `vndb:${id}:${reviewId}`,
        guard: target ? { uploadId: id, ordinal: choice.ordinal, reviewId, source: target.source } : null,
        matchDigest: entryImportMetadataDigest(matching),
        metadata: before?.metadata ?? [],
      };
      await save(tx, account, id, choice.ordinal, decision);
      return publicDecision(decision);
    });
  }
  async function metadataView(
    actor: Actor,
    id: string,
    ordinal: number,
    token: string,
  ): Promise<EntryImportMetadataView> {
    const upload = await load(actor, id),
      row = upload.rows[ordinal],
      decision = upload.decisions[ordinal];
    if (!row || !decision) throw new ProblemError('not_found');
    const record = decision.metadata?.find((item) => item.token === token);
    if (!record) throw new ProblemError('conflict');
    const account = owner(actor),
      personal = await personalEntries.readPersonalEntry(actor, record.subjectId);
    const profile = await metadataProfile(actor, decision),
      matching = await match(actor, row);
    const status =
      decision.reviewId === record.sourceReviewToken &&
      account.clientId === record.clientId &&
      (account.requestedBy ?? null) === record.requestedBy &&
      entryImportMetadataDigest(row) === record.sourceDigest &&
      entryPersonalMetadataDigest(personal) === record.personalDigest &&
      personal.annotationRevision === record.annotationRevision &&
      entryImportMetadataDigest(matching) === decision.matchDigest &&
      profile?.digest === record.profileDigest &&
      profile.incarnationId === record.incarnationId
        ? 'current'
        : 'stale';
    const view: EntryImportMetadataView = {
      status,
      reviewToken: token,
      sourceReviewToken: record.sourceReviewToken,
      subjectId: record.subjectId,
      personal,
      proposals: vndbMetadataProposals(row),
      outcome: record.confirmation?.outcome ?? null,
    };
    if (Buffer.byteLength(JSON.stringify(view)) > ENTRY_IMPORT_METADATA_LIMITS.responseBytes)
      throw new ProblemError('invalid_request');
    return view;
  }
  async function reviewMetadata(actor: Actor, id: string, ordinal: number, sourceReviewToken: string, key: string) {
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
    if (decision.metadata?.some((item) => item.confirmation && !item.confirmation.outcome))
      throw new ProblemError('conflict');
    const matching = await match(actor, row),
      profile = await metadataProfile(actor, decision);
    if (!profile || entryImportMetadataDigest(matching) !== decision.matchDigest) throw new ProblemError('conflict');
    const account = owner(actor),
      personal = await personalEntries.readPersonalEntry(actor, decision.targetId);
    const requestDigest = entryImportMetadataDigest({ key });
    const next: EntryImportMetadataReview = {
      token: randomUUID(),
      requestDigest,
      sourceReviewToken,
      subjectId: decision.targetId,
      clientId: account.clientId,
      requestedBy: account.requestedBy ?? null,
      annotationRevision: personal.annotationRevision,
      personalDigest: entryPersonalMetadataDigest(personal),
      sourceDigest: entryImportMetadataDigest(row),
      profileDigest: profile.digest,
      incarnationId: profile.incarnationId,
    };
    return mutation(actor, 'metadata-review', key, { id, ordinal, sourceReviewToken }, async (tx, a) => {
      const locked = await tx.query<Upload>(
        `SELECT * FROM library.vndb_import WHERE route=$1 AND account_id=$2 AND upload_id=$3
          AND state='active' AND expires_at>clock_timestamp() FOR UPDATE`,
        [requireRoute(a.accountId), a.accountId, id],
      );
      const found = locked.rows[0],
        current = found?.decisions[ordinal];
      if (!found || !current || current.reviewId !== sourceReviewToken) throw new ProblemError('conflict');
      const history = [...(current.metadata ?? [])],
        existing = history.find((item) => item.requestDigest === requestDigest);
      if (existing) return { ordinal, reviewToken: existing.token };
      if (history.some((item) => item.confirmation && !item.confirmation.outcome)) throw new ProblemError('conflict');
      if (history.length >= ENTRY_IMPORT_METADATA_LIMITS.reviewsPerRow) throw new ProblemError('conflict');
      history.push(next);
      assertEntryImportMetadataHistorySize(history);
      current.metadata = history;
      await save(tx, a, id, ordinal, current);
      return { ordinal, reviewToken: next.token };
    });
  }
  async function persistMetadataConfirmation(
    actor: Actor,
    id: string,
    ordinal: number,
    token: string,
    confirmation: EntryImportMetadataReview['confirmation'],
  ) {
    if (!confirmation) return;
    const stateDigest = entryImportMetadataDigest(confirmation);
    await mutation(
      actor,
      'metadata-progress',
      `${id}:${ordinal}:${token}:progress:${stateDigest}`,
      { id, ordinal, reviewToken: token, stateDigest },
      async (tx, a) => {
        const locked = await tx.query<Upload>(
          'SELECT * FROM library.vndb_import WHERE route=$1 AND account_id=$2 AND upload_id=$3 FOR UPDATE',
          [requireRoute(a.accountId), a.accountId, id],
        );
        const found = locked.rows[0],
          decision = found?.decisions[ordinal],
          record = decision?.metadata?.find((item) => item.token === token);
        if (!found || !record?.confirmation || record.confirmation.selectionDigest !== confirmation.selectionDigest)
          throw new ProblemError('conflict');
        const starting =
          (confirmation.annotationStarted && !record.confirmation.annotationStarted) ||
          (confirmation.provenanceStarted && !record.confirmation.provenanceStarted);
        if (
          starting &&
          (found.state !== 'active' ||
            decision?.reviewId !== record.sourceReviewToken ||
            entryImportMetadataDigest(found.rows[ordinal]) !== record.sourceDigest)
        )
          throw new ProblemError('conflict');
        record.confirmation = confirmation;
        await save(tx, a, id, ordinal, decision!);
        return { ordinal, reviewToken: token };
      },
    );
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
    const selections = parseEntryImportMetadataSelections(fields),
      selectionDigest = entryImportMetadataDigest(selections);
    let upload = await load(actor, id),
      decision = upload.decisions[ordinal],
      record = decision?.metadata?.find((item) => item.token === reviewToken);
    if (!record)
      return { reviewToken, fields: selections.map((item) => ({ field: item.field, status: 'stale' as const })) };
    if (record.confirmation && record.confirmation.selectionDigest !== selectionDigest)
      throw new ProblemError('conflict');
    if (record.confirmation?.outcome) return record.confirmation.outcome;
    if (!record.confirmation) {
      const confirmation = {
        fields: selections,
        selectionDigest,
        annotationKey: `vndb:${id}:${ordinal}:${reviewToken}:annotations`,
        provenanceKey: `vndb:${id}:${ordinal}:${reviewToken}:provenance`,
        annotationStarted: false,
        provenanceStarted: false,
      };
      await mutation(
        actor,
        'metadata-confirm',
        `${id}:${ordinal}:${reviewToken}`,
        { id, ordinal, reviewToken, fields: selections },
        async (tx, a) => {
          const locked = await tx.query<Upload>(
            'SELECT * FROM library.vndb_import WHERE route=$1 AND account_id=$2 AND upload_id=$3 FOR UPDATE',
            [requireRoute(a.accountId), a.accountId, id],
          );
          const found = locked.rows[0],
            current = found?.decisions[ordinal],
            metadata = current?.metadata?.find((item) => item.token === reviewToken);
          if (!found || !metadata) throw new ProblemError('conflict');
          if (metadata.confirmation) {
            if (metadata.confirmation.selectionDigest !== selectionDigest) throw new ProblemError('conflict');
            return { ordinal, reviewToken };
          }
          if (found.state !== 'active' || found.expires_at.getTime() <= Date.now()) throw new ProblemError('conflict');
          metadata.confirmation = confirmation;
          assertEntryImportMetadataHistorySize(current!.metadata ?? []);
          await save(tx, a, id, ordinal, current!);
          return { ordinal, reviewToken };
        },
      );
      upload = await load(actor, id);
      decision = upload.decisions[ordinal];
      record = decision?.metadata?.find((item) => item.token === reviewToken);
    }
    if (!record?.confirmation || !decision) throw new ProblemError('conflict');
    if (record.confirmation.outcome) return record.confirmation.outcome;
    const view = await metadataView(actor, id, ordinal, reviewToken);
    if (view.status !== 'current' && !record.confirmation.annotationStarted && !record.confirmation.provenanceStarted) {
      const outcome: EntryImportMetadataOutcome = {
        reviewToken,
        fields: selections.map((item) => ({ field: item.field, status: 'stale' })),
      };
      record.confirmation.outcome = outcome;
      await persistMetadataConfirmation(actor, id, ordinal, reviewToken, record.confirmation);
      return outcome;
    }
    const row = upload.rows[ordinal];
    if (!row) throw new ProblemError('not_found');
    const result = await applyEntryImportMetadataCommands({
      actor,
      subjectId: record.subjectId,
      provider: 'vndb',
      recordId: row.identifier!.value,
      reviewToken,
      personal: view.personal,
      proposals: view.proposals,
      selections,
      baselineAnnotationRevision: record.annotationRevision,
      confirmation: record.confirmation,
      native: personalEntries,
      persist: (confirmation) => persistMetadataConfirmation(actor, id, ordinal, reviewToken, confirmation),
      isCurrent: async () => {
        const latest = await load(actor, id),
          currentDecision = latest.decisions[ordinal],
          currentRow = latest.rows[ordinal];
        if (
          !currentDecision ||
          !currentRow ||
          currentDecision.reviewId !== record!.sourceReviewToken ||
          entryImportMetadataDigest(currentRow) !== record!.sourceDigest
        )
          return false;
        const profile = await metadataProfile(actor, currentDecision),
          matching = await match(actor, currentRow);
        return (
          entryImportMetadataDigest(matching) === currentDecision.matchDigest &&
          profile?.digest === record!.profileDigest &&
          profile.incarnationId === record!.incarnationId
        );
      },
      ...(recordCommand === undefined ? {} : { record: recordCommand }),
      isCancelled: async () => {
        try {
          return (await load(actor, id)).state !== 'active';
        } catch (error) {
          if (error instanceof LibraryNotFoundError) return true;
          throw error;
        }
      },
      ...(signal === undefined ? {} : { signal }),
    });
    return result.outcome;
  }
  async function save(
    tx: import('../command/command.ts').CommandTransaction,
    account: AccountActor,
    id: string,
    ordinal: number,
    decision: Decision,
  ) {
    const saved = await tx.query(
      `UPDATE library.vndb_import
      SET decisions=jsonb_set(decisions,ARRAY[$4::text],$5::jsonb)
      WHERE route=$1 AND account_id=$2 AND upload_id=$3
        AND octet_length(jsonb_set(decisions,ARRAY[$4::text],$5::jsonb)::text)<=$6`,
      [
        requireRoute(account.accountId),
        account.accountId,
        id,
        String(ordinal),
        JSON.stringify(decision),
        VNDB_DECISIONS_BYTES,
      ],
    );
    if (saved.rowCount !== 1) throw new ProblemError('conflict');
  }
  async function applyEntry(
    actor: Actor,
    id: string,
    item: { ordinal: number; reviewId: string },
    initial: Decision | undefined,
    record: (outcome: CommandOutcome<unknown>) => void,
  ) {
    let decision = initial;
    if (!decision || decision.reviewId !== item.reviewId || stateActionOf(decision) === null)
      return { ordinal: item.ordinal, reviewId: item.reviewId, status: 'stale' as const };
    if (['applied', 'skipped', 'unsupported', 'stale'].includes(decision.status))
      return { ordinal: item.ordinal, reviewId: item.reviewId, status: decision.status };
    if (decision.baseline && !decision.replace)
      return { ordinal: item.ordinal, reviewId: item.reviewId, status: 'skipped' as const };
    const started = await mutation(
      actor,
      'start',
      `${decision.commandKey}:start`,
      { id, item },
      async (tx, account) => {
        const locked = await tx.query<Upload>(
          `SELECT * FROM library.vndb_import
          WHERE route=$1 AND account_id=$2 AND upload_id=$3 AND state='active' AND expires_at>clock_timestamp() FOR UPDATE`,
          [requireRoute(account.accountId), account.accountId, id],
        );
        const found = locked.rows[0]?.decisions[item.ordinal];
        if (!found || found.reviewId !== item.reviewId) throw new ProblemError('conflict');
        found.status = 'applying';
        await save(tx, account, id, item.ordinal, found);
        return { reviewId: found.reviewId };
      },
    );
    record(started);
    // Reload frozen operands even when the start command was replayed.
    decision = (await load(actor, id)).decisions[item.ordinal]!;
    let status: Decision['status'] = 'failed';
    try {
      const result = await entries.putEntry(
        actor,
        decision.targetId!,
        {
          state: decision.state!,
          ...(decision.baseline
            ? {
                revision: decision.baseline.revision,
                ...(decision.baseline.incarnationId ? { incarnationId: decision.baseline.incarnationId } : {}),
              }
            : {}),
        },
        decision.commandKey,
        decision.guard!,
      );
      record(result);
      status = 'applied';
    } catch (error) {
      if (error instanceof GrantDeniedError) throw error;
      if (error instanceof LibraryConflictError || error instanceof LibraryNotFoundError) status = 'stale';
      else if (
        error instanceof LibraryEntryInvalidError ||
        (error instanceof ProblemError && error.code === 'unsupported_library_profile')
      )
        status = 'unsupported';
      // Transport/unknown failures retain the original operands and command for retry.
    }
    const finished = await mutation(
      actor,
      'finish',
      `${decision.commandKey}:finish:${status}`,
      { id, item, status },
      async (tx, account) => {
        const locked = await tx.query<Upload>(
          'SELECT * FROM library.vndb_import WHERE route=$1 AND account_id=$2 AND upload_id=$3 FOR UPDATE',
          [requireRoute(account.accountId), account.accountId, id],
        );
        const found = locked.rows[0]?.decisions[item.ordinal];
        if (found?.reviewId === item.reviewId && found.status !== 'applied') {
          found.status = status;
          await save(tx, account, id, item.ordinal, found);
        }
        return { status: found?.status ?? status };
      },
    );
    record(finished);
    return { ordinal: item.ordinal, reviewId: item.reviewId, status: finished.value.status };
  }
  async function applyScore(
    actor: Actor,
    id: string,
    item: { ordinal: number; scoreReviewId: string },
    initial: Decision | undefined,
    record: (outcome: CommandOutcome<unknown>) => void,
  ) {
    const score = initial?.score;
    if (!score || score.reviewId !== item.scoreReviewId)
      return { outcome: { ordinal: item.ordinal, scoreReviewId: item.scoreReviewId, status: 'stale' as const } };
    if (score.status === 'unavailable' || ['applied', 'skipped', 'stale', 'failed'].includes(score.status))
      return { outcome: { ordinal: item.ordinal, scoreReviewId: item.scoreReviewId, status: score.status } };
    const result = await mutation(
      actor,
      'score-unavailable',
      `${score.commandKey}:admission-unavailable`,
      { id, scoreReviewId: item.scoreReviewId },
      async (tx, account) => {
        const locked = await tx.query<Upload>(
          `SELECT * FROM library.vndb_import
          WHERE route=$1 AND account_id=$2 AND upload_id=$3 FOR UPDATE`,
          [requireRoute(account.accountId), account.accountId, id],
        );
        const stored = locked.rows[0];
        if (!stored || stored.state !== 'active' || stored.expires_at.getTime() <= Date.now())
          return { status: 'cancelled' as const };
        const found = stored.decisions[item.ordinal];
        if (!found?.score || found.score.reviewId !== item.scoreReviewId) return { status: 'stale' as const };
        if (['applied', 'skipped', 'stale', 'failed', 'unavailable'].includes(found.score.status))
          return { status: found.score.status };
        found.score.status = 'unavailable';
        await save(tx, account, id, item.ordinal, found);
        return { status: 'unavailable' as const };
      },
    );
    record(result);
    if (result.value.status === 'cancelled') return { stopped: 'cancelled' as const };
    return {
      outcome: { ordinal: item.ordinal, scoreReviewId: item.scoreReviewId, status: result.value.status },
    };
  }
  async function apply(
    actor: Actor,
    id: string,
    selected: { ordinal: number; reviewId?: string; scoreReviewId?: string }[],
    record: (outcome: CommandOutcome<unknown>) => void,
    signal?: AbortSignal,
  ) {
    const deadline = Date.now() + VNDB_LIMITS.applyMs,
      outcomes: Array<{ ordinal: number; reviewId?: string; scoreReviewId?: string; status: string }> = [];
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
      const upload = await load(actor, id);
      if (upload.state !== 'active' || upload.expires_at.getTime() <= Date.now()) {
        stopped = 'cancelled';
        break;
      }
      const decision = upload.decisions[item.ordinal];
      if (item.reviewId)
        outcomes.push(
          await applyEntry(actor, id, { ordinal: item.ordinal, reviewId: item.reviewId }, decision, record),
        );
      if (!item.scoreReviewId) continue;
      if (signal?.aborted || Date.now() >= deadline) {
        stopped = signal?.aborted ? 'cancelled' : 'deadline';
        break;
      }
      const scoreResult = await applyScore(
        actor,
        id,
        { ordinal: item.ordinal, scoreReviewId: item.scoreReviewId },
        decision,
        record,
      );
      if (scoreResult.outcome) outcomes.push(scoreResult.outcome);
      if (scoreResult.stopped) {
        stopped = scoreResult.stopped;
        break;
      }
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
  async function retainedRow(actor: Actor, id: string, ordinal: number) {
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
    if (!retained?.row || retained.expires_at.getTime() <= Date.now()) throw new LibraryNotFoundError();
    const matching = await match(actor, retained.row);
    const target = retained.decision?.targetId ? await current(actor, retained.decision.targetId) : null;
    await authorized(actor);
    return { ...retained, matching, target };
  }
  return {
    preview,
    page,
    review,
    reviewMetadata,
    metadata: metadataView,
    applyMetadata,
    apply,
    remove,
    retainedRow,
    authorized,
    source: async (actor: Actor, id: string) => ({ xml: (await load(actor, id)).xml }),
  };
}

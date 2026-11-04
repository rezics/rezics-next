import { randomUUID } from 'node:crypto';
import { createBangumiLabelReview } from './list-import-bangumi-labels.ts';
import type { BangumiLabelState } from './list-import-bangumi-label-model.ts';
import canonicalize from 'canonicalize';
import type { Pool } from 'pg';
import { readAccount } from '../access/account-data.ts';
import { GrantDeniedError } from '../access/grant-commands.ts';
import { mintReadTime, type CommandTransaction } from '../command/command.ts';
import type { KernelClock } from '../clock.ts';
import { tupleRoute } from '../content/imported-contract.ts';
import { ProblemError } from '../http/problem.ts';
import { RatingQuestionNotFoundError, STANDARD_QUESTION_ID, VOTE_SCOPE } from '../rating/votes.ts';
import type { Vote, createVoteCommands } from '../rating/votes.ts';
import { accessCheck, type Access, type Actor, type AccountActor } from '../request/access.ts';
import { deadlineFor } from '../request/deadline.ts';
import { newId, routeOf } from '../route/route.ts';
import readClaim from '../semantic/bulk-read-claim.sql';
import { withReadTransaction } from '../semantic/read.ts';
import type { KeyRing } from '../tokens/seal.ts';
import { createLibraryCommandRunner, LibraryNotFoundError, requireRoute } from './command-support.ts';
import { createEntryCommands, LibraryConflictError } from './entries.ts';
import { createEntryPersonalCommands } from './entry-personal.ts';
import { parseSourceTimestamp } from './entry-personal-model.ts';
import {
  ENTRY_IMPORT_METADATA_LIMITS,
  assertEntryImportMetadataHistorySize,
  entryImportMetadataDigest,
  entryPersonalMetadataDigest,
  type EntryImportMetadataProposal,
  type EntryImportMetadataConfirmation,
  type EntryImportMetadataProposals,
  type EntryImportMetadataView,
} from './list-import-entry-metadata.ts';
import {
  appendListImportMetadataReview,
  assertListImportMetadataReviewAvailable,
  createListImportMetadataCoordinator,
  mergeListImportMetadataConfirmation,
  selectListImportMetadataConfirmation,
  type ListImportMetadataExpiredRecovery,
} from './list-import-metadata-coordinator.ts';
import type { LabelCommandAdmission } from './label-command-admission.ts';
import { readLibraryProfileSourceObservation } from './profile-source.ts';
import {
  parseBangumiUpload,
  BANGUMI_LIMITS,
  type BangumiChoice,
  type BangumiOutcome,
  type BangumiReview,
  type BangumiRow,
  type BangumiScoreCurrentVote,
  type BangumiScoreQuestion,
  type BangumiScoreReview,
  type BangumiScoreSelection,
} from './list-import-bangumi-model.ts';

type NativeVotes = Pick<ReturnType<typeof createVoteCommands>, 'readOwnVote' | 'readRatingQuestion'>;
type Dependencies = {
  pool: Pool;
  access: Access;
  tokens: KeyRing;
  routeKey: Uint8Array;
  votes: NativeVotes;
  clock?: KernelClock;
};
type BangumiScorePlan = {
  action: 'set' | 'clear';
  units: number | null;
  consent: true;
  sourceState: BangumiScoreReview['source']['state'];
  sourceDigest: string;
  question: BangumiScoreQuestion | null;
  target: BangumiReview['guard'];
  baseline: NativeVoteGuard | null;
  commandKey: string;
  attribution: { provider: 'bangumi'; uploadId: string; ordinal: number; reviewToken: string };
};
type NativeVoteGuard =
  | { state: 'absent' }
  | { state: 'cleared'; revision: number }
  | { state: 'set'; units: number; revision: number };
type StoredReview = BangumiReview & { scoreGuard: NativeVoteGuard | null };
type StoredChoice = BangumiChoice & { scorePlan?: BangumiScorePlan };
type StoredRow = Omit<BangumiRow, 'review'> & {
  review: StoredReview | null;
  choice: StoredChoice | null;
  labels: BangumiLabelState | null;
};

function scoreSource(evidence: BangumiRow['evidence']): BangumiScoreReview['source'] {
  const field = evidence.fields.find((candidate) => candidate.field === 'rate');
  const scale = { minimum: 1 as const, maximum: 10 as const };
  if (!field) return { state: 'absent', scale, reason: 'Bangumi rate is absent; no source score is inferred.' };
  if (field.value === 0) return { state: 'unrated', value: 0, scale, reason: field.reason };
  if (field.meaning === 'known' && typeof field.value === 'number' && Number.isSafeInteger(field.value))
    return { state: 'score', value: field.value, scale, reason: field.reason };
  return {
    state: 'unsupported',
    ...(field.value === null ||
    typeof field.value === 'string' ||
    typeof field.value === 'number' ||
    typeof field.value === 'boolean'
      ? { value: field.value }
      : {}),
    scale,
    reason: field.reason,
  };
}

function scoreQuestion(question: Awaited<ReturnType<NativeVotes['readRatingQuestion']>>): BangumiScoreQuestion {
  return {
    id: question.id,
    revision: question.revision,
    meaning: question.meaning,
    label: question.label,
    grain: question.grain,
    lifecycleState: question.lifecycleState,
    scale: {
      minimum: question.minimumUnits,
      maximum: question.maximumUnits,
      step: question.stepUnits,
    },
  };
}

function currentScoreVote(vote: Awaited<ReturnType<NativeVotes['readOwnVote']>>): BangumiScoreCurrentVote {
  if (!vote) return { state: 'absent' };
  if (vote.units === null) return { state: 'cleared' };
  return { state: 'set', units: vote.units, revision: vote.revision, at: vote.changedAt };
}

function currentVoteGuard(vote: Vote | null): NativeVoteGuard {
  if (!vote) return { state: 'absent' };
  if (vote.units === null) return { state: 'cleared', revision: vote.revision };
  return { state: 'set', units: vote.units, revision: vote.revision };
}

function reviewView(review: StoredReview | null): BangumiReview | null {
  if (!review) return null;
  const { scoreGuard: _scoreGuard, ...visible } = review;
  return visible;
}

function assertJsonBytes(value: unknown, maximum: number): void {
  if (Buffer.byteLength(JSON.stringify(value)) > maximum) throw new ProblemError('invalid_request');
}

function assertReviewBytes(review: StoredReview | null): void {
  if (review) assertJsonBytes(review, BANGUMI_LIMITS.reviewBytes);
}

function choiceRequest(choice: StoredChoice): BangumiChoice {
  const { scorePlan: _scorePlan, ...request } = choice;
  return request;
}

function choiceMatches(stored: StoredChoice | null, requested: BangumiChoice): boolean {
  return stored !== null && canonicalize(choiceRequest(stored)) === canonicalize(requested);
}
function scoreSelection(choice: BangumiScoreChoice): BangumiScoreSelection {
  if (choice.action === 'set') return { action: 'set', units: choice.units };
  return { action: choice.action };
}
export function bangumiMetadataProposals(evidence: BangumiRow['evidence']): EntryImportMetadataProposals {
  const source = evidence.source;
  const noteField = ['comment', 'notes'].find((field) => Object.hasOwn(source, field)) ?? null;
  const noteRaw = noteField === null ? undefined : source[noteField];
  const note: EntryImportMetadataProposal =
    noteField === null
      ? { state: 'absent', sourceField: null, reason: 'This row has no retained note field.' }
      : typeof noteRaw !== 'string'
        ? { state: 'invalid', sourceField: noteField, sourceValue: null, reason: 'The retained note is not text.' }
        : noteRaw.length === 0
          ? {
              state: 'empty',
              sourceField: noteField,
              sourceValue: '',
              reason: 'An empty source comment is not a native clear.',
            }
          : !noteRaw.isWellFormed() ||
              noteRaw.includes('\u0000') ||
              Buffer.byteLength(noteRaw) > ENTRY_IMPORT_METADATA_LIMITS.noteBytes
            ? {
                state: 'unsupported',
                sourceField: noteField,
                reason: 'The retained note is outside the native 4,096-byte text limit.',
              }
            : { state: 'value', sourceField: noteField, value: noteRaw };
  const privacyField = Object.hasOwn(source, 'private') ? 'private' : null;
  const privacyRaw = privacyField === null ? undefined : source.private;
  const privacy: EntryImportMetadataProposal =
    privacyField === null
      ? { state: 'absent', sourceField: null, value: { status: 'absent' } }
      : typeof privacyRaw === 'boolean'
        ? {
            state: 'value',
            sourceField: privacyField,
            value: { status: 'known', meaning: privacyRaw ? 'private' : 'source_visible' },
            sourceValue: privacyRaw,
          }
        : typeof privacyRaw === 'string' &&
            privacyRaw.length > 0 &&
            Buffer.byteLength(privacyRaw) <= ENTRY_IMPORT_METADATA_LIMITS.privacyValueBytes &&
            !/[\u0000-\u001f\u007f]/.test(privacyRaw)
          ? {
              state: 'unknown',
              sourceField: privacyField,
              sourceValue: privacyRaw,
              value: { status: 'unknown', sourceValue: privacyRaw },
            }
          : privacyRaw === null
            ? { state: 'unknown', sourceField: privacyField, value: { status: 'unknown' } }
            : typeof privacyRaw === 'number' && Number.isFinite(privacyRaw)
              ? {
                  state: 'unknown',
                  sourceField: privacyField,
                  sourceValue: privacyRaw,
                  value: { status: 'unknown', sourceValue: String(privacyRaw) },
                }
              : {
                  state: 'unsupported',
                  sourceField: privacyField,
                  reason: 'The retained private value cannot fit the native provenance evidence bound.',
                };
  const timestamp = (field: 'created_at' | 'updated_at'): EntryImportMetadataProposal => {
    if (!Object.hasOwn(source, field)) return { state: 'absent', sourceField: null, value: { status: 'absent' } };
    const raw = source[field];
    if (typeof raw !== 'string')
      return { state: 'invalid', sourceField: field, sourceValue: null, reason: 'The retained timestamp is not text.' };
    if (raw.length === 0)
      return {
        state: 'empty',
        sourceField: field,
        sourceValue: '',
        reason: 'An empty timestamp is not an absent timestamp.',
      };
    try {
      parseSourceTimestamp(raw);
      return { state: 'value', sourceField: field, value: { status: 'known', value: raw }, sourceValue: raw };
    } catch {
      if (
        Buffer.byteLength(raw) <= ENTRY_IMPORT_METADATA_LIMITS.timestampBytes &&
        !/[\u0000-\u001f\u007f]/.test(raw) &&
        !/^\d{4}(?:-\d{2})?(?:-\d{2})?(?:T|$)/.test(raw)
      )
        return {
          state: 'unknown',
          sourceField: field,
          sourceValue: raw,
          value: { status: 'unknown', sourceValue: raw },
        };
      return {
        state: 'invalid',
        sourceField: field,
        sourceValue: raw.slice(0, 64),
        reason: 'The retained timestamp is not representable with its original precision.',
      };
    }
  };
  return {
    note,
    priority: {
      state: 'unsupported',
      sourceField: null,
      reason: 'Bangumi has no retained personal-list priority field.',
    },
    privacy,
    sourceCreated: timestamp('created_at'),
    sourceUpdated: timestamp('updated_at'),
  };
}
export function createBangumiImport(deps: Dependencies) {
  const { pool, access, votes } = deps;
  const runner = createLibraryCommandRunner(deps);
  const entries = createEntryCommands(deps);
  const personalEntries = createEntryPersonalCommands(deps);
  const owner = (actor: Actor): AccountActor => {
    if (actor.kind !== 'account') throw new GrantDeniedError();
    requireRoute(actor.accountId);
    return actor;
  };
  async function read<T>(actor: Actor, body: (tx: CommandTransaction, a: AccountActor, route: number) => Promise<T>) {
    const a = owner(actor),
      route = requireRoute(a.accountId),
      deadline = deadlineFor(5000);
    const check = await accessCheck(access, a, 'library_entry:list', { route, id: a.accountId }, { pool, deadline });
    return withReadTransaction(
      pool,
      async (tx) => {
        const at = await mintReadTime(tx, deps.clock);
        const current = await readAccount(tx, route, a.accountId);
        if (
          !current ||
          current.kind !== 'actor' ||
          current.state !== 'active' ||
          current.fenced ||
          !Number.isSafeInteger(a.authnEpoch) ||
          a.authnEpoch < 1 ||
          current.minimumAuthnEpoch > BigInt(a.authnEpoch) ||
          !a.scopes.includes('library_entry:list') ||
          !(await check(tx, at))
        )
          throw new GrantDeniedError();
        return body(tx, a, route);
      },
      deadline,
    );
  }
  const args = (a: AccountActor, id: string) => [requireRoute(a.accountId), a.accountId, id];
  async function header(tx: CommandTransaction, a: AccountActor, id: string, lock = false) {
    if (routeOf(id) !== routeOf(a.accountId)) throw new LibraryNotFoundError();
    const h = (
      await tx.query<{ cancelled: boolean }>(
        `SELECT cancelled FROM library.bangumi_upload WHERE route=$1 AND account_id=$2 AND upload_id=$3
          AND expires_at>clock_timestamp()${lock ? ' FOR UPDATE' : ''}`,
        args(a, id),
      )
    ).rows[0];
    if (!h) throw new LibraryNotFoundError();
    return h;
  }
  async function row(
    tx: CommandTransaction,
    a: AccountActor,
    id: string,
    ordinal: number,
    lock = false,
  ): Promise<StoredRow> {
    const r = (
      await tx.query<StoredRow>(
        `SELECT r.ordinal,r.evidence,r.review,r.choice,r.outcome,r.labels FROM library.bangumi_upload_row r
      JOIN library.bangumi_upload u USING(route,account_id,upload_id)
      WHERE r.route=$1 AND r.account_id=$2 AND r.upload_id=$3 AND r.ordinal=$4
        AND u.expires_at>clock_timestamp()${lock ? ' FOR UPDATE OF r' : ''}`,
        [...args(a, id), ordinal],
      )
    ).rows[0];
    if (!r) throw new LibraryNotFoundError();
    return r;
  }
  function change<T>(
    actor: Actor,
    kind: string,
    key: string,
    input: unknown,
    body: (tx: CommandTransaction, a: AccountActor) => Promise<T>,
  ) {
    return runner.ownAccount(
      actor,
      { action: 'library_entry:update', kind: `library.bangumi.${kind}`, requestKey: key, input },
      async (tx) => ({
        value: await body(tx, owner(actor)),
        events: [
          {
            type: 'com.rezics.library.bangumi.changed.v1',
            subject: owner(actor).accountId,
            data: { operation: kind },
          },
        ],
      }),
    );
  }
  async function preview(actor: Actor, upload: string, key: string) {
    const evidence = parseBangumiUpload(upload);
    const made = await change(actor, 'preview', key, { upload }, async (tx, a) => {
      const id = newId(requireRoute(a.accountId));
      await tx.query('INSERT INTO library.bangumi_upload(route,account_id,upload_id) VALUES($1,$2,$3)', args(a, id));
      try {
        for (let i = 0; i < evidence.length; i++)
          await tx.query(
            `INSERT INTO library.bangumi_upload_row
          (route,account_id,upload_id,ordinal,evidence) VALUES($1,$2,$3,$4,$5::jsonb)`,
            [...args(a, id), i, JSON.stringify(evidence[i])],
          );
      } catch (error) {
        // PostgreSQL expands numeric notation and JSONB whitespace; reject without exposing row details.
        if (
          error &&
          typeof error === 'object' &&
          'code' in error &&
          ['23514', '22P02', '22003'].includes(String(error.code))
        )
          throw new ProblemError('invalid_request');
        throw error;
      }
      return { uploadId: id, count: evidence.length };
    });
    return made.value;
  }
  async function page(actor: Actor, id: string, after: number) {
    return read(actor, async (tx, a) => {
      const h = await header(tx, a, id);
      const rows = (
        await tx.query<StoredRow>(
          `SELECT r.ordinal,r.evidence,r.review,r.outcome FROM library.bangumi_upload_row r
        JOIN library.bangumi_upload u USING(route,account_id,upload_id)
        WHERE r.route=$1 AND r.account_id=$2 AND r.upload_id=$3 AND r.ordinal>$4
          AND u.expires_at>clock_timestamp() ORDER BY r.ordinal LIMIT 11`,
          [...args(a, id), after],
        )
      ).rows;
      const visibleRows = rows.slice(0, BANGUMI_LIMITS.page).map((stored) => ({
        ordinal: stored.ordinal,
        evidence: stored.evidence,
        review: reviewView(stored.review),
        outcome: stored.outcome,
      }));
      const response = {
        uploadId: id,
        cancelled: h.cancelled,
        rows: visibleRows,
        next: rows.length > BANGUMI_LIMITS.page ? rows[BANGUMI_LIMITS.page - 1]!.ordinal : null,
      };
      assertJsonBytes(response, BANGUMI_LIMITS.pageResponseBytes);
      return response;
    });
  }
  async function observation(actor: Actor, target: string) {
    const at = await mintReadTime(pool, deps.clock);
    return readLibraryProfileSourceObservation({ ...deps, actor, at, deadline: deadlineFor(5000) }, target);
  }
  async function profileMetadata(actor: Actor, target: string) {
    const current = await observation(actor, target);
    if (!current || current.source.subjectId !== target) return null;
    let incarnationId: string | null = null;
    try {
      incarnationId = (await entries.readEntry(actor, target)).incarnationId ?? null;
    } catch (error) {
      if (!(error instanceof LibraryNotFoundError)) throw error;
    }
    const source = current.source;
    return {
      incarnationId,
      digest: entryImportMetadataDigest({
        subjectId: target,
        identityEpoch: String(current.anchor.identityEpoch),
        sourceKind: source.kind,
        releaseDigest: source.kind === 'supported' ? source.pin.releaseDigest : null,
        acceptingType: current.anchor.acceptingType,
        incarnationId,
      }),
      current,
    };
  }
  async function scoreReview(
    actor: Actor,
    evidence: BangumiRow['evidence'],
    target: string | null,
    guard: BangumiReview['guard'],
    selection: BangumiScoreSelection,
  ): Promise<{ score: BangumiScoreReview; guard: NativeVoteGuard | null }> {
    const source = scoreSource(evidence);
    const unavailable = (
      reason: BangumiScoreReview['native']['admission']['reason'],
      question: BangumiScoreQuestion | null = null,
      currentVote: BangumiScoreCurrentVote | null = null,
      voteGuard: NativeVoteGuard | null = null,
    ): { score: BangumiScoreReview; guard: NativeVoteGuard | null } => ({
      score: {
        source,
        native: {
          questionId: STANDARD_QUESTION_ID,
          question,
          currentVote,
          selection,
          admission: { status: 'unavailable', reason },
        },
      },
      guard: voteGuard,
    });
    if (!owner(actor).scopes.includes(VOTE_SCOPE)) return unavailable('native_vote_scope_required');

    let question: Awaited<ReturnType<NativeVotes['readRatingQuestion']>>;
    try {
      question = await votes.readRatingQuestion(actor, STANDARD_QUESTION_ID);
    } catch (error) {
      if (error instanceof RatingQuestionNotFoundError) return unavailable('question_unavailable');
      throw error;
    }
    if (
      selection.action === 'set' &&
      (!Number.isSafeInteger(selection.units) ||
        selection.units < question.minimumUnits ||
        selection.units > question.maximumUnits ||
        question.stepUnits < 1 ||
        (selection.units - question.minimumUnits) % question.stepUnits !== 0)
    )
      throw new ProblemError('invalid_request');
    const visibleQuestion = scoreQuestion(question);
    if (!target || !guard) return unavailable('target_not_selected', visibleQuestion);

    let vote: Awaited<ReturnType<NativeVotes['readOwnVote']>>;
    try {
      vote = await votes.readOwnVote(actor, STANDARD_QUESTION_ID, target);
    } catch (error) {
      if (error instanceof LibraryNotFoundError) return unavailable('target_not_selected', visibleQuestion);
      if (error instanceof RatingQuestionNotFoundError) return unavailable('question_unavailable');
      throw error;
    }
    const currentVote = currentScoreVote(vote);
    if (question.revision !== 1 || question.lifecycleState !== 'active')
      return unavailable('question_revision_unsupported', visibleQuestion, currentVote, currentVoteGuard(vote));
    if (question.minimumUnits !== 0 || question.maximumUnits !== 20 || question.stepUnits !== 1)
      return unavailable('question_scale_unsupported', visibleQuestion, currentVote, currentVoteGuard(vote));
    return unavailable('conditional_admission_unavailable', visibleQuestion, currentVote, currentVoteGuard(vote));
  }
  async function review(
    actor: Actor,
    id: string,
    ordinal: number,
    target: string | undefined,
    selection: BangumiScoreSelection,
    key: string,
  ) {
    const original = await read(actor, async (tx, a) => {
      if ((await header(tx, a, id)).cancelled) throw new ProblemError('conflict');
      return row(tx, a, id, ordinal);
    });
    if (
      (original.choice && !original.outcome) ||
      original.review?.metadata?.some((item) => item.confirmation && !item.confirmation.outcome)
    )
      throw new ProblemError('conflict');
    const e = original.evidence;
    const candidates: string[] = [];
    let unavailable = false;
    let claimGuard: BangumiGuard['claim'] = null;
    if (
      typeof e.source.subject_id === 'number' &&
      Number.isSafeInteger(e.source.subject_id) &&
      e.source.subject_id > 0
    ) {
      try {
        const externalId = String(e.source.subject_id),
          claimRoute = tupleRoute(deps.routeKey, 'bangumi', externalId);
        const claim = await readClaim.run(pool, {
          route: claimRoute,
          source: 'bangumi',
          external_id: externalId,
        });
        claimGuard = { route: claimRoute, externalId, subjectId: claim?.subject_id ?? null };
        if (claim) {
          const observed = await observation(actor, claim.subject_id);
          if (observed) candidates.push(observed.source.subjectId);
          else unavailable = true;
        }
      } catch {
        unavailable = true;
      }
    }
    const selected = target ?? (candidates.length === 1 ? candidates[0] : undefined);
    const observed = selected ? await observation(actor, selected) : null;
    if (target && !observed) throw new LibraryNotFoundError();
    const source = observed?.source;
    const nativeStates =
      source?.kind === 'supported' && e.medium !== 'unknown'
        ? (source.profile.entryStateSet?.states.filter((s) => s.role === e.stateRole) ?? [])
        : [];
    const proposedState = nativeStates.length === 1 ? nativeStates[0]!.id : null;
    let current: BangumiReview['current'] = null;
    if (source) {
      try {
        const entry = await entries.readEntry(actor, source.subjectId);
        current = {
          state: entry.state,
          revision: entry.revision,
          ...(entry.incarnationId === undefined ? {} : { incarnationId: entry.incarnationId }),
        };
      } catch (error) {
        if (!(error instanceof LibraryNotFoundError)) throw error;
      }
    }
    const reviewToken = randomUUID();
    const guard: BangumiReview['guard'] =
      source?.kind === 'supported'
        ? {
            subjectId: source.subjectId,
            releaseDigest: source.pin.releaseDigest,
            identityEpoch: String(observed!.anchor.identityEpoch),
            claim: claimGuard,
            upload: { uploadId: id, ordinal, reviewToken },
          }
        : null;
    const score = await scoreReview(actor, e, source?.subjectId ?? null, guard, selection);
    const review: StoredReview = {
      token: reviewToken,
      candidates,
      target: source?.subjectId ?? null,
      match: target
        ? 'chosen'
        : candidates.length > 1
          ? 'ambiguous'
          : source
            ? current
              ? 'already_matched'
              : 'matched'
            : unavailable
              ? 'unavailable'
              : 'unmatched',
      guard,
      proposedState,
      current,
      conflict: current !== null && proposedState !== null && current.state !== proposedState,
      score: score.score,
      scoreGuard: score.guard,
      metadata: original.review?.metadata ?? [],
    };
    assertReviewBytes(review);
    const saved = await change(
      actor,
      'review',
      key,
      { id, ordinal, target: target ?? null, score: selection },
      async (tx, a) => {
        const h = await header(tx, a, id, true);
        const locked = await row(tx, a, id, ordinal, true);
        if (h.cancelled || (locked.choice && !locked.outcome)) throw new ProblemError('conflict');
        await tx.query(
          `UPDATE library.bangumi_upload_row SET review=$5::jsonb,choice=NULL,outcome=NULL,labels=NULL WHERE route=$1 AND account_id=$2 AND upload_id=$3 AND ordinal=$4`,
          [...args(a, id), ordinal, JSON.stringify(review)],
        );
        return { ordinal, reviewToken: review.token };
      },
    );
    const stored = await read(actor, async (tx, a) => {
      if ((await header(tx, a, id)).cancelled) throw new ProblemError('conflict');
      return row(tx, a, id, ordinal);
    });
    if (!stored.review || stored.review.token !== saved.value.reviewToken) throw new ProblemError('conflict');
    return { ordinal, review: reviewView(stored.review) };
  }
  async function metadataReceipt(
    { actor, id, ordinal }: { actor: Actor; id: string; ordinal: number },
    recovery: {
      token: string;
      sourceReviewToken: string;
      subjectId: string;
      clientId: string;
      requestedBy: string | null;
      confirmation: EntryImportMetadataConfirmation;
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
    const command = await personalEntries.readCommandReceipt(actor, {
      kind,
      requestKey: key,
      digest,
      async authorize(tx) {
        const linked = await tx.query(
          `SELECT 1 FROM library.bangumi_upload u
           JOIN library.bangumi_upload_row r USING(route,account_id,upload_id)
           CROSS JOIN LATERAL jsonb_array_elements(COALESCE(r.review->'metadata','[]'::jsonb)) m
           WHERE u.route=$1 AND u.account_id=$2 AND u.upload_id=$3 AND r.ordinal=$4
             AND r.review->>'token'=$6 AND m->>'token'=$5 AND m->>'sourceReviewToken'=$6
             AND m->>'subjectId'=$7 AND m->>'clientId'=$8
             AND m->>'requestedBy' IS NOT DISTINCT FROM $9::text
             AND m->'confirmation'->>$10='true'
             AND m->'confirmation'->>$11=$12
             AND m->'confirmation'->>$13=$14
             AND m->'confirmation'->>'selectionDigest'=$15
             AND ($16::text IS NULL OR m->'confirmation'->>'provenanceKind'=$16)
             AND ${expiredOnly
               ? "u.expires_at<=clock_timestamp() AND COALESCE(u.recovery_until,u.expires_at+interval '24 hours')>clock_timestamp()"
               : "(u.expires_at>clock_timestamp() OR COALESCE(u.recovery_until,u.expires_at+interval '24 hours')>clock_timestamp())"}
           FOR UPDATE OF u,r`,
          [
            requireRoute(account.accountId), account.accountId, id, ordinal, recovery.token,
            recovery.sourceReviewToken,
            recovery.subjectId, account.clientId, account.requestedBy ?? null,
            annotation ? 'annotationStarted' : 'provenanceStarted',
            annotation ? 'annotationKey' : 'provenanceKey', key,
            annotation ? 'annotationReceiptDigest' : 'provenanceReceiptDigest', digest,
            confirmation.selectionDigest,
            annotation ? null : confirmation.provenanceKind ?? null,
          ],
        );
        if (!linked.rowCount) throw new LibraryNotFoundError();
      },
    });
    return command !== null;
  }

  const metadataCoordinator = createListImportMetadataCoordinator({
    provider: 'bangumi',
    nativeAdmission: 'bangumi-source-v1',
    native: personalEntries,
    async prepareReview({ actor, id, ordinal, sourceReviewToken }) {
      const original = await read(actor, async (tx, a) => {
        if ((await header(tx, a, id)).cancelled) throw new ProblemError('conflict');
        return row(tx, a, id, ordinal);
      });
      const review = original.review;
      if (!review || review.token !== sourceReviewToken || !review.guard) throw new ProblemError('conflict');
      const history = review.metadata ?? [];
      assertListImportMetadataReviewAvailable(history);
      const account = owner(actor),
        profile = await profileMetadata(actor, review.target);
      if (
        !profile ||
        profile.current.source.kind !== 'supported' ||
        profile.incarnationId !== (review.current?.incarnationId ?? null)
      )
        throw new ProblemError('conflict');
      if (
        profile.current.source.pin.releaseDigest !== review.guard.releaseDigest ||
        String(profile.current.anchor.identityEpoch) !== review.guard.identityEpoch
      )
        throw new ProblemError('conflict');
      const personal = await personalEntries.readPersonalEntry(actor, review.target);
      return {
        history,
        identity: {
          sourceReviewToken,
          subjectId: review.target,
          clientId: account.clientId,
          requestedBy: account.requestedBy ?? null,
          annotationRevision: personal.annotationRevision,
          personalDigest: entryPersonalMetadataDigest(personal),
          sourceDigest: entryImportMetadataDigest(original.evidence),
          profileDigest: profile.digest,
          incarnationId: profile.incarnationId,
        },
      };
    },
    async persistReview({ actor, id, ordinal, sourceReviewToken, key }, next) {
      const saved = await change(actor, 'metadata-review', key, { id, ordinal, sourceReviewToken }, async (tx, a) => {
        if ((await header(tx, a, id, true)).cancelled) throw new ProblemError('conflict');
        const locked = await row(tx, a, id, ordinal, true);
        if (!locked.review || locked.review.token !== sourceReviewToken) throw new ProblemError('conflict');
        const appended = appendListImportMetadataReview(locked.review.metadata ?? [], next);
        if (!appended.added) return { ordinal, reviewToken: appended.reviewToken };
        locked.review.metadata = appended.history;
        assertReviewBytes(locked.review);
        await tx.query(
          `UPDATE library.bangumi_upload_row SET review=$5::jsonb WHERE route=$1 AND account_id=$2 AND upload_id=$3 AND ordinal=$4`,
          [...args(a, id), ordinal, JSON.stringify(locked.review)],
        );
        return { ordinal, reviewToken: appended.reviewToken };
      });
      return saved.value;
    },
    async loadReview({ actor, id, ordinal }, reviewToken) {
      return read(actor, async (tx, a) => {
        const stored = await row(tx, a, id, ordinal);
        return stored.review?.metadata?.find((item) => item.token === reviewToken) ?? null;
      });
    },
    async loadExpiredRecovery({ actor, id, ordinal }, reviewToken) {
      const account = owner(actor);
      return read(actor, async (tx, a) => {
        const found = await tx.query<{ recovery: ListImportMetadataExpiredRecovery | null }>(
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
             FROM jsonb_array_elements(COALESCE(r.review->'metadata','[]'::jsonb)) m
             WHERE m->>'token'=$5 AND m->>'sourceReviewToken'=r.review->>'token'
               AND m->>'clientId'=$6
               AND m->>'requestedBy' IS NOT DISTINCT FROM $7::text
           ) AS recovery
           FROM library.bangumi_upload u
           JOIN library.bangumi_upload_row r USING(route,account_id,upload_id)
           WHERE u.route=$1 AND u.account_id=$2 AND u.upload_id=$3 AND r.ordinal=$4
             AND u.expires_at<=clock_timestamp()
             AND COALESCE(u.recovery_until,u.expires_at+interval '24 hours')>clock_timestamp()`,
          [requireRoute(a.accountId), a.accountId, id, ordinal, reviewToken, account.clientId, account.requestedBy ?? null],
        );
        return found.rows[0]?.recovery ?? null;
      });
    },
    async recoverReceipt({ actor, id, ordinal }, recovery, phase) {
      return metadataReceipt({ actor, id, ordinal }, recovery, phase, true);
    },
    async readReceipt({ actor, id, ordinal }, review, phase) {
      if (!review.confirmation) return false;
      return metadataReceipt({ actor, id, ordinal }, review as typeof review & { confirmation: EntryImportMetadataConfirmation }, phase, false);
    },
    async readView({ actor, id, ordinal }, reviewToken) {
      const current = await read(actor, async (tx, a) => {
        const h = await header(tx, a, id);
        return { cancelled: h.cancelled, row: await row(tx, a, id, ordinal) };
      });
      const review = current.row.review,
        metadata = review?.metadata?.find((item) => item.token === reviewToken);
      if (!review || !metadata) throw new ProblemError('conflict');
      const account = owner(actor),
        personal = await personalEntries.readPersonalEntry(actor, metadata.subjectId),
        profile = await profileMetadata(actor, metadata.subjectId);
      return {
        review: metadata,
        observation: {
          sourceReviewToken: review.token,
          subjectId: review.target,
          clientId: account.clientId,
          requestedBy: account.requestedBy ?? null,
          sourceDigest: entryImportMetadataDigest(current.row.evidence),
          profileDigest: profile?.digest ?? null,
          incarnationId: profile?.incarnationId ?? null,
          personal,
          proposals: bangumiMetadataProposals(current.row.evidence),
          recordId: String(current.row.evidence.source.subject_id),
          providerCurrent:
            review.token === metadata.sourceReviewToken &&
            review.target === metadata.subjectId &&
            review.guard !== null &&
            profile !== null &&
            profile.current.source.kind === 'supported' &&
            profile.current.source.pin.releaseDigest === review.guard.releaseDigest &&
            String(profile.current.anchor.identityEpoch) === review.guard.identityEpoch,
        },
      };
    },
    async confirm({ actor, id, ordinal }, reviewToken, proposed) {
      await change(
        actor,
        'metadata-confirm',
        `${id}:${ordinal}:${reviewToken}`,
        { id, ordinal, reviewToken, selectionDigest: proposed.selectionDigest },
        async (tx, a) => {
          const h = await header(tx, a, id, true),
            locked = await row(tx, a, id, ordinal, true),
            record = locked.review?.metadata?.find((item) => item.token === reviewToken);
          if (!record) throw new ProblemError('conflict');
          const confirmation = selectListImportMetadataConfirmation(record.confirmation, proposed);
          if (!record.confirmation && h.cancelled) throw new ProblemError('conflict');
          record.confirmation = confirmation;
          assertEntryImportMetadataHistorySize(locked.review?.metadata ?? []);
          assertReviewBytes(locked.review);
          await tx.query(
            `UPDATE library.bangumi_upload_row SET review=$5::jsonb WHERE route=$1 AND account_id=$2 AND upload_id=$3 AND ordinal=$4`,
            [...args(a, id), ordinal, JSON.stringify(locked.review)],
          );
          return { ordinal, reviewToken };
        },
      );
    },
    async persist({ actor, id, ordinal }, reviewToken, confirmation) {
      const stateDigest = entryImportMetadataDigest(confirmation);
      await change(
        actor,
        'metadata-progress',
        `${id}:${ordinal}:${reviewToken}:progress:${stateDigest}`,
        { id, ordinal, reviewToken, stateDigest },
        async (tx, a) => {
          const h = await header(tx, a, id, true),
            locked = await row(tx, a, id, ordinal, true),
            record = locked.review?.metadata?.find((item) => item.token === reviewToken);
          if (!record?.confirmation || record.confirmation.selectionDigest !== confirmation.selectionDigest)
            throw new ProblemError('conflict');
          const starting =
            (confirmation.annotationStarted && !record.confirmation.annotationStarted) ||
            (confirmation.provenanceStarted && !record.confirmation.provenanceStarted);
          if (
            starting &&
            (h.cancelled ||
              locked.review?.token !== record.sourceReviewToken ||
              entryImportMetadataDigest(locked.evidence) !== record.sourceDigest)
          )
            throw new ProblemError('conflict');
          record.confirmation = mergeListImportMetadataConfirmation(record.confirmation, confirmation);
          assertEntryImportMetadataHistorySize(locked.review?.metadata ?? []);
          assertReviewBytes(locked.review);
          await tx.query(
            `UPDATE library.bangumi_upload_row SET review=$5::jsonb WHERE route=$1 AND account_id=$2 AND upload_id=$3 AND ordinal=$4`,
            [...args(a, id), ordinal, JSON.stringify(locked.review)],
          );
          return { ordinal, reviewToken };
        },
      );
    },
    async isCurrent({ actor, id, ordinal }, reviewed) {
      const latest = await read(actor, async (tx, a) => ({ row: await row(tx, a, id, ordinal) })),
        latestReview = latest.row.review,
        latestMetadata = latestReview?.metadata?.find((item) => item.token === reviewed.token);
      if (
        !latestReview ||
        !latestMetadata ||
        latestReview.token !== latestMetadata.sourceReviewToken ||
        entryImportMetadataDigest(latest.row.evidence) !== latestMetadata.sourceDigest ||
        !latestReview.guard
      )
        return false;
      const profile = await profileMetadata(actor, latestMetadata.subjectId);
      return (
        !!profile &&
        profile.current.source.kind === 'supported' &&
        profile.current.source.pin.releaseDigest === latestReview.guard.releaseDigest &&
        String(profile.current.anchor.identityEpoch) === latestReview.guard.identityEpoch &&
        profile.incarnationId === latestMetadata.incarnationId &&
        profile.digest === latestMetadata.profileDigest
      );
    },
    admission({ actor, id, ordinal }, reviewed, signal): LabelCommandAdmission {
      const account = owner(actor),
        selectionDigest = reviewed.confirmation?.selectionDigest;
      if (!selectionDigest) throw new ProblemError('conflict');
      const input = reviewed.confirmation?.nativeAdmission === 'bangumi-source-v1' ? {
        source: 'bangumi-metadata-v1',
        uploadId: id,
        ordinal,
        sourceReviewToken: reviewed.sourceReviewToken,
        reviewToken: reviewed.token,
        subjectId: reviewed.subjectId,
        sourceDigest: reviewed.sourceDigest,
        profileDigest: reviewed.profileDigest,
        incarnationId: reviewed.incarnationId,
        selectionDigest,
      } : undefined;
      return {
        input,
        async prepare() {
          return async (tx) => {
            const current = await tx.query<{ cancelled: boolean; evidence: BangumiRow['evidence']; review: StoredReview | null }>(
              `SELECT u.cancelled,r.evidence,r.review FROM library.bangumi_upload u
               JOIN library.bangumi_upload_row r USING(route,account_id,upload_id)
               WHERE u.route=$1 AND u.account_id=$2 AND u.upload_id=$3 AND r.ordinal=$4
                 AND u.expires_at>clock_timestamp()
               FOR UPDATE OF u,r`,
              [requireRoute(account.accountId), account.accountId, id, ordinal],
            );
            if (signal?.aborted) throw new LibraryConflictError();
            const stored = current.rows[0],
              metadata = stored?.review?.metadata?.find((item) => item.token === reviewed.token);
            if (
              !stored || stored.cancelled || !metadata ||
              stored.review?.token !== reviewed.sourceReviewToken ||
              metadata.sourceReviewToken !== reviewed.sourceReviewToken ||
              metadata.subjectId !== reviewed.subjectId ||
              metadata.clientId !== account.clientId ||
              metadata.requestedBy !== (account.requestedBy ?? null) ||
              metadata.sourceDigest !== reviewed.sourceDigest ||
              metadata.profileDigest !== reviewed.profileDigest ||
              metadata.incarnationId !== reviewed.incarnationId ||
              entryImportMetadataDigest(stored.evidence) !== reviewed.sourceDigest ||
              metadata.confirmation?.selectionDigest !== selectionDigest
            )
              throw new ProblemError('conflict');
          };
        },
      };
    },
    async isCancelled({ actor, id }) {
      try {
        return await read(actor, async (tx, a) => (await header(tx, a, id)).cancelled);
      } catch (error) {
        if (error instanceof ProblemError && error.code === 'not_found') return true;
        throw error;
      }
    },
  });

  async function reviewMetadata(actor: Actor, id: string, ordinal: number, sourceReviewToken: string, key: string) {
    return metadataCoordinator.review({ actor, id, ordinal, sourceReviewToken, key });
  }

  async function metadataView(
    actor: Actor,
    id: string,
    ordinal: number,
    reviewToken: string,
  ): Promise<EntryImportMetadataView> {
    return metadataCoordinator.view({ actor, id, ordinal, reviewToken });
  }

  async function applyMetadata(
    actor: Actor,
    id: string,
    ordinal: number,
    reviewToken: string,
    fields: unknown,
    signal?: AbortSignal,
  ) {
    return metadataCoordinator.apply({
      actor,
      id,
      ordinal,
      reviewToken,
      fields,
      ...(signal === undefined ? {} : { signal }),
    });
  }
  async function apply(actor: Actor, id: string, choices: BangumiChoice[], signal: AbortSignal, deadline: number) {
    if (new Set(choices.map((c) => c.ordinal)).size !== choices.length) throw new ProblemError('invalid_request');
    const outcomes: BangumiOutcome[] = [];
    for (const choice of choices) {
      if (signal.aborted || Date.now() >= deadline) break;
      const { ordinal } = choice;
      const scoreChoice = choice.score ?? { action: 'preserve' as const };
      if (
        (scoreChoice.action !== 'preserve' && scoreChoice.consent !== true) ||
        (scoreChoice.action === 'set' &&
          (!Number.isSafeInteger(scoreChoice.units) || scoreChoice.units < 0 || scoreChoice.units > 20)) ||
        (choice.skip && scoreChoice.action !== 'preserve')
      )
        throw new ProblemError('invalid_request');
      // The immutable submitted review and operands survive a crash between the native effect and acknowledgment.
      const claim = await change(
        actor,
        'confirm',
        `${id}:${ordinal}:${choice.reviewToken}`,
        { id, choice },
        async (tx, a) => {
          const h = await header(tx, a, id, true),
            r = await row(tx, a, id, ordinal, true);
          if (h.cancelled) throw new ProblemError('conflict');
          if (!r.review || r.review.token !== choice.reviewToken) throw new ProblemError('conflict');
          if (scoreChoice.action !== 'preserve' && !r.review.score) throw new ProblemError('conflict');
          const reviewedSelection = r.review.score?.native.selection ?? { action: 'preserve' as const };
          if (canonicalize(scoreSelection(scoreChoice)) !== canonicalize(reviewedSelection))
            throw new ProblemError('conflict');
          if (r.choice && !choiceMatches(r.choice, choice)) throw new ProblemError('conflict');
          const scorePlan: BangumiScorePlan | undefined =
            scoreChoice.action === 'preserve'
              ? undefined
              : {
                  action: scoreChoice.action,
                  units: scoreChoice.action === 'set' ? scoreChoice.units : null,
                  consent: true,
                  sourceState: r.review.score!.source.state,
                  sourceDigest: entryImportMetadataDigest(r.evidence),
                  question: r.review.score!.native.question,
                  target: r.review.guard,
                  baseline: r.review.scoreGuard,
                  commandKey: `bangumi:${id}:${ordinal}:${choice.reviewToken}:rating`,
                  attribution: { provider: 'bangumi', uploadId: id, ordinal, reviewToken: choice.reviewToken },
                };
          const storedChoice: StoredChoice = r.choice ?? {
            ...choice,
            ...(scorePlan === undefined ? {} : { scorePlan }),
          };
          assertJsonBytes(storedChoice, BANGUMI_LIMITS.choiceBytes);
          await tx.query(
            `UPDATE library.bangumi_upload_row SET choice=$5::jsonb WHERE route=$1 AND account_id=$2 AND upload_id=$3 AND ordinal=$4`,
            [...args(a, id), ordinal, JSON.stringify(storedChoice)],
          );
          // Private evidence stays out of durable command receipts.
          return { confirmed: true };
        },
      );
      void claim;
      const r = await read(actor, async (tx, a) => {
        if ((await header(tx, a, id)).cancelled) throw new ProblemError('conflict');
        return row(tx, a, id, ordinal);
      });
      // A receipt for an older confirmation cannot admit a subsequently refreshed review.
      if (r.review?.token !== choice.reviewToken) throw new ProblemError('conflict');
      if (r.outcome) {
        outcomes.push(r.outcome);
        continue;
      }
      if (!choiceMatches(r.choice, choice)) throw new ProblemError('conflict');
      const v = r.review;
      if (!v) throw new ProblemError('conflict');
      const outcome: BangumiOutcome = {
        ordinal,
        status: 'unsupported',
        applied: [],
        retained: r.evidence.fields.map((f) => f.field),
      };
      if (choice.skip) outcome.status = 'skipped';
      else if (choice.state === 'omit' || (v.current && choice.state === 'preserve')) outcome.status = 'skipped';
      else if (v.proposedState && v.guard && v.target) {
        try {
          await entries.putEntry(
            actor,
            v.target,
            {
              state: v.proposedState,
              ...(v.current
                ? {
                    revision: v.current.revision,
                    ...(v.current.incarnationId ? { incarnationId: v.current.incarnationId } : {}),
                  }
                : {}),
            },
            `bangumi:${id}:${ordinal}:${choice.reviewToken}`,
            v.guard,
          );
          outcome.status = 'applied';
          outcome.applied = ['type'];
        } catch (error) {
          if (error instanceof GrantDeniedError) throw error;
          outcome.status =
            error instanceof LibraryConflictError ||
            error instanceof LibraryNotFoundError ||
            (error instanceof ProblemError && error.code === 'unsupported_library_profile')
              ? 'stale'
              : 'failed';
        }
      }
      const sourceState = v.score?.source.state;
      outcome.score =
        scoreChoice.action === 'preserve'
          ? { action: 'preserve', status: 'skipped', reason: 'existing_native_vote_preserved' }
          : scoreChoice.action === 'set' && (sourceState === 'absent' || sourceState === 'unrated')
            ? { action: 'set', status: 'unsupported', reason: `source_${sourceState}` }
            : {
                action: scoreChoice.action,
                status: 'unavailable',
                reason: v.score?.native.admission.reason ?? 'conditional_admission_unavailable',
              };
      assertJsonBytes(outcome, BANGUMI_LIMITS.outcomeBytes);
      // An acknowledged row can be refreshed under a new token; an uncertain command keeps its original choice.
      await change(actor, 'ack', randomUUID(), { id, ordinal, outcome }, async (tx, a) => {
        await header(tx, a, id, true);
        await tx.query(
          `UPDATE library.bangumi_upload_row SET outcome=$5::jsonb,
          choice=CASE WHEN $6 THEN NULL ELSE choice END WHERE route=$1 AND account_id=$2 AND upload_id=$3 AND ordinal=$4 AND review->>'token'=$7`,
          [
            ...args(a, id),
            ordinal,
            outcome.status === 'failed' ? null : JSON.stringify(outcome),
            outcome.status === 'stale',
            choice.reviewToken,
          ],
        );
        return { ordinal, status: outcome.status };
      });
      outcomes.push(outcome);
    }
    return { uploadId: id, outcomes, remaining: choices.slice(outcomes.length).map((c) => c.ordinal) };
  }
  async function cancel(actor: Actor, id: string, key: string) {
    return (
      await change(actor, 'cancel', key, { id }, async (tx, a) => {
        await header(tx, a, id, true);
        await tx.query(
          'UPDATE library.bangumi_upload SET cancelled=true WHERE route=$1 AND account_id=$2 AND upload_id=$3',
          args(a, id),
        );
        await tx.query(
          'UPDATE library.bangumi_upload_row SET labels=NULL WHERE route=$1 AND account_id=$2 AND upload_id=$3',
          args(a, id),
        );
        return { uploadId: id, cancelled: true };
      })
    ).value;
  }
  async function remove(actor: Actor, id: string, key: string) {
    return (
      await change(actor, 'delete', key, { id }, async (tx, a) => {
        await header(tx, a, id, true);
        await tx.query(
          'DELETE FROM library.bangumi_upload WHERE route=$1 AND account_id=$2 AND upload_id=$3',
          args(a, id),
        );
        return { deleted: true };
      })
    ).value;
  }
  return {
    preview,
    page,
    review,
    reviewMetadata,
    metadata: metadataView,
    applyMetadata,
    apply,
    cancel,
    remove,
    ...createBangumiLabelReview(deps, { read, change, header, row }),
  };
}

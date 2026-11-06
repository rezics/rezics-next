import type { KernelClient } from '@rezics/client';
import { isPlatformClosedError } from '../../kernel/platform-closed';
import type { SessionEnv } from '../../session/client';
import { prepareSession, viewerCredential } from '../../session/request';
import { mapSourceAdmissionPort } from '../rich-private-entry/admission';
import { admitPrivateSourceObservation } from '../rich-private-entry/native';
import { libraryFullQuery } from '../reads';
import { readSubjectLabelAssignments } from '../subject-labels.ts';
import {
  BANGUMI_PAGE,
  SUBJECT_ID,
  type BangumiLabelApplyData,
  type BangumiLabelState,
  type BangumiLabelOption,
  type BangumiTagPage,
  quotedIdempotencyKey,
  type BangumiApplyCallResult,
  type BangumiApplyResult,
  type BangumiChoice,
  type BangumiCommand,
  type BangumiCurrent,
  type BangumiEntryReadback,
  type BangumiEvidence,
  type BangumiFailure,
  type BangumiFailureKind,
  type BangumiGuard,
  type BangumiInspectionCommand,
  type BangumiInspectionResult,
  type BangumiImportPort,
  type BangumiMatch,
  type BangumiMutateResult,
  type BangumiOutcome,
  type BangumiPage,
  type BangumiPageResult,
  type BangumiPreviewResult,
  type BangumiRetainedField,
  type BangumiReview,
  type BangumiReviewResult,
  type BangumiRow,
  type BangumiScoreOutcome,
  type BangumiScoreReview,
  type BangumiScoreSelection,
  type BangumiVoteReadback,
  type BangumiUnknown,
} from './contract';

type NativeResult = { data?: unknown; error?: { value?: unknown } | null; status: number };
type NativeHeaders = { authorization: string };
type KeyedNativeHeaders = NativeHeaders & { 'idempotency-key': string };
export type BangumiSurface = NonNullable<KernelClient['libraryImports']['bangumi']>;

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function safeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value);
}

function statusOfError(error: unknown): number | undefined {
  return record(error) && typeof error.status === 'number' ? error.status : undefined;
}

/** Bind installed `libraryImports.bangumi` methods. Missing methods stay unavailable. */
export function nativeBangumiImport(client: KernelClient): BangumiSurface | undefined {
  const surface = client.libraryImports?.bangumi;
  if (typeof surface !== 'function' || typeof surface.$preview?.post !== 'function') return undefined;
  return surface;
}

function publicDetail(detail: unknown): string | undefined {
  if (typeof detail !== 'string' || !detail.trim()) return undefined;
  if (/[<>]|bangumi\.tv|collections\s*:/i.test(detail)) return undefined;
  return detail;
}

function failureKind(status: number, body: unknown): BangumiFailureKind {
  const detail = record(body) && typeof body.detail === 'string' ? body.detail : '';
  if (status === 401 || status === 403) return 'denied';
  if (status === 404) return 'not-found';
  if (status === 413 || /256 KiB|too large|content_too_large/i.test(detail)) return 'too-large';
  if (status === 422) return 'idempotency';
  if (status === 409) return 'conflict';
  if (status === 400 || /malformed|format|collections|invalid_request/i.test(detail)) return 'malformed';
  return 'unavailable';
}

function failure(status: number, body: unknown): BangumiFailure {
  const kind = failureKind(status, body);
  const detail = publicDetail(record(body) ? body.detail : undefined);
  return detail ? { kind, detail } : { kind };
}

function unknown(command: BangumiCommand): BangumiUnknown {
  return { kind: 'unknown', command };
}

function outcomeOf(status: number, body: unknown, command: BangumiCommand): BangumiFailure | BangumiUnknown {
  if (status === 0 || status >= 500) return unknown(command);
  return failure(status, body);
}

const matches: readonly BangumiMatch[] = [
  'matched',
  'already_matched',
  'ambiguous',
  'unmatched',
  'unavailable',
  'chosen',
];

function isMatch(value: unknown): value is BangumiMatch {
  return typeof value === 'string' && (matches as readonly string[]).includes(value);
}

function isJson(value: unknown): value is import('./contract').BangumiJson {
  if (value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean')
    return true;
  if (Array.isArray(value)) return value.every(isJson);
  if (!record(value)) return false;
  return Object.values(value).every(isJson);
}

function isField(value: unknown): value is BangumiRetainedField {
  if (!record(value) || typeof value.field !== 'string' || typeof value.reason !== 'string') return false;
  if (!('value' in value) || !isJson(value.value)) return false;
  return value.meaning === 'known' || value.meaning === 'unknown' || value.meaning === 'invalid';
}

function isEvidence(value: unknown): value is BangumiEvidence {
  if (
    !record(value) ||
    !isJson(value.source) ||
    typeof value.source !== 'object' ||
    value.source === null ||
    Array.isArray(value.source)
  )
    return false;
  if (!Array.isArray(value.fields) || typeof value.medium !== 'string') return false;
  if (value.stateRole !== null && typeof value.stateRole !== 'string') return false;
  return value.fields.every(isField);
}

function isGuard(value: unknown): value is BangumiGuard {
  return (
    record(value) &&
    typeof value.subjectId === 'string' &&
    SUBJECT_ID.test(value.subjectId) &&
    typeof value.releaseDigest === 'string' &&
    typeof value.identityEpoch === 'string'
  );
}

function isCurrent(value: unknown): value is BangumiCurrent {
  if (!record(value) || typeof value.state !== 'string' || typeof value.revision !== 'number') return false;
  if ('incarnationId' in value && value.incarnationId !== null && typeof value.incarnationId !== 'string') return false;
  return true;
}

function isScoreSource(value: unknown): value is BangumiScoreReview['source'] {
  return (
    record(value) &&
    (value.state === 'score' ||
      value.state === 'unrated' ||
      value.state === 'absent' ||
      value.state === 'unsupported') &&
    record(value.scale) &&
    value.scale.minimum === 1 &&
    value.scale.maximum === 10 &&
    typeof value.reason === 'string' &&
    (!('value' in value) ||
      value.value === null ||
      typeof value.value === 'string' ||
      typeof value.value === 'boolean' ||
      (typeof value.value === 'number' && Number.isFinite(value.value)))
  );
}

function isScoreQuestion(value: unknown): value is NonNullable<BangumiScoreReview['native']['question']> {
  if (
    !record(value) ||
    typeof value.id !== 'string' ||
    !Number.isSafeInteger(value.revision) ||
    (value.meaning !== null && typeof value.meaning !== 'string') ||
    typeof value.label !== 'string' ||
    (value.grain !== 'work' && value.grain !== 'release' && value.grain !== 'episode' && value.grain !== 'character') ||
    (value.lifecycleState !== 'active' && value.lifecycleState !== 'retired') ||
    !record(value.scale) ||
    !safeInteger(value.scale.minimum) ||
    !safeInteger(value.scale.maximum) ||
    !safeInteger(value.scale.step)
  )
    return false;
  return value.scale.minimum <= value.scale.maximum && value.scale.step > 0;
}

function isScoreCurrentVote(value: unknown): value is NonNullable<BangumiScoreReview['native']['currentVote']> {
  if (!record(value)) return false;
  if (value.state === 'absent' || value.state === 'cleared') return true;
  return (
    value.state === 'set' &&
    Number.isSafeInteger(value.units) &&
    Number.isSafeInteger(value.revision) &&
    typeof value.at === 'string'
  );
}

function isScoreSelection(value: unknown): value is BangumiScoreSelection {
  if (!record(value)) return false;
  if (value.action === 'preserve' || value.action === 'clear') return true;
  return value.action === 'set' && Number.isSafeInteger(value.units);
}

function isScoreReview(value: unknown): value is BangumiScoreReview {
  if (!record(value) || !isScoreSource(value.source) || !record(value.native)) return false;
  const native = value.native;
  if (typeof native.questionId !== 'string') return false;
  if (native.question !== null && !isScoreQuestion(native.question)) return false;
  if (native.currentVote !== null && !isScoreCurrentVote(native.currentVote)) return false;
  if (!isScoreSelection(native.selection) || !record(native.admission)) return false;
  const admission = native.admission;
  const reviewed = admission.status === 'reviewed' && admission.reason === 'native_review_observed';
  const unavailable =
    admission.status === 'unavailable' &&
    (admission.reason === 'native_vote_scope_required' ||
      admission.reason === 'target_not_selected' ||
      admission.reason === 'question_unavailable' ||
      admission.reason === 'question_revision_unsupported' ||
      admission.reason === 'question_scale_unsupported' ||
      admission.reason === 'conditional_admission_unavailable');
  if (!reviewed && !unavailable) return false;
  return true;
}

function isScoreOutcome(value: unknown): value is BangumiScoreOutcome {
  if (!record(value)) return false;
  if (value.action !== 'preserve' && value.action !== 'set' && value.action !== 'clear') return false;
  if (
    value.status !== 'applied' &&
    value.status !== 'skipped' &&
    value.status !== 'stale' &&
    value.status !== 'unsupported' &&
    value.status !== 'failed' &&
    value.status !== 'unavailable'
  )
    return false;
  if ('reason' in value && typeof value.reason !== 'string') return false;
  if ('vote' in value) {
    if (!record(value.vote)) return false;
    if (!Number.isSafeInteger(value.vote.units) || !Number.isSafeInteger(value.vote.revision)) return false;
    if (typeof value.vote.at !== 'string') return false;
  }
  return true;
}

function isReview(value: unknown): value is BangumiReview {
  if (!record(value) || typeof value.token !== 'string' || !SUBJECT_ID.test(value.token)) return false;
  if (!isMatch(value.match) || !Array.isArray(value.candidates) || typeof value.conflict !== 'boolean') return false;
  if (value.target !== null && (typeof value.target !== 'string' || !SUBJECT_ID.test(value.target))) return false;
  if (value.guard !== null && !isGuard(value.guard)) return false;
  if (value.proposedState !== null && typeof value.proposedState !== 'string') return false;
  if (value.current !== null && !isCurrent(value.current)) return false;
  if ('score' in value && !isScoreReview(value.score)) return false;
  return value.candidates.every((id) => typeof id === 'string' && SUBJECT_ID.test(id));
}

function isOutcome(value: unknown): value is BangumiOutcome {
  if (
    !record(value) ||
    typeof value.ordinal !== 'number' ||
    !Array.isArray(value.applied) ||
    !Array.isArray(value.retained)
  )
    return false;
  const validStatus =
    value.status === 'applied' ||
    value.status === 'skipped' ||
    value.status === 'stale' ||
    value.status === 'unsupported' ||
    value.status === 'failed';
  return validStatus && (!('score' in value) || isScoreOutcome(value.score));
}

function isRow(value: unknown): value is BangumiRow {
  if (!record(value) || typeof value.ordinal !== 'number' || !isEvidence(value.evidence)) return false;
  if (value.review !== null && !isReview(value.review)) return false;
  if (value.outcome !== null && !isOutcome(value.outcome)) return false;
  return true;
}

function isPage(value: unknown): value is BangumiPage {
  if (!record(value) || typeof value.uploadId !== 'string' || !SUBJECT_ID.test(value.uploadId)) return false;
  if (typeof value.cancelled !== 'boolean' || !Array.isArray(value.rows) || value.rows.length > BANGUMI_PAGE)
    return false;
  if (value.next !== null && typeof value.next !== 'number') return false;
  return value.rows.every(isRow);
}

function isApply(value: unknown): value is BangumiApplyResult {
  if (
    !record(value) ||
    typeof value.uploadId !== 'string' ||
    !Array.isArray(value.outcomes) ||
    !Array.isArray(value.remaining)
  )
    return false;
  return value.outcomes.every(isOutcome) && value.remaining.every((ordinal) => typeof ordinal === 'number');
}

function isLabelVersion(value: unknown): value is { id: string; revision: number } {
  return (
    record(value) &&
    typeof value.id === 'string' &&
    SUBJECT_ID.test(value.id) &&
    typeof value.revision === 'number' &&
    Number.isSafeInteger(value.revision) &&
    value.revision > 0
  );
}

function isLabelState(value: unknown): value is BangumiLabelState {
  if (
    !record(value) ||
    typeof value.confirmed !== 'boolean' ||
    !Array.isArray(value.outcomes) ||
    value.outcomes.length > 16
  )
    return false;
  const review = value.review;
  if (
    !record(review) ||
    typeof review.token !== 'string' ||
    !SUBJECT_ID.test(review.token) ||
    typeof review.rowRevision !== 'string' ||
    !SUBJECT_ID.test(review.rowRevision) ||
    !['missing', 'empty', 'known', 'invalid', 'unknown'].includes(String(review.evidence)) ||
    !Array.isArray(review.items) ||
    review.items.length > 16
  )
    return false;
  if (
    review.subject !== null &&
    (!record(review.subject) ||
      typeof review.subject.subjectId !== 'string' ||
      !SUBJECT_ID.test(review.subject.subjectId) ||
      typeof review.subject.identityEpoch !== 'string' ||
      typeof review.subject.acceptingType !== 'string' ||
      !(review.subject.releaseDigest === null || typeof review.subject.releaseDigest === 'string'))
  )
    return false;
  const items = review.items.every((item) => {
    if (
      !record(item) ||
      !Number.isSafeInteger(item.index) ||
      !isJson(item.source) ||
      (item.status !== 'ready' && item.status !== 'invalid' && item.status !== 'duplicate') ||
      !(item.duplicateOf === null || Number.isSafeInteger(item.duplicateOf))
    )
      return false;
    if (!record(item.target)) return false;
    if ('labelId' in item.target)
      return (
        typeof item.target.labelId === 'string' &&
        SUBJECT_ID.test(item.target.labelId) &&
        safeInteger(item.target.revision) &&
        item.target.revision > 0
      );
    return typeof item.target.name === 'string';
  });
  if (!items) return false;
  return value.outcomes.every((outcome) => {
    if (
      !record(outcome) ||
      !Number.isSafeInteger(outcome.index) ||
      !['assigned', 'unchanged', 'duplicate', 'invalid', 'stale', 'capacity', 'conflict', 'limit', 'failed'].includes(
        String(outcome.status),
      ) ||
      typeof outcome.created !== 'boolean'
    )
      return false;
    return (
      (outcome.label === null || isLabelVersion(outcome.label)) &&
      (outcome.assignment === null || isLabelVersion(outcome.assignment))
    );
  });
}

function isTagPage(value: unknown): value is BangumiTagPage {
  if (
    !record(value) ||
    !Number.isSafeInteger(value.ordinal) ||
    !(value.rowRevision === null || (typeof value.rowRevision === 'string' && SUBJECT_ID.test(value.rowRevision))) ||
    !['missing', 'empty', 'known', 'invalid', 'unknown'].includes(String(value.evidence)) ||
    !Array.isArray(value.tags) ||
    value.tags.length > 32 ||
    !(value.next === null || (safeInteger(value.next) && value.next >= 0)) ||
    !(value.labels === null || isLabelState(value.labels))
  )
    return false;
  return value.tags.every(
    (tag) =>
      record(tag) &&
      Number.isSafeInteger(tag.index) &&
      'value' in tag &&
      isJson(tag.value) &&
      (tag.status === 'supported' || tag.status === 'invalid' || tag.status === 'unknown') &&
      (tag.proposedName === null || typeof tag.proposedName === 'string'),
  );
}

function isLabelApply(value: unknown): value is BangumiLabelApplyData {
  if (
    !record(value) ||
    typeof value.uploadId !== 'string' ||
    !SUBJECT_ID.test(value.uploadId) ||
    !Number.isSafeInteger(value.ordinal) ||
    !Array.isArray(value.outcomes) ||
    value.outcomes.length > 16 ||
    !Array.isArray(value.remaining) ||
    value.remaining.length > 16
  )
    return false;
  return (
    value.outcomes.every((outcome) => {
      if (
        !record(outcome) ||
        !Number.isSafeInteger(outcome.index) ||
        !['assigned', 'unchanged', 'duplicate', 'invalid', 'stale', 'capacity', 'conflict', 'limit', 'failed'].includes(
          String(outcome.status),
        ) ||
        typeof outcome.created !== 'boolean'
      )
        return false;
      return (
        (outcome.label === null || isLabelVersion(outcome.label)) &&
        (outcome.assignment === null || isLabelVersion(outcome.assignment))
      );
    }) && value.remaining.every((index) => Number.isSafeInteger(index))
  );
}

function isLabelOptions(value: unknown): value is { labels: BangumiLabelOption[] } {
  if (!record(value) || !Array.isArray(value.labels) || value.labels.length > 20) return false;
  return value.labels.every(
    (label) =>
      record(label) &&
      typeof label.id === 'string' &&
      SUBJECT_ID.test(label.id) &&
      typeof label.name === 'string' &&
      safeInteger(label.revision) &&
      label.revision > 0,
  );
}

function isChoice(value: unknown): value is BangumiChoice {
  if (!record(value) || typeof value.ordinal !== 'number' || typeof value.reviewToken !== 'string') return false;
  if (!SUBJECT_ID.test(value.reviewToken) || typeof value.skip !== 'boolean') return false;
  return value.state === 'preserve' || value.state === 'replace' || value.state === 'omit';
}

async function withSession(
  request: Request,
  sessionEnv: Partial<SessionEnv>,
  originConfigured: boolean,
): Promise<{ authorization: string } | BangumiFailure> {
  if (!originConfigured) return { kind: 'unavailable' };
  try {
    await prepareSession(request, sessionEnv);
    const authorization = viewerCredential(request);
    if (!authorization) return { kind: 'denied' };
    return { authorization };
  } catch (error) {
    if (isPlatformClosedError(error)) return { kind: 'unavailable' };
    if (statusOfError(error) === 401 || statusOfError(error) === 403) return { kind: 'denied' };
    throw error;
  }
}

function responseReason(result: NativeResult): string {
  const body = record(result.error) && 'value' in result.error ? result.error.value : result.error;
  if (record(body)) {
    if (typeof body.reason === 'string' && body.reason.trim()) return body.reason;
    if (typeof body.code === 'string' && body.code.trim()) return body.code;
  }
  return `http_${result.status}`;
}

function unavailableReadback(result: NativeResult): { status: 'stale' | 'unavailable'; reason: string } {
  return {
    status: result.status === 409 ? 'stale' : 'unavailable',
    reason: responseReason(result),
  };
}

async function readCurrentEntry(
  client: KernelClient,
  subjectId: string,
  authorization: string,
): Promise<BangumiEntryReadback> {
  const result = await client.libraryEntries({ subjectId }).get({
    query: libraryFullQuery(),
    headers: { authorization },
    fetch: { cache: 'no-store', redirect: 'manual' },
  });
  if (result.status === 404) return { status: 'absent' };
  if (result.error || !record(result.data) || !record(result.data.libraryEntry)) return unavailableReadback(result);
  const entry = result.data.libraryEntry;
  if (entry.subjectId !== subjectId || typeof entry.state !== 'string' || !Number.isSafeInteger(entry.revision))
    return { status: 'unavailable', reason: 'entry_read_response_invalid' };
  if ('incarnationId' in entry && entry.incarnationId !== null && typeof entry.incarnationId !== 'string')
    return { status: 'unavailable', reason: 'entry_read_response_invalid' };
  return {
    status: 'present',
    state: entry.state,
    revision: entry.revision as number,
    ...(entry.incarnationId === undefined ? {} : { incarnationId: entry.incarnationId as string | null }),
  };
}

async function readCurrentVote(
  client: KernelClient,
  subjectId: string,
  questionId: string,
  authorization: string,
): Promise<BangumiVoteReadback> {
  const result = await client
    .subjects({ id: subjectId })
    .ratings({ questionId })
    .vote.get({
      headers: { authorization },
      fetch: { cache: 'no-store', redirect: 'manual' },
    });
  if (result.status === 404) return { status: 'current', vote: { state: 'absent' } };
  if (result.error || !record(result.data)) return unavailableReadback(result);
  const vote = result.data;
  if (!Number.isSafeInteger(vote.units) || !Number.isSafeInteger(vote.revision) || typeof vote.at !== 'string')
    return { status: 'unavailable', reason: 'vote_read_response_invalid' };
  return {
    status: 'current',
    vote: { state: 'set', units: vote.units as number, revision: vote.revision as number, at: vote.at },
  };
}

export function kernelBangumiPort(
  client: KernelClient,
  request: Request,
  sessionEnv: Partial<SessionEnv>,
  originConfigured: boolean,
): BangumiImportPort {
  const headers = (authorization: string): NativeHeaders => ({ authorization });
  const keyedHeaders = (authorization: string, key: string): KeyedNativeHeaders => ({
    authorization,
    'idempotency-key': quotedIdempotencyKey(key),
  });
  async function call<T>(
    command: BangumiCommand,
    send: (bangumi: BangumiSurface, authorization: string) => Promise<NativeResult>,
    read: (data: unknown) => T | undefined,
  ): Promise<T | BangumiFailure | BangumiUnknown> {
    const session = await withSession(request, sessionEnv, originConfigured);
    if ('kind' in session) return session;
    const bangumi = nativeBangumiImport(client);
    if (!bangumi) return { kind: 'unavailable' };
    let result: NativeResult;
    try {
      result = await send(bangumi, session.authorization);
    } catch (error) {
      if (isPlatformClosedError(error)) return { kind: 'unavailable' };
      if (error instanceof TypeError) return unknown(command);
      throw error;
    }
    if (result.error) return outcomeOf(result.status, result.error.value, command);
    const value = read(result.data);
    if (!value) return { kind: 'unavailable' };
    return value;
  }
  return {
    async preview(command) {
      return call(
        command,
        (bangumi, authorization) =>
          bangumi.$preview.post({ upload: command.upload }, { headers: keyedHeaders(authorization, command.key) }),
        (data) => {
          if (!record(data) || typeof data.uploadId !== 'string' || !SUBJECT_ID.test(data.uploadId)) return undefined;
          if (typeof data.count !== 'number' || !Number.isInteger(data.count) || data.count < 1) return undefined;
          return { kind: 'previewed' as const, uploadId: data.uploadId, count: data.count };
        },
      );
    },
    async page(command) {
      return call(
        command,
        (bangumi, authorization) =>
          bangumi({ uploadId: command.uploadId }).get({
            query: { after: command.after },
            headers: headers(authorization),
          }),
        (data) => (isPage(data) ? ({ kind: 'page', page: data } as const) : undefined),
      );
    },
    async review(command) {
      return call(
        command,
        (bangumi, authorization) => {
          const resource = bangumi({ uploadId: command.uploadId });
          return resource.$review.post(
            {
              ordinal: command.ordinal,
              ...(command.target ? { target: command.target } : {}),
              ...(command.score ? { score: command.score } : {}),
            },
            { headers: keyedHeaders(authorization, command.key) },
          );
        },
        (data) => {
          if (!record(data) || typeof data.ordinal !== 'number' || !isReview(data.review)) return undefined;
          return { kind: 'reviewed' as const, ordinal: data.ordinal, review: data.review };
        },
      );
    },
    async apply(command) {
      return call(
        command,
        (bangumi, authorization) => {
          const resource = bangumi({ uploadId: command.uploadId });
          return resource.$apply.post(command.body, { headers: headers(authorization) });
        },
        (data) => (isApply(data) ? ({ kind: 'applied', result: data } as const) : undefined),
      );
    },
    async cancel(command) {
      return call(
        command,
        (bangumi, authorization) =>
          bangumi({ uploadId: command.uploadId }).$cancel.post(
            {},
            { headers: keyedHeaders(authorization, command.key) },
          ),
        (data) => {
          if (!record(data) || typeof data.uploadId !== 'string' || data.cancelled !== true) return undefined;
          return { kind: 'cancelled' as const, uploadId: data.uploadId };
        },
      );
    },
    async delete(command) {
      return call(
        command,
        (bangumi, authorization) =>
          bangumi({ uploadId: command.uploadId }).delete(undefined, {
            headers: keyedHeaders(authorization, command.key),
          }),
        (data) => (record(data) && data.deleted === true ? ({ kind: 'deleted' } as const) : undefined),
      );
    },
    async tags(command) {
      return call(
        command,
        (bangumi, authorization) =>
          bangumi({ uploadId: command.uploadId })
            .rows({ ordinal: command.ordinal })
            .tags.get({ query: { after: command.after }, headers: headers(authorization) }),
        (data) =>
          isTagPage(data) && data.ordinal === command.ordinal
            ? ({ kind: 'tags', page: data, ...(command.custody ? { custody: command.custody } : {}) } as const)
            : undefined,
      );
    },
    async searchLabels(query) {
      const session = await withSession(request, sessionEnv, originConfigured);
      if ('kind' in session) return session;
      try {
        const result = await client.libraryLabels.get({
          query: { q: query, limit: 20 },
          headers: { authorization: session.authorization },
        });
        if (result.error) return failure(result.status, result.error.value);
        if (!isLabelOptions(result.data)) return { kind: 'unavailable' };
        return { kind: 'label-options', labels: result.data.labels };
      } catch (error) {
        if (isPlatformClosedError(error)) return { kind: 'unavailable' };
        if (error instanceof TypeError) return { kind: 'unavailable' };
        throw error;
      }
    },
    async reviewLabels(command) {
      return call(
        command,
        (bangumi, authorization) =>
          bangumi({ uploadId: command.uploadId }).$reviewLabels.post(
            { ordinal: command.ordinal, rowRevision: command.rowRevision, mappings: command.mappings },
            { headers: keyedHeaders(authorization, command.key) },
          ),
        (data) =>
          record(data) &&
          data.ordinal === command.ordinal &&
          isLabelState(data.labels) &&
          data.labels.review.rowRevision === command.rowRevision
            ? ({ kind: 'labels-reviewed', ordinal: data.ordinal, labels: data.labels } as const)
            : undefined,
      );
    },
    async applyLabels(command) {
      return call(
        command,
        (bangumi, authorization) =>
          bangumi({ uploadId: command.uploadId }).$applyLabels.post(
            { ordinal: command.ordinal, reviewToken: command.reviewToken },
            { headers: headers(authorization) },
          ),
        (data) =>
          isLabelApply(data) && data.uploadId === command.uploadId && data.ordinal === command.ordinal
            ? ({ kind: 'labels-applied', result: data } as const)
            : undefined,
      );
    },
    async readAssignments(subjectId) {
      const session = await withSession(request, sessionEnv, originConfigured);
      if ('kind' in session) return session;
      const assignments = await readSubjectLabelAssignments(client, subjectId, session.authorization);
      return { kind: 'assignments', subjectId, assignments };
    },
    async admitSource(command) {
      const session = await withSession(request, sessionEnv, originConfigured);
      if ('kind' in session) return session;
      try {
        const result = await admitPrivateSourceObservation(client, {
          subjectId: command.subjectId,
          body: command.body,
          key: command.key,
          authorization: session.authorization,
        });
        return mapSourceAdmissionPort(result, command);
      } catch (error) {
        if (isPlatformClosedError(error)) return { kind: 'unavailable' };
        if (error instanceof TypeError) return unknown(command);
        throw error;
      }
    },
    async inspect(command: BangumiInspectionCommand): Promise<BangumiInspectionResult> {
      const session = await withSession(request, sessionEnv, originConfigured);
      if ('kind' in session) {
        const unavailable = { status: 'unavailable', reason: session.kind } as const;
        return { entry: unavailable, vote: command.questionId ? unavailable : null };
      }
      const [entry, vote] = await Promise.all([
        readCurrentEntry(client, command.subjectId, session.authorization),
        command.questionId
          ? readCurrentVote(client, command.subjectId, command.questionId, session.authorization)
          : Promise.resolve(null),
      ]);
      return { entry, vote };
    },
  };
}

export type {
  BangumiApplyCallResult,
  BangumiMutateResult,
  BangumiPageResult,
  BangumiPreviewResult,
  BangumiReviewResult,
};

import type { KernelClient } from '@rezics/client';
import { isPlatformClosedError } from '../../kernel/platform-closed';
import type { SessionEnv } from '../../session/client';
import { prepareSession, sessionSubject, viewerCredential } from '../../session/request';
import {
  VNDB_ID,
  quotedVndbKey,
  type VndbApplyResult,
  type VndbCommand,
  type VndbDecision,
  type VndbFailure,
  type VndbJson,
  type VndbPage,
  type VndbPort,
  type VndbPreview,
  type VndbReviewResult,
  type VndbRow,
  type VndbScoreDecision,
  type VndbSourceValue,
  type VndbState,
  type VndbUnknown,
} from './contract';

type VndbSurface = KernelClient['libraryImports']['vndb'];

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function jsonValue(value: unknown): value is VndbJson {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  return Array.isArray(value) ? value.every(jsonValue) : record(value) && Object.values(value).every(jsonValue);
}

/** Eden's `libraryImports` is a function; bind `vndb` by property access, not `in`/`typeof object`. */
export function nativeVndbImport(client: KernelClient): VndbSurface | undefined {
  const route = client.libraryImports?.vndb;
  if (typeof route !== 'function') return undefined;
  try {
    const uploaded = route({ uploadId: '00000000-0000-4000-8000-000000000000' });
    if (
      typeof route.$preview?.post !== 'function' ||
      typeof uploaded.get !== 'function' ||
      typeof uploaded.source?.get !== 'function' ||
      typeof uploaded.$review?.post !== 'function' ||
      typeof uploaded.$apply?.post !== 'function' ||
      typeof uploaded.$cancel?.post !== 'function' ||
      typeof uploaded.delete !== 'function'
    )
      return undefined;
    return route;
  } catch {
    return undefined;
  }
}

function failureKind(status: number): VndbFailure['kind'] {
  if (status === 400) return 'admission';
  if (status === 413) return 'wire-too-large';
  if (status === 401 || status === 403) return 'denied';
  if (status === 404) return 'not-found';
  if (status === 409) return 'conflict';
  if (status === 422) return 'idempotency';
  return 'rejected';
}

function nativeCode(value: unknown): string | undefined {
  if (!record(value) || typeof value.code !== 'string' || !/^[a-z0-9_.-]{1,80}$/i.test(value.code)) return undefined;
  return value.code;
}

function failure(status: number, body: unknown): VndbFailure {
  const code = nativeCode(body);
  return code ? { kind: failureKind(status), status, code } : { kind: failureKind(status), status };
}

function unknown(command: VndbCommand): VndbUnknown {
  return { kind: 'unknown', command };
}

function bounds(value: unknown): value is VndbPreview['limits'] {
  return (
    record(value) &&
    Number.isSafeInteger(value.bytes) &&
    Number.isSafeInteger(value.wireBytes) &&
    Number.isSafeInteger(value.depth) &&
    Number.isSafeInteger(value.rows) &&
    Number.isSafeInteger(value.evidenceBytes) &&
    Number.isSafeInteger(value.page) &&
    Number.isSafeInteger(value.uploads) &&
    Number.isSafeInteger(value.lifetimeMs) &&
    Number.isSafeInteger(value.applyMs)
  );
}

function preview(value: unknown): value is VndbPreview {
  return (
    record(value) &&
    typeof value.uploadId === 'string' &&
    VNDB_ID.test(value.uploadId) &&
    Number.isInteger(value.rows) &&
    (value.rows as number) >= 0 &&
    bounds(value.limits)
  );
}

function sourceValue(value: unknown): value is VndbSourceValue {
  if (!record(value) || !['missing', 'unknown', 'invalid', 'value'].includes(String(value.kind))) return false;
  if (value.raw !== null && typeof value.raw !== 'string') return false;
  if ('value' in value && typeof value.value !== 'string' && typeof value.value !== 'number') return false;
  if ('precision' in value && !['year', 'month', 'day'].includes(String(value.precision))) return false;
  if (
    'scale' in value &&
    (!record(value.scale) ||
      typeof value.scale.min !== 'number' ||
      typeof value.scale.max !== 'number' ||
      typeof value.scale.step !== 'number' ||
      !Number.isFinite(value.scale.min) ||
      !Number.isFinite(value.scale.max) ||
      !Number.isFinite(value.scale.step))
  )
    return false;
  return true;
}

function nativeQuestion(value: unknown): boolean {
  return (
    record(value) &&
    typeof value.id === 'string' &&
    VNDB_ID.test(value.id) &&
    Number.isSafeInteger(value.revision) &&
    (value.meaning === null || typeof value.meaning === 'string') &&
    typeof value.label === 'string' &&
    ['work', 'release', 'episode', 'character'].includes(String(value.grain)) &&
    record(value.scale) &&
    Number.isFinite(value.scale.min) &&
    Number.isFinite(value.scale.max) &&
    Number.isFinite(value.scale.step) &&
    value.aggregateEffect === 'public-standard-aggregate'
  );
}

function nativeVote(value: unknown): boolean {
  if (!record(value)) return false;
  if (value.state === 'unavailable' || value.state === 'absent') return true;
  if (value.state === 'cleared')
    return Number.isSafeInteger(value.revision) && (value.revision as number) >= 1 && typeof value.at === 'string';
  return (
    value.state === 'set' &&
    Number.isSafeInteger(value.units) &&
    (value.units as number) >= 0 &&
    Number.isSafeInteger(value.revision) &&
    (value.revision as number) >= 1 &&
    typeof value.at === 'string'
  );
}

function nativeScore(value: unknown): boolean {
  if (!record(value)) return false;
  if (value.question !== null && !nativeQuestion(value.question)) return false;
  if (!nativeVote(value.currentVote) || typeof value.sourceReason !== 'string') return false;
  if (value.exactUnits !== null && (!Number.isSafeInteger(value.exactUnits) || Number(value.exactUnits) < 0))
    return false;
  return (
    record(value.admission) &&
    value.admission.status === 'unavailable' &&
    [
      'conditional-admission-unavailable',
      'native-question-unavailable',
      'native-current-vote-unavailable',
      'source-not-vn-score',
    ].includes(String(value.admission.reason))
  );
}

function scoreDecision(value: unknown): value is VndbScoreDecision {
  return (
    record(value) &&
    typeof value.reviewId === 'string' &&
    VNDB_ID.test(value.reviewId) &&
    ['applied', 'failed', 'reviewed', 'skipped', 'stale', 'unavailable'].includes(String(value.status)) &&
    typeof value.targetId === 'string' &&
    VNDB_ID.test(value.targetId) &&
    (value.action === 'vote' || value.action === 'clear') &&
    (value.units === null || (Number.isSafeInteger(value.units) && Number(value.units) >= 0)) &&
    nativeQuestion(value.question) &&
    nativeVote(value.currentVote) &&
    (value.consent === 'adopt-native-vote' || value.consent === 'clear-native-vote') &&
    typeof value.sourceReason === 'string' &&
    value.nativeAdmission === 'unavailable'
  );
}

function state(value: unknown): value is VndbState {
  return (
    record(value) &&
    typeof value.id === 'string' &&
    record(value.labels) &&
    Object.values(value.labels).every((label) => typeof label === 'string')
  );
}

function row(value: unknown): value is VndbRow {
  if (!record(value) || !Number.isInteger(value.ordinal) || !['vn', 'retained'].includes(String(value.kind)))
    return false;
  if (
    typeof value.title !== 'string' ||
    !Array.isArray(value.labels) ||
    !value.labels.every((label) => typeof label === 'string')
  )
    return false;
  if (
    value.identifier !== null &&
    (!record(value.identifier) ||
      value.identifier.provider !== 'vndb' ||
      value.identifier.kind !== 'vn' ||
      typeof value.identifier.value !== 'string')
  )
    return false;
  if (value.suggestedRole !== null && typeof value.suggestedRole !== 'string') return false;
  if (
    !record(value.fields) ||
    !Object.values(value.fields).every(sourceValue) ||
    typeof value.retainedReason !== 'string' ||
    !jsonValue(value.evidence)
  )
    return false;
  if (!record(value.match) || !Array.isArray(value.match.candidates)) return false;
  if (!['unsupported', 'ambiguous', 'matched', 'unavailable', 'unmatched'].includes(String(value.match.status)))
    return false;
  if (
    value.target !== null &&
    (!record(value.target) ||
      typeof value.target.targetId !== 'string' ||
      !Array.isArray(value.target.states) ||
      !value.target.states.every(state))
  )
    return false;
  if (
    value.decision !== null &&
    (!record(value.decision) ||
      typeof value.decision.reviewId !== 'string' ||
      typeof value.decision.status !== 'string')
  )
    return false;
  if (value.scoreDecision !== null && !scoreDecision(value.scoreDecision)) return false;
  if (!nativeScore(value.nativeScore)) return false;
  return record(value.fieldsTreatment);
}

function page(value: unknown): value is VndbPage {
  return (
    record(value) &&
    typeof value.uploadId === 'string' &&
    VNDB_ID.test(value.uploadId) &&
    (value.state === 'active' || value.state === 'cancelled') &&
    typeof value.expiresAt === 'string' &&
    Number.isInteger(value.total) &&
    Array.isArray(value.rows) &&
    value.rows.length <= 8 &&
    value.rows.every(row) &&
    (value.next === null || Number.isInteger(value.next))
  );
}

function decision(value: unknown): value is VndbDecision {
  return (
    record(value) &&
    typeof value.reviewId === 'string' &&
    ['applied', 'applying', 'failed', 'reviewed', 'skipped', 'stale', 'unsupported'].includes(String(value.status)) &&
    (value.targetId === null || typeof value.targetId === 'string') &&
    (value.state === null || typeof value.state === 'string')
  );
}

function reviewResult(value: unknown): value is VndbReviewResult {
  if (scoreDecision(value) || decision(value)) return true;
  return (
    record(value) &&
    value.status === 'unavailable' &&
    (value.reason === 'native-question-unavailable' || value.reason === 'native-current-vote-unavailable')
  );
}

function applied(value: unknown): value is VndbApplyResult {
  return (
    record(value) &&
    typeof value.uploadId === 'string' &&
    Array.isArray(value.outcomes) &&
    value.outcomes.length <= 8 &&
    value.outcomes.every(
      (outcome) =>
        record(outcome) &&
        Number.isInteger(outcome.ordinal) &&
        ((typeof outcome.reviewId === 'string' && outcome.scoreReviewId === undefined) ||
          (typeof outcome.scoreReviewId === 'string' && outcome.reviewId === undefined)) &&
        typeof outcome.status === 'string',
    ) &&
    (value.stopped === null || value.stopped === 'cancelled' || value.stopped === 'deadline')
  );
}

function responseData(value: unknown): { status: number; data: unknown; error: unknown } | null {
  if (!record(value) || typeof value.status !== 'number') return null;
  const error = record(value.error) && 'value' in value.error ? value.error.value : value.error;
  return { status: value.status, data: value.data, error };
}

async function withSession(
  request: Request,
  sessionEnv: Partial<SessionEnv>,
  originConfigured: boolean,
  expectedSubject: string,
): Promise<{ authorization: string } | VndbFailure> {
  if (!originConfigured) return { kind: 'unavailable', status: 503 };
  try {
    await prepareSession(request, sessionEnv);
    const authorization = viewerCredential(request);
    return authorization && sessionSubject(request) === expectedSubject
      ? { authorization }
      : { kind: 'denied', status: 401 };
  } catch (error) {
    return isPlatformClosedError(error) ? { kind: 'unavailable', status: 503 } : { kind: 'unavailable', status: 503 };
  }
}

export function kernelVndbPort(
  client: KernelClient,
  request: Request,
  sessionEnv: Partial<SessionEnv>,
  originConfigured: boolean,
  expectedSubject: string,
): VndbPort {
  function headers(authorization: string): { authorization: string };
  function headers(authorization: string, key: string): { authorization: string; 'idempotency-key': string };
  function headers(authorization: string, key?: string) {
    return { authorization, ...(key ? { 'idempotency-key': quotedVndbKey(key) } : {}) };
  }
  const route = nativeVndbImport(client);

  async function call<T, R>(
    command: VndbCommand,
    send: (authorization: string) => Promise<unknown>,
    decode: (data: unknown) => T | undefined,
    resultOf: (value: T) => R,
  ): Promise<R | VndbFailure | VndbUnknown> {
    if (!route) return { kind: 'unavailable', status: 503 };
    const auth = await withSession(request, sessionEnv, originConfigured, expectedSubject);
    if ('kind' in auth) return auth;
    try {
      const result = responseData(await send(auth.authorization));
      if (!result || result.status === 0 || result.status >= 500) return unknown(command);
      if (result.status >= 400) return failure(result.status, result.error);
      const value = decode(result.data);
      return value === undefined ? unknown(command) : resultOf(value);
    } catch {
      return unknown(command);
    }
  }

  return {
    preview(command) {
      return call(
        command,
        (authorization) => route!.$preview.post({ xml: command.xml }, { headers: headers(authorization, command.key) }),
        (data) => (preview(data) ? data : undefined),
        (value) => ({ kind: 'previewed', value }),
      );
    },
    page(command) {
      return call(
        command,
        (authorization) =>
          route!({ uploadId: command.uploadId }).get({
            query: { offset: command.offset },
            headers: headers(authorization),
          }),
        (data) => (page(data) ? data : undefined),
        (value) => ({ kind: 'page', value }),
      );
    },
    source(command) {
      return call(
        command,
        (authorization) =>
          route!({ uploadId: command.uploadId }).source.get({
            headers: headers(authorization),
          }),
        (data) => (record(data) && typeof data.xml === 'string' ? data.xml : undefined),
        (xml) => ({ kind: 'source', xml }),
      );
    },
    review(command) {
      return call(
        command,
        (authorization) =>
          route!({ uploadId: command.uploadId }).$review.post(command.body, {
            headers: headers(authorization, command.key),
          }),
        (data) => (reviewResult(data) ? data : undefined),
        (value) => ({ kind: 'reviewed', value }),
      );
    },
    apply(command) {
      return call(
        command,
        (authorization) =>
          route!({ uploadId: command.uploadId }).$apply.post(command.body, { headers: headers(authorization) }),
        (data) => (applied(data) ? data : undefined),
        (value) => ({ kind: 'applied', value }),
      );
    },
    cancel(command) {
      return call(
        command,
        (authorization) =>
          route!({ uploadId: command.uploadId }).$cancel.post({}, { headers: headers(authorization, command.key) }),
        (data) => (record(data) && data.state === 'cancelled' ? true : undefined),
        () => ({ kind: 'cancelled' }),
      );
    },
    delete(command) {
      return call(
        command,
        (authorization) =>
          route!({ uploadId: command.uploadId }).delete(undefined, { headers: headers(authorization, command.key) }),
        (data) => (record(data) && data.state === 'deleted' ? true : undefined),
        () => ({ kind: 'deleted' }),
      );
    },
  };
}

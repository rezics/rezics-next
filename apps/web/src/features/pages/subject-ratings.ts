import type { KernelClient } from '@rezics/client';
import type { SessionEnv } from '../../session/client';
import { prepareSession, sessionSubject, viewerCredential } from '../../session/request';
import { admitRatingRetryAfter, ratingRetryAt } from './rating-retry-admission';
import { decodeOwnRatingValue } from './subject-own-rating-value';
import { admitRatingAggregate } from './rating-population-value';
import { GLOBAL, QUESTION } from './subject-ratings-ids.ts';
import { classifyPersonalScoreWriteProblem, type PersonalScoreWriteResult } from '../../library/score-write';

export { GLOBAL, QUESTION };
export type Realm = { id: string; name: string };
export type Figure = {
  population: string;
  count: number;
  mean?: number;
  histogram?: number[];
  remaining?: number;
  freshness?: { asOf: string | null; updating: boolean };
};
export type StatisticObservation = { kind: 'unversioned'; digest: string };
export type Statistic = {
  source: string;
  scale: { min: number; max: number };
  mean: number;
  count: number;
  asOf: string;
  licence?: string;
  attribution?: string;
  sourceRecordId?: string;
  sourceAlias?: string;
  observation?: StatisticObservation;
};

export const SOURCE_STATISTIC_PROVIDERS = ['vndb', 'bangumi'] as const;
export type SourceStatisticProvider = (typeof SOURCE_STATISTIC_PROVIDERS)[number];

export function providerStatisticLabel(source: string): string {
  if (source === 'vndb') return 'VNDB';
  if (source === 'bangumi') return 'Bangumi';
  return source;
}
type SubjectRoutes = ReturnType<KernelClient['subjects']>;
import type { RatingQuestion } from '../../ratings/question-contract';
export type { RatingQuestion } from '../../ratings/question-contract';
export type PublicFigure = NonNullable<Awaited<ReturnType<SubjectRoutes['figure']['get']>>['data']>['figure'];
export type Ratings = {
  question: RatingQuestion;
  figure: PublicFigure;
  figures: Figure[];
  statistics: Statistic[];
  realms: Realm[];
  own: number | null;
};

import { PUBLIC_RATING_SCALE, displayRating } from '../../ratings/question-contract';
export { PUBLIC_RATING_SCALE, displayRating } from '../../ratings/question-contract';

export function validRatingUnits(units: number, scale: RatingQuestion['scale']): boolean {
  return (
    Number.isSafeInteger(units) &&
    units >= scale.min &&
    units <= scale.max &&
    (units - scale.min) % scale.displayStep === 0
  );
}

export function hasPublicMean(figure: PublicFigure): figure is PublicFigure & { mean: number } {
  return (
    figure.questionId === QUESTION &&
    figure.populationId === GLOBAL &&
    figure.state === 'ready' &&
    Number.isSafeInteger(figure.count) &&
    figure.count > 0 &&
    figure.mean !== null &&
    Number.isFinite(figure.mean) &&
    figure.mean >= PUBLIC_RATING_SCALE.min &&
    figure.mean <= PUBLIC_RATING_SCALE.max
  );
}

export { readRatingQuestion } from '../../ratings/question-read';
import { readRatingQuestion } from '../../ratings/question-read';

export type SubjectOwnRating =
  | { reader: string | null; kind: 'ready'; units: number | null }
  | { reader: string | null; kind: 'unavailable' };

/** Identify the credential prepared for this request without exposing the bearer in browser cache keys. */
export async function preparedRatingReader(request: Request, authorization: string | null): Promise<string | null> {
  const subject = sessionSubject(request);
  if (subject) return subject;
  if (!authorization) return null;
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(authorization)));
  return `credential:${Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('')}`;
}

/** Public sources have independent, serializable outcomes. Absence is never a successful zero. */
export type FailedRatingOutcome = { kind: 'failed'; retryAfter?: string; retryAt?: number };
export type RatingOutcome<T> =
  | { kind: 'ready'; value: T }
  | { kind: 'idle' | 'absent' | 'unavailable' | 'terminal' }
  | FailedRatingOutcome;
export type RatingSources = {
  question: RatingOutcome<RatingQuestion>;
  figure: RatingOutcome<PublicFigure>;
  global: RatingOutcome<Figure>;
  statistics: RatingOutcome<Statistic[]>;
};
export type RatingSource = keyof RatingSources;
export const RATING_SOURCES: RatingSource[] = ['question', 'figure', 'global', 'statistics'];

export function failedRatingSources(only?: RatingSource): RatingSources {
  const outcome = (source: RatingSource): RatingOutcome<never> => ({
    kind: only === undefined || only === source ? 'failed' : 'idle',
  });
  return {
    question: outcome('question'),
    figure: outcome('figure'),
    global: outcome('global'),
    statistics: outcome('statistics'),
  };
}

export function ratingResponseHeaders(result: { headers?: unknown } | undefined): unknown {
  return result && 'headers' in result ? result.headers : undefined;
}

export function failedRatingOutcome(headers?: unknown, now = Date.now()): FailedRatingOutcome {
  const retryAfter = admitRatingRetryAfter(headers, now);
  const retryAt = ratingRetryAt(retryAfter, now);
  return retryAfter === undefined || retryAt === undefined
    ? { kind: 'failed' }
    : { kind: 'failed', retryAfter, retryAt };
}

export function ratingFailure(
  status: number,
  headers?: unknown,
  now = Date.now(),
): Exclude<RatingOutcome<never>, { kind: 'ready' }> {
  if (status === 404) return { kind: 'absent' };
  if (status === 410) return { kind: 'terminal' };
  if (status === 401 || status === 403) return { kind: 'unavailable' };
  return failedRatingOutcome(headers, now);
}

type RatingRecord = Record<string, unknown>;

function isRecord(value: unknown): value is RatingRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isInteger(value: unknown): value is number {
  return Number.isInteger(value);
}

function isDate(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function isRatingQuestion(value: unknown): value is RatingQuestion {
  if (!isRecord(value) || !isRecord(value.scale)) return false;
  return (
    value.id === QUESTION &&
    isInteger(value.revision) &&
    value.revision >= 1 &&
    value.revision <= 2_147_483_647 &&
    typeof value.label === 'string' &&
    value.label.length >= 1 &&
    value.label.length <= 200 &&
    ['work', 'release', 'episode', 'character'].includes(value.grain as string) &&
    isInteger(value.scale.min) &&
    isInteger(value.scale.max) &&
    value.scale.max > value.scale.min &&
    isInteger(value.scale.displayStep) &&
    value.scale.displayStep >= 1
  );
}

function isPublicFigure(value: unknown): value is PublicFigure {
  if (!isRecord(value) || !isRecord(value.scale)) return false;
  const validDisplayNumber = (number: unknown) =>
    number === null || (typeof number === 'number' && Number.isFinite(number) && number >= 0 && number <= 10);
  return (
    value.questionId === QUESTION &&
    value.populationId === GLOBAL &&
    isInteger(value.scale.min) &&
    isInteger(value.scale.max) &&
    isInteger(value.scale.displayStep) &&
    value.scale.displayStep >= 1 &&
    isInteger(value.count) &&
    value.count >= 0 &&
    ['ready', 'insufficient_data', 'updating'].includes(value.state as string) &&
    validDisplayNumber(value.mean) &&
    validDisplayNumber(value.score)
  );
}

function isObservation(value: unknown): value is StatisticObservation {
  return (
    isRecord(value) &&
    value.kind === 'unversioned' &&
    typeof value.digest === 'string' &&
    /^[0-9a-f]{64}$/.test(value.digest)
  );
}

function isStatistic(value: unknown): value is Statistic {
  if (!isRecord(value) || !isRecord(value.scale)) return false;
  const { min, max } = value.scale;
  const source = value.source;
  const record = value.sourceRecordId;
  return (
    typeof source === 'string' &&
    (source === 'vndb' || source === 'bangumi' || source.length > 0) &&
    isInteger(min) &&
    min >= 0 &&
    min <= 4096 &&
    isInteger(max) &&
    max > min &&
    max <= 4096 &&
    typeof value.mean === 'number' &&
    Number.isFinite(value.mean) &&
    value.mean >= min &&
    value.mean <= max &&
    isInteger(value.count) &&
    Number.isSafeInteger(value.count) &&
    value.count >= 1 &&
    value.count <= 2_147_483_647 &&
    isDate(value.asOf) &&
    (value.licence === undefined ||
      (typeof value.licence === 'string' && value.licence.length >= 1 && value.licence.length <= 1024)) &&
    (value.attribution === undefined ||
      (typeof value.attribution === 'string' && value.attribution.length >= 1 && value.attribution.length <= 2000)) &&
    (value.sourceAlias === undefined ||
      (typeof value.sourceAlias === 'string' && value.sourceAlias.length >= 1 && value.sourceAlias.length <= 128)) &&
    (record === undefined || (typeof record === 'string' && record.length >= 1 && record.length <= 1024)) &&
    (value.observation === undefined || isObservation(value.observation))
  );
}

function isNativeStatistic(value: Statistic): boolean {
  if (value.source !== 'vndb' && value.source !== 'bangumi') return false;
  if (value.source === 'bangumi' && value.scale.min === 0 && value.scale.max === 10) {
    if (value.sourceRecordId !== undefined && !/^[1-9][0-9]*$/.test(value.sourceRecordId)) return false;
  }
  return true;
}

function isStatistics(value: unknown): value is Statistic[] {
  if (!Array.isArray(value) || value.length > 2 || !value.every(isStatistic)) return false;
  const native = value.filter(isNativeStatistic);
  if (native.length !== value.length) return value.every(isStatistic) && value.length <= 2;
  const providers = native.map((item) => item.source);
  return new Set(providers).size === providers.length;
}

/** Legacy supplied display fixtures are adapted explicitly; they are never native population authority. */
export function suppliedRatingSources(data: Ratings): RatingSources {
  const global = data.figures.find((item) => item.population === GLOBAL);
  return {
    question: { kind: 'ready', value: data.question },
    figure: { kind: 'ready', value: data.figure },
    global: global ? { kind: 'ready', value: global } : { kind: 'absent' },
    statistics: { kind: 'ready', value: data.statistics },
  };
}

/** One anonymous read per requested source, concurrently; no credential, memberships or own vote is acquired. */
export async function readRatings(
  client: KernelClient,
  id: string,
  only?: RatingSource,
  signal?: AbortSignal,
): Promise<RatingSources> {
  signal?.throwIfAborted();
  const fetch = signal ? { signal } : {};
  const subject = client.subjects({ id });
  const requested = (source: RatingSource) => only === undefined || only === source;
  async function settle<T>(source: RatingSource, read: () => Promise<RatingOutcome<T>>): Promise<RatingOutcome<T>> {
    if (!requested(source)) return { kind: 'idle' };
    try {
      const result = await read();
      signal?.throwIfAborted();
      return result;
    } catch {
      signal?.throwIfAborted();
      return { kind: 'failed' };
    }
  }
  const [question, figure, global, statistics] = await Promise.all([
    settle('question', async () => {
      const result = await client['rating-questions']({ questionId: QUESTION }).get({ fetch });
      return result.status === 200 && isRatingQuestion(result.data)
        ? { kind: 'ready', value: result.data }
        : ratingFailure(result.status, ratingResponseHeaders(result));
    }),
    settle('figure', async () => {
      const result = await subject.figure.get({ fetch });
      return result.status === 200 && isPublicFigure(result.data?.figure)
        ? { kind: 'ready', value: result.data.figure }
        : ratingFailure(result.status, ratingResponseHeaders(result));
    }),
    settle('global', async () => {
      const result = await subject.ratings.get({ query: { question: QUESTION, population: [GLOBAL] }, fetch });
      if (result.status !== 200) return ratingFailure(result.status, ratingResponseHeaders(result));
      const aggregate = admitRatingAggregate(result.data, { subject: id, question: QUESTION, populations: [GLOBAL] });
      const value = aggregate?.figures[0];
      return value ? { kind: 'ready', value } : { kind: 'failed' };
    }),
    settle('statistics', async () => {
      const result = await subject['source-statistics'].get({ fetch });
      return result.status === 200 && isStatistics(result.data)
        ? { kind: 'ready', value: result.data }
        : ratingFailure(result.status, ratingResponseHeaders(result));
    }),
  ]);
  return { question, figure, global, statistics };
}

export async function readOwnRating(
  client: KernelClient,
  request: Request,
  env: Partial<SessionEnv>,
  id: string,
  expectedReader?: string | null,
): Promise<SubjectOwnRating> {
  const signal = request.signal;
  let reader: string | null = null;
  try {
    signal.throwIfAborted();
    await prepareSession(request, env);
    signal.throwIfAborted();
    const authorization = viewerCredential(request);
    reader = await preparedRatingReader(request, authorization);
    signal.throwIfAborted();
    if (!authorization || (expectedReader !== undefined && reader !== expectedReader))
      return { reader, kind: 'unavailable' };
    const result = await client
      .subjects({ id })
      .ratings({ questionId: QUESTION })
      .vote.get({ headers: { authorization }, fetch: { signal } });
    signal.throwIfAborted();
    if (result.status === 200) {
      const value = decodeOwnRatingValue(result.data);
      return value ? { reader, kind: 'ready', units: value.units } : { reader, kind: 'unavailable' };
    }
    if (result.status === 404) return { reader, kind: 'ready', units: null };
    return { reader, kind: 'unavailable' };
  } catch {
    signal.throwIfAborted();
    return { reader, kind: 'unavailable' };
  }
}

function currentRatingObservation(subjectId: string, question: RatingQuestion) {
  return {
    subjectId,
    question: {
      id: question.id,
      revision: question.revision,
      grain: question.grain,
      meaning: question.meaning ?? question.label,
      scale: question.scale,
    },
  };
}

function ratingWriteProblem(result: { status: number; error?: unknown }): PersonalScoreWriteResult {
  const error = result.error;
  const body =
    error && typeof error === 'object' && 'value' in error
      ? error.value
      : error && typeof error === 'object' && 'data' in error
        ? error.data
        : error;
  const record = body && typeof body === 'object' && !Array.isArray(body) ? (body as Record<string, unknown>) : {};
  return classifyPersonalScoreWriteProblem({
    status: result.status,
    ...(typeof record.code === 'string' ? { code: record.code } : {}),
    ...(typeof record.detail === 'string' ? { detail: record.detail } : {}),
  });
}

async function rereadOwnVote(
  vote: { get: (init: { headers: { authorization: string } }) => Promise<{ status: number; data?: unknown }> },
  authorization: string,
  units: number | null,
): Promise<PersonalScoreWriteResult | null> {
  try {
    const current = await vote.get({ headers: { authorization } });
    if (units === null) return current.status === 404 ? 'successful' : null;
    if (current.status !== 200) return null;
    const value = decodeOwnRatingValue(current.data);
    return value?.units === units ? 'successful' : null;
  } catch {
    return null;
  }
}

/** Write this reader's one vote. Each user action supplies its own idempotency key. */
export async function writeOwnRating(
  client: KernelClient,
  id: string,
  authorization: string,
  units: number | null,
  idempotencyKey: string,
): Promise<boolean> {
  try {
    const question = await readRatingQuestion(client);
    if (units !== null && (!question || !validRatingUnits(units, question.scale))) return false;
    return (
      (await writeRatingVote(client, {
        subjectId: id,
        questionId: QUESTION,
        authorization,
        units,
        idempotencyKey,
        ...(question ? { observation: currentRatingObservation(id, question) } : {}),
      })) === 'successful'
    );
  } catch {
    return false;
  }
}

/** Shared native transport for the existing vote writer. A bound call never rereads an unbound question. */
export async function writeRatingVote(
  client: KernelClient,
  input: {
    subjectId: string;
    questionId: string;
    authorization: string;
    units: number | null;
    idempotencyKey: string;
    observation?: {
      subjectId: string;
      question: {
        id: string;
        revision: number;
        grain: string;
        meaning: string;
        scale: { min: number; max: number; displayStep: number };
      };
    };
  },
): Promise<PersonalScoreWriteResult> {
  const vote = client.subjects({ id: input.subjectId }).ratings({ questionId: input.questionId }).vote;
  const headers = {
    authorization: input.authorization,
    'idempotency-key': input.idempotencyKey,
    ...(input.observation ? { 'x-rating-observation': JSON.stringify(input.observation) } : {}),
  };
  try {
    const result =
      input.units === null
        ? await vote.delete(undefined, { headers })
        : await vote.put({ units: input.units }, { headers });
    if (!result.error && result.status === (input.units === null ? 204 : 200)) return 'successful';
    const classified = ratingWriteProblem(result);
    if (classified !== 'uncertain') return classified;
    return (await rereadOwnVote(vote, input.authorization, input.units)) ?? 'uncertain';
  } catch {
    return (await rereadOwnVote(vote, input.authorization, input.units)) ?? 'uncertain';
  }
}

export async function loadSubjectRatings(
  client: KernelClient,
  _request: Request,
  _env: Partial<SessionEnv>,
  id: string,
) {
  return readRatings(client, id);
}

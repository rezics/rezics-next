import type { KernelClient } from '@rezics/client';
import type { SessionEnv } from '../../session/client';
import { prepareSession, sessionSubject, viewerCredential } from '../../session/request';
import { decodeOwnRatingValue } from './subject-own-rating-value';

export const GLOBAL = '00000000-0000-8000-8000-000000000000';
export const QUESTION = '00000000-0000-7000-8000-000000000001';
export type Realm = { id: string; name: string };
export type Figure = {
  population: string;
  count: number;
  mean?: number;
  histogram?: number[];
  remaining?: number;
  freshness?: { asOf: string | null; updating: boolean };
};
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
};
type SubjectRoutes = ReturnType<KernelClient['subjects']>;
export type RatingQuestion = NonNullable<
  Awaited<ReturnType<ReturnType<KernelClient['rating-questions']>['get']>>['data']
>;
export type PublicFigure = NonNullable<Awaited<ReturnType<SubjectRoutes['figure']['get']>>['data']>['figure'];
export type Ratings = {
  question: RatingQuestion;
  figure: PublicFigure;
  figures: Figure[];
  statistics: Statistic[];
  realms: Realm[];
  own: number | null;
};

/** PublicFigure numbers already use this documented display domain, rather than vote units. */
export const PUBLIC_RATING_SCALE = { min: 0, max: 10 } as const;

/** The standard question maps its stored bounds and step to the published display domain. */
export function displayRating(units: number, scale: RatingQuestion['scale']): number {
  return (
    PUBLIC_RATING_SCALE.min +
    ((units - scale.min) / (scale.max - scale.min)) * (PUBLIC_RATING_SCALE.max - PUBLIC_RATING_SCALE.min)
  );
}

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

export async function readRatingQuestion(client: KernelClient): Promise<RatingQuestion | null> {
  const result = await client['rating-questions']({ questionId: QUESTION }).get();
  return result.status === 200 && result.data ? result.data : null;
}

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
export type RatingOutcome<T> =
  | { kind: 'ready'; value: T }
  | { kind: 'idle' | 'absent' | 'unavailable' | 'terminal' | 'failed' };
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

export function ratingFailure(status: number): Exclude<RatingOutcome<never>, { kind: 'ready' }> {
  if (status === 404) return { kind: 'absent' };
  if (status === 410) return { kind: 'terminal' };
  if (status === 401 || status === 403) return { kind: 'unavailable' };
  return { kind: 'failed' };
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
export async function readRatings(client: KernelClient, id: string, only?: RatingSource): Promise<RatingSources> {
  const subject = client.subjects({ id });
  const requested = (source: RatingSource) => only === undefined || only === source;
  async function settle<T>(source: RatingSource, read: () => Promise<RatingOutcome<T>>): Promise<RatingOutcome<T>> {
    if (!requested(source)) return { kind: 'idle' };
    try {
      return await read();
    } catch {
      return { kind: 'failed' };
    }
  }
  const [question, figure, global, statistics] = await Promise.all([
    settle('question', async () => {
      const result = await client['rating-questions']({ questionId: QUESTION }).get();
      return result.status === 200 && result.data?.id === QUESTION
        ? { kind: 'ready', value: result.data }
        : ratingFailure(result.status);
    }),
    settle('figure', async () => {
      const result = await subject.figure.get();
      return result.status === 200 &&
        result.data?.figure.questionId === QUESTION &&
        result.data.figure.populationId === GLOBAL
        ? { kind: 'ready', value: result.data.figure }
        : ratingFailure(result.status);
    }),
    settle('global', async () => {
      const result = await subject.ratings.get({ query: { question: QUESTION, population: [GLOBAL] } });
      if (result.status !== 200 || !result.data) return ratingFailure(result.status);
      const value = result.data.figures.find((item) => item.population === GLOBAL);
      return result.data.subject === id && result.data.question === QUESTION && value
        ? { kind: 'ready', value }
        : { kind: 'failed' };
    }),
    settle('statistics', async () => {
      const result = await subject['source-statistics'].get();
      return result.status === 200 && result.data
        ? { kind: 'ready', value: result.data }
        : ratingFailure(result.status);
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
  let reader: string | null = null;
  try {
    await prepareSession(request, env);
    const authorization = viewerCredential(request);
    reader = await preparedRatingReader(request, authorization);
    if (!authorization || (expectedReader !== undefined && reader !== expectedReader))
      return { reader, kind: 'unavailable' };
    const result = await client
      .subjects({ id })
      .ratings({ questionId: QUESTION })
      .vote.get({ headers: { authorization } });
    if (result.status === 200) {
      const value = decodeOwnRatingValue(result.data);
      return value ? { reader, kind: 'ready', units: value.units } : { reader, kind: 'unavailable' };
    }
    if (result.status === 404) return { reader, kind: 'ready', units: null };
    return { reader, kind: 'unavailable' };
  } catch {
    return { reader, kind: 'unavailable' };
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
  const vote = client.subjects({ id }).ratings({ questionId: QUESTION }).vote;
  const headers = { authorization, 'idempotency-key': idempotencyKey };
  try {
    if (units !== null) {
      const question = await readRatingQuestion(client);
      if (!question || !validRatingUnits(units, question.scale)) return false;
    }
    const result = units === null ? await vote.delete(undefined, { headers }) : await vote.put({ units }, { headers });
    return units === null ? result.status === 204 : result.status === 200;
  } catch {
    return false;
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

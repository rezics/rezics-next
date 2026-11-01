import type { KernelClient } from '@rezics/client';
import type { SessionEnv } from '../../session/client';
import { prepareSession, viewerCredential } from '../../session/request';
import { isPlatformClosedError } from '../../kernel/platform-closed';

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

export type SubjectOwnRating = { kind: 'ready'; units: number | null } | { kind: 'unavailable' };

export async function readRatings(
  client: KernelClient,
  id: string,
  authorization: string | null,
  memberships: Realm[] = [],
): Promise<Ratings | null> {
  const realms = memberships.slice(0, 3);
  const subject = client.subjects({ id });
  const headers = authorization ? { authorization } : {};
  try {
    const ownVote = authorization
      ? subject
          .ratings({ questionId: QUESTION })
          .vote.get({ headers })
          .catch((error: unknown) => {
            if (isPlatformClosedError(error)) return { status: 403, data: null };
            throw error;
          })
      : null;
    const [question, headline, aggregate, sources, vote] = await Promise.all([
      readRatingQuestion(client),
      subject.figure.get({ headers }),
      subject.ratings.get({
        query: { question: QUESTION, population: [GLOBAL, ...realms.map((realm) => realm.id)] },
        headers,
      }),
      subject['source-statistics'].get({ headers }),
      ownVote,
    ]);
    if (
      !question ||
      headline.status !== 200 ||
      !headline.data ||
      headline.data.figure.questionId !== question.id ||
      aggregate.status !== 200 ||
      !aggregate.data ||
      sources.status !== 200 ||
      !sources.data ||
      (vote && ![200, 401, 403, 404].includes(vote.status))
    )
      return null;
    return {
      question,
      figure: headline.data.figure,
      figures: aggregate.data.figures,
      statistics: sources.data,
      realms,
      own: vote?.status === 200 ? (vote.data?.units ?? null) : null,
    };
  } catch {
    return null;
  }
}

export async function readOwnRating(
  client: KernelClient,
  request: Request,
  env: Partial<SessionEnv>,
  id: string,
): Promise<SubjectOwnRating> {
  try {
    await prepareSession(request, env);
    const authorization = viewerCredential(request);
    if (!authorization) return { kind: 'unavailable' };
    const result = await client
      .subjects({ id })
      .ratings({ questionId: QUESTION })
      .vote.get({ headers: { authorization } });
    if (result.status === 200) return { kind: 'ready', units: result.data?.units ?? null };
    if (result.status === 404) return { kind: 'ready', units: null };
    return { kind: 'unavailable' };
  } catch {
    return { kind: 'unavailable' };
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

export async function loadSubjectRatings(client: KernelClient, request: Request, env: Partial<SessionEnv>, id: string) {
  let authorization: string | null = null;
  try {
    await prepareSession(request, env);
    authorization = viewerCredential(request);
  } catch {
    /* Public figures remain readable. */
  }
  return readRatings(client, id, authorization);
}

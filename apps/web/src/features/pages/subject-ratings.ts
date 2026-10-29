import type { KernelClient } from '@rezics/client';
import type { SessionEnv } from '../../session/client';
import { prepareSession, viewerCredential } from '../../session/request';
import { isPlatformClosedError } from '../../kernel/platform-closed';

export const GLOBAL = '00000000-0000-8000-8000-000000000000';
export const QUESTION = '00000000-0000-7000-8000-000000000001';
export type Realm = { id: string; name: string };
export type Figure = { population: string; count: number; mean?: number; histogram?: number[]; remaining?: number };
export type Statistic = {
  source: string;
  scale: { min: number; max: number };
  mean: number;
  count: number;
  asOf: string;
};
export type Ratings = { figures: Figure[]; statistics: Statistic[]; realms: Realm[]; own: number | null };
type Response<T> = { status: number; data?: T | null };
type Route = {
  ratings: { get(options: unknown): Promise<Response<{ figures: Figure[] }>> } & ((args: { questionId: string }) => {
    vote: { get(options: unknown): Promise<Response<{ units: number }>> };
  });
  'source-statistics': { get(options: unknown): Promise<Response<Statistic[]>> };
};

export async function readRatings(
  client: KernelClient,
  id: string,
  authorization: string | null,
  memberships: Realm[] = [],
): Promise<Ratings | null> {
  const realms = memberships.slice(0, 3);
  const subject = client.subjects({ id }) as unknown as Route;
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
    const [aggregate, sources, vote] = await Promise.all([
      subject.ratings.get({
        query: { question: QUESTION, population: [GLOBAL, ...realms.map((realm) => realm.id)] },
        headers,
      }),
      subject['source-statistics'].get({ headers }),
      ownVote,
    ]);
    if (
      aggregate.status !== 200 ||
      !aggregate.data ||
      sources.status !== 200 ||
      !sources.data ||
      (vote && ![200, 401, 403, 404].includes(vote.status))
    )
      return null;
    return {
      figures: aggregate.data.figures,
      statistics: sources.data,
      realms,
      own: vote?.status === 200 ? (vote.data?.units ?? null) : null,
    };
  } catch {
    return null;
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

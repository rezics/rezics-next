import type { PoolClient } from 'pg';
import { routeOf } from '../route/route.ts';
import pageLikedSubjects from './liked-page.sql';
import findLikedSubjects from './liked-membership.sql';
import findLikedVersion from './liked-version.sql';

type Client = Pick<PoolClient, 'query'>;

export type LikedSubject = Readonly<{ subjectId: string; kind: 'like' | 'love' }>;

/** Read raw subject reaction ids from the actor's partition. The caller owns disclosure. */
export async function readLikedSubjectPage(
  client: Client,
  input: Readonly<{ actorAccountId: string; after?: string; limit: number }>,
): Promise<Readonly<{ subjects: readonly LikedSubject[]; next?: string; version: bigint }>> {
  if (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 256)
    throw new TypeError('Liked subject page limit must be from 1 to 256');
  const route = routeOf(input.actorAccountId);
  if (route === null) throw new TypeError('Invalid actor account id');
  const parameters = {
    route,
    actor_id: input.actorAccountId,
    after: input.after ?? '00000000-0000-7000-8000-000000000000',
    limit: input.limit + 1,
  };
  const rows = await client.query<(typeof pageLikedSubjects)['~reylo']['element']>(
    pageLikedSubjects.sql,
    pageLikedSubjects.params.map((name) => parameters[name as keyof typeof parameters]),
  );
  const version = parseVersion(rows.rows[0]?.version);
  const present = rows.rows.filter((row) => row.subjectId !== null);
  const hasMore = present.length > input.limit;
  const subjects = present.slice(0, input.limit).map((row) => {
    if (typeof row.subjectId !== 'string' || (row.kind !== 'like' && row.kind !== 'love'))
      throw new TypeError('Invalid liked subject row');
    return { subjectId: row.subjectId, kind: row.kind } as const;
  });
  return hasMore && subjects.length > 0
    ? { subjects, next: subjects[subjects.length - 1]!.subjectId, version }
    : { subjects, version };
}

/** One statement checks up to 256 subject ids for current like/love membership. */
export async function readLikedMembership(
  client: Client,
  input: Readonly<{ actorAccountId: string; subjectIds: readonly string[] }>,
): Promise<Readonly<{ subjects: ReadonlySet<string>; version: bigint }>> {
  if (input.subjectIds.length > 256) throw new TypeError('At most 256 liked membership ids');
  const route = routeOf(input.actorAccountId);
  if (route === null) throw new TypeError('Invalid actor account id');
  const ids = [...new Set(input.subjectIds)];
  const parameters = {
    route,
    actor_id: input.actorAccountId,
    target_ids: ids,
  };
  const rows = await client.query<(typeof findLikedSubjects)['~reylo']['element']>(
    findLikedSubjects.sql,
    findLikedSubjects.params.map((name) => parameters[name as keyof typeof parameters]),
  );
  const liked = new Set<string>();
  for (const row of rows.rows) {
    if (row.subjectId === null) continue;
    if (typeof row.subjectId !== 'string') throw new TypeError('Invalid liked membership row');
    liked.add(row.subjectId);
  }
  return { subjects: liked, version: parseVersion(rows.rows[0]?.version) };
}

/** Read only the raw source version, never a permission or completeness claim. */
export async function readLikedVersion(client: Client, input: Readonly<{ actorAccountId: string }>): Promise<bigint> {
  const route = routeOf(input.actorAccountId);
  if (route === null) throw new TypeError('Invalid actor account id');
  const parameters = { route, actor_id: input.actorAccountId };
  const rows = await client.query<(typeof findLikedVersion)['~reylo']['element']>(
    findLikedVersion.sql,
    findLikedVersion.params.map((name) => parameters[name as keyof typeof parameters]),
  );
  return parseVersion(rows.rows[0]?.version);
}

function parseVersion(value: unknown): bigint {
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]*)$/.test(value)) throw new TypeError('Invalid liked version row');
  return BigInt(value);
}

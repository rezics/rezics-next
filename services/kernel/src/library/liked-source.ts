import type { PoolClient } from 'pg';
import { readLikedSubjectPage, readLikedMembership, readLikedVersion } from '../content/liked-read.ts';

type Client = Pick<PoolClient, 'query'>;
/** Retained source versions are exact decimal text, never JSON bigint or a floating-point count. */
export type LikedSourceVersion = string;

/** One actual Content native statement, including empty input/output. Raw originals are not public members. */
export async function readLikedOriginalPage(
  client: Client,
  input: { actorAccountId: string; after?: string; limit: number },
) {
  const page = await readLikedSubjectPage(client, input);
  return { subjects: page.subjects, next: page.next ?? null, version: page.version.toString() };
}

/** One actual Content native statement, including an empty batch; membership carries no disclosure authority. */
export async function readLikedOriginalMembership(
  client: Client,
  input: { actorAccountId: string; subjectIds: readonly string[] },
) {
  const membership = await readLikedMembership(client, input);
  return { subjects: membership.subjects, version: membership.version.toString() };
}

/** This version invalidates reaction observations only, not identity or current source/terminal permission. */
export async function readLikedOriginalVersion(client: Client, actorAccountId: string): Promise<LikedSourceVersion> {
  return (await readLikedVersion(client, { actorAccountId })).toString();
}

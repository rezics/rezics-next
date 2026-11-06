import type { Pool } from 'pg';
import { contributionAttribution, contributionDeleted } from '../access/contribution-attribution.ts';
import { readPublicAccount } from '../access/public-identity.ts';
import { routeOf } from '../route/route.ts';
import readPostAuthor from './read-post-author.sql';
import type { ItemView, PostEntry } from './reads.ts';
import { isErasedPlaceholder } from './model.ts';

type AuthorRow = { author_account_id: string };

async function publicIdentity(pool: Pool, accountId: string | null | undefined) {
  if (!accountId) return null;
  const route = routeOf(accountId);
  if (route === null) return null;
  return readPublicAccount(pool, route, accountId);
}

async function parentAuthor(pool: Pool, postId: string): Promise<string | null> {
  const route = routeOf(postId);
  if (route === null) return null;
  const row = await readPostAuthor.run(pool, { route, id: postId });
  const author = (Array.isArray(row) ? row[0] : row) as AuthorRow | null | undefined;
  return author?.author_account_id ?? null;
}

function withoutAuthorId<T extends { authorId?: string }>(value: T): Omit<T, 'authorId'> {
  const { authorId: _authorId, ...rest } = value;
  return rest;
}

/** Adds contribution attribution and, for replies, parent attribution.
 * Deleted authors drop `authorId` so the wire cannot name the account.
 */
export async function presentContributedPost(pool: Pool, post: PostEntry): Promise<PostEntry> {
  if (isErasedPlaceholder(post) || !('authorId' in post)) return post;
  const item = post as ItemView;
  const attribution = contributionAttribution(await publicIdentity(pool, item.authorId));
  const parentId = item.parentId;
  const parent =
    parentId === null
      ? undefined
      : {
          postId: parentId,
          attribution: contributionAttribution(await publicIdentity(pool, await parentAuthor(pool, parentId))),
        };
  const presented = parent ? { ...item, attribution, parent } : { ...item, attribution };
  if (!contributionDeleted(attribution)) return presented;
  return withoutAuthorId(presented) as unknown as PostEntry;
}

import type { Pool } from 'pg';
import { contributionDeleted } from '../access/contribution-attribution.ts';
import { readContributionAttributions } from '../access/public-identity.ts';
import { routeOf } from '../route/route.ts';
import readPostAuthor from './read-post-author.sql';
import type { ItemView, PostEntry } from './reads.ts';
import { isErasedPlaceholder } from './model.ts';

type AuthorRow = { author_account_id: string };

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
 * Live, explicit-deletion and unavailable identities stay distinct.
 */
export async function presentContributedPost(pool: Pool, post: PostEntry): Promise<PostEntry> {
  if (isErasedPlaceholder(post) || !('authorId' in post)) return post;
  const item = post as ItemView;
  const parentId = item.parentId;
  const parentAccountId = parentId === null ? null : await parentAuthor(pool, parentId);
  const ids = [item.authorId, parentAccountId].filter((id): id is string => typeof id === 'string' && id.length > 0);
  const current = ids.length ? await readContributionAttributions(pool, ids) : new Map();
  const attribution = item.authorId ? (current.get(item.authorId) ?? null) : null;
  const parent =
    parentId === null
      ? undefined
      : {
          postId: parentId,
          attribution: parentAccountId ? (current.get(parentAccountId) ?? null) : null,
        };
  const presented = parent ? { ...item, attribution, parent } : { ...item, attribution };
  if (!contributionDeleted(attribution)) return presented;
  return withoutAuthorId(presented) as unknown as PostEntry;
}

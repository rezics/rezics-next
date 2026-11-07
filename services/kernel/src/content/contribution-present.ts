import {
  contributionDeleted,
  readContributionAttributions,
  type ContributionAttribution,
} from '../access/public-identity.ts';
import { deadlineClient } from '../access/authenticate.ts';
import { withConnection } from '../database/pool.ts';
import { ProblemError } from '../http/problem-error.ts';
import type { Anchored, ReadContext } from './model.ts';
import { readPost, type ContentReadDependencies, type PostEntry, type RetainContentRead } from './reads.ts';

type Attributed<T> = T extends { readonly authorId: string }
  ? Omit<T, 'authorId'> & {
      readonly authorId?: string;
      readonly attribution: ContributionAttribution;
      readonly parent?: { readonly postId: string; readonly attribution: ContributionAttribution };
    }
  : T;

/** Public serialization is distinct from native author identity used for authorization. */
export type ContributedPostEntry = Attributed<PostEntry>;

export function presentContributedPost(
  post: PostEntry,
  identities: ReadonlyMap<string, ContributionAttribution>,
  parent?: PostEntry,
): ContributedPostEntry {
  if (!('authorId' in post)) return post;
  const attribution = identities.get(post.authorId) ?? null;
  const parentContext =
    parent?.availability === 'available' && parent.id === post.parentId
      ? { parent: { postId: parent.id, attribution: identities.get(parent.authorId) ?? null } }
      : {};
  const { authorId, ...retained } = post;
  return contributionDeleted(attribution)
    ? { ...retained, attribution, ...parentContext }
    : { ...post, attribution, ...parentContext };
}

/** One exact point and at most one disclosed parent, sharing a deduplicated Accounts batch. */
export async function readContributedPost(
  dependencies: ContentReadDependencies,
  threadId: string,
  postId: string,
  context: ReadContext,
): Promise<Anchored<ContributedPostEntry>> {
  let currentPost: Parameters<RetainContentRead<PostEntry>>[0] | undefined;
  const post = await readPost(dependencies, threadId, postId, context, undefined, (current) => {
    currentPost = current;
  });
  if (!post.value) throw new ProblemError('not_found');
  const value = post.value;
  if (!('authorId' in value)) return { value, anchor: post.anchor };

  let currentParent: Parameters<RetainContentRead<PostEntry>>[0] | undefined;
  const parent = value.parentId
    ? await readPost(dependencies, threadId, value.parentId, context, undefined, (current) => {
        currentParent = current;
      })
    : undefined;
  const disclosedParent = parent?.value?.availability === 'available' ? parent.value : undefined;
  const identities = await withConnection(dependencies.pool, (client) =>
    readContributionAttributions(deadlineClient(client, context.deadline), [
      value.authorId,
      ...(disclosedParent ? [disclosedParent.authorId] : []),
    ]),
  );

  // Reuse native prepared authority and original witnesses after foreign identity work.
  const confirmedParent = disclosedParent ? await currentParent!() : undefined;
  const parentStillDisclosed = confirmedParent?.value?.availability === 'available' ? disclosedParent : undefined;
  const confirmedPost = await currentPost!();
  if (!confirmedPost.value) throw new ProblemError('not_found');
  return { value: presentContributedPost(value, identities, parentStillDisclosed), anchor: confirmedPost.anchor };
}

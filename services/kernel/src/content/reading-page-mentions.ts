import type { DocumentNode, DocumentSnapshot } from '@rezics/document';
import { t } from 'elysia';
import type { Static } from 'typebox';
import type { Pool } from 'pg';
import { classifyUnavailability } from '../access/unavailable.ts';
import { readPublicIdentities, type PublicIdentity } from '../access/account-data.ts';
import { ProblemError } from '../http/problem.ts';
import { routeOf } from '../route/route.ts';
import type { PostEntry } from './reads.ts';

const closed = { additionalProperties: false } as const;
const mentionId = t.String({ format: 'uuid' });

const ReadingPageMentionSourceSchema = t.Object(
  {
    postId: mentionId,
    threadId: mentionId,
    revisionId: mentionId,
    sha256: t.String({ pattern: '^[0-9a-f]{64}$' }),
    pageIndex: t.Integer({ minimum: 0, maximum: 20 }),
    references: t.Array(mentionId, { maxItems: 100 }),
    overflow: t.Boolean(),
  },
  closed,
);

const ReadingPageMentionIdentitySchema = t.Union([
  t.Object({ id: mentionId, state: t.Literal('active'), handle: t.Union([t.String({ maxLength: 64 }), t.Null()]) }, closed),
  t.Object({ id: mentionId, state: t.Literal('concealed') }, closed),
  t.Object({ id: mentionId, state: t.Literal('erased') }, closed),
]);

export const ReadingPageMentionsSchema = t.Object(
  {
    state: t.Union([t.Literal('current'), t.Literal('unavailable')]),
    retryable: t.Boolean(),
    overflow: t.Boolean(),
    sources: t.Array(ReadingPageMentionSourceSchema, { maxItems: 21 }),
    identities: t.Array(ReadingPageMentionIdentitySchema, { maxItems: 100 }),
  },
  closed,
);

export type ReadingPageMentions = Static<typeof ReadingPageMentionsSchema>;
export type SelectedReadingPageMentionInventory = Readonly<{
  identities: readonly string[];
  sources: readonly SelectedReadingPageMentionSource[];
  overflow: boolean;
}>;

export type ReadingPageMentionPost = Readonly<{
  id: string;
  threadId: string;
  availability: PostEntry['availability'];
  revisionId?: string;
  sha256: string | null;
  body: DocumentSnapshot | null;
}>;

export type SelectedReadingPageMentionSource = ReadingPageMentions['sources'][number];

function isAccountId(value: string): boolean {
  return routeOf(value) !== null;
}

function visitMentions(node: DocumentNode, visit: (id: string) => void): void {
  const id = node.type === 'mention' ? node.attrs?.accountId : undefined;
  if (typeof id === 'string' && isAccountId(id)) visit(id);
  for (const child of node.content ?? []) visitMentions(child, visit);
}

/** Select only current readable bodies, preserving their page and document order. */
export function selectReadingPageMentions(posts: readonly ReadingPageMentionPost[]): SelectedReadingPageMentionInventory {
  const identities: string[] = [];
  const selected = new Set<string>();
  const sources: SelectedReadingPageMentionSource[] = [];
  for (const [pageIndex, post] of posts.entries()) {
    if (post.availability !== 'available' || !post.body || !post.revisionId || !post.sha256) continue;
    const references = new Set<string>();
    let overflow = false;
    visitMentions(post.body.doc, (id) => {
      if (selected.has(id)) references.add(id);
      else if (identities.length < 100) {
        identities.push(id);
        selected.add(id);
        references.add(id);
      } else overflow = true;
    });
    sources.push({
      postId: post.id,
      threadId: post.threadId,
      revisionId: post.revisionId,
      sha256: post.sha256,
      pageIndex,
      references: [...references],
      overflow,
    });
  }
  return { identities, sources, overflow: sources.some((source) => source.overflow) };
}

export function readingPageMentionIdentityViews(ids: readonly string[], accounts: readonly PublicIdentity[]) {
  const byId = new Map(accounts.map((account) => [account.id, account]));
  return ids.map((id) => {
    const account = byId.get(id);
    if (!account) return { id, state: 'concealed' as const };
    if (account.state === 'deleted') return { id, state: 'erased' as const };
    return { id, state: 'active' as const, handle: account.handle };
  });
}

export function currentReadingPageMentions(
  selection: SelectedReadingPageMentionInventory,
  accounts: readonly PublicIdentity[],
): ReadingPageMentions {
  return {
    state: 'current',
    retryable: false,
    overflow: selection.overflow,
    sources: [...selection.sources],
    identities: readingPageMentionIdentityViews(selection.identities, accounts),
  };
}

export function unavailableReadingPageMentions(
  selection: SelectedReadingPageMentionInventory,
): ReadingPageMentions {
  return {
    state: 'unavailable',
    retryable: true,
    overflow: selection.overflow,
    sources: [...selection.sources],
    identities: [],
  };
}

/** One bounded call through Access's existing public identity projection. */
export async function readReadingPageMentions(pool: Pool, posts: readonly PostEntry[]): Promise<ReadingPageMentions> {
  const selection = selectReadingPageMentions(posts);
  if (!selection.identities.length) return currentReadingPageMentions(selection, []);

  const routes = selection.identities.map((id) => {
    const route = routeOf(id);
    if (route === null) throw new TypeError('Reading page mention id must be a routable account');
    return route;
  });
  try {
    const accounts = await readPublicIdentities(pool, routes, selection.identities);
    return currentReadingPageMentions(selection, accounts);
  } catch (error) {
    if (classifyUnavailability(error) === undefined && !(error instanceof ProblemError && error.code === 'dependency_unavailable'))
      throw error;
    return unavailableReadingPageMentions(selection);
  }
}

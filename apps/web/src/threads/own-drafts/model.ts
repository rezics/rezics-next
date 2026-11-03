import type { DocumentSnapshot } from '@rezics/document';
import type { CurrentPost } from '../actions';
import type { locales } from '../../paraglide/runtime.js';

export type OwnDraftLocale = (typeof locales)[number];

export type OwnDraftActionPaths = Readonly<{
  resume: string;
  edit: string | null;
  publish: string | null;
  erase: string | null;
}>;

/** The installed native wire page. Bodies are only present on the separate selected read. */
export type OwnDraftEntry = Readonly<{
  id: string;
  threadId: string;
  firstPostId: string;
  revisionId: string;
  authorId: string;
  kind: 'discussion' | 'review';
  documentKind: 'opening' | 'reply';
  title: string | null;
  savedAt: string;
  licence: string;
  language: string | null;
  subjectIds: readonly string[];
  mediaIds: readonly string[];
  board: Readonly<{ id: string; title: string | null; realmId: string | null }>;
  actions: OwnDraftActionPaths;
}>;

export type OwnDraftPageData = Readonly<{
  state: 'ready' | 'preparing';
  viewer: Readonly<{ accountId: string; authnEpoch: number }>;
  drafts: readonly OwnDraftEntry[];
  next: string | null;
}>;

export type OwnDraftSelection = Readonly<{
  post: Readonly<Pick<CurrentPost, 'id' | 'threadId'> & { body: DocumentSnapshot }>;
  revision: string;
}>;

export type OwnDraftIdentity = Readonly<{
  accountId: string;
  authnEpoch: number;
  /** Opaque in-memory caller generation. Never a token or route value. */
  callerEpoch: string;
  locale: OwnDraftLocale;
  source: string;
  address: '/drafts';
}>;

export type OwnDraftPageRequest = Readonly<{
  accountId: string;
  cursor?: string;
}>;

export type OwnDraftSelectionRequest = Readonly<{
  accountId: string;
  id: string;
  threadId: string;
}>;

export type OwnDraftReadFailure = 'unavailable' | 'denied' | 'concealed' | 'stale';

/** Bounded native reader; neither selected bytes nor cursors enter a persistent query cache. */
export type OwnDraftReader = Readonly<{
  list: (request: OwnDraftPageRequest, signal: AbortSignal) => Promise<OwnDraftPageData | OwnDraftReadFailure>;
  resume: (request: OwnDraftSelectionRequest, signal: AbortSignal) => Promise<OwnDraftSelection | OwnDraftReadFailure>;
}>;

export type OwnDraftIndex = Readonly<{
  byId: ReadonlyMap<string, OwnDraftEntry>;
  rows: readonly OwnDraftEntry[];
}>;

/** Build one O(N) lookup for the bounded native page. */
export function indexOwnDraftPage(page: OwnDraftPageData): OwnDraftIndex {
  if (page.drafts.length > 20) throw new Error('Native own-draft page exceeded its 20-row bound');
  const byId = new Map<string, OwnDraftEntry>();
  for (const row of page.drafts) {
    if (byId.has(row.id)) throw new Error('Native own-draft page repeated a post identity');
    byId.set(row.id, row);
  }
  return Object.freeze({ byId, rows: page.drafts });
}

function pathFor(entry: OwnDraftEntry, accountId: string, action: keyof OwnDraftActionPaths): string | null {
  switch (action) {
    case 'resume':
      return `/v1/accounts/${accountId}/drafts/${entry.id}?threadId=${entry.threadId}`;
    case 'edit':
    case 'publish':
      return `/v1/posts/${entry.id}/revisions`;
    case 'erase':
      return `/v1/posts/${entry.id}`;
  }
}

/** Validate native advice against the exact selected resource before a typed method may be called. */
export function admittedOwnDraftAction(
  entry: OwnDraftEntry,
  accountId: string,
  action: keyof OwnDraftActionPaths,
): string | null {
  // Advice never grants authority for a different account or a replacement revision.
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  if (
    entry.authorId !== accountId ||
    ![accountId, entry.id, entry.threadId, entry.revisionId].every((id) => uuid.test(id))
  )
    return null;
  const expected = pathFor(entry, accountId, action);
  return entry.actions[action] === expected ? expected : null;
}

export function ownDraftIdentityKey(identity: OwnDraftIdentity): string {
  return JSON.stringify([
    identity.accountId,
    identity.authnEpoch,
    identity.callerEpoch,
    identity.locale,
    identity.source,
    identity.address,
  ]);
}

export function ownDraftRequestKey(identityKey: string, cursor: string | null): string {
  return JSON.stringify([identityKey, cursor]);
}

/** A body read is a separate operation that only the explicit selection handler calls. */
export async function readSelectedOwnDraft(
  reader: OwnDraftReader,
  identity: OwnDraftIdentity,
  entry: OwnDraftEntry,
  signal: AbortSignal,
): Promise<OwnDraftSelection | OwnDraftReadFailure> {
  if (signal.aborted) return 'unavailable';
  if (!admittedOwnDraftAction(entry, identity.accountId, 'resume')) return 'concealed';
  const result = await reader.resume({ accountId: identity.accountId, id: entry.id, threadId: entry.threadId }, signal);
  if (signal.aborted) return 'unavailable';
  if (typeof result === 'string') return result;
  if (result.post.id !== entry.id || result.post.threadId !== entry.threadId) return 'concealed';
  if (result.post.body === null || result.revision !== entry.revisionId) return 'stale';
  return {
    revision: result.revision,
    post: { id: result.post.id, threadId: result.post.threadId, body: result.post.body },
  };
}

export function documentForInspection(selection: OwnDraftSelection): DocumentSnapshot {
  return selection.post.body;
}

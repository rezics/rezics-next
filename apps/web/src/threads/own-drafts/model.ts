import type { KernelClient } from '@rezics/client';
import type { DocumentSnapshot } from '@rezics/document';
import type { CurrentPost, EditFailure, RevisedPost, WriteFailure } from '../actions';
import type { locales } from '../../paraglide/runtime.js';
import type { SavedWriting } from '../local-writing-draft';

export type OwnDraftLocale = (typeof locales)[number];

type DraftsResource = ReturnType<KernelClient['accounts']>['drafts'];
export type OwnDraftNativePage = NonNullable<Awaited<ReturnType<DraftsResource['get']>>['data']>;
export type OwnDraftNativePost = NonNullable<Awaited<ReturnType<ReturnType<DraftsResource>['get']>>['data']>['post'];
export type OwnDraftEntry = OwnDraftNativePage['drafts'][number];
export type OwnDraftActionPaths = OwnDraftEntry['actions'];
/** Keep the generated wire shape, allowing immutable fixtures and the retained in-memory page. */
export type OwnDraftPageData = Readonly<Omit<OwnDraftNativePage, 'drafts'> & { drafts: readonly OwnDraftEntry[] }>;

export type OwnDraftSelection = Readonly<{
  post: Readonly<
    Pick<CurrentPost, 'id' | 'threadId' | 'parentId'> & { body: DocumentSnapshot; mediaIds: readonly string[] }
  >;
  revision: string;
}>;

export type OwnDraftWriteAction = 'save' | 'publish';
export type OwnDraftWriteInput = Readonly<{
  action: OwnDraftWriteAction;
  postId: string;
  threadId: string;
  body: DocumentSnapshot;
  revisionId: string;
  idempotencyKey: string;
  mediaIds: readonly string[];
}>;
export type OwnDraftEraseInput = Readonly<{
  postId: string;
  threadId: string;
  opening: boolean;
  revisionId: string;
  idempotencyKey: string;
}>;
export type OwnDraftReadback =
  | Readonly<{
      state: 'available';
      revision: string;
      visibility: 'draft' | 'published' | 'other';
      body: DocumentSnapshot | null;
      mediaIds: readonly string[];
    }>
  | 'denied'
  | 'concealed'
  | 'unavailable';
export type OwnDraftCommands = Readonly<{
  write: (input: OwnDraftWriteInput, signal: AbortSignal) => Promise<{ ok: true; post: RevisedPost } | EditFailure>;
  erase: (input: OwnDraftEraseInput, signal: AbortSignal) => Promise<{ ok: true } | WriteFailure>;
  readback: (postId: string, signal: AbortSignal) => Promise<OwnDraftReadback>;
}>;
export type OwnDraftLocalWritingReader = Readonly<{
  load: (
    request: Readonly<{ identity: OwnDraftIdentity; entry: OwnDraftEntry; selection: OwnDraftSelection }>,
    signal: AbortSignal,
  ) => Promise<SavedWriting | null | 'unavailable'>;
}>;

export type OwnDraftIdentity = Readonly<{
  accountId: string;
  /** The route learns the native epoch from its first admitted page. */
  authnEpoch: number | null;
  /** Opaque in-memory caller generation. Never a token or route value. */
  callerEpoch: string;
  locale: OwnDraftLocale;
  source: string;
  address: '/drafts';
}>;

export type OwnDraftPageRequest = Readonly<{
  accountId: string;
  /** Omitted only for the first page, which establishes this visit's native epoch. */
  authnEpoch?: number;
  cursor?: string;
}>;

export type OwnDraftSelectionRequest = Readonly<{
  accountId: string;
  authnEpoch?: number;
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

export const OWN_DRAFT_CURSOR_MAX_LENGTH = 32768;
export const OWN_DRAFT_PREDECESSOR_LIMIT = 8;

/** Native continuation coordinates are opaque, nonempty strings bounded in JavaScript code units. */
export function isOwnDraftCursor(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= OWN_DRAFT_CURSOR_MAX_LENGTH;
}

export type OwnDraftCoordinate = string | null;
export type OwnDraftMovement = 'initial' | 'next' | 'previous' | 'first' | 'refresh';

/** Retain only the admitted path coordinates for this mounted private visit. */
export function moveOwnDraftCoordinates(
  coordinates: readonly OwnDraftCoordinate[],
  movement: OwnDraftMovement,
  target: OwnDraftCoordinate,
): readonly OwnDraftCoordinate[] {
  switch (movement) {
    case 'initial':
    case 'first':
      return [null];
    case 'previous':
      return coordinates.slice(0, -1);
    case 'refresh':
      return coordinates;
    case 'next':
      return [...coordinates, target].slice(-(OWN_DRAFT_PREDECESSOR_LIMIT + 1));
  }
}

/** A body read is a separate operation that only the explicit selection handler calls. */
export async function readSelectedOwnDraft(
  reader: OwnDraftReader,
  identity: OwnDraftIdentity,
  entry: OwnDraftEntry,
  signal: AbortSignal,
  current: () => boolean = () => true,
): Promise<OwnDraftSelection | OwnDraftReadFailure> {
  if (signal.aborted || !current()) return 'unavailable';
  if (identity.authnEpoch === null || !Number.isSafeInteger(identity.authnEpoch) || identity.authnEpoch <= 0)
    return 'denied';
  if (!admittedOwnDraftAction(entry, identity.accountId, 'resume')) return 'concealed';
  const result = await reader.resume(
    { accountId: identity.accountId, authnEpoch: identity.authnEpoch, id: entry.id, threadId: entry.threadId },
    signal,
  );
  if (signal.aborted || !current()) return 'unavailable';
  if (typeof result === 'string') return result;
  if (result.post.id !== entry.id || result.post.threadId !== entry.threadId) return 'concealed';
  if (!result.post.body || result.revision !== entry.revisionId) return 'stale';
  if (JSON.stringify(result.post.mediaIds) !== JSON.stringify(entry.mediaIds)) return 'stale';
  return {
    revision: result.revision,
    post: {
      id: result.post.id,
      threadId: result.post.threadId,
      parentId: result.post.parentId,
      body: result.post.body,
      mediaIds: [...result.post.mediaIds],
    },
  };
}

export function documentForInspection(selection: OwnDraftSelection): DocumentSnapshot {
  return selection.post.body;
}

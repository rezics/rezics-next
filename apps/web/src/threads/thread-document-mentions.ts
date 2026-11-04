import type { ReadingPageResponse } from '@rezics/client';
import type { DocumentMentions } from '@rezics/ui/document-body';
import type { QueryClient, QueryKey } from '@tanstack/react-query';
import { browserObservation, type BrowserCacheEvent } from '../session/observation';
import { sessionQueryKey } from '../session/browser-state';
import type { ThreadPost } from './thread-page';

type NativeMentionProjection = NonNullable<ReadingPageResponse['mentions']>;
export type ThreadDocumentMentionPage = Omit<
  Pick<ReadingPageResponse, 'target' | 'viewer' | 'query' | 'mentions'>,
  'mentions'
> & { mentions: NativeMentionProjection; selectedPostId: string | null };
export type ThreadDocumentMentionPost = Pick<
  ThreadPost,
  'id' | 'threadId' | 'revisionId' | 'sha256' | 'availability'
>;

export type ThreadDocumentMentionResult = Readonly<{
  mentions: DocumentMentions;
  notice: 'unavailable' | 'changed' | 'overflow' | null;
  overflow: boolean;
  retryable: boolean;
}>;

const emptyMentions: DocumentMentions = {};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function validSource(value: unknown): value is NativeMentionProjection['sources'][number] {
  if (!isRecord(value)) return false;
  return (
    typeof value.postId === 'string' &&
    typeof value.threadId === 'string' &&
    typeof value.revisionId === 'string' &&
    typeof value.sha256 === 'string' &&
    Number.isInteger(value.pageIndex) &&
    typeof value.overflow === 'boolean' &&
    Array.isArray(value.references) &&
    value.references.length <= 100 &&
    value.references.every((id) => typeof id === 'string')
  );
}

function validIdentity(value: unknown): value is NativeMentionProjection['identities'][number] {
  if (!isRecord(value) || typeof value.id !== 'string') return false;
  if (value.state === 'active') return value.handle === null || typeof value.handle === 'string';
  return value.state === 'concealed' || value.state === 'erased';
}

/** Missing optional server output is unavailable; it is never treated as an empty reference set. */
export function isReadingPageMentionProjection(value: unknown): value is NativeMentionProjection {
  if (!isRecord(value)) return false;
  if (
    (value.state !== 'current' && value.state !== 'unavailable') ||
    typeof value.retryable !== 'boolean' ||
    typeof value.overflow !== 'boolean' ||
    !Array.isArray(value.sources) ||
    value.sources.length > 21 ||
    !value.sources.every(validSource) ||
    !Array.isArray(value.identities) ||
    value.identities.length > 100 ||
    !value.identities.every(validIdentity)
  )
    return false;
  const sourceIds = new Set(value.sources.flatMap((source) => source.references));
  const identityIds = new Set(value.identities.map((identity) => identity.id));
  if (identityIds.size !== value.identities.length) return false;
  if (value.state === 'current' && [...sourceIds].some((id) => !identityIds.has(id))) return false;
  if (value.state === 'unavailable' && value.identities.length !== 0) return false;
  return true;
}

export function threadDocumentMentionPage(
  page: ReadingPageResponse,
  selectedPostId: string | undefined,
): ThreadDocumentMentionPage | null {
  const projection: unknown = page.mentions;
  if (!isReadingPageMentionProjection(projection)) return null;
  return { target: page.target, viewer: page.viewer, query: page.query, mentions: projection, selectedPostId: selectedPostId ?? null };
}

function result(
  notice: ThreadDocumentMentionResult['notice'],
  overflow = false,
  retryable = false,
  mentions = emptyMentions,
): ThreadDocumentMentionResult {
  return { mentions, notice, overflow, retryable };
}

/** Admit handles only for the exact disclosed source occurrence carried by the current page. */
export function projectThreadDocumentMentions(
  page: ThreadDocumentMentionPage | null,
  post: ThreadDocumentMentionPost,
  pageIndex: number,
  viewerCurrent: boolean,
): ThreadDocumentMentionResult {
  if (!page) return result('unavailable', false, true);
  if (!viewerCurrent) return result(null);
  const source = page.mentions.sources.find((candidate) => candidate.postId === post.id && candidate.pageIndex === pageIndex);
  const priorSource = page.mentions.sources.find((candidate) => candidate.postId === post.id);
  if (!source) {
    const references = priorSource?.references.length ?? 0;
    const overflow = priorSource?.overflow ?? false;
    return result(references || overflow ? 'changed' : null, false, !!(references || overflow));
  }
  const hasReferences = source.references.length > 0 || source.overflow;
  const selectedPostPresent = page.selectedPostId === null || page.mentions.sources.some((candidate) => candidate.postId === page.selectedPostId);
  if (
    !selectedPostPresent ||
    page.target.threadId !== post.threadId ||
    source.threadId !== post.threadId ||
    post.availability !== 'available' ||
    source.revisionId !== post.revisionId ||
    source.sha256 !== post.sha256
  )
    return result(hasReferences ? 'changed' : null, false, hasReferences);
  if (page.mentions.state === 'unavailable')
    return result('unavailable', source.overflow, page.mentions.retryable);
  const identities = new Map(page.mentions.identities.map((identity) => [identity.id, identity]));
  const disclosed: Record<string, { handle: string }> = {};
  for (const id of source.references) {
    const identity = identities.get(id);
    if (identity?.state === 'active' && typeof identity.handle === 'string' && identity.handle.length > 0)
      disclosed[id] = { handle: identity.handle };
  }
  return result(source.overflow ? 'overflow' : null, source.overflow, false, disclosed);
}

function sameKey(left: QueryKey, right: QueryKey): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

/** A mounted post holds no identity summaries after its page, session or reader visit retires. */
export class ThreadDocumentMentionLease {
  private page: ThreadDocumentMentionPage | null;
  private active = true;
  private revision = 0;
  private readonly listeners = new Set<() => void>();
  private stopCache: (() => void) | undefined;

  constructor(
    page: ThreadDocumentMentionPage | null,
    private readonly pageQueryKey: QueryKey | undefined,
    private readonly readerCurrent: () => boolean,
  ) {
    this.page = page;
  }

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = () => this.revision;
  getServerSnapshot = () => 0;

  connect(client: QueryClient): () => void {
    if (!this.isCurrent()) this.retire();
    if (!this.active) return () => {};
    this.stopCache = browserObservation(client).subscribeCache(this.onCacheEvent);
    return () => this.retire();
  }

  project(post: ThreadDocumentMentionPost, pageIndex: number, viewerCurrent: boolean): ThreadDocumentMentionResult {
    if (!this.isCurrent()) {
      this.retire();
      return result(null);
    }
    return projectThreadDocumentMentions(this.page, post, pageIndex, viewerCurrent);
  }

  isCurrent(): boolean {
    return this.active && this.readerCurrent();
  }

  retire = () => {
    if (!this.active) return;
    this.active = false;
    this.page = null;
    this.stopCache?.();
    this.stopCache = undefined;
    this.revision++;
    this.listeners.forEach((listener) => listener());
  };

  private onCacheEvent = (event: BrowserCacheEvent) => {
    const key = event.query.queryKey;
    const session = sameKey(key, sessionQueryKey);
    const page = this.pageQueryKey !== undefined && sameKey(key, this.pageQueryKey);
    const account = key.some((part) => part === 'account' || part === 'accounts');
    if (session || account || (page && (event.type === 'updated' || event.type === 'removed'))) this.retire();
  };
}

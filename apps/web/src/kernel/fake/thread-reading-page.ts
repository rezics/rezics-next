import type { ReadingPage } from '../../threads/thread-page';
import type { FakeRoute } from '../fake-modules';

/** Authored example of the installed DTO; unavailable owners are deliberately explicit. */
export function authoredReadingPage(
  thread: ReadingPage['thread'],
  items: ReadingPage['replies']['items'] = [],
  authors: ReadingPage['authors']['items'] = [],
): ReadingPage {
  return {
    target: { threadId: thread.id, boardId: thread.boardId, boardSecurityRevision: '1' },
    viewer: { kind: 'anonymous' },
    query: { cursor: null, limit: 20 },
    thread,
    replies: { items, next: null },
    authors: { state: 'current', retryable: false, items: authors },
    actions: { state: 'unavailable', retryable: true, references: [], reply: { state: 'unavailable' } },
    watch: { state: 'sign_in_required' },
    slowMode: { state: 'unavailable', retryable: true },
    currentness: { source: 'current', place: 'current', reactions: 'current', authors: 'current', actions: 'unavailable', watch: 'sign_in_required', slowMode: 'unavailable' },
    reactionsAsOf: null,
  };
}

export const routes: FakeRoute[] = [{
  method: 'GET',
  path: /^\/v1\/threads\/([^/]+)\/reading-page$/,
  story: ({ request, recordings, match }) => {
    // These are the same admitted recorded documents used by the ordinary prepared thread reader.
    const recorded = Object.entries(recordings).find(([key, value]) => key.startsWith('thread') &&
      value.thread && typeof value.thread === 'object' && 'id' in value.thread && value.thread.id === match?.[1]);
    if (!recorded) return;
    const thread = recorded[1].thread as ReadingPage['thread'];
    const posts = recordings[`${recorded[0]}-posts`]?.posts as ReadingPage['replies']['items'] | undefined;
    const items = (posts ?? []).filter((post) => post.id !== thread.firstPost.id).slice(0, 20);
    const ids = new Set([thread.firstPost, ...items].flatMap((post) => post.availability === 'available' ? [post.authorId] : []));
    const accounts = recordings.accounts?.accounts as { id: string; state: string; displayName?: string; handle?: string; avatar?: ReadingPage['authors']['items'][number]['avatar'] }[] | undefined;
    const page = authoredReadingPage(thread, items, (accounts ?? []).filter((author) => ids.has(author.id)).map((author) => ({
      id: author.id,
      displayName: author.state === 'active' ? author.displayName ?? null : null,
      handle: author.state === 'active' ? author.handle ?? null : null,
      avatar: author.state === 'active' ? author.avatar ?? null : null,
    })));
    page.query.cursor = new URL(request.url).searchParams.get('cursor');
    return page;
  },
}];

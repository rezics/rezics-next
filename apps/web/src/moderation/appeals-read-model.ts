import type { QueryClient } from '@tanstack/react-query';
import { preparePrivateReaderRead, type PrivateReaderRead } from './private-reader-lifetime';
import type { AppealPage } from './appeals-read';
import type { ModerationTarget } from './target-content';

export type AppealReadInput = { boardId: string; threadId?: string; postId?: string; cursor?: string };
export type AppealReadState = 'ready' | 'loading' | 'unavailable' | 'stale' | 'closed';
export type PrivateAppealPage = AppealPage &
  PrivateReaderRead & {
    targets: ModerationTarget[];
    viewerId: string | null;
    readKey: string;
    generation: string;
    state: AppealReadState;
  };

/** Post identity is return context; native Appeals reads only board or thread scope. */
export function moderationAppealInput(boardId: string, search: Record<string, unknown>): AppealReadInput {
  return {
    boardId,
    ...(typeof search.thread === 'string' && search.thread.length <= 128 ? { threadId: search.thread } : {}),
    ...(typeof search.post === 'string' && search.post.length <= 128 ? { postId: search.post } : {}),
    ...(typeof search.cursor === 'string' && search.cursor.length <= 4096 && search.cursor
      ? { cursor: search.cursor }
      : {}),
  };
}
export function appealReadKey(input: AppealReadInput): string {
  return JSON.stringify([input.boardId, input.threadId ?? '', input.postId ?? '', input.cursor ?? '']);
}

/** Only location changes that replace the admitted queue are departures. */
export function appealNavigationContext(location: { pathname: string; search: Record<string, unknown> }): string {
  return JSON.stringify([
    location.pathname,
    location.search.tab ?? '',
    appealReadKey(moderationAppealInput('', location.search)),
  ]);
}
export function appealPageIsCurrent(page: Pick<PrivateAppealPage, 'readKey'>, input: AppealReadInput): boolean {
  return page.readKey === appealReadKey(input);
}

/** A retired request lifetime never revives when navigation or the same viewer returns. */
export function createAppealReadLifetime() {
  let retired = false;
  let serial = 0;
  let viewerSeen = false;
  let sessionViewer: string | null = null;
  // Browser-session identity stays in this mounted lifetime, never in page data or cache keys.
  let sessionCsrfToken: string | null = null;
  let viewerRetired = false;
  return {
    retire() {
      retired = true;
      serial++;
    },
    get retired() {
      return retired;
    },
    get viewerRetired() {
      return viewerRetired;
    },
    observeViewer(
      viewerId: string | null,
      session: { state: string; subject?: string | null; csrfToken?: string | null },
    ) {
      const currentViewer = session.state === 'signed-in' ? (session.subject ?? null) : null;
      const currentCsrfToken = session.csrfToken ?? null;
      if (
        (viewerSeen && (currentViewer !== sessionViewer || currentCsrfToken !== sessionCsrfToken)) ||
        ((session.state !== 'unknown' || viewerSeen) &&
          (session.state !== 'signed-in' || (viewerId !== null && session.subject !== viewerId)))
      ) {
        retired = true;
        viewerRetired = true;
        serial++;
      }
      if (session.state !== 'unknown') {
        viewerSeen = true;
        sessionViewer = currentViewer;
        sessionCsrfToken = currentCsrfToken;
      }
    },
    begin() {
      return ++serial;
    },
    isCurrent(token: number) {
      return !retired && token === serial;
    },
    accepts(token: number, page: PrivateAppealPage, input: AppealReadInput, viewerId: string | null) {
      return !retired && token === serial && page.viewerId === viewerId && appealPageIsCurrent(page, input);
    },
  };
}

/** The route and bounded explicit recovery share the same immutable scope. */
export async function prepareModerationAppealRead(
  client: QueryClient,
  input: AppealReadInput,
  read: (input: AppealReadInput) => Promise<PrivateAppealPage>,
  signal?: AbortSignal,
) {
  const original = Object.freeze({ ...input });
  const page = await preparePrivateReaderRead(client, appealReadKey(original), () => read(original), signal);
  return page.readerBinding.retired || (!page.readerOrigin && page.state === 'ready')
    ? {
        ...page,
        appeals: [],
        targets: [],
        next: null,
        state: page.readerBinding.retired ? ('closed' as const) : ('unavailable' as const),
      }
    : page;
}

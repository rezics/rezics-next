import type { MainClient } from '../discover/types.ts';
import type { ThreadRead, ThreadSort, ThreadsPage, ThreadWindow } from '../feed/thread.ts';
import { settleFrame, type RealmFrameRead } from './zone-presentation-read.ts';
import { idOf } from './route.ts';

type Ok<Call> = Call extends (...args: never[]) => Promise<{ data: infer Data }> ? NonNullable<Data> : never;
export type BoardPage = Ok<MainClient['v1']['classification-vocabulary']['get']>;
export interface DiscussionQuery {
  sort: ThreadSort;
  window: ThreadWindow;
  cursor?: string;
  concept?: string;
  boardsCursor?: string;
  language?: string;
}

/** List addresses retain the board and language; changing either starts its own collection. */
export function discussionListHref(path: string, query: DiscussionQuery): string {
  const params = new URLSearchParams();
  if (query.sort !== 'best') params.set('sort', query.sort);
  if (query.sort === 'top' && query.window !== 'week') params.set('t', query.window);
  if (query.concept) params.set('concept', query.concept);
  if (query.language) params.set('language', query.language);
  if (query.cursor) params.set('cursor', query.cursor);
  if (query.boardsCursor) params.set('boardsCursor', query.boardsCursor);
  return `${path}/discussions${params.size ? `?${params}` : ''}`;
}

/** Production routes and stories share the client and failure boundary. No roster read authorizes discussion. */
export function realmDiscussionReads(main: MainClient, realm: string, actingSubject?: string) {
  const actor = actingSubject ? { actingSubject } : {};
  const realmId = idOf(realm) ?? realm;
  return {
    async boards(cursor?: string): Promise<RealmFrameRead<BoardPage>> {
      const context = await settleFrame(() => main.v1.realms({ realm: realmId })['classification-context'].get());
      if (!context.ok) return context;
      return settleFrame(() => main.v1['classification-vocabulary'].get({ query: {
        context: context.data.context, limit: 20, ...(cursor ? { cursor } : {}),
      } }), cursor);
    },
    threads(query: DiscussionQuery): Promise<RealmFrameRead<ThreadsPage>> {
      // Concept boards are an API selection. Never filter a returned page locally:
      // a server that has not opened this selection returns its ordinary refusal.
      const selection = { sort: query.sort,
        ...(query.sort === 'top' ? { window: query.window } : {}),
        ...(query.cursor ? { cursor: query.cursor } : {}),
        ...(query.concept ? { concept: query.concept } : {}),
        ...(query.language ? { language: query.language } : {}), ...actor };
      return settleFrame(() => main.v1.realms({ realm: realmId }).threads.get({ query: selection }), query.cursor);
    },
    thread(reply: string, sort: ThreadSort, language?: string, cursor?: string): Promise<RealmFrameRead<ThreadRead>> {
      return settleFrame(() => main.v1.realms({ realm: realmId }).threads({ reply: reply.slice(-36) }).get({ query: {
        sort, ...(language ? { language } : {}), ...(cursor ? { cursor } : {}), ...actor,
      } }), cursor);
    },
  };
}

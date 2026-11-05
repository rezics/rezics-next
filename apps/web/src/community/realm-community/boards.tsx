import type { ReactNode } from 'react';
import { ListRow } from '@rezics/ui/list-row';
import { m } from '../../paraglide/messages.js';
import { getLocale } from '../../paraglide/runtime.js';
import { boardRequestHref } from '../../threads/board-navigation';
import { threadLocation } from '../../threads/thread-href';
import type { RealmBoard } from '../space';
import type { useShelfContinuationFocus } from '../publication-controls-view';
import type { RealmBoardRecent, RealmBoardRecentThread } from './recent';

function purposeLabel(purpose: RealmBoard['purpose']): string {
  return purpose === 'reviews' ? m.realm_board_purpose_reviews() : m.realm_board_purpose_discussion();
}

function commentsLabel(comments: RealmBoardRecentThread['comments']): string | null {
  if (comments.state !== 'current') return null;
  const count = new Intl.NumberFormat(getLocale()).format(comments.value);
  return comments.kind === 'lower-bound'
    ? m.realm_board_recent_replies_more({ count })
    : m.realm_board_recent_replies({ count });
}

function recentRegion(board: RealmBoard, boardHref: string, current: () => boolean) {
  const recent: RealmBoardRecent | undefined = board.recent;
  if (!recent) return null;
  if (recent.state === 'unavailable') {
    return (
      <p className="text-sm text-muted-foreground" data-slot="realm-board-recent-unavailable">
        {m.realm_board_recent_unavailable()}
      </p>
    );
  }
  if (!recent.threads.length) return null;
  return (
    <ul className="space-y-1 border-s border-border ps-4" data-slot="realm-board-recent" aria-label={m.realm_board_recent()}>
      {recent.threads.map((thread) => {
        const href = threadLocation(
          getLocale(),
          { id: thread.id, title: thread.title },
          undefined,
          undefined,
          undefined,
          boardHref,
        );
        const replies = commentsLabel(thread.comments);
        return (
          <li key={thread.id} className="min-w-0">
            <a
              href={href}
              data-slot="realm-board-recent-link"
              data-thread-id={thread.id}
              onClick={(event) => {
                if (!current()) event.preventDefault();
              }}
              onAuxClick={(event) => {
                if (!current()) event.preventDefault();
              }}
              onContextMenu={(event) => {
                if (!current()) event.preventDefault();
              }}
              className="inline-flex min-h-11 min-w-11 max-w-full items-center rounded-sm py-2 underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-ring"
            >
              {thread.title ?? m.threads_untitled()}
            </a>
            {replies ? <p className="text-xs text-muted-foreground">{replies}</p> : null}
          </li>
        );
      })}
    </ul>
  );
}

export function RealmCommunityBoards({
  boards,
  unavailable,
  continuation,
  complete,
  focus,
  returnFor,
  current,
}: {
  returnFor: (id: string) => string | undefined;
  current: () => boolean;
  boards: RealmBoard[];
  unavailable: number;
  continuation: ReactNode;
  complete: boolean;
  focus: ReturnType<typeof useShelfContinuationFocus>;
}) {
  const boardHref = (board: RealmBoard) => {
    const returnTo = returnFor(board.id);
    return boardRequestHref(getLocale(), board.id, returnTo ? { returnTo } : {});
  };
  return (
    <section data-slot="realm-community-boards" className="space-y-4" aria-labelledby="realm-boards-heading">
      <h2 ref={focus.boundaryRef} tabIndex={-1} id="realm-boards-heading" className="text-xl font-semibold">
        {m.realm_boards_heading()}
      </h2>
      {boards.length ? (
        <ul className="space-y-1">
          {boards.map((board) => {
            const href = boardHref(board);
            return (
              <ListRow
                key={board.id}
                id={`realm-board-${board.id}`}
                ref={board.id === focus.firstId ? focus.itemRef : null}
                tabIndex={-1}
                aria-label={board.id === focus.firstId ? focus.regionLabel : undefined}
                className="flex flex-col items-stretch gap-3 rounded-xl px-4 py-3 focus-visible:outline-2 focus-visible:outline-ring"
              >
                <div className="flex items-start gap-4">
                  <div className="min-w-0 flex-1 space-y-1">
                    <h3 className="font-semibold">
                      <a
                        href={href}
                        onClick={(event) => {
                          if (!current()) event.preventDefault();
                        }}
                        onAuxClick={(event) => {
                          if (!current()) event.preventDefault();
                        }}
                        onContextMenu={(event) => {
                          if (!current()) event.preventDefault();
                        }}
                        className="inline-flex min-h-11 min-w-11 items-center rounded-sm py-2 underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-ring"
                        data-slot="realm-board-link"
                      >
                        {board.title ?? m.threads_untitled()}
                      </a>
                    </h3>
                    {board.description ? (
                      <p className="text-sm leading-relaxed text-muted-foreground">{board.description}</p>
                    ) : null}
                    <p className="text-xs font-medium text-muted-foreground">{purposeLabel(board.purpose)}</p>
                  </div>
                  {board.visibility === 'draft' || board.visibility === 'protected' ? (
                    <p className="shrink-0 text-xs text-muted-foreground">
                      {board.visibility === 'draft' ? m.realm_board_draft() : m.realm_board_protected()}
                    </p>
                  ) : null}
                </div>
                {recentRegion(board, href, current)}
              </ListRow>
            );
          })}
        </ul>
      ) : unavailable === 0 && complete ? (
        <p className="text-muted-foreground">{m.realm_boards_empty()}</p>
      ) : null}
      {unavailable > 0 ? <p className="text-muted-foreground">{m.realm_boards_unavailable()}</p> : null}
      {continuation}
      <p role="status" className="sr-only">
        {focus.announcement}
      </p>
    </section>
  );
}

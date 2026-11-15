import type { ReactNode } from 'react';
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
  if (comments.state !== 'current') return m.realm_board_recent_replies_unavailable();
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
  if (!recent.threads.length)
    return recent.complete ? (
      <p className="text-sm text-muted-foreground" data-slot="realm-board-recent-empty">
        {m.realm_board_recent_empty()}
      </p>
    ) : null;
  return (
    <div className="min-w-0 space-y-2 border-t border-border pt-3" data-slot="realm-board-recent">
      <p aria-hidden="true" className="text-xs font-semibold text-muted-foreground">
        {m.realm_board_recent()}
      </p>
      <ul className="min-w-0 divide-y divide-border" aria-label={m.realm_board_recent()}>
        {recent.threads.slice(0, 3).map((thread) => {
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
            <li key={thread.id} className="min-w-0 py-1.5 first:pt-0 last:pb-0">
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
                className="inline-flex max-w-full items-center text-sm underline-offset-4 hover:underline"
              >
                {thread.title ?? m.threads_untitled()}
              </a>
              {replies ? <p className="ps-1 text-xs text-muted-foreground">{replies}</p> : null}
            </li>
          );
        })}
      </ul>
    </div>
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
    <section
      data-slot="realm-community-boards"
      className="min-w-0 space-y-5 border-t border-border pt-6 sm:pt-8"
      aria-labelledby="realm-boards-heading"
    >
      <h2
        ref={focus.boundaryRef}
        tabIndex={-1}
        id="realm-boards-heading"
        className="scroll-mt-6 text-2xl font-semibold focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-ring"
      >
        {m.realm_boards_heading()}
      </h2>
      <p className="max-w-prose text-sm leading-relaxed text-muted-foreground">{m.community_boards_description()}</p>
      {boards.length ? (
        <ul className="grid min-w-0 gap-3 sm:gap-4 lg:grid-cols-2">
          {boards.map((board) => {
            const href = boardHref(board);
            const visibilityLabel = {
              published: m.catalogue_reports_visibility_visible(),
              draft: m.realm_board_draft(),
              protected: m.realm_board_protected(),
              taken_down: m.catalogue_reports_visibility_taken_down(),
            }[board.visibility];
            return (
              <li
                key={board.id}
                id={`realm-board-${board.id}`}
                ref={board.id === focus.firstId ? focus.itemRef : null}
                tabIndex={-1}
                aria-label={board.id === focus.firstId ? focus.regionLabel : undefined}
                className="min-w-0 rounded-xl focus-visible:outline-2 focus-visible:outline-ring"
              >
                <article
                  data-slot="realm-board-card"
                  data-visibility={board.visibility}
                  className="min-w-0 space-y-3 rounded-xl border border-border bg-card p-4 sm:p-5"
                >
                  <header className="min-w-0 space-y-2">
                    <h3 className="text-lg leading-snug font-semibold sm:text-xl">
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
                        className="inline-flex max-w-full items-center underline-offset-4 hover:underline"
                        data-slot="realm-board-link"
                      >
                        {board.title ?? m.threads_untitled()}
                      </a>
                    </h3>
                    <div className="flex min-w-0 flex-wrap gap-2 text-xs font-medium">
                      <span className="rounded-full bg-muted px-2.5 py-1 text-muted-foreground">
                        {purposeLabel(board.purpose)}
                      </span>
                      {visibilityLabel ? (
                        <span className="rounded-full border border-border px-2.5 py-1 text-muted-foreground">
                          {visibilityLabel}
                        </span>
                      ) : null}
                    </div>
                    {board.description ? (
                      <p className="max-w-prose text-sm leading-relaxed text-muted-foreground">{board.description}</p>
                    ) : null}
                  </header>
                  {recentRegion(board, href, current)}
                </article>
              </li>
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

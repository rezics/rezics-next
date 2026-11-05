import type { ReactNode } from 'react';
import { ListRow } from '@rezics/ui/list-row';
import { m } from '../../paraglide/messages.js';
import { getLocale } from '../../paraglide/runtime.js';
import { boardRequestHref } from '../../threads/board-navigation';
import type { RealmBoard } from '../space';
import type { useShelfContinuationFocus } from '../publication-controls-view';

function purposeLabel(purpose: RealmBoard['purpose']): string {
  return purpose === 'reviews' ? m.realm_board_purpose_reviews() : m.realm_board_purpose_discussion();
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
          {boards.map((board) => (
            <ListRow
              key={board.id}
              id={`realm-board-${board.id}`}
              ref={board.id === focus.firstId ? focus.itemRef : null}
              tabIndex={-1}
              aria-label={board.id === focus.firstId ? focus.regionLabel : undefined}
              className="flex items-start gap-4 rounded-xl px-4 py-3 focus-visible:outline-2 focus-visible:outline-ring"
            >
              <div className="min-w-0 flex-1 space-y-1">
                <h3 className="font-semibold">
                  <a
                    href={boardHref(board)}
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
            </ListRow>
          ))}
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
